# CodeLens

A Chrome extension and web app that explains any GitHub repository in plain English, for the people who can't read code.

**Live web app:** https://clear-code-insights.lovable.app/

**Team:** Ayush Savnani & Kaavya Gupta

---

## What it does

CodeLens detects the moment you visit a freshly-created public GitHub repository, pulls every code file through GitHub's public API, and runs the codebase through Llama 3.3 70B. It returns two things side by side:

1. **A developer code review** with severity scoring (Critical / Warnings / Suggestions)
2. **Plain-English documentation** tailored to the audience you pick (Founder, Investor, Client, or New Hire)

The same codebase, four different voices, generated in one model call.

## Problem statements addressed

- **P1: AI-Powered Code Review Assistant for Engineering Teams** — automated review of repos with severity-categorized findings.
- **P8: Technical Documentation Generator for Developers** — auto-generated documentation from any codebase, including a "New Hire" mode for onboarding.

## How it works

1. You visit a GitHub repository created within the last 7 days that has code in it.
2. The CodeLens extension wakes up, detects the repo, and shows a copper "NEW" badge on its toolbar icon.
3. You click the icon and press **Fetch & Send Code**.
4. The extension fetches up to 20 source files via the public GitHub REST API (no authentication needed).
5. It opens the CodeLens web app in a new tab and injects the code into the editor.
6. The web app calls Llama 3.3 70B (via Groq) and renders the review and documentation in two panels.
7. You can switch the Audience dropdown to regenerate the documentation in a different voice, or export the documentation as a PDF.

## Tech stack

- **Chrome Extension:** vanilla JavaScript, Manifest V3
- **Web App:** React (built on Lovable)
- **AI:** Llama 3.3 70B via Groq (OpenAI-compatible chat completions API)
- **Data source:** GitHub public REST API
- **PDF export:** native browser print, no external libraries

## Installing the extension locally

The extension is unpacked, so it loads directly from this folder.

1. Open Chrome and visit `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select the folder containing `manifest.json`
5. The CodeLens icon (copper "C" on a rounded square) appears in your toolbar

## Using it end to end

1. Open any public GitHub repository created within the last 7 days that contains code. If you don't have one handy, fork a small public repo to your account — the fork's `created_at` becomes today.
2. The CodeLens toolbar icon shows a **NEW** badge once it confirms the repo is fresh and non-empty.
3. Click the icon, then click **Fetch & Send Code**.
4. A new tab opens at the CodeLens web app. The textarea fills in automatically and analysis fires on its own.
5. Read the code review on the left, the plain-English documentation on the right.
6. Switch the Audience dropdown to regenerate the documentation in a different voice.
7. Click **Download as PDF** to export just the documentation.

## File map

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 declaration |
| `content.js` | Detects when the user is on a GitHub repo page, notifies the background worker |
| `background.js` | The brain. Hits the GitHub API, decides if the repo is new and non-empty, fetches files, injects code into the web app |
| `popup.html` | The toolbar popup UI |
| `popup.js` | Wires the popup to the background worker |
| `icon-16.png`, `icon-48.png`, `icon-128.png` | Toolbar icons at three sizes |
| `icon.svg` | Source for the icon |
| `generate-icons.html` | A small tool that re-generates the three PNG sizes from the SVG |
| `CodeLens-OnePager.pdf` | One-page submission document |

## Repository detection rules

The extension only activates and shows the **NEW** badge when ALL of these are true:

1. The repo was created within the last 7 days (per `created_at` from the GitHub API).
2. The repo has at least one commit (`pushed_at` is not null and differs from `created_at`).
3. The repo is not empty (the `size` field is greater than 0).

If you've already sent a version of a repo to the web app, CodeLens remembers it via `pushed_at` in `chrome.storage.local` and stays quiet. If new commits land, the badge reappears.

## Constraints and notes

- **Public repos only** for this MVP. No GitHub OAuth.
- **20-file cap** per analysis. Skips binaries, only fetches: `.js .ts .py .html .css .java .cpp .c .go .rb .php .swift .json .md`
- **Groq API key** is hardcoded in the web app source on Lovable. Acceptable for a hackathon demo; for production you would proxy through a backend.

## Credits

Built by **Ayush Savnani** and **Kaavya Gupta** for the 2026 hackathon.
