// content.js
// -----------------------------------------------------------------------------
// This script is injected into every GitHub page that matches "github.com/*/*".
// Its job is small and focused:
//   1. Figure out if the page the user is on looks like a real repository page
//      (e.g. github.com/facebook/react), and not something else like
//      github.com/settings or github.com/orgs/whatever.
//   2. Send the {owner, repo} pair to the background service worker so it can
//      hit the GitHub API and decide whether this repo is "new" (< 7 days old).
//   3. Because GitHub is a single-page app, the URL can change without the
//      page fully reloading. We watch for those silent URL changes and notify
//      the background script again whenever the user navigates to a new repo.
// -----------------------------------------------------------------------------

// These are URL path segments that look like /username/something but are not
// actually user repos — they are GitHub's own pages. We skip them so we don't
// spam the API with 404s.
const RESERVED_OWNERS = new Set([
  "settings", "notifications", "explore", "marketplace", "pulls", "issues",
  "topics", "trending", "collections", "events", "sponsors", "new", "login",
  "logout", "join", "signup", "search", "orgs", "organizations", "about",
  "pricing", "features", "enterprise", "customer-stories", "security",
  "team", "site", "contact", "readme", "codespaces", "discussions",
  "watching", "stars", "your_repositories"
]);

// Pull "owner" and "repo" out of the current URL.
// Returns null if this page does not look like a repo page.
function parseRepoFromUrl() {
  // location.pathname looks like "/facebook/react" or "/facebook/react/issues"
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;            // not enough path segments
  const [owner, repo] = parts;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;  // GitHub system page
  // A repo name can't start with "." and shouldn't include weird characters.
  // GitHub allows letters, digits, dot, dash, underscore.
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}

// Send the current repo info to the background service worker.
// The background script will do the actual API call + decision.
function notifyBackground() {
  // If the extension was reloaded/updated while this tab stayed open, the
  // chrome.runtime connection becomes invalid. chrome.runtime.id is undefined
  // in that case. Checking it lets us bail out cleanly instead of throwing
  // "Extension context invalidated" all over the console.
  if (!chrome.runtime?.id) {
    cleanup();
    return;
  }

  const info = parseRepoFromUrl();
  try {
    if (!info) {
      // Not on a repo page — tell background to clear its state for this tab.
      chrome.runtime.sendMessage({ type: "NOT_A_REPO" }).catch(() => {});
      return;
    }
    chrome.runtime.sendMessage({
      type: "REPO_DETECTED",
      owner: info.owner,
      repo: info.repo,
      url: window.location.href
    }).catch(() => {
      // The background worker may be asleep; the runtime will spin it up.
      // We just ignore any "no receiver" errors here.
    });
  } catch (err) {
    // sendMessage can throw synchronously if the extension was unloaded.
    // Stop the observer so we don't keep retrying on every DOM mutation.
    cleanup();
  }
}

// Disconnect the observer and remove listeners so we don't keep firing
// after the extension context has gone away.
function cleanup() {
  try { observer.disconnect(); } catch (_) {}
  window.removeEventListener("popstate", checkUrlChange);
}

// Run once on initial load.
notifyBackground();

// GitHub is a single-page app: it changes the URL using history.pushState
// instead of a full page reload. So the content script does NOT get re-injected
// on those navigations. We have to watch for URL changes ourselves.
let lastSeenUrl = window.location.href;

function checkUrlChange() {
  if (window.location.href !== lastSeenUrl) {
    lastSeenUrl = window.location.href;
    notifyBackground();
  }
}

// Watch the DOM for changes. GitHub mutates the body on SPA navigation, so this
// reliably fires shortly after the URL changes.
const observer = new MutationObserver(checkUrlChange);
observer.observe(document.body, { childList: true, subtree: true });

// Belt-and-suspenders: also listen for browser back/forward.
window.addEventListener("popstate", checkUrlChange);
