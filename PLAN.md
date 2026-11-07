# Sembilan — next round plan

Goal: make the app safer to change, installable like a real app, and clearer for riders — all things that can be done before the first real road test.

| # | Task | Files | Who | Status |
|---|------|-------|-----|--------|
| A | Automated tests + run them on every push (GitHub Actions) | `tests/`, `package.json`, `.github/workflows/test.yml` | Haiku agent | Done |
| B | Installable app (PWA): manifest, app icon, offline app shell | `manifest.webmanifest`, `sw.js`, `icon.svg`, `<head>` of `index.html` | Haiku agent | Done |
| C | Riding tips at navigation start (keep screen on; iPhone pauses GPS when locked) + "data last updated" line in Settings | `index.html` | Haiku agent | Done |
| D | "Report a problem" button for testers | `index.html` | Needs owner's WhatsApp number | Waiting for input |
| — | Review every change, run tests, push | — | Claude (Opus) | Done: 15/15 tests pass; tests found a search bug (same-name places 25 km apart merged), fixed |

Rules for every task
- `index.html` is edited by one agent at a time.
- Nothing is pushed without review and passing tests.
- Keep the app a single page with no build step; GitHub Pages serves the repo as-is.

Not in this round (needs money or a real ride): live traffic, avoid-tolls routing, true motorcycle routing server, native Android/iOS app.

## Round 2 — ready for the tester pilot

| # | Task | Files | Who | Status |
|---|------|-------|-----|--------|
| E | Trip log + "Laporkan masalah" (report a problem) button: tester describes the issue, app attaches what happened (route, last GPS points, last voice prompts, reroutes, device), shares via WhatsApp/share sheet. Owner number can be set later in one constant. Tests included. | `index.html`, `tests/` | Haiku agent | Done |
| J | Tester guide page in BM + English: install, how to test safely, what to report | `panduan.html` | Haiku agent | Done |
| K | Night mode: dark map automatically after sunset (less glare for riders), manual override kept. Tests included. | `index.html`, `tests/` | Haiku agent, after E | Waiting |
| — | Review, run tests, push | — | Claude (Opus) | After each task |
