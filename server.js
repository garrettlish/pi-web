#!/usr/bin/env node
/**
 * pi-web: a web UI bridge for the pi coding agent, running `pi --mode rpc`.
 *
 * Usage:
 *   node server.js [--port 3210] [--host 127.0.0.1] [--cwd <project-dir>]
 *                  [--session-dir <dir>] [--followup-dir <dir>]
 *                  [--pi <pi-bin>] [--allow-remote]
 *
 * Security model: this process can start the agent, which can run shell
 * commands as you. It binds to loopback and rejects requests whose Host or
 * Origin is not local, so other web pages cannot drive it (DNS rebinding /
 * CSRF). Binding elsewhere, or --allow-remote, turns those guards off.
 *
 * No npm dependencies. Node >= 18.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, openSync, readSync, closeSync, createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HELP = `pi-web — a local web UI for the pi coding agent

Usage:
  pi-web [options]
  node server.js [options]

Options:
  --port <n>          Port to listen on (default: 3210, env PI_WEB_PORT)
  --host <addr>       Address to bind (default: 127.0.0.1, env PI_WEB_HOST).
                      Binding a non-loopback address enables remote access.
  --cwd <dir>         Directory the agent works in (default: current directory)
  --session-dir <dir> Where pi stores session files
                      (default: ~/.pi/agent/sessions, env PI_CODING_AGENT_SESSION_DIR)
  --followup-dir <dir>
                      Where Follow-ups are saved (default: ~/.pi/followups,
                      env PI_WEB_FOLLOWUP_DIR)
  --pi <path>         pi executable to spawn (default: "pi" on PATH, env PI_BIN)
  --allow-remote      Disable the localhost-only request guards while still
                      binding to 127.0.0.1 (for reverse proxies; see README)
  -h, --help          Show this help
  -v, --version       Show the version

Environment:
  PI_WEB_PORT, PI_WEB_HOST, PI_WEB_CWD, PI_BIN,
  PI_CODING_AGENT_SESSION_DIR, PI_WEB_FOLLOWUP_DIR, PI_WEB_ALLOW_REMOTE
`;

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (process.argv.includes("-v") || process.argv.includes("--version")) {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const PORT = Number(argValue("--port", process.env.PI_WEB_PORT || 3210));
const HOST = argValue("--host", process.env.PI_WEB_HOST || "127.0.0.1");
const CWD = path.resolve(argValue("--cwd", process.env.PI_WEB_CWD || process.cwd()));
const SESSION_DIR = path.resolve(
  argValue("--session-dir", process.env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), ".pi", "agent", "sessions"))
);
const PI_BIN = argValue("--pi", process.env.PI_BIN || "pi");

/** localhost names/IPs — anything else means the operator opted into remote serving */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

// Binding to a non-loopback address is itself the opt-in to remote serving, so
// it does not need a second flag. Requests are guarded while we are loopback-only.
const ALLOW_REMOTE =
  process.argv.includes("--allow-remote") ||
  process.env.PI_WEB_ALLOW_REMOTE === "1" ||
  !isLoopbackHost(HOST);

// ---------------------------------------------------------------------------
// pi RPC subprocess pool
// ---------------------------------------------------------------------------
// One pi process = one open session. Multiple processes run concurrently;
// each browser tab (client) is attached to exactly one at a time and all of
// its commands/events route through that process. File-backed sessions are
// keyed "file:<abs path>" so any tab can attach to an already-running session
// instead of spawning a duplicate; brand-new sessions get "slot:<uuid>" keys
// until pi reports the file it created (then a file alias is registered).

/** key -> PiProc */
const procs = new Map();
/** abs session file -> proc key (live processes only) */
const fileAlias = new Map();
/** clientId -> { res (SSE response), key (attached proc key), detachedAt } */
const clients = new Map();
/** procs with no viewer and no run are stopped after this idle time */
const IDLE_REAP_MS = 30 * 60 * 1000;
/** How long a client entry survives without an SSE stream. EventSource
 *  reconnects on its own with the same id, so an entry cannot be dropped the
 *  moment its stream closes — that would lose the process attachment and make
 *  the reconnected tab's commands fail with 503. Past this window the tab is
 *  gone. Without this sweep every page load left an entry behind forever, and
 *  every broadcast (one per pi event) walked all of them. */
const CLIENT_GRACE_MS = 60 * 1000;
/** Hard bound on tracked clients, so a pathological churn of page loads cannot
 *  grow the map faster than the grace period drains it. */
const CLIENTS_MAX = 200;

function clientEntry(id) {
  let c = clients.get(id);
  if (!c) {
    // Enforce the bound at registration: new connections are exactly when the
    // map grows, and waiting for the 25 s heartbeat would let a burst of page
    // loads past the cap.
    if (clients.size >= CLIENTS_MAX) sweepClients(Date.now(), CLIENTS_MAX - 1);
    c = { res: null, key: null, detachedAt: 0 };
    clients.set(id, c);
  }
  return c;
}

/** Drop client entries whose stream has been gone past the grace period, then
 *  enforce a hard bound by evicting the oldest detached entries. `target` is
 *  the size to get down to — callers about to add an entry pass one less. */
function sweepClients(now = Date.now(), target = CLIENTS_MAX) {
  for (const [id, c] of clients) {
    if (!c.res && c.detachedAt && now - c.detachedAt > CLIENT_GRACE_MS) clients.delete(id);
  }
  if (clients.size <= target) return;
  const detached = [...clients].filter(([, c]) => !c.res).sort((a, b) => a[1].detachedAt - b[1].detachedAt);
  for (const [id] of detached) {
    if (clients.size <= target) break;
    clients.delete(id);
  }
}

/** live SSE responses attached to a proc key */
function clientsOn(key) {
  const out = [];
  for (const c of clients.values()) if (c.key === key && c.res) out.push(c.res);
  return out;
}

class PiProc {
  constructor(key, { cwd, sessionFile }) {
    this.key = key;
    this.cwd = cwd;
    this.sessionFile = sessionFile || null;
    this.proc = null;
    this.buffer = "";
    this.seq = 0;
    /** id -> { resolve, timer } */
    this.pending = new Map();
    this.isStreaming = false;
    this.lastActivity = Date.now();
    /** Last queue snapshot from the event stream. pi emits queue_update only
     *  when the queue changes and get_state carries no queue text, so without
     *  this a tab that switches away and back would show an empty dock while
     *  the process still holds those messages. */
    this.queued = { steering: [], followUp: [] };
  }

  /** Hand a client that just (re)attached the queue as it stands now. Attaching
   *  is the only moment the client cannot already know it: every change is
   *  broadcast, so a stale dock only survives a detach. */
  sendQueueSnapshot(res) {
    const { steering, followUp } = this.queued;
    if (!steering.length && !followUp.length) return;
    try {
      res.write(`data: ${JSON.stringify({ type: "queue_update", steering, followUp })}\n\n`);
    } catch {
      // the close handler on the SSE request cleans the entry up
    }
  }

  broadcast(record) {
    const data = `data: ${JSON.stringify(record)}\n\n`;
    for (const res of clientsOn(this.key)) {
      try {
        res.write(data);
      } catch {
        // the close handler on the SSE request cleans the entry up
      }
    }
  }

  handleRecord(record) {
    this.lastActivity = Date.now();
    if (record && record.type === "response" && record.id && this.pending.has(record.id)) {
      const p = this.pending.get(record.id);
      this.pending.delete(record.id);
      clearTimeout(p.timer);
      p.resolve(record);
      return;
    }
    if (record && record.type === "agent_start") this.isStreaming = true;
    else if (record && (record.type === "agent_settled" || record.type === "agent_end")) this.isStreaming = false;
    // Remember the queue while broadcasting: pi sends it only on change, so
    // this copy is the only way a re-attaching tab can learn what is pending.
    if (record && record.type === "queue_update") {
      this.queued = { steering: record.steering || [], followUp: record.followUp || [] };
    }
    // Session events, extension UI requests, bash updates -> attached clients
    this.broadcast(record);
  }

  start() {
    if (this.proc) return this.proc;
    const args = ["--mode", "rpc"];
    if (this.sessionFile) args.push("--session", this.sessionFile);
    // A new session starts on the configured default; a resumed one keeps the
    // model its own file recorded.
    const startupModel = this.sessionFile ? sessionModel(this.sessionFile) : defaultModelSetting();
    if (startupModel) args.push("--model", startupModel);
    console.log(`[pi-web] starting: ${PI_BIN} ${args.join(" ")} (cwd=${this.cwd})`);
    const p = spawn(PI_BIN, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = p;
    this.buffer = "";

    p.stdout.on("data", (chunk) => {
      if (this.proc !== p) return; // retired process — ignore stale output
      this.buffer += chunk.toString("utf8");
      // Strict JSONL framing: split on LF only (docs warn against readline,
      // which also splits on U+2028/U+2029).
      for (;;) {
        const idx = this.buffer.indexOf("\n");
        if (idx < 0) break;
        let line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (err) {
          console.error("[pi-web] unparseable stdout record:", line.slice(0, 200), err.message);
          continue;
        }
        try {
          this.handleRecord(record);
        } catch (err) {
          console.error("[pi-web] record handler error:", err);
        }
      }
    });

    p.stderr.on("data", (d) => process.stderr.write(`[pi] ${d}`));

    p.on("error", (err) => {
      console.error("[pi-web] failed to spawn pi:", err.message);
      // spawn failures (e.g. ENOENT) never emit "exit" — tear the pool entry
      // down here too or it leaks as a dead process forever
      if (this.proc !== p) return;
      this.broadcast({ type: "server", event: "pi_error", error: err.message });
      this.teardown(null, "error");
    });

    p.on("exit", (code, signal) => {
      console.log(`[pi-web] pi exited (code=${code} signal=${signal}) key=${this.key}`);
      // Only tear down if this is still the current process handle — a
      // deliberately stopped process may exit after teardown already ran.
      if (this.proc !== p) return;
      this.teardown(code, signal);
    });

    // Writing to a closed stdin would otherwise raise an unhandled 'error' event.
    p.stdin.on("error", (err) => {
      console.error("[pi-web] pi stdin error:", err.message);
    });

    return p;
  }

  /** Unregister from the pool, reject pending commands, notify attached clients. */
  teardown(code, signal) {
    this.proc = null;
    this.buffer = "";
    for (const [, pr] of this.pending) {
      clearTimeout(pr.timer);
      try {
        pr.reject(new Error("pi process exited"));
      } catch {}
    }
    this.pending.clear();
    this.isStreaming = false;
    // The queue lived in the process, so a restart must not replay it.
    this.queued = { steering: [], followUp: [] };
    this.broadcast({ type: "server", event: "pi_exit", code, signal });
    procs.delete(this.key);
    for (const [file, key] of fileAlias) if (key === this.key) fileAlias.delete(file);
    for (const c of clients.values()) if (c.key === this.key) c.key = null;
  }

  stop() {
    const p = this.proc;
    if (!p) return;
    // Detach immediately: from now on every command must go elsewhere.
    this.teardown(null, "stopped");
    try {
      p.stdin.end();
    } catch {}
    // Grace period for a clean exit, then make sure it is really gone.
    setTimeout(() => {
      if (p.exitCode === null) p.kill("SIGTERM");
    }, 3000).unref();
  }

  /** Send a command to this pi and resolve with its correlated response. */
  sendCommand(cmd, timeoutMs = 120000) {
    if (!this.proc) this.start();
    const id = `web-${++this.seq}-${randomUUID().slice(0, 8)}`;
    const record = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for response to ${cmd.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify(record)}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`failed to write to pi stdin: ${err.message}`));
      }
    });
  }
}

/** A "slot" proc learns the real session file pi created (on first prompt)
 *  and becomes attachable by path — closing the race where another tab would
 *  spawn a second process for the same file. */
function learnSessionFile(proc, file) {
  if (!file || !proc.key.startsWith("slot:") || proc.sessionFile) return;
  const abs = path.resolve(file);
  if (fileAlias.has(abs)) return; // already owned by another live proc
  proc.sessionFile = abs;
  fileAlias.set(abs, proc.key);
  console.log(`[pi-web] slot ${proc.key} -> session ${abs}`);
}

/** Attach `client` to the process for `sessionFile` (spawning it if needed),
 *  or to a brand-new process. Never stops other sessions. */
async function openSession({ client, sessionFile, cwd }) {
  const c = clientEntry(client);
  let key;
  if (sessionFile) {
    const abs = path.resolve(sessionFile);
    key = fileAlias.get(abs) || `file:${abs}`;
  } else {
    key = `slot:${randomUUID()}`;
  }
  let proc = procs.get(key);
  let spawned = false;
  if (!proc) {
    let pcwd;
    if (sessionFile) {
      // Session switch: the session header records the cwd it ran in — trust it
      // over the client so a stale cached app.js can never start pi in the
      // wrong directory.
      const headerCwd = sessionCwd(sessionFile);
      pcwd = headerCwd || (typeof cwd === "string" && cwd ? path.resolve(cwd) : CWD);
    } else {
      // New session: no header exists yet, so honor the client's cwd.
      pcwd = typeof cwd === "string" && cwd ? path.resolve(cwd) : CWD;
    }
    proc = new PiProc(key, { cwd: pcwd, sessionFile: sessionFile ? path.resolve(sessionFile) : null });
    procs.set(key, proc);
    if (sessionFile) fileAlias.set(path.resolve(sessionFile), key);
    proc.start();
    spawned = true;
  }
  // Resolve /api/open only once a fresh spawn answers RPC — otherwise the
  // client's ready-poll adds up to its 250ms tick on every cold open.
  if (spawned) await waitPiRpcReady(proc);
  c.key = key;
  if (c.res) {
    try {
      c.res.write(`data: ${JSON.stringify({ type: "server", event: "hello" })}\n\n`);
    } catch {}
    proc.sendQueueSnapshot(c.res);
  }
  return { ok: true, sessionFile: proc.sessionFile, cwd: proc.cwd };
}

/** Wait until a freshly spawned pi answers an RPC. Bounded: on timeout or
 *  process death we return anyway — the client's waitPiReady stays as the
 *  backstop and the pi_error/pi_exit broadcasts report the failure. */
async function waitPiRpcReady(proc, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (proc.proc && Date.now() < deadline) {
    try {
      await proc.sendCommand({ type: "get_state" }, 5000);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// Reap idle processes: no attached browser tab, nothing streaming, quiet for a while.
setInterval(() => {
  for (const [key, proc] of procs) {
    if (clientsOn(key).length || proc.isStreaming) continue;
    if (Date.now() - proc.lastActivity > IDLE_REAP_MS) {
      console.log(`[pi-web] reaping idle pi (key=${key})`);
      proc.stop();
    }
  }
}, 60000).unref();

// ---------------------------------------------------------------------------
// Session cwd: the session header line records the cwd pi ran in, so a session
// switch can always restore the right directory — even when the client sends
// no cwd (stale cached app.js) or sends a wrong one.
// ---------------------------------------------------------------------------

/** Read the cwd recorded in a session file's `{"type":"session",...}` header line. */
function sessionCwd(file) {
  try {
    const buf = Buffer.alloc(4096);
    const f = openSync(file, "r");
    try {
      const { bytesRead } = readSync(f, buf, 0, buf.length, 0);
      const header = JSON.parse(buf.toString("utf8", 0, bytesRead).split("\n")[0]);
      return typeof header.cwd === "string" && header.cwd ? path.resolve(header.cwd) : null;
    } finally {
      closeSync(f);
    }
  } catch {
    return null;
  }
}

/** The model a session file last recorded, as `provider/id`, or null.
 *
 *  pi restores a resumed session's model from its `model_change` entries, but
 *  only through `modelRuntime.getModel()`, which needs the provider registered
 *  at that moment. A lazy provider such as workbuddy is not registered yet, so
 *  `--session <file>` silently opens on whatever provider did register first
 *  and every resume of a workbuddy session lands on the wrong model. Passing
 *  the recorded model back as `--model` closes that gap.
 *
 *  Scanned in chunks, not read whole: a session whose transcript carries large
 *  tool output reaches tens of megabytes. The last model_change wins, so the
 *  whole file is walked rather than only its head or tail — the entry can sit
 *  anywhere in between once output is appended after it. */
function sessionModel(file) {
  let f;
  let decoder;
  try {
    f = openSync(file, "r");
    decoder = new StringDecoder("utf8");
    const buf = Buffer.alloc(64 * 1024);
    let carry = "";
    let last = null;
    const scan = (line) => {
      if (!line || !line.includes("model_change")) return;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return; // a partially written trailing line is normal for a live session
      }
      if (e.type === "model_change" && e.provider && e.modelId) last = `${e.provider}/${e.modelId}`;
    };
    for (;;) {
      const n = readSync(f, buf, 0, buf.length, null);
      if (!n) break;
      const text = carry + decoder.write(buf.subarray(0, n));
      const lines = text.split("\n");
      carry = lines.pop(); // the unterminated tail continues in the next chunk
      for (const line of lines) scan(line);
    }
    scan(carry + decoder.end());
    return last;
  } catch {
    return null;
  } finally {
    if (f !== undefined) {
      try {
        closeSync(f);
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Configured models: filter the catalog down to settings.enabledModels patterns
// (same semantics as pi's model scope: case-insensitive globs matched against
// "provider/id" or bare "id"; optional ":level" and "@context" suffixes ignored)
// ---------------------------------------------------------------------------

const PI_SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "settings.json");

function readPiSettings() {
  try {
    return JSON.parse(readFileSync(PI_SETTINGS_FILE, "utf8"));
  } catch {
    return null;
  }
}

function enabledModelPatterns() {
  const settings = readPiSettings();
  return Array.isArray(settings?.enabledModels) ? settings.enabledModels.filter((p) => typeof p === "string") : [];
}

/** The configured startup model as `provider/id`, or null.
 *
 *  Passed to a NEWLY spawned pi as `--model`. Without it pi resolves its startup
 *  model while extension providers are still registering — a lazy provider such
 *  as workbuddy (credential resolve + catalog fetch) is not in the catalog yet,
 *  so `findInitialModel` falls through to any model that already is, and the
 *  session opens on a provider the model picker does not even list. Re-registering
 *  the provider later does not repair that: pi only refreshes the CURRENT
 *  provider/model from the registry. A resumed session uses its own recorded
 *  model instead (see sessionModel). */
function defaultModelSetting() {
  const settings = readPiSettings();
  const provider = settings?.defaultProvider;
  const model = settings?.defaultModel;
  return typeof provider === "string" && provider && typeof model === "string" && model ? `${provider}/${model}` : null;
}

function patternMatches(pattern, provider, id) {
  let p = pattern.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i, "");
  const at = p.indexOf("@");
  if (at > 0 && /^[\d.,]+[kKmM]?$/.test(p.slice(at + 1))) p = p.slice(0, at);
  const source = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const re = new RegExp(`^${source}$`, "i");
  return re.test(`${provider}/${id}`) || re.test(id);
}

function filterConfiguredModels(models, patterns) {
  if (!patterns.length) return models;
  const filtered = models.filter((m) => patterns.some((p) => patternMatches(p, m.provider, m.id)));
  return filtered.length ? filtered : models; // never leave the dropdown empty on unmatched patterns
}

// ---------------------------------------------------------------------------
// MCP server state (resources panel)
// ---------------------------------------------------------------------------

const MCP_LIST_TIMEOUT_MS = 20000;

/** Run `pi mcp list --json` and return its parsed report.
 *
 *  pi keeps this command out of RPC mode: connection state, per-server tools
 *  and the tail of a failing server's stderr only exist in the shell command,
 *  and it works without a session. A disconnected server makes the command
 *  exit 1 while still printing valid JSON, so the exit code is not the test —
 *  parseable output is. Arguments are passed as an array, never through a
 *  shell, and the child inherits no stdin so it cannot block on a prompt.
 *
 *  `cwd` matters: a project `.pi/mcp.json` is only read from there, so the run
 *  uses the workspace of the session the panel is describing. */
function runPiMcpList(cwd = CWD) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(PI_BIN, ["mcp", "list", "--json"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ servers: [], errors: [{ message: err.message }], unavailable: true });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, MCP_LIST_TIMEOUT_MS);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGKILL"); // a wedged server must not grow this forever
    });
    child.stderr.on("data", (c) => {
      stderr = (stderr + c.toString("utf8")).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ servers: [], errors: [{ message: err.message }], unavailable: true });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          servers: Array.isArray(parsed.servers) ? parsed.servers : [],
          errors: Array.isArray(parsed.errors) ? parsed.errors : [],
          note: parsed.note,
        });
      } catch {
        resolve({
          servers: [],
          errors: [{ message: `${signal ? `pi mcp list was killed (${signal})` : `pi mcp list exited ${code}`}${stderr ? `: ${stderr.trim()}` : ""}` }],
          unavailable: true,
        });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Session history listing
// ---------------------------------------------------------------------------

function userText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/** pi expands a skill invocation into a user message whose text is its whole
 *  SKILL.md wrapped in a `<skill name="…" location="…">` block, followed by the
 *  prompt the user typed. Format mirrors parseSkillBlock in pi's own session
 *  code, so a change there degrades to the raw text instead of mis-parsing. */
function parseSkillBlock(text) {
  const match = String(text || "").match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return { name: match[1], location: match[2], content: match[3], userMessage: match[4] ? match[4].trim() : "" };
}

/** The block the composer appends for an attached document. Both sides agree on
 *  this shape (see `attachedFileBlock` in public/app.js), and the server only
 *  ever needs to find it: to keep its body out of titles and search results. */
const ATTACHED_FILE_BLOCK = /<attached-file name="([^"]*)"[^>]*>\n[\s\S]*?\n<\/attached-file>/g;
const unescapeAttr = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** A user message's own words. A skill body is instruction context pi injected
 *  on the user's behalf — never something they typed — so titles and search
 *  index the skill's name and the prompt that followed it. Indexing the body
 *  made one skill definition match every query in every session that used it.
 *  A document the composer attached is the same situation: its text is what the
 *  model read, so it is replaced by the file name and the body stays out of the
 *  title and the index. */
function promptText(content) {
  const raw = userText(content).replace(ATTACHED_FILE_BLOCK, (_, name) => `[attached: ${unescapeAttr(name)}]`);
  const skill = parseSkillBlock(raw);
  return skill ? [skill.name, skill.userMessage].filter(Boolean).join("\n") : raw;
}

/** Session files under the configured directory, newest first, with their stat.
 *  Shared by the sidebar listing and the search index so both see one corpus
 *  (and one directory walk) instead of drifting apart. */
async function sessionFilesWithStats(limit = 400) {
  const files = [];
  async function walk(dir, depth) {
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (d.isFile() && d.name.endsWith(".jsonl")) files.push(p);
    }
  }
  await walk(SESSION_DIR, 0);

  const stats = await Promise.all(
    files.map(async (f) => {
      try {
        return { f, st: await fsp.stat(f) };
      } catch {
        return null;
      }
    })
  );

  return stats.filter(Boolean).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, limit);
}

/** One-line summary of a session file for its sidebar row.
 *  Assistant-message cost and `usage` entries are summed together on purpose:
 *  pi documents a `usage` entry as model-attributed usage that is *not* part of
 *  an assistant message (e.g. cache warming), so both contribute to the total
 *  without overlapping. */
function summarizeSessionText(text, st, f) {
  let header = null;
  let name = null;
  let title = null;
  let messages = 0;
  let cost = 0;
  let lastTs = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a partially written trailing line is normal for a live session
    }
    if (e.type === "session") header = e;
    else if (e.type === "session_info" && e.name) name = e.name;
    else if (e.type === "message") {
      messages++;
      lastTs = e.timestamp;
      if (title === null && e.message?.role === "user") title = promptText(e.message.content);
      if (e.message?.role === "assistant" && e.message?.usage?.cost) cost += e.message.usage.cost.total || 0;
    } else if (e.type === "usage" && e.usage?.cost) {
      cost += e.usage.cost.total || 0;
    }
  }
  if (!header) return null;
  return {
    file: f,
    id: header.id,
    cwd: header.cwd,
    timestamp: header.timestamp,
    lastTimestamp: lastTs,
    name: name || null,
    title: (title || "").slice(0, 120),
    messages,
    cost: Number(cost.toFixed(4)),
    mtime: st.mtimeMs,
  };
}

/** Per-file summaries, keyed by path and validated by mtime+size. Session files
 *  are append-mostly, so the sidebar only re-parses the files that changed
 *  instead of re-reading the whole (often hundreds of megabytes) corpus on
 *  every poll. */
const sessionSummaryCache = new Map();

async function sessionSummary(f, st) {
  const key = `${st.mtimeMs}:${st.size}`;
  const cached = sessionSummaryCache.get(f);
  if (cached && cached.key === key) return cached.summary;
  let summary = null;
  try {
    summary = summarizeSessionText(await fsp.readFile(f, "utf8"), st, f);
  } catch {
    summary = null;
  }
  sessionSummaryCache.set(f, { key, summary });
  return summary;
}

async function listSessions(limit = 400) {
  const usable = await sessionFilesWithStats(limit);
  const sessions = await Promise.all(usable.map(({ f, st }) => sessionSummary(f, st)));

  // Sessions get deleted and pruned; drop their summaries so the cache cannot
  // grow without bound over a long-running server.
  const live = new Set(usable.map(({ f }) => f));
  for (const file of sessionSummaryCache.keys()) if (!live.has(file)) sessionSummaryCache.delete(file);

  return sessions.filter(Boolean);
}

// listSessions walks the whole session dir; cache briefly so several tabs
// polling /api/sessions share one walk. The walk is cheap now that parsing is
// cached per file, so the TTL only has to absorb simultaneous polls.
let sessionsCache = { at: 0, promise: null };
function listSessionsCached() {
  if (sessionsCache.promise && Date.now() - sessionsCache.at < 2000) return sessionsCache.promise;
  sessionsCache = { at: Date.now(), promise: listSessions() };
  return sessionsCache.promise;
}

/** per-file live status from the process pool, merged into /api/sessions */
function activeStatus() {
  const map = new Map(); // abs session file -> { active, streaming }
  for (const proc of procs.values()) {
    if (proc.sessionFile) map.set(proc.sessionFile, { active: true, streaming: proc.isStreaming });
  }
  return map;
}

async function sessionsWithStatus() {
  const [sessions, active] = await Promise.all([listSessionsCached(), Promise.resolve(activeStatus())]);
  for (const s of sessions) {
    const a = active.get(path.resolve(s.file));
    s.active = !!(a && a.active);
    s.streaming = !!(a && a.streaming);
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------
// A follow-up is a run's summary the user kept, stored as one plain JSON file
// under FOLLOWUP_DIR. It is deliberately independent of the session it came
// from: reading a follow-up must not spawn pi, replay a transcript, or even
// need the session file to still exist — the answer is already here. The id is
// a UUID, so it is also the file name and the only thing a client may address.
const FOLLOWUP_DIR = path.resolve(
  argValue("--followup-dir", process.env.PI_WEB_FOLLOWUP_DIR || path.join(os.homedir(), ".pi", "followups"))
);
const FOLLOWUP_ID = /^[A-Za-z0-9_-]{1,80}$/;
const FOLLOWUP_TEXT_MAX = 2 * 1024 * 1024;
const FOLLOWUP_LIST_MAX = 500;
/** per-file metadata, keyed by path and validated by mtime+size: listing reads
 *  every follow-up once, then only the ones that changed */
const followupCache = new Map();

function followupPath(id) {
  return path.join(FOLLOWUP_DIR, `${id}.json`);
}

function followupMeta(rec) {
  return {
    id: rec.id,
    title: rec.title || "",
    createdAt: rec.createdAt || 0,
    ts: rec.ts ?? null,
    cwd: rec.cwd || null,
    sessionFile: rec.sessionFile || null,
    sessionTitle: rec.sessionTitle || null,
    chars: typeof rec.text === "string" ? rec.text.length : 0,
  };
}

function stringField(value, max) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

async function listFollowups() {
  let names;
  try {
    names = await fsp.readdir(FOLLOWUP_DIR);
  } catch {
    return []; // the directory only appears once something is saved
  }
  const list = [];
  const live = new Set();
  for (const name of names) {
    const match = name.match(/^([A-Za-z0-9_-]{1,80})\.json$/);
    if (!match) continue;
    const file = followupPath(match[1]);
    live.add(file);
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    const cached = followupCache.get(file);
    if (cached && cached.key === key) {
      list.push(cached.meta);
      continue;
    }
    try {
      const rec = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!rec || rec.id !== match[1]) continue; // a file that is not ours
      const meta = followupMeta(rec);
      followupCache.set(file, { key, meta });
      list.push(meta);
    } catch {
      followupCache.delete(file); // a truncated write is not a follow-up
    }
  }
  for (const file of followupCache.keys()) if (!live.has(file)) followupCache.delete(file);
  return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, FOLLOWUP_LIST_MAX);
}

async function readFollowup(id) {
  const rec = JSON.parse(await fsp.readFile(followupPath(id), "utf8"));
  if (!rec || rec.id !== id) throw new Error("not a follow-up");
  return rec;
}

/** write-then-rename: a half-written file must never be listed as a follow-up,
 *  and a rename is atomic within the directory */
async function writeFollowup(rec) {
  await fsp.mkdir(FOLLOWUP_DIR, { recursive: true });
  const target = followupPath(rec.id);
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  await fsp.rename(temp, target);
}

// ---------------------------------------------------------------------------
// Cross-session search
// ---------------------------------------------------------------------------
// The sidebar filter only sees each session's title (its first user prompt).
// This index keeps the searchable text of every message — user prompts, model
// responses, tool requests and tool results — so one query can reach any
// occurrence in any workspace. Session files are append-mostly JSONL, so a
// file is re-parsed only when its mtime or size changed; parsed text is kept
// in a byte-capped LRU because a single tool result can be several megabytes.

const SEARCH_MAX_HITS = 200;
/** Text kept per record. Matches the popup's own display cap (MAX_TOOL_TEXT in
 *  app.js), so search reaches exactly what the popup can show — a record is
 *  never unfindable in the part a user would actually read. */
const SEARCH_RECORD_MAX_CHARS = 200000;
/** Parsed-text budget for the index cache, counted in text characters. Heap use
 *  is a few times this, so it is kept well below the corpus a normal install
 *  holds (a few hundred sessions, a few megabytes of text) to bound a machine
 *  with enormous tool output; eviction is LRU, one file at a time. */
const SEARCH_CACHE_MAX_BYTES = 24 * 1024 * 1024;

/** abs file -> { key, records, bytes }; Map order doubles as LRU order */
const searchCache = new Map();
let searchCacheBytes = 0;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Searchable records of one session entry. The system prompt is skipped on
 *  purpose: it is identical in every session and would bury every query under
 *  false hits. Thinking blocks are skipped too — they are model scratch space,
 *  not something the user asked for or the agent reported. */
function searchRecordsOf(entry) {
  if (!entry || entry.type !== "message") return [];
  const m = entry.message;
  if (!m || m.role === "system") return [];
  const blocks = Array.isArray(m.content) ? m.content : [];
  const out = [];
  const textBlocks = () => blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");

  if (m.role === "user") {
    const text = promptText(typeof m.content === "string" ? m.content : textBlocks());
    if (text.trim()) out.push({ role: "user", text });
  } else if (m.role === "assistant") {
    for (const b of blocks) {
      if (b.type === "text" && b.text) {
        out.push({ role: "assistant", text: b.text });
      } else if (b.type === "toolCall") {
        let args = "";
        try {
          args = JSON.stringify(b.arguments || {});
        } catch {
          args = String(b.arguments || "");
        }
        // the tool name is part of the text so "grep <pattern>" style queries hit
        out.push({ role: "tool", toolName: b.name || "", toolCallId: b.id || null, text: `${b.name || ""} ${args}` });
      }
    }
  } else if (m.role === "toolResult") {
    const text = blocks
      .map((b) => {
        if (b.type === "text") return b.text || "";
        return b.type === "image" ? "[image]" : "[block]";
      })
      .join("\n");
    if (text.trim()) out.push({ role: "toolResult", toolName: m.toolName || "", toolCallId: m.toolCallId || null, text });
    // A subagent result's text is the parent's combined answer; each child's
    // own output lives only in details.results[].finalOutput. Index the child
    // output when the combined text does not already contain it, so a
    // reviewer's own wording is searchable without duplicating a hit.
    if (Array.isArray(m.details?.results)) {
      const flat = (s) => s.replace(/\s+/g, " ").trim();
      const combined = flat(text);
      for (const child of m.details.results) {
        const output = typeof child?.finalOutput === "string" ? child.finalOutput.trim() : "";
        if (!output || combined.includes(flat(output))) continue;
        out.push({
          role: "toolResult",
          toolName: `${m.toolName || "tool"}/${child.agent || "child"}`,
          toolCallId: m.toolCallId || null,
          text: output,
        });
      }
    }
  } else if (m.role === "bashExecution") {
    out.push({ role: "bash", text: `$ ${m.command || ""}\n${m.output || ""}` });
  }

  return out
    .filter((r) => r.text)
    .map((r) => ({
      entryId: entry.id,
      ts: entry.timestamp || null,
      role: r.role,
      toolName: r.toolName || null,
      toolCallId: r.toolCallId || null,
      text: r.text.length > SEARCH_RECORD_MAX_CHARS ? r.text.slice(0, SEARCH_RECORD_MAX_CHARS) : r.text,
    }));
}

function touchSearchCache(file, entry) {
  searchCache.delete(file);
  searchCache.set(file, entry);
}

function evictSearchCache() {
  while (searchCacheBytes > SEARCH_CACHE_MAX_BYTES && searchCache.size > 1) {
    const [oldestFile, oldest] = searchCache.entries().next().value;
    searchCache.delete(oldestFile);
    searchCacheBytes -= oldest.bytes;
  }
}

/** Read one session file line by line and build its search records. Streamed
 *  rather than read whole: a session JSONL can be tens of megabytes, and
 *  holding the raw text alongside the parsed records doubles the cost of
 *  indexing the corpus. */
async function readSearchIndex(file) {
  const records = [];
  let header = null;
  let bytes = 0;
  // A run is everything between two user prompts, and its summary is the answer
  // text of the run's last assistant turn — the same turn the prompt outline
  // offers a "summary" jump to. Only a turn that settled (stop/length) and
  // carries answer text qualifies, so a run still streaming, aborted, failed or
  // cut off mid tool loop contributes nothing. Records already sit in `records`
  // in file order, so the flag is applied to those objects in place rather than
  // re-appending the turn at the end of the run.
  let runOpen = false; // a prompt has opened a run
  let runTexts = null; // assistant text records of that run's latest turn
  let runSettled = false;
  const closeRun = () => {
    if (runSettled && runTexts) for (const r of runTexts) r.summary = true;
    runOpen = false;
    runTexts = null;
    runSettled = false;
  };
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // a partially written trailing line is normal for a live session
      }
      if (e.type === "session") {
        header = e;
        continue;
      }
      const entryRecords = searchRecordsOf(e);
      for (const r of entryRecords) {
        bytes += Buffer.byteLength(r.text, "utf8");
        records.push(r);
      }
      if (e.type !== "message") continue;
      const m = e.message;
      if (m?.role === "user") {
        closeRun();
        runOpen = true;
      } else if (runOpen && m?.role === "assistant") {
        runTexts = entryRecords.filter((r) => r.role === "assistant");
        runSettled = (m.stopReason === "stop" || m.stopReason === "length") && runTexts.length > 0;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  closeRun();
  return { records, header, bytes };
}

/** Parsed search records for one session file, from cache when unchanged. */
async function indexSessionFile(file, st) {
  const key = `${st.mtimeMs}:${st.size}`;
  const cached = searchCache.get(file);
  if (cached && cached.key === key) {
    touchSearchCache(file, cached);
    return cached;
  }

  const { records, header, bytes } = await readSearchIndex(file);

  if (cached) searchCacheBytes -= cached.bytes;
  const entry = {
    key,
    bytes,
    records,
    sessionId: header?.id || null,
    cwd: header?.cwd || null,
  };
  searchCacheBytes += bytes;
  touchSearchCache(file, entry);
  evictSearchCache();
  return entry;
}

/** Collapse whitespace so a snippet stays a single logical line, and mark it as
 *  clipped when it does not start/end at the record's own boundary. */
function snippetParts(text, index, matchLength) {
  const before = 40; // enough context to recognise the sentence the match sits in
  const after = 140;
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, index + matchLength + after);
  const collapse = (s) => s.replace(/\s+/g, " ");
  return {
    before: (start > 0 ? "…" : "") + collapse(text.slice(start, index)),
    match: collapse(text.slice(index, index + matchLength)),
    after: collapse(text.slice(index + matchLength, end)) + (end < text.length ? "…" : ""),
  };
}

/** Which records a scope scans. "prompts" is only what the user typed — tool
 *  requests, their output and bash executions are agent traffic (a bash record
 *  also carries its output, so it cannot stand in for a prompt). "summary" is
 *  the answer text each run concluded with, as tagged while indexing. */
const SCOPES = {
  all: () => true,
  prompts: (r) => r.role === "user",
  summary: (r) => r.summary === true,
};

/** Search every session for all whitespace-separated terms (case-insensitive
 *  substring, AND semantics). Files are walked newest-first and each file's
 *  records newest-first, so the most recent occurrences surface first. Scanning
 *  stops at `limit` hits and reports `truncated` rather than an invented count.
 *
 *  `scope` narrows the channels scanned: "all" covers every record, "prompts"
 *  only what the user typed, "summary" only the run summaries. */
async function searchSessions(query, limit = SEARCH_MAX_HITS, scope = "all") {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    // a pathological term would make the regex scan every record for nothing
    .map((t) => t.slice(0, 200));
  if (!terms.length) return { hits: [], truncated: false, sessionsScanned: 0 };

  const patterns = terms.map((t) => new RegExp(escapeRegExp(t), "i"));
  // "prompts" narrows to what the user typed; "summary" narrows to the answer
  // each run concluded with (see readSearchIndex); "all" keeps every record.
  const keep = SCOPES[scope] || SCOPES.all;
  const hits = [];
  let truncated = false;
  let sessionsScanned = 0;

  const files = await sessionFilesWithStats();
  for (const { f, st } of files) {
    if (truncated) break;
    let index;
    try {
      index = await indexSessionFile(f, st);
    } catch {
      continue;
    }
    sessionsScanned++;
    // newest occurrence first: appended entries are chronologically last
    for (let i = index.records.length - 1; i >= 0; i--) {
      const r = index.records[i];
      if (!keep(r)) continue;
      let firstIndex = -1;
      let firstLength = 0;
      let ok = true;
      for (const re of patterns) {
        const m = re.exec(r.text);
        if (!m) {
          ok = false;
          break;
        }
        if (firstIndex < 0 || m.index < firstIndex) {
          firstIndex = m.index;
          firstLength = m[0].length;
        }
      }
      if (!ok) continue;
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      hits.push({
        sessionFile: f,
        sessionId: index.sessionId,
        cwd: index.cwd,
        entryId: r.entryId,
        role: r.role,
        toolName: r.toolName,
        toolCallId: r.toolCallId,
        ts: r.ts,
        ...snippetParts(r.text, firstIndex, firstLength),
      });
    }
  }

  return { hits, truncated, sessionsScanned };
}

// ---------------------------------------------------------------------------
// Composer file attachments: text extraction
// ---------------------------------------------------------------------------
// A prompt can carry more than an image. pi's RPC accepts only text and images,
// so a PDF, a Word document or an HTML page is turned into text here and travels
// inside the prompt — the model reads it directly, with no tool call and no need
// for the file to exist on disk anywhere the agent can reach. Everything below
// uses node: builtins only (zlib unpacks both containers), so a plain
// `node server.js` keeps working with no dependency and no external binary.
//
// Extraction is deliberately approximate: readable content, not faithful layout.
// A document the parser finds no text in (a scanned PDF, an encrypted file) is
// refused with a reason instead of being sent to the model as an empty prompt.

/** Upper bound on the text one attachment may add to a prompt. Unbounded, a
 *  500-page PDF would silently blow up both the context window and the request. */
const ATTACH_TEXT_MAX = 120000;
/** Upper bound on a file that may be attached at all, before parsing. It also
 *  keeps the base64 request body (4/3 of this) under the 32 MB body cap. */
const ATTACH_FILE_MAX = 20 * 1024 * 1024;

/** Ceiling on what one decompressed stream may produce. A 20 MB file can inflate
 *  to gigabytes — that is a decompression bomb, not a document — so the inflate
 *  itself is bounded rather than left to whatever the container claims. */
const ATTACH_INFLATE_MAX = 64 * 1024 * 1024;
/** Ceiling on everything one file may decompress to in total. Each stream has its
 *  own limit, but a document can hold dozens of them and every inflated copy
 *  stays in memory, so the sum is what actually has to be bounded. */
const ATTACH_INFLATE_TOTAL = 96 * 1024 * 1024;
/** Portion of a .docx or .html that is scanned for text. The extracted text is
 *  capped at ATTACH_TEXT_MAX anyway; a document whose markup runs past this has
 *  far more formatting than readable prose, and regex work is linear in it. */
const ATTACH_SOURCE_MAX = 4 * 1024 * 1024;

/** zlib inflate that also accepts a headerless deflate stream: PDF and OOXML
 *  writers produce either framing and neither says which. `budget` is shared
 *  across one extraction so the total stays bounded. */
function inflateBytes(buf, budget) {
  if (budget && budget.left <= 0) return null;
  const maxOutputLength = Math.min(ATTACH_INFLATE_MAX, budget ? budget.left : ATTACH_INFLATE_MAX);
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      const out = fn(buf, { maxOutputLength });
      if (budget) budget.left -= out.length;
      return out;
    } catch {
      // try the other framing
    }
  }
  return null;
}

/** Trim the whitespace a text extraction leaves behind without collapsing the
 *  blank lines that separate paragraphs. */
function tidyText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clipText(text, cap) {
  return text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false };
}

/** Every `N G obj` body in a PDF, keyed by object number, with its stream
 *  inflated when Flate-compressed. The file is scanned rather than read through
 *  the xref table: a damaged xref is common and the object headers are still
 *  exactly where they were written. The count is capped so a file stuffed with
 *  millions of tiny objects cannot spend the request's whole budget in the map. */
const ATTACH_PDF_OBJECTS_MAX = 50000;
const ATTACH_PDF_PAGES_MAX = 2000;

function pdfObjects(buf, budget) {
  const text = buf.toString("latin1");
  const objects = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while (objects.size < ATTACH_PDF_OBJECTS_MAX && (m = re.exec(text))) {
    const num = Number(m[1]);
    const at = re.lastIndex;
    const end = text.indexOf("endobj", at);
    if (end < 0) continue;
    const body = text.slice(at, end);
    const streamAt = body.indexOf("stream");
    if (streamAt < 0) {
      objects.set(num, { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt);
    // `stream` is followed by CRLF or LF; the data offsets are read off the
    // buffer, which shares the latin1 slice's offsets one to one
    let from = at + streamAt + "stream".length;
    if (buf[from] === 0x0d) from++;
    if (buf[from] === 0x0a) from++;
    const to = at + body.lastIndexOf("endstream");
    const raw = buf.subarray(from, to < from ? from : to);
    objects.set(num, { dict, stream: /\/FlateDecode/.test(dict) ? inflateBytes(raw, budget) || raw : raw });
  }
  return objects;
}

/** PDF 1.5+ packs ordinary objects into compressed object streams. Unfolded they
 *  stay invisible, taking the font dictionaries and most of the page tree with
 *  them. */
function expandPdfObjectStreams(objects) {
  for (const obj of [...objects.values()]) {
    if (!obj.stream || !/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const declared = Number((obj.dict.match(/\/N\s+(\d+)/) || [])[1] || 0);
    const first = Number((obj.dict.match(/\/First\s+(\d+)/) || [])[1] || 0);
    if (!declared || !first) continue;
    // /N is attacker-controlled: a small stream can claim a million members and
    // the header array would not have them, so bound it by what the file could
    // possibly hold and by the global object cap
    const count = Math.min(declared, Math.floor(first / 2), ATTACH_PDF_OBJECTS_MAX - objects.size);
    if (count < 1) continue;
    const body = obj.stream.toString("latin1");
    const head = body.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i++) {
      const num = head[i * 2];
      const from = head[i * 2 + 1];
      const to = i + 1 < count ? head[(i + 1) * 2 + 1] : body.length - first;
      if (!Number.isFinite(num) || !Number.isFinite(from) || objects.has(num)) continue;
      objects.set(num, { dict: body.slice(first + from, first + to), stream: null });
    }
  }
}

/** Read a /ToUnicode CMap — the only reliable way to map a PDF's character codes
 *  back to text for a subsetted font, where code 3 is whatever glyph the writer
 *  happened to place third. */
function pdfCMapOf(data) {
  const text = data.toString("latin1");
  const map = new Map();
  let codeLen = 0;
  const utf16 = (hex) => {
    const clean = hex.replace(/[^0-9a-fA-F]/g, "");
    let out = "";
    for (let i = 0; i + 4 <= clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (!codeLen) codeLen = pair[1].length / 2;
      map.set(parseInt(pair[1], 16), utf16(pair[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      if (!codeLen) codeLen = range[1].length / 2;
      const lo = parseInt(range[1], 16);
      const hi = parseInt(range[2], 16);
      if (range[3]) {
        const base = parseInt(range[3].slice(0, 4), 16);
        for (let code = lo; code <= hi && code - lo < 65536; code++) map.set(code, String.fromCharCode(base + code - lo));
      } else if (range[4]) {
        [...range[4].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((item, i) => map.set(lo + i, utf16(item[1])));
      }
    }
  }
  return map.size ? { map, codeLen: codeLen || 1 } : null;
}

/** Fonts carrying a usable mapping, by object number, plus the /Fx resource
 *  names a content stream selects with Tf. */
function pdfFonts(objects) {
  const byObject = new Map();
  const byName = new Map();
  for (const [num, obj] of objects) {
    const toUnicode = obj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    const cmap = toUnicode && objects.get(Number(toUnicode[1]))?.stream;
    if (cmap) {
      const parsed = pdfCMapOf(cmap);
      if (parsed) byObject.set(num, parsed);
    }
    // a font resource dict is inherited through the page tree, so every dict is
    // searched rather than only each page's own /Resources
    for (const block of obj.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const entry of block[1].matchAll(/\/([^\s/<>[\](){}%]+)\s+(\d+)\s+\d+\s+R/g)) byName.set(entry[1], Number(entry[2]));
    }
  }
  return { byObject, byName };
}

function decodePdfText(bytes, font) {
  if (font) {
    let out = "";
    for (let i = 0; i + font.codeLen <= bytes.length; i += font.codeLen) {
      let code = 0;
      for (let k = 0; k < font.codeLen; k++) code = (code << 8) | bytes[i + k];
      out += font.map.get(code) ?? "";
    }
    return out;
  }
  // no CMap: a UTF-16BE string still decodes, and simple fonts are single-byte
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return Buffer.from(bytes).toString("latin1");
}

/** Pull the drawn text out of one page content stream. Line breaks come from the
 *  text matrix's y (many writers emit one BT/ET per word with an absolute Tm, so
 *  ending a text object alone would break after every word), and word spaces from
 *  the large negative kerning offsets a TJ array uses in place of a space glyph. */
function pdfContentText(data, fonts, cap) {
  const src = data.toString("latin1");
  const parts = [];
  let length = 0;
  let font = null;
  let lineY = null;
  let stack = [];
  const push = (s) => {
    if (!s) return;
    parts.push(s);
    length += s.length;
  };
  const newline = () => {
    if (length && parts[parts.length - 1] !== "\n") push("\n");
  };
  const nums = () => stack.filter((t) => t.type === "num").map((t) => t.value);
  const strs = () => stack.filter((t) => t.type === "str");

  let i = 0;
  while (i < src.length && length < cap) {
    const c = src[i];
    // a stream that never reaches an operator would otherwise grow the operand
    // stack for every token it holds
    if (stack.length > 65536) stack = [];
    if (c === "(") {
      // a literal string: escapes are symbolic, octal, or a line continuation
      const bytes = [];
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        const ch = src[j];
        if (ch === "\\") {
          const next = src[j + 1];
          const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
          if (simple[next] != null) {
            bytes.push(simple[next]);
            j += 2;
          } else if (next >= "0" && next <= "7") {
            const octal = src.slice(j + 1, j + 4).match(/^[0-7]{1,3}/)[0];
            bytes.push(parseInt(octal, 8) & 0xff);
            j += 1 + octal.length;
          } else {
            bytes.push(src.charCodeAt(j + 1) & 0xff);
            j += 2;
          }
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (!depth) {
            j++;
            break;
          }
        }
        bytes.push(src.charCodeAt(j) & 0xff);
        j++;
      }
      stack.push({ type: "str", bytes });
      i = j;
      continue;
    }
    if (c === "<" && src[i + 1] !== "<") {
      const end = src.indexOf(">", i);
      if (end < 0) break;
      const hex = src.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, "");
      const bytes = [];
      for (let k = 0; k + 2 <= hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      stack.push({ type: "str", bytes });
      i = end + 1;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      while (j < src.length && !/[\s/<>[\](){}%]/.test(src[j])) j++;
      stack.push({ type: "name", value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9+\-.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9+\-.eE]/.test(src[j])) j++;
      stack.push({ type: "num", value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z'"*]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z'"*0-9]/.test(src[j])) j++;
      const op = src.slice(i, j);
      i = j;
      if (op === "Tf") {
        const name = [...stack].reverse().find((t) => t.type === "name");
        if (name) font = fonts.byObject.get(fonts.byName.get(name.value)) || null;
      } else if (op === "Tj" || op === "'" || op === '"') {
        if (op !== "Tj") newline();
        const list = strs();
        if (list.length) push(decodePdfText(list[list.length - 1].bytes, font));
      } else if (op === "TJ") {
        for (const item of stack) {
          if (item.type === "str") push(decodePdfText(item.bytes, font));
          else if (item.type === "num" && item.value <= -180 && parts.length && !/\s$/.test(parts[parts.length - 1])) push(" ");
        }
      } else if (op === "Tm") {
        const y = nums()[5];
        if (y != null && lineY != null && Math.abs(y - lineY) > 1) newline();
        if (y != null) lineY = y;
      } else if (op === "Td" || op === "TD") {
        const dy = nums()[1];
        if (dy) {
          newline();
          if (lineY != null) lineY += dy;
        }
      } else if (op === "T*") {
        newline();
      }
      stack = [];
      continue;
    }
    if (c === "[" || c === "]") {
      // the brackets carry nothing themselves; their items stay on the stack
      i++;
      continue;
    }
    i++;
  }
  return parts.join("");
}

/** Page objects in reading order, walked from /Catalog /Pages so a document's
 *  pages are not whatever order their objects happen to sit in the file. */
function pdfPages(objects) {
  const pages = [];
  const seen = new Set();
  const walk = (num) => {
    if (seen.has(num) || pages.length >= ATTACH_PDF_PAGES_MAX) return;
    seen.add(num);
    const obj = objects.get(num);
    if (!obj) return;
    if (/\/Type\s*\/Page\b/.test(obj.dict)) {
      pages.push(obj);
      return;
    }
    const kids = obj.dict.match(/\/Kids\s*\[([^\]]*)\]/);
    for (const kid of kids ? kids[1].matchAll(/(\d+)\s+\d+\s+R/g) : []) walk(Number(kid[1]));
  };
  for (const obj of objects.values()) {
    if (!/\/Type\s*\/Catalog\b/.test(obj.dict)) continue;
    const pagesRef = obj.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
    if (pagesRef) walk(Number(pagesRef[1]));
  }
  if (!pages.length) {
    for (const obj of objects.values()) {
      if (pages.length >= ATTACH_PDF_PAGES_MAX) break;
      if (/\/Type\s*\/Page\b/.test(obj.dict)) pages.push(obj);
    }
  }
  return pages;
}

function pdfText(buf, cap, budget) {
  const objects = pdfObjects(buf, budget);
  expandPdfObjectStreams(objects);
  const fonts = pdfFonts(objects);
  const streams = [];
  for (const page of pdfPages(objects)) {
    const contents = page.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
    for (const ref of contents ? contents[1].matchAll(/(\d+)\s+\d+\s+R/g) : []) {
      const stream = objects.get(Number(ref[1]))?.stream;
      if (stream) streams.push(stream);
    }
  }
  const chunks = [];
  let length = 0;
  for (const stream of streams) {
    if (length >= cap) break;
    const text = pdfContentText(stream, fonts, cap - length);
    length += text.length;
    if (text.trim()) chunks.push(text);
  }
  return { text: tidyText(chunks.join("\n")), pages: streams.length, truncated: length >= cap };
}

/** Minimal ZIP reader for OOXML: the central directory names the entries and
 *  each local header gives the data offset. Word, LibreOffice and Pages all
 *  write stored or deflated entries and nothing else. */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const directoryAt = buf.readUInt32LE(eocd + 16);
  if (directoryAt > eocd) return null;
  // a directory that cannot be right is refused rather than walked: every
  // record is at least 46 bytes, so the declared count has an upper bound
  const count = Math.min(buf.readUInt16LE(eocd + 10), Math.floor((eocd - directoryAt) / 46));
  let at = directoryAt;
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x04034b50) continue;
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const from = localAt + 30 + localNameLen + localExtraLen;
    entries.set(name, { method, raw: buf.subarray(from, from + size) });
  }
  return entries;
}

/** Long documents are read only as far as a source cap. The extracted text is
 *  capped at ATTACH_TEXT_MAX, and markup-to-text is regex work linear in its
 *  input, so a file larger than this has far more formatting than prose. */
function cappedSource(text) {
  return text.length > ATTACH_SOURCE_MAX ? text.slice(0, ATTACH_SOURCE_MAX) : text;
}

/** Decode the head of a buffer for a source cap: slicing the bytes first keeps
 *  a multi-megabyte file from becoming a string only to be cut. */
function cappedUtf8(buf) {
  return cappedSource(buf.subarray(0, ATTACH_SOURCE_MAX).toString("utf8"));
}

/** WordprocessingML to text: paragraphs and breaks become newlines, tabs stay
 *  tabs, run formatting is dropped. w:tab and w:br are the only elements carrying
 *  the document's whitespace, so they are replaced before the tags are stripped. */
function docxText(buf, budget) {
  const entries = zipEntries(buf);
  const main = entries?.get("word/document.xml");
  if (!main) return null;
  const xml = main.method === 8 ? inflateBytes(main.raw, budget) : main.raw;
  if (!xml) return null;
  const text = cappedSource(xml.toString("utf8"))
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  return { text: tidyText(text) };
}

/** HTML to text, keeping block structure as newlines and list items as bullets.
 *  Script, style and template bodies go whole: their contents are not readable
 *  prose and would otherwise arrive in the prompt as code noise. */
function htmlText(buf) {
  const html = cappedUtf8(buf).replace(/^\uFEFF/, "");
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt|header|footer)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
  return { text: tidyText(text) };
}

/** Plain-text formats the browser can already decode, listed so a dropped .md or
 *  .csv does not need a trip through a parser. */
const ATTACH_TEXT_TYPES = new Set(["txt", "md", "markdown", "csv", "json", "log", "yaml", "yml"]);

/** Which handler a file goes to, by extension first and magic bytes second: a
 *  PDF saved without an extension still parses, while a file merely *named*
 *  .pdf is refused rather than guessed at. */
function attachmentKind(name, buf) {
  const ext = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  if (ext === "pdf" || buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "html" || ext === "htm") return "html";
  if (ATTACH_TEXT_TYPES.has(ext)) return "text";
  if (ext === "doc") return "doc";
  return null;
}

/** Extract one attachment's text as `{ kind, text, pages?, truncated }`. Throws a
 *  message meant for the user when the file cannot be read, because the composer
 *  has to say why an attachment was refused. */
function extractAttachment(name, buf) {
  if (!buf.length) throw new Error("the file is empty");
  if (buf.length > ATTACH_FILE_MAX) throw new Error(`the file is larger than ${ATTACH_FILE_MAX / (1024 * 1024)} MB`);
  const kind = attachmentKind(name, buf);
  if (kind === "doc") throw new Error("legacy .doc is not supported — save it as .docx or PDF");
  if (!kind) throw new Error("unsupported file type — attach a PDF, .docx, .html or a text file");
  const budget = { left: ATTACH_INFLATE_TOTAL };
  if (kind === "pdf") {
    const { text, pages, truncated } = pdfText(buf, ATTACH_TEXT_MAX, budget);
    if (!text) throw new Error("no text layer found — the PDF is probably a scan, which needs OCR first");
    return { kind, text: truncated ? text.slice(0, ATTACH_TEXT_MAX) : text, pages, truncated };
  }
  if (kind === "docx") {
    const parsed = docxText(buf, budget);
    if (!parsed?.text) throw new Error("not a readable .docx, or the document has no text");
    return { kind, ...clipText(parsed.text, ATTACH_TEXT_MAX) };
  }
  if (kind === "html") {
    const { text } = htmlText(buf);
    if (!text) throw new Error("the page contains no text");
    return { kind, ...clipText(text, ATTACH_TEXT_MAX) };
  }
  return { kind, ...clipText(tidyText(cappedUtf8(buf)), ATTACH_TEXT_MAX) };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Image types the read tool may return, and the sniffed magic bytes that must
 *  match. Only these are served: an arbitrary file must never be readable
 *  through the image endpoint just because a tool call named it. */
const IMAGE_TYPES = new Map([
  ["image/png", (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.length > 6 && b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
]);
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Reject requests that did not originate from this machine. Binding to
 * loopback already stops inbound connections, but a malicious page in another
 * tab can still open a cross-origin `fetch`/`EventSource` to localhost — the
 * Host and Origin checks below close that (DNS rebinding and CSRF).
 */
function isAllowedRequest(req) {
  if (!isLoopbackHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GETs, curl, and EventSource omit it
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  if (!ALLOW_REMOTE && !isAllowedRequest(req)) {
    sendJson(res, 403, { error: "pi-web only accepts requests from localhost — see README: Remote access" });
    return;
  }
  // Defense in depth for every response: no MIME sniffing, no referrer leaks to
  // outside sites, and no framing (the UI must never be clickjacked).
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ type: "server", event: "hello" })}\n\n`);
      const c = clientEntry(url.searchParams.get("client") || "");
      c.res = res;
      c.detachedAt = 0;
      // a reconnected stream (page reload) missed every queue_update since the
      // process started holding messages — replay the current queue now
      const attached = c.key ? procs.get(c.key) : null;
      if (attached) attached.sendQueueSnapshot(res);
      req.on("close", () => {
        if (c.res !== res) return;
        c.res = null;
        c.detachedAt = Date.now();
      });
      return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
      sendJson(res, 200, { cwd: CWD, sessionDir: SESSION_DIR, piBin: PI_BIN });
      return;
    }

    if (pathname === "/api/open" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body || typeof body.client !== "string" || !body.client) {
        sendJson(res, 400, { error: "missing client id" });
        return;
      }
      const resp = await openSession({
        client: body.client,
        sessionFile: typeof body.sessionFile === "string" && body.sessionFile ? body.sessionFile : null,
        cwd: typeof body.cwd === "string" ? body.cwd : null,
      });
      sendJson(res, 200, resp);
      return;
    }

    if (pathname === "/api/cmd" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body || typeof body.type !== "string") {
        sendJson(res, 400, { error: "missing command type" });
        return;
      }
      const c = clients.get(body.client);
      const proc = c && c.key ? procs.get(c.key) : null;
      if (!proc || !proc.proc) {
        sendJson(res, 503, { error: "no pi process — open a session first" });
        return;
      }
      const { client, ...cmdbody } = body;
      const response = await proc.sendCommand(cmdbody);
      if (cmdbody.type === "get_available_models" && response?.data?.models) {
        const filtered = filterConfiguredModels(response.data.models, enabledModelPatterns());
        if (filtered.length) response.data.models = filtered;
      }
      if (cmdbody.type === "get_state" && response?.data?.sessionFile) {
        learnSessionFile(proc, response.data.sessionFile);
      }
      // a fresh session learns its file right after the first prompt, before
      // another tab could click the newly-listed file and double-open it
      if (cmdbody.type === "prompt" && proc.key.startsWith("slot:")) {
        proc.sendCommand({ type: "get_state" }).then((r) => learnSessionFile(proc, r?.data?.sessionFile)).catch(() => {});
      }
      sendJson(res, 200, response);
      return;
    }

    if (pathname === "/api/ui-response" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      // Fire-and-forget: no command response exists for extension_ui_response.
      const c = clients.get(body.client);
      const proc = c && c.key ? procs.get(c.key) : null;
      if (!proc || !proc.proc) {
        sendJson(res, 503, { error: "pi not running" });
        return;
      }
      const { client, ...rest } = body;
      proc.proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...rest })}\n`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/sessions" && req.method === "GET") {
      sendJson(res, 200, { sessions: await sessionsWithStatus() });
      return;
    }

    // Follow-ups: the summaries the user kept. The list carries metadata only,
    // so the sidebar never downloads full answers; one follow-up is fetched when
    // it is opened, and that read never touches pi or the session directory.
    if (pathname === "/api/followups" && req.method === "GET") {
      sendJson(res, 200, { followups: await listFollowups() });
      return;
    }

    if (pathname === "/api/followups" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const text = stringField(body.text, FOLLOWUP_TEXT_MAX);
      if (!text || !text.trim()) {
        sendJson(res, 400, { error: "a follow-up needs the summary text" });
        return;
      }
      const record = {
        id: randomUUID(),
        version: 1,
        createdAt: Date.now(),
        title: stringField(body.title, 300) || text.trim().split("\n")[0].slice(0, 120),
        text,
        ts: Number.isFinite(Number(body.ts)) && body.ts ? Number(body.ts) : null,
        cwd: stringField(body.cwd, 4096),
        sessionFile: stringField(body.sessionFile, 4096),
        sessionTitle: stringField(body.sessionTitle, 300),
      };
      await fsp.mkdir(FOLLOWUP_DIR, { recursive: true });
      // write-then-rename: a half-written file must never be listed as a
      // follow-up, and a rename is atomic within the directory
      await writeFollowup(record);
      sendJson(res, 200, { followup: followupMeta(record) });
      return;
    }

    const followupMatch = pathname.match(/^\/api\/followups\/([A-Za-z0-9_-]+)$/);
    if (followupMatch && !FOLLOWUP_ID.test(followupMatch[1])) {
      // the capture group is already narrow; keep the check so a future regex
      // change cannot turn this into a path traversal
      sendJson(res, 400, { error: "bad follow-up id" });
      return;
    }
    if (followupMatch && req.method === "GET") {
      try {
        sendJson(res, 200, { followup: await readFollowup(followupMatch[1]) });
      } catch {
        sendJson(res, 404, { error: "no such follow-up" });
      }
      return;
    }
    // Editing a kept summary: title and body only. Everything that places the
    // follow-up (id, createdAt, cwd, session link) stays as saved, so an edit
    // never reorders the list or detaches it from its session.
    if (followupMatch && req.method === "PATCH") {
      let rec;
      try {
        rec = await readFollowup(followupMatch[1]);
      } catch {
        sendJson(res, 404, { error: "no such follow-up" });
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.title !== undefined) {
        const title = stringField(body.title, 300);
        if (title === null) {
          sendJson(res, 400, { error: "title must be a string" });
          return;
        }
        rec.title = title.trim();
      }
      if (body.text !== undefined) {
        const text = stringField(body.text, FOLLOWUP_TEXT_MAX);
        if (!text || !text.trim()) {
          sendJson(res, 400, { error: "a follow-up needs the summary text" });
          return;
        }
        rec.text = text;
      }
      await writeFollowup(rec);
      sendJson(res, 200, { followup: { ...followupMeta(rec), text: rec.text } });
      return;
    }
    if (followupMatch && req.method === "DELETE") {
      try {
        await fsp.unlink(followupPath(followupMatch[1]));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // Cross-session full-text search: prompts, responses, tool requests and
    // tool results across every workspace. Read-only over the session
    // directory — the same corpus /api/sessions lists. `scope=prompts` narrows
    // it to user prompts, `scope=summary` to the answer each run concluded
    // with. Unknown scopes fall back to the full corpus.
    if (pathname === "/api/search" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : SEARCH_MAX_HITS;
      const requested = url.searchParams.get("scope");
      const scope = Object.hasOwn(SCOPES, requested) ? requested : "all";
      sendJson(res, 200, await searchSessions(q, limit, scope));
      return;
    }

    // Directory listing for the workspace picker (local folders only, no dotfiles)
    if (pathname === "/api/browse" && req.method === "GET") {
      const params = new URL(req.url, "http://localhost").searchParams;
      const dir = path.resolve(params.get("path") || os.homedir());
      const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
      let dirs = [];
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
      } catch (err) {
        sendJson(res, 403, { error: err.message, path: dir, parent, dirs: [] });
        return;
      }
      sendJson(res, 200, { path: dir, parent, dirs, home: os.homedir() });
      return;
    }

    // MCP server state for the resources panel. `pi mcp list --json` is the
    // only source that reports live connection state, so it is run on demand
    // rather than cached: a server can be signed in, edited or killed between
    // two looks. It connects every enabled server, so the result is slow enough
    // to need its own timeout, and a non-zero exit is normal when a server is
    // merely disconnected — the JSON is still the answer.
    if (pathname === "/api/mcp" && req.method === "GET") {
      // The project half of the MCP config lives in the session's workspace, so
      // describe the workspace this tab's agent is actually running in. That
      // cwd was already trusted enough to spawn pi in (see /api/open), so this
      // grants nothing new; without a client the server's own cwd is used.
      const client = clients.get(url.searchParams.get("client") || "");
      const proc = client && client.key ? procs.get(client.key) : null;
      const out = await runPiMcpList(proc?.cwd || CWD);
      sendJson(res, 200, out);
      return;
    }

    // Text of a composer attachment: a PDF, .docx, .html or plain-text file the
    // user dropped on the composer, or picked, is turned into text here so it can
    // ride inside the next prompt. pi's RPC prompt accepts only text and images,
    // so extraction has to happen before the prompt, not in the agent.
    //
    // The bytes come from the browser's own File — nothing is read from a path on
    // this machine — and the response is text only, so this route is not a file
    // reader. JSON with a base64 body keeps the whole thing one request and holds
    // the body cap (32 MB) that every other write route already has.
    if (pathname === "/api/extract" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const name = stringField(body.name, 512) || "attachment";
      if (typeof body.data !== "string" || !body.data) {
        sendJson(res, 400, { error: "missing file data" });
        return;
      }
      // base64 is 4/3 of the file, so cap the encoded form rather than decoding an
      // oversized payload only to reject it
      if (body.data.length > Math.ceil((ATTACH_FILE_MAX * 4) / 3) + 4) {
        sendJson(res, 413, { error: `the file is larger than ${ATTACH_FILE_MAX / (1024 * 1024)} MB` });
        return;
      }
      let extracted;
      try {
        extracted = extractAttachment(name, Buffer.from(body.data, "base64"));
      } catch (err) {
        sendJson(res, 415, { error: err.message });
        return;
      }
      sendJson(res, 200, { name, ...extracted });
      return;
    }

    if (pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, procs: procs.size, clients: clients.size });
      return;
    }

    // Image bytes for a tool result that reports an image path but carries no
    // image block (e.g. a `read` that returns only {content:"", fileSize}).
    // Deliberately narrow: images only, verified by magic bytes, size-capped,
    // and behind the same loopback/Host/Origin guards as every other route.
    if (pathname === "/api/image" && req.method === "GET") {
      const target = url.searchParams.get("path") || "";
      if (!target || !path.isAbsolute(target)) {
        sendJson(res, 400, { error: "absolute path required" });
        return;
      }
      let real;
      try {
        real = await fsp.realpath(target);
        const st = await fsp.stat(real);
        if (!st.isFile()) throw new Error("not a regular file");
        if (st.size > MAX_IMAGE_BYTES) {
          sendJson(res, 413, { error: "image too large" });
          return;
        }
      } catch (err) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      let data;
      try {
        data = await fsp.readFile(real);
      } catch (err) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      const type = [...IMAGE_TYPES].find(([, matches]) => matches(data))?.[0];
      if (!type) {
        sendJson(res, 415, { error: "not a supported image" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": data.length,
        "Cache-Control": "no-store",
      });
      res.end(data);
      return;
    }

    // Static files
    const rel = pathname === "/" ? "/index.html" : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    // the trailing separator stops a sibling like /public-evil from matching
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const st = await fsp.stat(file);
      // Strong-ish validator from metadata, not content: hashing app.js on
      // every request would cost as much as sending it.
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const inm = req.headers["if-none-match"];
      if (inm && inm.split(",").some((t) => t.trim() === etag)) {
        res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
        res.end();
        return;
      }
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        // dev tool: always revalidate so client code changes apply on reload.
        // The ETag turns that revalidation into a bodyless 304 when the file
        // has not changed.
        "Cache-Control": "no-cache",
        ETag: etag,
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// Heartbeat so proxies keep SSE connections open. It also carries the detached
// client sweep: a dead stream is only noticed on write, and the ping is the
// one place that happens on a timer.
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.res) continue;
    try {
      c.res.write(`: ping\n\n`);
    } catch {
      c.res = null;
      c.detachedAt = Date.now();
    }
  }
  sweepClients();
}, 25000).unref();

function shutdown() {
  for (const proc of [...procs.values()]) proc.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[pi-web] port ${PORT} is already in use — is another pi-web already running?`);
    console.error(`[pi-web] try: lsof -ti :${PORT} | xargs kill   (then rerun)`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, HOST, () => {
  console.log(`[pi-web] http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}  (pi cwd: ${CWD})`);
  console.log(`[pi-web] session dir: ${SESSION_DIR}`);
  if (ALLOW_REMOTE) {
    console.warn(`[pi-web] WARNING: remote access is enabled (${HOST === "127.0.0.1" ? "--allow-remote" : `--host ${HOST}`}).`);
    console.warn(`[pi-web] Anyone who can reach this port can drive the agent, and it runs shell commands as you.`);
  }
});
