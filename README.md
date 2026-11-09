# pi-web

A web UI for the [pi coding agent](https://github.com/earendil-works/pi), consistent with the
terminal experience, plus things the TUI does not give you: easy chat-history browsing and a
detailed inspector for every LLM/tool call (request arguments, live execution updates, full
responses, token usage and cost).

- No npm dependencies, no build step — a single Node server plus static frontend files.
- Talks to pi via its documented [RPC mode](https://github.com/earendil-works/pi/blob/main/docs/rpc.md)
  (`pi --mode rpc`) as a child process; the browser only ever talks to the local bridge server.

## Run

```bash
node server.js                      # serve the directory server.js was started in
node server.js --cwd ~/some/project # operate pi inside another project
node server.js --port 8080          # default port is 3210
node server.js --session-dir ~/custom/sessions
node server.js --pi /path/to/pi     # default: `pi` on PATH (PI_BIN env works too)
```

Then open <http://localhost:3210>.

## Features

- **Live streaming** — assistant text, thinking and tool-call arguments stream in as pi works,
  matching the TUI flow (`message_start/update/end`, `tool_execution_*`, retry and compaction events).
- **Parallel multi-session** — every session runs in its own `pi --mode rpc` subprocess.
  Switching to another session does not stop the current one: it keeps working in the
  background, and each browser tab attaches to exactly one process at a time (its commands
  and SSE events are routed per tab, so parallel tabs never interleave each other's output).
  The sidebar marks sessions that are open in a background process (a pulsing dot while a
  run is active) — click back any time to re-attach and pick up where it left off. Idle
  processes with no attached tab are reaped after 30 minutes.
- **Chat history** — the sidebar lists all sessions found under the pi session directory
  (`~/.pi/agent/sessions` by default), with title, message count, cost and last activity.
  Clicking a session attaches to its process (spawning `pi --session <file>` if none is live)
  and the transcript is rebuilt from the session's active branch (`get_entries` + leaf walk),
  including pre-compaction history. Process-per-session is deliberate: the in-process
  `switch_session` RPC invalidates captured extension contexts, which makes extensions that
  hold a stale `ctx` throw "This extension ctx is stale after session replacement" errors.
- **Recent sessions** — the sidebar's *Recent* tab lists all sessions across every
  workspace, most recent first, with a workspace chip on each row — one click switches
  straight to a session without drilling into its workspace first. The chosen tab persists.
- **Call details** — every tool call is a collapsible card showing:
  - the *request* (tool name + arguments),
  - live *execution updates* while the tool runs,
  - the *response* (text/image content, tool `details`, error flag, duration),
  - double-click a card (or click an assistant message's meta line) for the full raw JSON.
- **Assistant metadata** — model/provider, token usage (input/output/cache), cost, stop reason.
- **Session stats** — context-window usage %, session cost and token totals in the header.
- **Model & thinking controls** — switch models and thinking levels from the header.
- **Steering / follow-up** — sending while pi is running automatically queues the message
  (`streamingBehavior: "steer"`); queued items are shown above the transcript and each can be
  undone (×) — pi's RPC only clears the whole queue, so per-item undo re-queues the survivors —
  or the whole queue can be cleared at once.
- **Abort** — Stop button or `Esc` aborts the current run.
- **Extension dialogs** — RPC extension UI requests (`select`, `confirm`, `input`, `editor`)
  surface as modal dialogs; `notify` appears as a toast.

## Architecture

```
browser tab A ──SSE /api/events?client=A──►  server.js  ──JSONL stdio──►  pi --mode rpc (session 1)
             ──POST /api/cmd {client:A}─►      │
browser tab B ──SSE /api/events?client=B──►  process pool  ──JSONL stdio──►  pi --mode rpc (session 2)
             ──POST /api/cmd {client:B}─►      │
```

- `server.js` — keeps a pool of pi RPC subprocesses (one per open session), keyed by session
  file. Each browser tab registers a client id; `/api/open` attaches the tab to a process
  (spawning one if needed), and commands/events are routed by that id. Performs strict JSONL
  framing (LF-only, per the pi docs), correlates command responses by id, and lists/parses
  session JSONL files for the history sidebar.
- `public/` — dependency-free frontend (`index.html`, `app.js`, `style.css`).

## Not (yet) supported

- Branch visualization (`get_tree` is available on the server side; the UI shows the active branch).
- The RPC `bash` command (use prompts instead).
