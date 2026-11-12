# Contributing to pi-web

Thanks for taking a look. This project is intentionally small — please keep it that way.

## Ground rules

- **No dependencies, no build step.** `server.js` and the three files in `public/` are the whole
  app. A change that adds a bundler, a framework or a dev-server defeats the point.
- **Small, focused diffs.** Fix the thing you came to fix; leave adjacent code alone.
- **Match the surrounding style.** Two-space indent, double quotes, semicolons, `const`/`let`,
  comments that explain *why* rather than *what*.
- **No secrets, hostnames or personal paths** in code, comments, tests or docs.

## Before opening a pull request

```bash
npm run check     # node --check on the server, frontend and tests
npm test          # end-to-end smoke test
node server.js    # then click through the flow you changed
```

The smoke test covers the HTTP surface and the security guards. It does not drive the UI, so a
manual verification note is valuable — say what you clicked and what you saw. If you add tests, they
should encode why the behavior matters, not just restate the implementation.

## Reporting bugs

Include the `pi` version (`pi --version`), Node version (`node -v`), operating system, the exact
command you used to start the server, and any console output from both the browser and the
terminal. If a specific session triggers the problem, a redacted excerpt of its JSONL file helps.

## Reporting security issues

Please do not open a public issue. See [SECURITY.md](SECURITY.md).

## Code map

| Area | Where |
| --- | --- |
| Process pool, client routing, HTTP endpoints | `server.js` |
| Session listing and JSONL parsing | `server.js` (`listSessions`, `sessionCwd`) |
| Follow-up store (one JSON file per saved summary) | `server.js` (`listFollowups`, `readFollowup`) |
| Transcript item model (entries → renderable items) | `public/app.js` (`buildItemsFromEntries`) |
| Turn copy (rich clipboard) and follow-up save | `public/app.js` (`copyRichText`, `emailHtml`, `saveFollowup`) |
| Live event handling | `public/app.js` (`handleEvent`) |
| Transcript reconciliation (no full re-render) | `public/app.js` (`renderTranscript`) |
| Design tokens and themes | `public/style.css` (`:root`, `[data-theme="<palette>"]`) |
| HTTP-level regression checks | `test/smoke.js` |
