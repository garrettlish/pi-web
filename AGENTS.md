# AGENTS.md

Guidance for AI coding agents (pi and others) working in this repository.

## Contents

- [What this project is](#what-this-project-is)
- [Language policy](#language-policy)
- [Public repository policy](#public-repository-policy)
- [Architecture constraints](#architecture-constraints)
- [Code style](#code-style)
- [Security invariants](#security-invariants)
- [Verification](#verification)

## What this project is

`pi-web` is a local web UI for the [pi coding agent](https://github.com/earendil-works/pi).
`server.js` spawns one `pi --mode rpc` subprocess per open session and bridges it to the browser
over SSE and JSON. The whole app is one Node file plus three static frontend files.

Read `README.md` for the full picture and `CONTRIBUTING.md` for contribution rules before
making changes. Both are short.

## Language policy

- **All content in this repository must be in English.** This applies to:
  - Code, identifiers, and comments
  - Documentation (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, and any new docs)
  - Commit messages, pull request titles and descriptions
  - Issue text, test names, log messages, and user-facing strings in the UI
- Do not introduce content in any other language. If you (the agent) are asked in another
  language, reply in that language but keep every file you write in English.

## Public repository policy

This repository is public and shared. Assume anything committed is readable by anyone, forever.

- **No secrets**: no API keys, tokens, credentials, cookies, or session contents — in code,
  comments, tests, examples, or documentation.
- **No personal information**: no real hostnames, usernames, home-directory paths, project names,
  or internal URLs. Use placeholders such as `you@example.com` or `~/code/my-project`.
- **Stay professional**: comments and docs should be concise, factual, and free of speculation
  about people or organizations.
- **Keep the docs honest**: if a change alters behavior, update `README.md` (including the HTTP
  API and configuration tables) and `CONTRIBUTING.md` when relevant. Documentation that lags
  behind code is a defect in this repo. Checking is required once per commit, not on every
  individual edit: before committing, re-read the README's Features, Controls, HTTP API,
  Configuration and Limitations sections against the final diff, and update anything that no
  longer describes the code.
- Security issues are reported privately, per `SECURITY.md` — never by opening a public issue
  with exploit details.

## Architecture constraints

These constraints are the point of the project. Do not weaken them:

- **No npm dependencies, no build step.** `server.js` and `public/` (index.html, app.js,
  style.css) are the entire app. Do not add a bundler, framework, transpiler, or dev-server.
- **Node >= 18, ESM only.** Use `node:` prefixed imports; no CommonJS, no TypeScript.
- **No frameworks on the frontend.** Plain DOM APIs only. Transcripts are built with
  `textContent`; untrusted content is never passed to `innerHTML`.
- **The browser never talks to `pi` directly.** All agent traffic flows through `server.js`.
- **One `pi` process per session.** Do not replace this with in-process session switching; it
  breaks loaded extension contexts (see README, Architecture).
- **Small, focused diffs.** Fix what you came to fix; do not refactor adjacent code, reformat,
  or "improve" unrelated things in the same change.

## Code style

Match the existing files exactly:

- Two-space indentation, double quotes, semicolons, `const`/`let` (no `var`).
- Comments explain *why*, not *what*.
- Plain, descriptive identifiers; no clever one-letter names outside tiny local scopes.
- CSS uses the design tokens in `public/style.css` (`:root`, `[data-theme="light"]`); new styles
  must work in both light and dark themes.

## Security invariants

The server can run shell commands as the user via `pi`, so these are non-negotiable:

- Default bind address stays `127.0.0.1`; the `Host`/`Origin` local-request guards stay on.
- Static file serving resolves paths and checks them against `public/` — path traversal must
  remain impossible (the smoke test asserts this).
- Session files are read only from the configured session directory.
- Request bodies stay capped at 32 MB.
- No `eval`, no dynamic code execution, no new remote-access escape hatch without an explicit,
  documented, warned-at-startup opt-in.

If a change would touch any of the above, stop and explain the trade-off in the pull request
before proceeding.

## Verification

Run before declaring any change done:

```bash
npm run check     # syntax check on server, frontend and tests
npm test          # end-to-end smoke test (HTTP surface + security guards)
```

`npm test` does not drive the UI, so for frontend changes also start `node server.js` and verify
the changed flow manually in the browser; state what you clicked and what you saw.
