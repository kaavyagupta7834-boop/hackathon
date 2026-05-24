// background.js
// -----------------------------------------------------------------------------
// This is the extension's "brain". It runs as a Manifest V3 service worker,
// which means Chrome can spin it up on demand and shut it down when idle.
//
// Responsibilities:
//   1. Listen for messages from content.js ("I'm on a repo page: owner/repo").
//   2. Hit the GitHub API to find out:
//        - When was the repo created?    (created_at)
//        - When was it last pushed to?   (pushed_at — used as a freshness key)
//        - What is the default branch?   (needed to list files)
//   3. Decide if it's "new" (created within last 7 days).
//   4. Compare pushed_at against the value we previously stored after sending
//      this repo. If they differ (or we've never sent it) → mark as "ready".
//   5. Update the action badge so the toolbar icon shows "NEW" or similar.
//   6. When the popup clicks the button, recursively fetch all matching code
//      files, combine them, and open them in a new tab at
//      https://story-telling-engine.lovable.app as a URL query parameter.
// -----------------------------------------------------------------------------

// The file extensions we are willing to send. Everything else is treated as
// "binary or uninteresting" and skipped.
const ALLOWED_EXTENSIONS = new Set([
  "js", "ts", "py", "html", "css", "java", "cpp", "c", "go", "rb", "php",
  "swift", "json", "md"
]);

// "New" = created within this many days.
const NEW_REPO_WINDOW_DAYS = 7;

// Where to send the combined code. Instead of a POST request, we open this
// URL in a brand-new Chrome tab with the code attached as a `?code=` query
// parameter (URL-encoded via encodeURIComponent).
const TARGET_ENDPOINT = "https://clear-code-insights.lovable.app";

// Cap how many files we'll fetch in one shot. Kept low (20) because the
// combined code is shipped through a URL query string, and most browsers /
// proxies / web frameworks truncate very long URLs.
const MAX_FILES = 20;

// Per-tab state, kept only in memory. Each entry is the latest evaluation we
// did for whatever repo that tab is currently showing.
// Shape: tabId -> {
//   status: "new" | "already-sent" | "not-new" | "not-a-repo" | "error" | "sending" | "done",
//   owner, repo, createdAt, pushedAt, defaultBranch, message
// }
const tabState = new Map();

// -----------------------------------------------------------------------------
// Helper: small wrapper around fetch that adds the standard GitHub headers and
// throws a clean error on non-2xx responses.
// -----------------------------------------------------------------------------
async function ghFetch(url) {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}`);
  }
  return res.json();
}

// -----------------------------------------------------------------------------
// Helper: set the toolbar badge text and color for a specific tab.
// -----------------------------------------------------------------------------
function setBadge(tabId, text, color = "#C17F3A") {
  if (tabId === undefined || tabId === null) return;
  chrome.action.setBadgeText({ tabId, text: text || "" }).catch(() => {});
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// Helper: read the "last sent pushed_at" we stored for a given repo.
// We use chrome.storage.local keyed by "sent:owner/repo".
// -----------------------------------------------------------------------------
async function getLastSentPushedAt(owner, repo) {
  const key = `sent:${owner}/${repo}`;
  const obj = await chrome.storage.local.get(key);
  return obj[key] || null;
}

async function setLastSentPushedAt(owner, repo, pushedAt) {
  const key = `sent:${owner}/${repo}`;
  await chrome.storage.local.set({ [key]: pushedAt });
}

// -----------------------------------------------------------------------------
// Core logic: given an owner/repo, ask GitHub about it and decide what to do.
// Saves the result into tabState[tabId] and updates the badge for that tab.
// -----------------------------------------------------------------------------
async function evaluateRepo(tabId, owner, repo) {
  try {
    // Step 1: ask GitHub for the repo metadata.
    const meta = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`);

    const createdAt = meta.created_at;          // ISO 8601 string
    const pushedAt = meta.pushed_at;            // ISO 8601 string — updates on every push
    const defaultBranch = meta.default_branch;  // e.g. "main"
    const size = meta.size;                     // size in KB; 0 means the repo is empty

    // Step 2: is the repo "new" (created within the last N days)?
    const createdMs = new Date(createdAt).getTime();
    const ageDays = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
    const isNew = ageDays <= NEW_REPO_WINDOW_DAYS;

    if (!isNew) {
      tabState.set(tabId, {
        status: "not-new",
        owner, repo, createdAt, pushedAt, defaultBranch,
        message: `Repo is ${Math.floor(ageDays)} days old — not in the 7-day window.`
      });
      setBadge(tabId, "");
      return;
    }

    // Step 2b: does the repo plausibly contain any code yet?
    //
    // We used to rely on the "size" field, but it's unreliable in practice:
    //   - It's reported in KB rounded down, so a small file (~100 bytes)
    //     literally rounds to 0 KB.
    //   - GitHub updates this field asynchronously — it can lag minutes
    //     behind reality after a push.
    // We also used to check pushed_at === created_at, but a fast push within
    // the same second as repo creation false-positives that rule.
    //
    // Now we only short-circuit when GitHub explicitly says there has never
    // been a push at all (pushed_at is null). If the user clicks Fetch &
    // Send Code on a still-empty repo, the actual tree-fetch logic later on
    // will surface "No matching code files in this repo." — which is the
    // honest answer rather than a stale "empty" guess.
    if (!pushedAt) {
      tabState.set(tabId, {
        status: "empty",
        owner, repo, createdAt, pushedAt, defaultBranch,
        message: "No code found in this repository yet"
      });
      setBadge(tabId, "");
      return;
    }

    // Step 3: have we already sent this exact version of the repo?
    // If pushed_at is unchanged from what we stored last time, the code hasn't
    // changed since we sent it — so don't bother the user with the popup again.
    const lastSent = await getLastSentPushedAt(owner, repo);
    if (lastSent && lastSent === pushedAt) {
      tabState.set(tabId, {
        status: "already-sent",
        owner, repo, createdAt, pushedAt, defaultBranch,
        message: "Already sent — no new changes since last time."
      });
      setBadge(tabId, "");
      return;
    }

    // Step 4: it's new (or has new commits since last send) — flag it.
    tabState.set(tabId, {
      status: "new",
      owner, repo, createdAt, pushedAt, defaultBranch,
      message: lastSent
        ? "New commits detected since last send."
        : "New repo detected (created within the last 7 days)."
    });
    setBadge(tabId, "NEW");
  } catch (err) {
    tabState.set(tabId, {
      status: "error",
      owner, repo,
      message: err.message || String(err)
    });
    setBadge(tabId, "ERR", "#b00020");
  }
}

// -----------------------------------------------------------------------------
// Listen for messages from content.js and popup.js.
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Identify which tab sent the message (content scripts) or the active tab
  // (popup — popups don't have sender.tab).
  const tabId = sender.tab ? sender.tab.id : null;

  // -- Message from content.js: user is on a repo page --
  if (msg.type === "REPO_DETECTED" && tabId !== null) {
    evaluateRepo(tabId, msg.owner, msg.repo);
    return false; // we don't sendResponse here
  }

  // -- Message from content.js: user navigated to a non-repo URL --
  if (msg.type === "NOT_A_REPO" && tabId !== null) {
    tabState.set(tabId, { status: "not-a-repo", message: "Not on a repo page." });
    setBadge(tabId, "");
    return false;
  }

  // -- Message from popup: "what's the state of the active tab?" --
  if (msg.type === "GET_STATE") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab) return sendResponse({ status: "not-a-repo", message: "No active tab." });
      const state = tabState.get(tab.id);
      sendResponse(state || { status: "not-a-repo", message: "Nothing detected yet." });
    });
    return true; // we're sending the response asynchronously
  }

  // -- Message from popup: "fetch all code and POST it" --
  if (msg.type === "FETCH_AND_SEND") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (!tab) return sendResponse({ ok: false, error: "No active tab." });
      try {
        const result = await fetchAndSend(tab.id);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    });
    return true; // async response
  }

  return false;
});

// -----------------------------------------------------------------------------
// fetchAndSend: do the heavy work.
//   1. Look up the cached repo info for this tab.
//   2. Recursively list every file in the repo (one API call via git/trees).
//   3. Filter the list down to the allowed extensions.
//   4. Download each file's raw content.
//   5. Concatenate everything into one big string.
//   6. Open a new Chrome tab pointing at
//      https://story-telling-engine.lovable.app?code=<URL-encoded code>.
//   7. On success, remember the pushed_at so we don't re-send unchanged code.
// -----------------------------------------------------------------------------
async function fetchAndSend(tabId) {
  const state = tabState.get(tabId);
  if (!state || !state.owner || !state.repo) {
    throw new Error("No repo info for this tab. Open a repo page first.");
  }
  const { owner, repo, defaultBranch, pushedAt } = state;

  // Update UI: we're working.
  tabState.set(tabId, { ...state, status: "sending", message: "Fetching code..." });
  setBadge(tabId, "...", "#888");

  // Step 1: recursive tree listing. One API call gives us every path.
  const treeJson = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`
  );

  // The tree's "tree" array contains entries with {path, type, size, sha}.
  // type === "blob" means it's a file (not a folder/submodule).
  const blobs = (treeJson.tree || []).filter(t => t.type === "blob");

  // Step 2: filter to allowed extensions.
  const wanted = blobs.filter(b => {
    const lastDot = b.path.lastIndexOf(".");
    if (lastDot === -1) return false;
    const ext = b.path.slice(lastDot + 1).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
  }).slice(0, MAX_FILES);

  if (wanted.length === 0) {
    throw new Error("No matching code files in this repo.");
  }

  // Step 3: download every file's raw text in parallel (but with a small
  // concurrency limit to be polite to GitHub).
  const pieces = await fetchAllFiles(owner, repo, defaultBranch, wanted);

  // Step 4: stitch them into one block, with a clear header per file so the
  // server can tell them apart if it wants to.
  const combined = pieces
    .map(p => `// ===== ${p.path} =====\n${p.content}`)
    .join("\n\n");

  // Step 5: open the web app in a fresh Chrome tab and inject the code
  // directly into its textarea + click the Analyze button.
  //
  // Why we don't put the code in the URL anymore:
  //   Lovable's hosting edge has a URL length limit. Even 2 tiny files
  //   produced a long-enough URL to hit a "page didn't load" error. The
  //   scripting-injection approach has no length limit and is much more
  //   robust as the user's repos grow.
  const newTab = await chrome.tabs.create({ url: TARGET_ENDPOINT });

  // Wait for the new tab to finish loading before we try to inject anything.
  // We listen to chrome.tabs.onUpdated for a "complete" status on this tab.
  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === newTab.id && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Inject a tiny function into the Lovable page. It needs to handle a
  // subtle race condition:
  //   - The Lovable app has a useEffect that runs on mount and checks the
  //     URL for a "?code=" param. If absent, it sets the textarea state
  //     to "" — which would wipe out our injected code.
  //   - So we (a) wait until the textarea has existed for a moment, (b)
  //     inject, (c) verify the value stuck, (d) re-inject if it got
  //     cleared, and (e) only THEN click Analyze.
  await chrome.scripting.executeScript({
    target: { tabId: newTab.id },
    func: (codeToInject) => {
      // Helper: programmatically set a React-controlled textarea's value
      // in a way React will actually notice (plain .value= is ignored).
      const setReactValue = (textarea, value) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value"
        ).set;
        nativeSetter.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      };

      // Helper: find and click the Analyze button.
      const clickAnalyze = () => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          b.textContent.trim().toLowerCase().startsWith("analyze")
        );
        if (btn) btn.click();
      };

      // Step 1: wait until the textarea exists in the DOM.
      const waitForTextarea = (attempt = 0) => {
        const textarea = document.querySelector("textarea");
        if (!textarea) {
          if (attempt < 40) {
            setTimeout(() => waitForTextarea(attempt + 1), 200);
          }
          return;
        }

        // Step 2: wait 1 second so Lovable's URL-param-reading useEffect
        // has a chance to run AND clear the field. We inject AFTER that
        // clear, so our value is the last one written.
        setTimeout(() => injectWithRetry(textarea), 1000);
      };

      // Step 3: inject, then verify the value survived. If something
      // clears it (e.g. a late-running effect), re-inject up to 5 times.
      const injectWithRetry = (textarea, retries = 5) => {
        setReactValue(textarea, codeToInject);

        // Check 500ms later that the value is still there.
        setTimeout(() => {
          if (textarea.value === codeToInject) {
            // Value stuck — give React a tick, then click Analyze.
            setTimeout(clickAnalyze, 200);
          } else if (retries > 0) {
            // Something wiped it — try again.
            injectWithRetry(textarea, retries - 1);
          } else {
            // Out of retries; click Analyze anyway in case the value is
            // actually in React state but the DOM is just out of sync.
            clickAnalyze();
          }
        }, 500);
      };

      waitForTextarea();
    },
    args: [combined],
  });

  // Step 6: remember that we sent THIS version of the repo (by pushed_at), so
  // a future visit to the same repo with no new commits won't ping the user.
  await setLastSentPushedAt(owner, repo, pushedAt);

  tabState.set(tabId, {
    ...state,
    status: "done",
    message: `Opened ${pieces.length} files (${combined.length.toLocaleString()} chars) in a new tab.`
  });
  setBadge(tabId, "Done", "#1f7a3a");

  return { fileCount: pieces.length, byteCount: combined.length };
}

// Helper: download all files with a small concurrency cap (5 at a time).
async function fetchAllFiles(owner, repo, branch, entries) {
  const results = [];
  let i = 0;
  const workers = new Array(Math.min(5, entries.length)).fill(null).map(async () => {
    while (i < entries.length) {
      const my = i++;
      const entry = entries[my];
      try {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${entry.path}`;
        const res = await fetch(url);
        if (!res.ok) continue;             // skip files we can't read
        const text = await res.text();
        results.push({ path: entry.path, content: text });
      } catch (_) {
        // ignore individual file failures — we'll send whatever we got
      }
    }
  });
  await Promise.all(workers);
  // Keep output in a stable, predictable order (alphabetical by path).
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

// -----------------------------------------------------------------------------
// Housekeeping: when a tab closes, drop its entry so the map doesn't grow.
// -----------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});
