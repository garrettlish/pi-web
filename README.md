# pi-web — DEPRECATED

> **This repository is deprecated and archived.**
> Use **[pi-ui](https://github.com/garrettlish/pi-ui)** instead.

`pi-web` was a local web UI for the [pi coding agent](https://github.com/earendil-works/pi) that
bridged a documented `pi --mode rpc` subprocess over SSE and JSON.

## Why it was replaced

[`pi-ui`](https://github.com/garrettlish/pi-ui) is the same UI with the **pi SDK embedded in-process**
instead of driven over RPC. The frontend and the HTTP surface are unchanged — what changed is the
backend, and with it every cost that came from running one subprocess per session:

| | `pi --mode rpc` (one process per session) | pi-ui (in-process SDK) |
| --- | --- | --- |
| New session | 1.33 s | **0.036 s** |
| Open a 30 MB session | 1.39 s | **0.75 s** |
| Read a 30 MB transcript | 2.80 s / 30.5 MB | **0.005 s / 1.9 MB** |
| Ten sessions in one workspace | ten process boots | one workspace build, ten × 46 ms |

Three separate costs were measured and removed:

- **Booting the agent.** ~0.9 s of every process start is `createAgentSessionServices()`
  discovering extensions, skills and MCP servers — work that depends only on the working directory.
  pi-ui builds it once per workspace and reuses it.
- **Shipping the transcript.** One real session was 28.7 MB of base64 PNG data across 36 image
  blocks. pi-ui keeps the bytes on the server and sends an `imageId` placeholder the browser fetches
  only when a picture is on screen, cutting the payload from 30.5 MB to 1.9 MB.
- **Framing the pipe.** A 30 MB JSONL line restarted the record scan from index 0 on every chunk —
  a consequence of the previous cost, and gone entirely once there is no pipe.

## Migrating

Nothing to port. pi-ui runs from a bare checkout:

```bash
git clone https://github.com/garrettlish/pi-ui.git
cd pi-ui
node server.js
```

Then open <http://localhost:3220>. Sessions, follow-ups and settings under `~/.pi` are read by both
projects, so existing history appears as-is. The one flag that moved is the default port (`3210` →
`3220`); every other flag keeps its name, and `--sdk <dir>` is new for pinning the SDK package.

## This repository

Archived, read-only, kept for its history and for the design notes in earlier commits. Issues and
pull requests should go to [garrettlish/pi-ui](https://github.com/garrettlish/pi-ui).

## License

[MIT](LICENSE)
