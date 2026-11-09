# pi-web

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-none-blue)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A local web UI for the [pi coding agent](https://github.com/earendil-works/pi).

`pi` ships with a terminal UI. `pi-web` puts the same agent in a browser and adds what a terminal
is bad at: browsing every past session across every project, and inspecting exactly what the model
sent and received — request arguments, live tool output, full responses, token usage and cost.

It is deliberately plain: one Node process, three static frontend files, **no npm dependencies and
no build step**. The browser never talks to `pi` directly — `server.js` bridges a documented
[`pi --mode rpc`](https://github.com/earendil-works/pi/blob/main/docs/rpc.md) subprocess over
SSE and JSON.

## Contents

- [Why another UI](#why-another-ui)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Features](#features)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Remote access](#remote-access)
- [Security notes](#security-notes)
- [Development](#development)
- [Limitations](#limitations)
- [License](#license)

## Why another UI

- **Terminal parity.** Streaming assistant text, thinking blocks, tool calls with live partial
  results, retries, compaction — all rendered as pi produces them, not after the fact.
- **Sessions are objects, not a scrollback.** Every session under the pi session directory is
  listable, filterable, resumable, and addressable by URL.
- **The inspector.** Every tool call keeps its request, its execution updates, its response and
  its raw JSON one double-click away. Assistant turns keep their model, token counts and cost.

## Requirements

- Node.js **18 or newer** (uses ESM and `node:` imports only).
- A working `pi` install on your `PATH` (`pi --version` should succeed), or pass `--pi <path>`.
- Nothing else. No `npm install` is required to run it.

## Quick start

```bash
git clone https://github.com/garrettlish/pi-web.git
cd pi-web
node server.js
```

Open <http://localhost:3210>. The agent starts in the directory `server.js` was launched
from — use the folder button in the sidebar to work somewhere else, or:

```bash
node server.js --cwd ~/code/my-project   # agent works in another project
node server.js --port 8080               # different port
node server.js --help                    # every option
```

You can also install it as a global command:

```bash
npm install -g .
pi-web --cwd ~/code/my-project
```

## Features

**Live transcript**

- Assistant text, thinking and tool-call arguments stream in as pi works
  (`message_start` / `message_update` / `message_end`, `tool_execution_*`, retry and compaction
  events), with a subset of Markdown rendered inline.
- Tool calls appear as one-line rows in the transcript; clicking one opens a popup with the request
  arguments, live execution updates and the final response (text, images, `details`, error state,
  duration). For `edit` calls the popup leads with a colored, line-numbered diff — green additions,
  red deletions — followed by the raw request and response. The popup has a **Raw JSON** toggle and
  copies the full payload — the transcript itself never grows or scrolls, so the surrounding
  messages stay put.
- Assistant turns carry model, provider, input/output/cache tokens, cost and stop reason.
- Queued steering / follow-up messages appear in a dock directly above the composer, next to the
  running indicator; each can be undone individually or the whole queue cleared. The queue belongs
  to the attached session's agent process — switching sessions shows only that session's queue.
- `Esc` or **Stop** aborts the current run. The running/compacting indicator and **Stop** sit in
  that same dock above the input, so they are visible from where you are typing; if `pi` dies, the
  sidebar status line turns into a restart button.

**Sessions**

- The sidebar lists every session under the pi session directory with title, message count, cost
  and last activity. **Recent** is a flat, cross-project list; **Workspaces** is a two-level
  project → session view.
- Opening a session rebuilds the transcript from its active branch, including history from before
  a compaction, so you see the same conversation the terminal would.
- Every open session runs in **its own `pi --mode rpc` process**. Switching sessions does not stop
  the previous one: it keeps running in the background (marked with a pulsing dot in the sidebar)
  and you can re-attach at any time. Each browser tab is bound to exactly one process, so parallel
  tabs never interleave each other's output.
- Sessions are addressable: the URL hash (`#ws=…&session=…`) survives a reload and can be
  bookmarked or shared between your own tabs.
- Idle processes with no attached tab are reaped after 30 minutes.

**Controls**

- Switch model and thinking level from the header. The model list honors `enabledModels` from
  `~/.pi/agent/settings.json`.
- Context-window usage (used / max / percent), session cost and token totals in the header —
  updated as each assistant message completes, not only when a run ends — with a session-details
  popover for the full path, session id, cwd and token breakdown.
- The list button in the header outlines every user prompt in the session; clicking an entry
  scrolls the transcript to that message.
- Drop image files anywhere on the page to attach them to the next message; click a thumbnail to
  enlarge it.
- `ArrowUp` / `ArrowDown` in the composer walk back and forward through previously sent
  prompts (terminal-style, kept in the browser's local storage, capped at 200 entries);
  the in-progress draft is restored when you arrow past the newest entry. Arrows keep
  their normal caret role while the cursor is inside a multi-line draft.
- The sidebar collapses to give the transcript the full window width; the state is
  remembered across reloads, and a button at the left edge of the header brings it back.
- Extension UI requests (`select`, `confirm`, `input`, `editor`) surface as real dialogs; `notify`
  becomes a toast.
- Light and dark themes, a resizable sidebar, keyboard focus styling.

## Architecture

```text
browser tab A ──SSE /api/events?client=A──►  server.js  ──JSONL over stdio──►  pi --mode rpc (session 1)
              ──POST /api/cmd {client:A}──►      │
browser tab B ──SSE /api/events?client=B──►  process pool ──JSONL over stdio──►  pi --mode rpc (session 2)
              ──POST /api/cmd {client:B}──►      │
```

| File | Role |
| --- | --- |
| `server.js` | Process pool of `pi --mode rpc`, client routing, session listing, static files |
| `public/index.html` | Application shell |
| `public/app.js` | State, transcript reconciliation, event handling — no framework |
| `public/style.css` | Design tokens, light/dark themes, layout |

The server keeps one `pi` subprocess per open session, keyed by session file. A browser tab
registers a client id; `/api/open` attaches the tab to a process (spawning one if needed) and all
later commands and SSE events are routed by that id. stdout is framed strictly on LF (the pi docs
warn that `readline` also splits on U+2028/U+2029), and command responses are correlated by id.

A process per session is deliberate: the in-process `switch_session` RPC invalidates contexts held
by loaded extensions, which then fail with "extension ctx is stale after session replacement".
Starting a fresh process with `--session <file>` avoids that class of bug entirely.

### HTTP API

Everything the frontend uses is plain JSON; there is no auth layer because the server is
localhost-only by default.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Server cwd, session directory, pi binary |
| `GET /api/health` | Liveness and live process count |
| `GET /api/events?client=<id>` | SSE stream of pi records for this client's session |
| `POST /api/open` | `{client, sessionFile?, cwd?}` — attach this client to a session |
| `POST /api/cmd` | `{client, type, …}` — forward a pi RPC command, await its response |
| `POST /api/ui-response` | Answer an extension UI request |
| `GET /api/sessions` | List sessions with live active/streaming flags |
| `GET /api/browse?path=<dir>` | Directory listing for the workspace picker |

## Configuration

Command-line flags (each has an environment-variable equivalent):

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--port <n>` | `PI_WEB_PORT` | `3210` | Listen port |
| `--host <addr>` | `PI_WEB_HOST` | `127.0.0.1` | Bind address; a non-loopback value enables remote access |
| `--cwd <dir>` | `PI_WEB_CWD` | current directory | Directory the agent works in |
| `--session-dir <dir>` | `PI_CODING_AGENT_SESSION_DIR` | `~/.pi/agent/sessions` | Where pi stores sessions |
| `--pi <path>` | `PI_BIN` | `pi` on `PATH` | pi executable to spawn |
| `--allow-remote` | `PI_WEB_ALLOW_REMOTE=1` | off | Drop the loopback request guards (reverse proxies) |

`--help` prints the same list; `--version` prints the package version.

## Remote access

**Do not expose this server to a network you do not control.** Anything that can reach the port can
drive the agent, and the agent runs shell commands as you. There is no login.

By default the server binds to `127.0.0.1` and also rejects requests whose `Host` or `Origin` is not
local, which blocks DNS rebinding and cross-origin requests from other browser tabs.

Preferred remote setup — keep the server on loopback and tunnel to it:

```bash
node server.js                                   # stays on 127.0.0.1
ssh -N -L 3210:127.0.0.1:3210 you@your-machine   # then browse http://localhost:3210
```

Two escape hatches exist for containers and reverse proxies, and both log a warning at startup
because they remove the request guards:

- `--host 0.0.0.0` — bind beyond loopback (binding elsewhere is itself the opt-in).
- `--allow-remote` — stay on loopback but drop the `Host`/`Origin` checks, e.g. when a proxy
  rewrites the `Host` header.

Either way, put authentication in front of the port before it is reachable by anyone else.

## Security notes

- Paths from the browser are resolved and checked against the public asset directory before being
  served; the workspace picker only lists existing directories.
- Session listing walks only the configured session directory.
- No `eval`, no `innerHTML` with unescaped session content: transcripts are built with
  `textContent`, and the Markdown subset escapes before formatting.
- Reported vulnerabilities: see [SECURITY.md](SECURITY.md).

## Development

There is no build step. Both entry points are plain files that a browser or Node runs directly.

```bash
npm start          # same as node server.js
npm run check      # node --check on the server, frontend and smoke test
npm test           # end-to-end smoke test (starts a throwaway server)
```

`npm test` boots the server on a random port and verifies what has actually broken before: the page
and assets are served, the HTTP API answers, foreign `Host`/`Origin` requests are rejected, path
traversal cannot escape `public/`, and malformed commands return a clean 4xx. It needs no agent
credentials — when `pi` happens to be installed it also checks the agent round-trip, otherwise it
skips that check.

Frontend changes apply on reload (static files are served with `Cache-Control: no-cache`). Server
changes need a restart. Session files are plain JSONL and readable with any text editor, which is
often the fastest way to debug an event you did not expect.

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Limitations

- Only the active branch of a session is rendered; pi supports branching, but there is no branch
  visualization yet.
- The RPC `bash` command is intentionally unused — send prompts instead.
- No authentication. See [Remote access](#remote-access).
- No multi-user support: one person, one machine, many tabs.

## License

[MIT](LICENSE)
