#!/usr/bin/env node
/**
 * pi-web: a web UI bridge for the pi coding agent, running `pi --mode rpc`.
 *
 * Usage:
 *   node server.js [--port 3210] [--host 127.0.0.1] [--cwd <project-dir>]
 *                  [--session-dir <dir>] [--pi <pi-bin>] [--allow-remote]
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
  --pi <path>         pi executable to spawn (default: "pi" on PATH, env PI_BIN)
  --allow-remote      Disable the localhost-only request guards while still
                      binding to 127.0.0.1 (for reverse proxies; see README)
  -h, --help          Show this help
  -v, --version       Show the version

Environment:
  PI_WEB_PORT, PI_WEB_HOST, PI_WEB_CWD, PI_BIN,
  PI_CODING_AGENT_SESSION_DIR, PI_WEB_ALLOW_REMOTE
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
      if (title === null && e.message?.role === "user") title = userText(e.message.content);
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
    const text = typeof m.content === "string" ? m.content : textBlocks();
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
      for (const r of searchRecordsOf(e)) {
        bytes += Buffer.byteLength(r.text, "utf8");
        records.push(r);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
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

/** Search every session for all whitespace-separated terms (case-insensitive
 *  substring, AND semantics). Files are walked newest-first and each file's
 *  records newest-first, so the most recent occurrences surface first. Scanning
 *  stops at `limit` hits and reports `truncated` rather than an invented count.
 *
 *  `scope` narrows the channels scanned: "all" covers every record, "prompts"
 *  only what the user typed. Only user messages qualify — tool requests, their
 *  output and bash executions are agent traffic (a bash record also carries its
 *  output, so it cannot stand in for a prompt). */
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
  const promptsOnly = scope === "prompts";
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
      if (promptsOnly && r.role !== "user") continue;
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

    // Cross-session full-text search: prompts, responses, tool requests and
    // tool results across every workspace. Read-only over the session
    // directory — the same corpus /api/sessions lists. `scope=prompts` narrows
    // it to user prompts. Unknown scopes fall back to the full corpus.
    if (pathname === "/api/search" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : SEARCH_MAX_HITS;
      const scope = url.searchParams.get("scope") === "prompts" ? "prompts" : "all";
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
