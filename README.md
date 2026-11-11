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
  red deletions — followed by the raw request and response. Edits Cursor performs through its own
  activity tool render identically: the row shows the file and its `+N −M` counts, the popup title
  names the file, and the body opens on the colored diff even though Cursor reports the change as
  response text (or as a `diff` next to the counts) rather than as an `edit` result. The popup has a
  **Raw JSON** toggle and copies the full payload — the transcript itself never grows or scrolls, so
  the surrounding messages stay put.
- **Subagent runs are shown as their own transcript card**, not as an opaque tool row. When the
  `subagent` tool fans work out to child agents, the card head summarizes the run (agents involved,
  running/failed/done counts, wall time, tokens) and one row per child carries its live state and
  current activity — the tool it is running, its most recent tools and output, and its error when
  it fails. Clicking the card (or any child row) opens a run inspector: a summary strip with mode,
  child count, run id, duration, tokens and cost, then one panel per child with its task, live
  `now` activity, recent tools, recent output, final Markdown output, error, model/thinking level
  and an **open transcript** button that switches this tab to that child's own session. A run with
  some failed children is marked as a partial success rather than a failed tool call, and a
  background launch explains that its children are reported when the run completes. Both live
  progress (`tool_execution_update` snapshots) and the persisted result render from one normalized
  view model, so an open inspector keeps updating while the run is still going.
- **A skill invocation is shown as a call, not as its definition.** pi expands `/skill-name args`
  into one user message holding the whole `SKILL.md` inside a `<skill>` block, followed by the args.
  The transcript parses that apart and renders a `SKILL` chip with the skill's name, then the prompt
  you actually typed, with the definition folded behind a `definition · N lines` disclosure — a
  one-line request no longer scrolls for thousands of words you never wrote. The same parse feeds the
  session title (skill name plus prompt) and the prompt index, so a skill body is neither the title
  of every session that used it nor a match for every search.
- Assistant turns carry model, provider, input/output/cache tokens, cost and stop reason.
- Queued steering / follow-up messages appear in a dock directly above the composer, next to the
  running indicator; each can be undone individually or the whole queue cleared. The queue belongs
  to the attached session's agent process — switching sessions shows only that session's queue,
  and switching back restores it (the server re-sends the process's current queue when a tab
  re-attaches).
- `Esc` or **Stop** aborts the current run. The running/compacting indicator and **Stop** share one
  row in that same dock above the input — indicator on the left, **Stop** at its far right — so they
  are visible from where you are typing; if `pi` dies, the sidebar status line turns into a restart
  button.

**Sessions**

- The sidebar lists every session under the pi session directory with title, message count, cost
  and last activity. **Recent** is a flat, cross-project list; **Workspaces** is a two-level
  project → session view; **Favorites** is a flat list of the sessions you starred. The star beside
  the session details button in the header adds or removes the open session, and each row in the
  Favorites tab carries a star that removes it. Stars live in the browser's local storage, so they
  are per-browser and survive reloads; a starred session that no longer exists is skipped.
- Opening a session rebuilds the transcript from its active branch, including history from before
  a compaction, so you see the same conversation the terminal would. The switch is optimistic:
  the sidebar highlight and URL hash update immediately, sessions opened before in the same tab
  render from an in-memory cache and pull only entries appended since (via the `get_entries
  since` cursor), and unseen sessions show a "loading session…" notice while `pi` boots. Each
  session also remembers its scroll position: switching away and back returns you to the line you
  left, and a session that was following the stream resumes following it.
- Every open session runs in **its own `pi --mode rpc` process**. Switching sessions does not stop
  the previous one: it keeps running in the background (marked with a pulsing dot in the sidebar)
  and you can re-attach at any time. Each browser tab is bound to exactly one process, so parallel
  tabs never interleave each other's output.
- Sessions are addressable: the URL hash (`#ws=…&session=…`) survives a reload and can be
  bookmarked or shared between your own tabs.
- Idle processes with no attached tab are reaped after 30 minutes.
- The sidebar filter matches a session's title only. The search button beside the workspace button
  (or `Cmd/Ctrl`+`K`) opens a dialog with two tabs, **Prompts** first and selected by default:
  it searches only what you typed, so a word that recurs in tool output cannot bury the prompt
  that asked for it. **Everything** widens the same query to **every prompt, response, tool
  request and tool result in every workspace**: all typed terms must match (case-insensitive),
  newest occurrences first, and each hit shows its role, workspace, session and a snippet around
  the match. Switching tabs re-runs the query and puts the caret back in the search field. A
  subagent's child output is indexed too and labelled by agent (`subagent/reviewer`), so a
  reviewer's own wording is findable even when the parent's summary paraphrases it. Clicking
  a hit switches to that session and jumps to the occurrence — scrolling to the message, or
  opening the tool call's request/response popup. The system prompt and thinking blocks are left
  out of the index: identical in every session, they would bury every query under false hits.

**Controls**

- Switch model and thinking level from the header. The model list honors `enabledModels` from
  `~/.pi/agent/settings.json`. Both are in-app menus anchored below their button, with the height
  clamped to the space left under it, so they scroll instead of spilling off the window.
- A new session starts on the model configured in `~/.pi/agent/settings.json` (`defaultProvider`
  plus `defaultModel`), and a resumed session restarts on the last model its own file recorded, so
  the header never disagrees with the picker. Providers that register late — workbuddy resolves
  credentials and fetches its catalog after pi boots — would otherwise lose the race for pi's
  default and leave the session on an unrelated provider.
- Context-window usage (used / max / percent), session cost and token totals in the header —
  updated as each assistant message completes, not only when a run ends — with a session-details
  popover for the session title, full path, session id, cwd and token breakdown.
- The settings button at the right of the `pi running` status row opens a centered, near-full-window
  read-only inspector with three tabs: **Models** (every configured model with its provider/id,
  context window, output cap, per-million-token costs, API dialect, accepted input types and whether
  it is the current one), **Skills** (each skill pi discovered for this session, with scope, origin,
  description and `SKILL.md` path) and **MCPs**. The MCP tab asks the
  server to run `pi mcp list --json` in the session's workspace, so it shows live connection state,
  scope, exposure, transport, an auth provider, the tools each server offers as chips and the error
  or stderr tail of a failed one; reopen it or click the tab again to re-read.
- The list button in the header outlines every user prompt in the session; clicking an entry
  scrolls the transcript to that message. Each entry carries an indented second row that jumps to
  the run's summary — the concluding answer after the tool loop, landing on its text rather than on
  a turn whose tool cards can run for screens. A run that was interrupted (aborted or failed) has no
  summary, so it shows no such row.
- Attach images to the next message either way: drop files anywhere on the page, or use the
  image button beside the composer hint to pick them from the OS file dialog (both paths accept
  image files only and land in the same thumbnail row); click a thumbnail to enlarge it. Images
  already in a transcript prompt open the same way — click one to see it in a popup, then click the
  picture in that popup for the full-window viewer (the same two steps a tool-result image takes).
- `ArrowUp` / `ArrowDown` in the composer walk back and forward through previously sent
  prompts (terminal-style, kept in the browser's local storage, capped at 200 entries);
  the in-progress draft is restored when you arrow past the newest entry. Arrows keep
  their normal caret role while the cursor is inside a multi-line draft.
- The sidebar collapses to give the transcript the full window width; the state is
  remembered across reloads, and a button at the left edge of the header brings it back.
- Extension UI requests (`select`, `confirm`, `input`, `editor`) surface as real dialogs; `notify`
  becomes a toast.
- Clicking a tool call opens its request/response popup. A result that read a picture is shown as
  the image itself (click to enlarge into a full-window viewer layered over the popup, so the
  request/response stays readable underneath), not just as `{"content": "", "fileSize": …}` —
  whether pi returned the bytes inline or only reported the file size and path.
- Six independent palettes — mono (minimal grey/white), sky (fresh blue), grove (natural green),
  ember (energetic orange), elegant (soft violet) and night (dark) — picked from a swatch dropdown
  in the header, with the choice remembered across reloads; a resizable sidebar and keyboard
  focus styling. Every palette is built from one token set, so the palettes differ only in color:
  a neutral grouped page, white content surfaces, a single accent reserved for the primary action
  and the current selection, and a translucent functional layer (toolbar, sidebar, composer) that
  turns opaque under the system's Reduce Transparency setting.
- Tool-call state is read twice over: a rail on the row's leading edge and a worded chip, so
  `queued`, `running`, `done` and `error` are distinguishable without relying on color alone.

## Architecture

![pi-web architecture: browser tabs talk to one Node process over POST /api/* and the SSE event stream; that process keeps one pi --mode rpc subprocess per session, exchanging JSONL over stdio, and lists and searches the session directory those subprocesses write](docs/pi-web-architecture.png)

| File | Role |
| --- | --- |
| `server.js` | Process pool of `pi --mode rpc`, client routing, session listing, static files |
| `public/index.html` | Application shell |
| `public/app.js` | State, transcript reconciliation, event handling — no framework |
| `public/style.css` | Design tokens, the six palettes, layout |

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
| `GET /api/health` | Liveness, live process count, and tracked client count |
| `GET /api/events?client=<id>` | SSE stream of pi records for this client's session |
| `POST /api/open` | `{client, sessionFile?, cwd?}` — attach this client to a session; a fresh spawn is awaited until pi answers RPC |
| `POST /api/cmd` | `{client, type, …}` — forward a pi RPC command, await its response |
| `POST /api/ui-response` | Answer an extension UI request |
| `GET /api/image?path=<file>` | Serve an image a tool call referenced by path (PNG/JPEG/GIF/WebP only, verified by magic bytes, 16 MB cap) |
| `GET /api/sessions` | List sessions with live active/streaming flags |
| `GET /api/search?q=<terms>&limit=<n>&scope=<all\|prompts>` | Full-text search across every session's prompts, responses, tool requests and tool results; `scope=prompts` narrows it to user prompts; returns snippet hits plus a `truncated` flag |
| `GET /api/browse?path=<dir>` | Directory listing for the workspace picker |
| `GET /api/mcp?client=<id>` | MCP server state as `pi mcp list --json` reports it, run in that client's session workspace; `{ servers, errors }`, where a disconnected server still returns 200 with its state and error |

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
- `GET /api/image` is the one route that reads an arbitrary absolute path, because a tool result can
  reference a picture anywhere on disk. It is restricted to image bytes: the content must sniff as
  PNG, JPEG, GIF or WebP, the size is capped at 16 MB, and it is served with `no-store`. Anything
  else — text, JSON, SVG — is refused with 415, so the endpoint cannot be used as a general file
  reader.
- Session listing walks only the configured session directory.
- Cross-session search reads only the same session directory, returns snippets and never writes.
  Parsed indexes live in a byte-capped in-memory cache and are keyed by each file's mtime and size.
- Session summaries for the sidebar are cached per file under the same mtime+size key, so polling
  re-parses only the sessions that changed instead of re-reading the whole corpus.
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
and assets are served, the HTTP API answers, search reaches every channel of a fixture session and
skips the system prompt and thinking blocks, foreign `Host`/`Origin` requests are rejected, path
traversal cannot escape `public/`, and malformed commands return a clean 4xx. It also pins the
static-asset revalidation (`ETag` → `304`) and the client bound that keeps closed event streams from
accumulating. It runs against a throwaway session directory, needs no agent credentials, and — when
`pi` happens to be installed — also checks the agent round-trip, otherwise it skips that check.

Frontend changes apply on reload (static files are served with `Cache-Control: no-cache` plus an
`ETag`, so an unchanged asset revalidates as a bodyless `304` instead of being re-sent). Server
changes need a restart. Session files are plain JSONL and readable with any text editor, which is
often the fastest way to debug an event you did not expect.

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Limitations

- Only the active branch of a session is rendered; pi supports branching, but there is no branch
  visualization yet.
- The RPC `bash` command is intentionally unused — send prompts instead.
- No authentication. See [Remote access](#remote-access).
- No multi-user support: one person, one machine, many tabs.
- Cross-session search indexes the text of every message in every session file, not only the active
  branch. History from before a compaction is reachable (and rendered), but a message on a branch
  that was branched away from has no transcript row: clicking such a hit reports that it is not on
  the active branch instead of jumping.

## License

[MIT](LICENSE)
