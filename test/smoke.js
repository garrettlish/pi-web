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
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT || 3300 + Math.floor(Math.random() * 400));
const BASE = `http://127.0.0.1:${PORT}`;

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

const server = spawn(process.execPath, [path.join(ROOT, "server.js"), "--port", String(PORT)], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
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
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  if (serverLog.trim()) console.error(`\nserver log:\n${serverLog.trim()}`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
