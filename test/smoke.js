#!/usr/bin/env node
/**
 * End-to-end smoke test for pi-web. No dependencies, no test framework.
 *
 *   node test/smoke.js
 *
 * Starts a throwaway server on a free port, then checks the things that have
 * actually broken before: the page and its assets are served, the HTTP API
 * answers, foreign hosts and cross-origin writes are rejected, and path
 * traversal cannot escape public/.
 *
 * It does NOT spawn a real pi agent — that needs credentials and a model, and
 * belongs in a manual check. When pi is installed the script additionally
 * verifies that a session can be opened.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT || 3300 + Math.floor(Math.random() * 400));
const BASE = `http://127.0.0.1:${PORT}`;

// A throwaway session directory keeps /api/sessions and /api/search
// deterministic and independent of whatever real sessions this machine has.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-smoke-"));
function writeFixture(dirName, file, lines) {
  const dir = path.join(FIXTURE_DIR, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Status code of a raw request; needed because fetch() ignores a Host header override. */
function rawRequestStatus(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method: "GET", headers },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Two workspaces, each with one session. The fixture exercises every searchable
// channel and two of the exclusion rules (system prompt, thinking blocks).
writeFixture("--tmp-ws-alpha--", "2026-01-01T00-00-00-000Z_aaaa.jsonl", [
  { type: "session", version: 3, id: "aaaa", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/ws-alpha" },
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "please inspect the flibbertigibbet module" }] },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SEARCHTHINKINGONLY private reasoning" },
        { type: "text", text: "the flibbertigibbet module exports nothing useful" },
        { type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "SEARCHTOOLARG flibbertigibbet" } },
      ],
    },
  },
  {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call-1", toolName: "grep", content: [{ type: "text", text: "SEARCHTOOLOUT flibbertigibbet.js:1" }] },
  },
  {
    type: "message",
    id: "a3",
    parentId: "r1",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-sub", name: "subagent", arguments: { agent: "reviewer", task: "SEARCHSUBTASK review auth" } }],
    },
  },
  // A subagent fan-out: the tool result text is the parent's combined answer,
  // while each child's own output lives only in details.results[].finalOutput.
  {
    type: "message",
    id: "r2",
    parentId: "a3",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-sub",
      toolName: "subagent",
      content: [{ type: "text", text: "combined answer" }],
      details: {
        mode: "single",
        results: [{ index: 0, agent: "reviewer", exitCode: 0, finalOutput: "SEARCHCHILDOUT the token check trusts the alg header" }],
      },
    },
  },
]);
writeFixture("--tmp-ws-beta--", "2026-02-02T00-00-00-000Z_bbbb.jsonl", [
  { type: "session", version: 3, id: "bbbb", timestamp: "2026-02-02T00:00:00.000Z", cwd: "/tmp/ws-beta" },
  {
    type: "message",
    id: "u2",
    parentId: null,
    timestamp: "2026-02-02T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "unrelated request about widgets" }] },
  },
  {
    type: "message",
    id: "s1",
    parentId: null,
    timestamp: "2026-02-02T00:00:02.000Z",
    message: { role: "system", content: "SEARCHSYSTEMONLY system preamble" },
  },
  {
    type: "message",
    id: "a2",
    parentId: "u2",
    timestamp: "2026-02-02T00:00:03.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "the widgets are fine, and so is flibbertigibbet" }],
    },
  },
]);

const server = spawn(
  process.execPath,
  [path.join(ROOT, "server.js"), "--port", String(PORT), "--session-dir", FIXTURE_DIR],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  }
);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

function stopServer() {
  if (!server.killed) server.kill("SIGTERM");
}

try {
  check("server starts and answers /api/health", await waitForServer());

  const index = await fetch(`${BASE}/`);
  const html = await index.text();
  check("GET / returns 200", index.status === 200, `got ${index.status}`);
  check("page has the app title", html.includes("<title>pi-web</title>"));
  check("page links the stylesheet", html.includes('href="/style.css"'));
  check("page loads the frontend script", html.includes('src="/app.js"'));

  for (const asset of ["/style.css", "/app.js", "/favicon.svg"]) {
    const res = await fetch(`${BASE}${asset}`);
    check(`GET ${asset} returns 200`, res.status === 200, `got ${res.status}`);
  }

  const securityHeaders = (await fetch(`${BASE}/`)).headers;
  check("X-Content-Type-Options: nosniff", securityHeaders.get("x-content-type-options") === "nosniff");
  check("X-Frame-Options: DENY", securityHeaders.get("x-frame-options") === "DENY");
  check("Referrer-Policy: no-referrer", securityHeaders.get("referrer-policy") === "no-referrer");

  const config = await (await fetch(`${BASE}/api/config`)).json();
  check("/api/config reports a cwd", typeof config.cwd === "string" && config.cwd.length > 0);
  check("/api/config reports the pi binary", typeof config.piBin === "string" && config.piBin.length > 0);

  const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
  check("/api/sessions returns a list", Array.isArray(sessions.sessions));

  // Cross-session search: every channel (prompt, response, tool request, tool
  // result) is reachable, the system prompt and thinking blocks are not, and
  // the route sits behind the same localhost guards as everything else.
  const search = async (q) => (await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`)).json();
  const both = await search("flibbertigibbet");
  check("/api/search returns a hits list", Array.isArray(both.hits));
  check("/api/search reports truncation state", typeof both.truncated === "boolean");
  check(
    "/api/search reaches every workspace",
    new Set(both.hits.map((h) => h.cwd)).size === 2,
    JSON.stringify(both.hits.map((h) => h.cwd))
  );
  const channels = new Set(both.hits.map((h) => h.role));
  for (const role of ["user", "assistant", "tool", "toolResult"]) {
    check(`/api/search matches ${role} content`, channels.has(role), [...channels].join(","));
  }
  check("/api/search scopes hits to the matching entry", both.hits.every((h) => h.match.toLowerCase() === "flibbertigibbet"));
  check("/api/search returns a snippet around the match", both.hits.every((h) => h.before != null && h.after != null && h.entryId));

  const toolArg = await search("SEARCHTOOLARG");
  check("/api/search matches tool-call arguments", toolArg.hits.length > 0 && toolArg.hits.every((h) => h.role === "tool"));
  const toolOut = await search("SEARCHTOOLOUT");
  check("/api/search matches tool results", toolOut.hits.length > 0 && toolOut.hits.every((h) => h.role === "toolResult"));

  // Subagent child output is only in details.results[].finalOutput; searching it
  // must reach the child run even though the tool result text differs.
  const childOut = await search("SEARCHCHILDOUT");
  check("/api/search reaches subagent child output", childOut.hits.length === 1, JSON.stringify(childOut.hits.map((h) => h.toolName)));
  check("/api/search labels the subagent child by agent", childOut.hits[0]?.toolName === "subagent/reviewer", childOut.hits[0]?.toolName);
  check(
    "/api/search ignores the system prompt",
    (await search("SEARCHSYSTEMONLY")).hits.length === 0
  );
  check("/api/search ignores thinking blocks", (await search("SEARCHTHINKINGONLY")).hits.length === 0);
  check(
    "/api/search requires all terms",
    (await search("flibbertigibbet widgets")).hits.length === 1,
    JSON.stringify((await search("flibbertigibbet widgets")).hits.map((h) => h.role))
  );
  check("/api/search is case-insensitive", (await search("FLIBBERTIGIBBET")).hits.length === both.hits.length);
  const emptySearch = await search("");
  check("/api/search ignores an empty query", Array.isArray(emptySearch.hits) && emptySearch.hits.length === 0);
  const searchCrossOrigin = await fetch(`${BASE}/api/search?q=flibbertigibbet`, {
    headers: { Origin: "https://evil.example.com" },
  });
  check("cross-origin search is rejected", searchCrossOrigin.status === 403, `got ${searchCrossOrigin.status}`);

  const browse = await (await fetch(`${BASE}/api/browse?path=${encodeURIComponent(ROOT)}`)).json();
  check("/api/browse lists directories", Array.isArray(browse.dirs) && browse.dirs.includes("public"));

  // Guards: a foreign Host (DNS rebinding) and a foreign Origin (CSRF) must fail.
  // `fetch` refuses to override Host, so the Host case needs a raw request.
  const badHostStatus = await rawRequestStatus("/", { Host: "evil.example.com" });
  check("foreign Host is rejected", badHostStatus === 403, `got ${badHostStatus}`);

  const badOrigin = await fetch(`${BASE}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ client: "smoke" }),
  });
  check("cross-origin POST is rejected", badOrigin.status === 403, `got ${badOrigin.status}`);

  // Traversal: encoded and literal attempts must not serve files outside public/.
  for (const attempt of ["/../package.json", "/..%2fpackage.json", "/%2e%2e/server.js", "/../server.js"]) {
    const res = await fetch(`${BASE}${attempt}`, { redirect: "manual" });
    const body = res.status === 200 ? await res.text() : "";
    check(`traversal ${attempt} is not served`, res.status !== 200 || !body.includes('"name": "pi-web"'), `got ${res.status}`);
  }

  // A malformed command must be a clean 4xx, never a stack trace or a crash.
  const badCmd = await fetch(`${BASE}/api/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "smoke" }),
  });
  check("command without a type is rejected", badCmd.status === 400, `got ${badCmd.status}`);
  check("no stack trace leaks in the error body", !(await badCmd.text()).includes("at Object."));

  // /api/image must serve images only: a traversal-ish path, a relative path,
  // a non-image file and a missing file are all refused.
  const img = (q) => fetch(`${BASE}/api/image?${q}`);
  check("/api/image rejects a relative path", (await img("path=package.json")).status === 400);
  check("/api/image rejects an empty path", (await img("path=")).status === 400);
  check("/api/image 404s a missing file", (await img(`path=${encodeURIComponent("/tmp/pi-web-nope.png")}`)).status === 404);
  const notImage = await img(`path=${encodeURIComponent(path.join(ROOT, "server.js"))}`);
  check("/api/image refuses a non-image file", notImage.status === 415, `got ${notImage.status}`);
  const realPng = path.join(ROOT, "public", "favicon.svg");
  check("/api/image refuses SVG (no script-bearing types)", (await img(`path=${encodeURIComponent(realPng)}`)).status === 415);

  // Only run the agent-backed check when pi is actually installed: /api/open
  // succeeds either way, so ask the agent for its state and treat a 503 as
  // "no agent here" rather than a pass.
  const openRes = await fetch(`${BASE}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "smoke" }),
  });
  check("/api/open attaches a client", openRes.ok, `got ${openRes.status}`);

  const stateRes = await fetch(`${BASE}/api/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "smoke", type: "get_state" }),
  });
  if (stateRes.status === 503) {
    console.log("  skip  agent round-trip (pi not available)");
  } else {
    const body = await stateRes.json().catch(() => ({}));
    check("agent answers get_state", stateRes.ok && body?.success !== false, JSON.stringify(body).slice(0, 200));
  }

  check("server still alive after the request matrix", (await fetch(`${BASE}/api/health`)).ok);
} finally {
  stopServer();
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  if (serverLog.trim()) console.error(`\nserver log:\n${serverLog.trim()}`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
