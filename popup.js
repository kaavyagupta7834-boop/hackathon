// popup.js
// -----------------------------------------------------------------------------
// This script powers the popup window (popup.html). It does three things:
//
//   1. When the popup opens, it asks the background service worker:
//        "What's the status of the currently-active tab?"
//      and then renders that status (e.g. "New Repo Detected", "Already Sent").
//
//   2. If the status is "new", it enables the "Fetch & Send Code" button.
//
//   3. When the button is clicked, it tells the background worker to do the
//      heavy work (recursive file fetch + POST to localhost:3000), then
//      updates the UI with the result.
//
// The popup itself never talks to GitHub or to localhost — it just renders
// state and forwards button clicks. All the network work happens in
// background.js so the popup can close without interrupting anything.
// -----------------------------------------------------------------------------

// Grab references to the UI elements we'll be updating.
const pill = document.getElementById("status-pill");
const statusLabel = document.getElementById("status-label");
const repoLine = document.getElementById("repo-line");
const message = document.getElementById("message");
const sendBtn = document.getElementById("send-btn");
const result = document.getElementById("result");

// Update the pill's label and color class. We only swap the text inside the
// "status-label" span so the pulse-dot and spinner siblings inside the pill
// remain intact between renders.
function setPill(label, cssClass) {
  statusLabel.textContent = label;
  pill.className = "";              // wipe any previous status class
  if (cssClass) pill.classList.add(cssClass);
}

// Render a state object (the same shape background.js puts into tabState).
function render(state) {
  // Always start each render by making the button visible — individual cases
  // below can hide it again (e.g. for the "empty" repo case).
  sendBtn.style.display = "";

  if (!state) {
    setPill("unknown", "");
    repoLine.textContent = "";
    message.textContent = "No information available.";
    sendBtn.disabled = true;
    return;
  }

  // Show owner/repo if we know it. We use a styled slash for nicer typography.
  if (state.owner && state.repo) {
    repoLine.innerHTML =
      `${escapeHtml(state.owner)}<span class="slash">/</span>${escapeHtml(state.repo)}`;
  } else {
    repoLine.textContent = "";
  }

  // Show the human-readable message.
  message.textContent = state.message || "";

  // The pill + button enabling depends on the status string.
  switch (state.status) {
    case "new":
      setPill("New Repo Detected", "new");
      sendBtn.disabled = false;
      sendBtn.textContent = "Fetch & Send Code";
      break;
    case "sending":
      setPill("Fetching code…", "sending");
      sendBtn.disabled = true;
      sendBtn.textContent = "Fetching code…";
      break;
    case "done":
      setPill("Done", "done");
      sendBtn.disabled = true;
      sendBtn.textContent = "Done";
      break;
    case "already-sent":
      setPill("Already sent", "");
      sendBtn.disabled = true;
      sendBtn.textContent = "Nothing to send";
      break;
    case "not-new":
      setPill("Not a new repo", "");
      sendBtn.disabled = true;
      sendBtn.textContent = "Older than 7 days";
      break;
    case "empty":
      // Repo is in the 7-day window but has no code committed yet
      // (size === 0, or pushed_at is null, or pushed_at === created_at).
      // Per spec: no NEW badge, no Fetch & Send button — just a message.
      setPill("Empty repo", "");
      sendBtn.disabled = true;
      sendBtn.style.display = "none";
      break;
    case "error":
      setPill("Error", "error");
      sendBtn.disabled = true;
      sendBtn.textContent = "Error";
      break;
    case "not-a-repo":
    default:
      setPill("Not a repo page", "");
      sendBtn.disabled = true;
      sendBtn.textContent = "Open a GitHub repo first";
      break;
  }
}

// Step 1: ask the background worker for the current tab's state.
chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
  // chrome.runtime.lastError can fire if the service worker hasn't booted yet.
  // We just render whatever we got (or nothing).
  render(state);
});

// Step 2: when the button is clicked, ask the background worker to do the
// fetch + POST. We immediately flip the UI into "sending" mode so the user
// gets instant feedback.
sendBtn.addEventListener("click", () => {
  render({ status: "sending", message: "Fetching code from GitHub…",
           owner: pill.dataset.owner, repo: pill.dataset.repo });
  result.textContent = "";

  chrome.runtime.sendMessage({ type: "FETCH_AND_SEND" }, (resp) => {
    if (!resp) {
      render({ status: "error", message: "No response from background worker." });
      return;
    }
    if (resp.ok) {
      // Re-pull the latest state so the message/owner/repo are accurate.
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (s) => render(s));
      result.textContent =
        `Sent ${resp.fileCount} files (${resp.byteCount.toLocaleString()} chars) to CodeLens.`;
    } else {
      render({ status: "error", message: resp.error || "Unknown error." });
      result.textContent = "";
    }
  });
});

// Tiny HTML escaper so we can safely put owner/repo into innerHTML without
// risking weird characters in the repo name breaking the layout.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
