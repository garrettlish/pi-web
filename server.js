#!/usr/bin/env node
/**
 * pi-web: a web UI bridge for the pi coding agent, running `pi --mode rpc`.
 *
 * Usage:
 *   node server.js [--port 3210] [--cwd <project-dir>] [--session-dir <dir>] [--pi <pi-bin>]
 *
 * No npm dependencies. Node >= 18.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, openSync, readSync, closeSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(argValue("--port", process.env.PI_WEB_PORT || 3210));
const CWD = path.resolve(argValue("--cwd", process.env.PI_WEB_CWD || process.cwd()));
const SESSION_DIR = path.resolve(
  argValue("--session-dir", process.env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), ".pi", "agent", "sessions"))
);
const PI_BIN = argValue("--pi", process.env.PI_BIN || "pi");

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
/** clientId -> { res (SSE response), key (attached proc key) } */
const clients = new Map();
/** procs with no viewer and no run are stopped after this idle time */
const IDLE_REAP_MS = 30 * 60 * 1000;

function clientEntry(id) {
  let c = clients.get(id);
  if (!c) {
    c = { res: null, key: null };
    clients.set(id, c);
  }
  return c;
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
    // Session events, extension UI requests, bash updates -> attached clients
    this.broadcast(record);
  }

  start() {
    if (this.proc) return this.proc;
    const args = ["--mode", "rpc"];
    if (this.sessionFile) args.push("--session", this.sessionFile);
    console.log(`[pi-web] starting: ${PI_BIN} ${args.join(" ")} (cwd=${this.cwd})`);
    const p = spawn(PI_BIN, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = p;
    this.buffer = "";

    p.stdout.on("data", (chunk) => {
      if (this.proc !== p) return; // retired process — ignore stale output
      this.buffer += chunk.toString("utf8");
      // Strict JSONL framing: split on LF only (docs warn against readline,
      // which also splits on U+2028/U+2029).
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
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
        this.proc.stdin.write(JSON.stringify(record) + "\n");
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
 *  or to a brand-new process. Never stops other running sessions. */
function openSession({ client, sessionFile, cwd }) {
  const c = clientEntry(client);
  let key;
  if (sessionFile) {
    const abs = path.resolve(sessionFile);
    key = fileAlias.get(abs) || `file:${abs}`;
  } else {
    key = `slot:${randomUUID()}`;
  }
  let proc = procs.get(key);
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
  }
  c.key = key;
  if (c.res) {
    try {
      c.res.write(`data: ${JSON.stringify({ type: "server", event: "hello" })}\n\n`);
    } catch {}
  }
  return { ok: true, sessionFile: proc.sessionFile, cwd: proc.cwd };
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

// ---------------------------------------------------------------------------
// Configured models: filter the catalog down to settings.enabledModels patterns
// (same semantics as pi's model scope: case-insensitive globs matched against
// "provider/id" or bare "id"; optional ":level" and "@context" suffixes ignored)
// ---------------------------------------------------------------------------

const PI_SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "settings.json");

function enabledModelPatterns() {
  try {
    const settings = JSON.parse(readFileSync(PI_SETTINGS_FILE, "utf8"));
    return Array.isArray(settings.enabledModels) ? settings.enabledModels.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
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

async function listSessions(limit = 400) {
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

  const usable = stats.filter(Boolean).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, limit);

  const sessions = await Promise.all(
    usable.map(async ({ f, st }) => {
      try {
        const text = await fsp.readFile(f, "utf8");
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
            continue;
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
      } catch {
        return null;
      }
    })
  );

  return sessions.filter(Boolean);
}

// listSessions walks the whole session dir; cache briefly so several tabs
// polling /api/sessions share one walk.
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
// HTTP server
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

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

const server = http.createServer(async (req, res) => {
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
      req.on("close", () => {
        if (c.res === res) c.res = null;
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
      const resp = openSession({
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
      proc.proc.stdin.write(JSON.stringify({ type: "extension_ui_response", ...rest }) + "\n");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/sessions" && req.method === "GET") {
      sendJson(res, 200, { sessions: await sessionsWithStatus() });
      return;
    }

    // Directory listing for the workspace picker (local folders only, no dotfiles)
    if (pathname === "/api/browse" && req.method === "GET") {
      const params = new URL(req.url, "http://localhost").searchParams;
      let dir = path.resolve(params.get("path") || os.homedir());
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
      sendJson(res, 200, { ok: true, procs: procs.size });
      return;
    }

    // Static files
    let rel = pathname === "/" ? "/index.html" : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        // dev tool: always revalidate so client code changes apply on reload
        "Cache-Control": "no-cache",
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

// Heartbeat so proxies keep SSE connections open
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.res) continue;
    try {
      c.res.write(`: ping\n\n`);
    } catch {
      c.res = null;
    }
  }
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
server.listen(PORT, () => {
  console.log(`[pi-web] http://localhost:${PORT}  (pi cwd: ${CWD})`);
  console.log(`[pi-web] session dir: ${SESSION_DIR}`);
});
