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
// Follow-ups live in their own directory, so the smoke test exercises the real
// save/list/read/delete path without touching ~/.pi/followups.
const FOLLOWUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-followups-"));
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
  // The run's last turn, and the only one that settles: the answer text above
  // (a1) was mid-loop, so the summary scope must not reach it.
  {
    type: "message",
    id: "a4",
    parentId: "r2",
    timestamp: "2026-01-01T00:00:06.000Z",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "SEARCHSUMMARYANSWER the module is unused, nothing to change" }],
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
      stopReason: "stop",
      content: [{ type: "text", text: "the widgets are fine, and so is flibbertigibbet SEARCHRESPONSEONLY" }],
    },
  },
  // A run cut off by the user has an answer, but it is an interruption rather
  // than a conclusion, so the summary scope must not reach it.
  {
    type: "message",
    id: "u4",
    parentId: "a2",
    timestamp: "2026-02-02T00:00:04.000Z",
    message: { role: "user", content: [{ type: "text", text: "now check the gadget" }] },
  },
  {
    type: "message",
    id: "a5",
    parentId: "u4",
    timestamp: "2026-02-02T00:00:05.000Z",
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: "SEARCHABORTEDANSWER the gadget is" }],
    },
  },
]);

// A skill invocation is pi's expansion of a slash command: the whole SKILL.md
// wrapped in pi's own <skill> block, then the prompt the user typed. Its body is
// instruction text the agent reads, not something the user wrote, so the title
// and the prompt index must show the invocation and the prompt only.
writeFixture("--tmp-ws-gamma--", "2026-03-03T00-00-00-000Z_cccc.jsonl", [
  { type: "session", version: 3, id: "cccc", timestamp: "2026-03-03T00:00:00.000Z", cwd: "/tmp/ws-gamma" },
  {
    type: "message",
    id: "u3",
    parentId: null,
    timestamp: "2026-03-03T00:00:01.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            '<skill name="skill:review-helper" location="/tmp/skills/review-helper/SKILL.md">',
            "References are relative to /tmp/skills/review-helper.",
            "",
            "# Review Helper",
            "",
            "SKILLBODYONLY follow these steps when reviewing.",
            "</skill>",
            "",
            "SKILLPROMPTTERM please review the diff",
          ].join("\n"),
        },
      ],
    },
  },
]);

const server = spawn(
  process.execPath,
  [path.join(ROOT, "server.js"), "--port", String(PORT), "--session-dir", FIXTURE_DIR, "--followup-dir", FOLLOWUP_DIR],
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

/** Open an SSE stream and expose records as they arrive, so one stream can be
 *  read across several assertions (a second reader on the same body throws). */
async function sseClient(url) {
  const ctl = new AbortController();
  const res = await fetch(url, { signal: ctl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  const waiters = [];
  let buffer = "";
  let closed = false;
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            queue.push(JSON.parse(line.slice(6)));
          } catch {
            continue; // keepalive or malformed frame
          }
          wake();
        }
      }
    } catch {
      // aborted by close()
    }
    closed = true;
    wake();
  })();
  return {
    /** Records up to and including the first one `predicate` accepts; empty
     *  when the timeout expires or the stream ends first. */
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = queue.findIndex(predicate);
        if (i >= 0) return queue.splice(0, i + 1);
        const left = deadline - Date.now();
        if (closed || left <= 0) return [];
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    close() {
      ctl.abort();
    },
  };
}

/** Queue snapshot on (re)attach, driven by test/fake-pi.js so it needs no
 *  credentials. pi emits queue_update only when the queue changes, so without
 *  the snapshot a tab that switches away and back keeps an empty dock while
 *  the process still holds those messages. */
async function queueSnapshotChecks() {
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const fakeBin = path.join(ROOT, "test", "fake-pi.js");
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "server.js"), "--port", String(port), "--session-dir", FIXTURE_DIR, "--pi", fakeBin],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const post = async (pathname, body) =>
    (await fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })).json();
  const sessionA = path.join(FIXTURE_DIR, "--queue-ws-a--", "2026-03-01T00-00-00-000Z_qa.jsonl");
  const sessionB = path.join(FIXTURE_DIR, "--queue-ws-b--", "2026-03-02T00-00-00-000Z_qb.jsonl");
  // A session's process runs in the cwd its header records, so this fixture's
  // cwd has to exist — otherwise the fake binary cannot be spawned at all.
  writeFixture("--queue-ws-a--", path.basename(sessionA), [
    { type: "session", version: 3, id: "qa", timestamp: "2026-03-01T00:00:00.000Z", cwd: FIXTURE_DIR },
  ]);
  writeFixture("--queue-ws-b--", path.basename(sessionB), [
    { type: "session", version: 3, id: "qb", timestamp: "2026-03-02T00:00:00.000Z", cwd: FIXTURE_DIR },
  ]);
  const holdsQueued = (r) => Array.isArray(r?.steering) && r.steering.includes("QUEUED-ONE");

  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    // One stream for the whole scenario: the server keeps a single live stream
    // per client id, exactly like the app's one EventSource per tab.
    const es = await sseClient(`${base}/api/events?client=q1`);
    await es.waitFor((r) => r?.event === "hello", 3000);
    await post("/api/open", { client: "q1", sessionFile: sessionA });
    const steered = await post("/api/cmd", { client: "q1", type: "steer", message: "QUEUED-ONE" });
    check("steer is accepted as queued", steered?.data?.disposition === "queued", JSON.stringify(steered).slice(0, 160));
    const before = await es.waitFor(holdsQueued);
    check("queue_update reaches the attached tab", before.some(holdsQueued), JSON.stringify(before).slice(0, 200));

    // Switch to another session and back. The queue lives in session A's
    // process; nothing in the switch produces a queue_update, so the re-attach
    // has to replay the snapshot or the dock comes back empty.
    await post("/api/open", { client: "q1", sessionFile: sessionB });
    await post("/api/open", { client: "q1", sessionFile: sessionA });
    const replay = await es.waitFor(holdsQueued);
    check("re-attaching a session replays its pending queue", replay.some(holdsQueued), JSON.stringify(replay).slice(0, 200));

    // An EventSource reconnect uses the same client id on a new stream; the
    // tab missed nothing but must still be told what is pending.
    es.close();
    const reconnected = await sseClient(`${base}/api/events?client=q1`);
    const afterReconnect = await reconnected.waitFor(holdsQueued, 3000);
    check(
      "a reconnected event stream replays the pending queue",
      afterReconnect.some(holdsQueued),
      JSON.stringify(afterReconnect).slice(0, 200)
    );

    await post("/api/cmd", { client: "q1", type: "clear_queue" });
    const cleared = await reconnected.waitFor((r) => Array.isArray(r?.steering) && !r.steering.length, 5000);
    check("clearing the queue is broadcast", cleared.length > 0, JSON.stringify(cleared).slice(0, 200));

    // Nothing pending: a re-attach must stay silent rather than flash an
    // empty dock back onto the screen.
    reconnected.close();
    const quiet = await sseClient(`${base}/api/events?client=q1`);
    const snapshots = await quiet.waitFor((r) => Array.isArray(r?.steering), 800);
    check("an empty queue sends no snapshot", snapshots.length === 0, JSON.stringify(snapshots).slice(0, 200));
    quiet.close();
  } finally {
    child.kill("SIGTERM");
    if (failures && log.trim()) console.error(`\nqueue-snapshot server log:\n${log.trim()}`);
  }
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

  // The resources panel reads MCP state through `pi mcp list --json`, which pi
  // can answer with no servers configured, with servers that fail to connect,
  // or (when pi is missing) not at all. All three are 200s with a servers/errors
  // pair: a disconnected server is a state to display, not a failed request.
  const mcpRes = await fetch(`${BASE}/api/mcp`);
  const mcp = await mcpRes.json().catch(() => ({}));
  check("/api/mcp answers with a server list", mcpRes.status === 200 && Array.isArray(mcp.servers), `got ${mcpRes.status}`);
  check("/api/mcp answers with an errors list", Array.isArray(mcp.errors), JSON.stringify(mcp).slice(0, 200));

  // Follow-ups: a summary the user kept, stored under the configured directory
  // and readable without pi or the session it came from. The write is the real
  // one — there is no separate fixture path — and the read must not need the
  // session file to exist.
  const emptyFollowups = await (await fetch(`${BASE}/api/followups`)).json();
  check("/api/followups starts empty", Array.isArray(emptyFollowups.followups) && emptyFollowups.followups.length === 0);
  const followupText = "## Findings\n\nThe module is unused.\n\n| file | note |\n| --- | --- |\n| a.js | dead |\n";
  const saved = await fetch(`${BASE}/api/followups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "FollowupTitle", text: followupText, cwd: "/tmp/ws-alpha" }),
  });
  const savedBody = await saved.json().catch(() => ({}));
  check("/api/followups saves a summary", saved.ok && typeof savedBody.followup?.id === "string", JSON.stringify(savedBody).slice(0, 200));
  const followupId = savedBody.followup?.id;
  const savedFile = path.join(FOLLOWUP_DIR, `${followupId}.json`);
  check("a follow-up is one JSON file on disk", fs.existsSync(savedFile), savedFile);
  const listed = await (await fetch(`${BASE}/api/followups`)).json();
  check(
    "/api/followups lists the saved summary with metadata",
    listed.followups.length === 1 && listed.followups[0].title === "FollowupTitle" && listed.followups[0].chars === followupText.length,
    JSON.stringify(listed).slice(0, 200)
  );
  check(
    "/api/followups lists metadata without the body",
    listed.followups[0]?.text === undefined,
    JSON.stringify(listed.followups[0]).slice(0, 200)
  );
  const opened = await (await fetch(`${BASE}/api/followups/${followupId}`)).json();
  check(
    "/api/followups returns the stored Markdown",
    opened.followup?.text === followupText,
    JSON.stringify(opened).slice(0, 200)
  );
  check("/api/followups 404s an unknown id", (await fetch(`${BASE}/api/followups/${"-".repeat(10)}`)).status === 404);
  check("/api/followups rejects an empty body", (await fetch(`${BASE}/api/followups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x", text: "   " }),
  })).status === 400);
  const traversal = await fetch(`${BASE}/api/followups/${encodeURIComponent("..%2F..%2Fetc%2Fpasswd")}`);
  check("a follow-up id cannot escape the follow-up directory", traversal.status === 404 || traversal.status === 400, `got ${traversal.status}`);
  const removed = await fetch(`${BASE}/api/followups/${followupId}`, { method: "DELETE" });
  check("/api/followups deletes a summary", removed.ok && !fs.existsSync(savedFile), `got ${removed.status}`);
  check("deleting a follow-up twice is not an error", (await fetch(`${BASE}/api/followups/${followupId}`, { method: "DELETE" })).ok);

  const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
  check("/api/sessions returns a list", Array.isArray(sessions.sessions));

  // Cross-session search: every channel (prompt, response, tool request, tool
  // result) is reachable, the system prompt and thinking blocks are not, and
  // the route sits behind the same localhost guards as everything else.
  const search = async (q, extra = "") => (await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}${extra}`)).json();
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

  // scope=prompts narrows the same index to user prompts: agent-authored
  // channels (responses, tool requests, tool results, subagent child output)
  // must disappear, and prompts from every workspace must still be reachable.
  const promptHits = await search("flibbertigibbet", "&scope=prompts");
  check(
    "/api/search scope=prompts returns only user prompts",
    promptHits.hits.length > 0 && promptHits.hits.every((h) => h.role === "user"),
    JSON.stringify(promptHits.hits.map((h) => h.role))
  );
  check(
    "/api/search scope=prompts is narrower than the full corpus",
    promptHits.hits.length < both.hits.length,
    `${promptHits.hits.length} of ${both.hits.length}`
  );
  check(
    "/api/search scope=prompts reaches prompts in every workspace",
    new Set([...(await search("flibbertigibbet", "&scope=prompts")).hits, ...(await search("widgets", "&scope=prompts")).hits].map((h) => h.cwd))
      .size === 2,
    JSON.stringify(promptHits.hits.map((h) => h.cwd))
  );
  for (const [label, q] of [["tool-call arguments", "SEARCHTOOLARG"], ["tool results", "SEARCHTOOLOUT"], ["subagent child output", "SEARCHCHILDOUT"], ["responses", "SEARCHRESPONSEONLY"]]) {
    check(`/api/search scope=prompts skips ${label}`, (await search(q, "&scope=prompts")).hits.length === 0);
  }
  check(
    "/api/search scope=prompts finds a prompt in the other workspace",
    (await search("widgets", "&scope=prompts")).hits.some((h) => h.cwd === "/tmp/ws-beta")
  );

  // scope=summary narrows the same index to the answer each run concluded with:
  // the last turn of the run, and only when it settled. Answer text from a mid
  // tool loop (a1), a prompt, a tool request/result and a run cut off by the
  // user (a5) must all stay out.
  const summaryHits = await search("SEARCHSUMMARYANSWER", "&scope=summary");
  check(
    "/api/search scope=summary finds a settled run's answer",
    summaryHits.hits.length === 1 && summaryHits.hits[0].role === "assistant",
    JSON.stringify(summaryHits.hits.map((h) => [h.role, h.before]))
  );
  check(
    "/api/search scope=summary skips answer text from mid tool loop",
    (await search("exports nothing useful", "&scope=summary")).hits.length === 0
  );
  check(
    "/api/search scope=summary skips an aborted run",
    (await search("SEARCHABORTEDANSWER", "&scope=summary")).hits.length === 0
  );
  check(
    "/api/search scope=summary finds the summary in every workspace",
    new Set([...summaryHits.hits, ...(await search("SEARCHRESPONSEONLY", "&scope=summary")).hits].map((h) => h.cwd)).size === 2,
    JSON.stringify((await search("SEARCHRESPONSEONLY", "&scope=summary")).hits.map((h) => h.cwd))
  );
  for (const [label, q] of [["prompts", "unrelated request"], ["tool-call arguments", "SEARCHTOOLARG"], ["tool results", "SEARCHTOOLOUT"], ["subagent child output", "SEARCHCHILDOUT"]]) {
    check(`/api/search scope=summary skips ${label}`, (await search(q, "&scope=summary")).hits.length === 0);
  }
  check("/api/search reports scope=summary truncation state", typeof summaryHits.truncated === "boolean");

  // A skill invocation is pi's expansion of a slash command: the whole SKILL.md
  // inside pi's <skill> block, then the prompt. The body is instruction text the
  // agent reads, not something the user wrote, so it must not join the prompt
  // index — one definition would otherwise match every query, in every session
  // that ever used that skill, and outrank the prompts that asked for anything.
  const skillPrompt = await search("SKILLPROMPTTERM", "&scope=prompts");
  check("/api/search scope=prompts finds the prompt after a skill block", skillPrompt.hits.length === 1);
  check(
    "/api/search skips a skill body in the prompt index",
    (await search("SKILLBODYONLY", "&scope=prompts")).hits.length === 0
  );
  check(
    "/api/search names the skill in a prompt snippet instead of the raw tag",
    !skillPrompt.hits[0]?.before.includes("<skill name=") && skillPrompt.hits[0]?.before.includes("review-helper"),
    JSON.stringify(skillPrompt.hits[0]?.before)
  );
  check(
    "/api/sessions titles a skill session by the skill and the prompt",
    (() => {
      const title = sessions.sessions.find((s) => s.cwd === "/tmp/ws-gamma")?.title || "";
      return title.includes("review-helper") && title.includes("SKILLPROMPTTERM") && !title.includes("SKILLBODYONLY");
    })(),
    JSON.stringify(sessions.sessions.find((s) => s.cwd === "/tmp/ws-gamma")?.title)
  );
  const unknownScope = await search("flibbertigibbet", "&scope=bogus");
  check("/api/search treats an unknown scope as the full corpus", unknownScope.hits.length === both.hits.length);
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

  // Static assets must revalidate: a conditional request for an unchanged file
  // has to be a bodyless 304, otherwise every reload re-downloads app.js.
  const asset = await fetch(`${BASE}/app.js`);
  const etag = asset.headers.get("etag");
  await asset.text();
  check("static assets carry an ETag", !!etag, `etag=${etag}`);
  const revalidated = await fetch(`${BASE}/app.js`, { headers: { "If-None-Match": etag } });
  check("unchanged asset revalidates as 304", revalidated.status === 304, `got ${revalidated.status}`);
  const stale = await fetch(`${BASE}/app.js`, { headers: { "If-None-Match": '"0-0"' } });
  check("stale ETag still returns the file", stale.status === 200 && (await stale.text()).length > 0, `got ${stale.status}`);

  // A closed event stream must not leak its client entry: every page load used
  // to leave one behind, and every broadcast walked all of them. Each stream
  // here reads its first chunk, because a request aborted before the response
  // headers never registers a client at all. The grace period keeps a
  // reconnecting EventSource attached, so this asserts the map stays bounded
  // rather than that it drops to zero immediately.
  const openThenClose = async (id) => {
    const ctl = new AbortController();
    const res = await fetch(`${BASE}/api/events?client=${id}`, { signal: ctl.signal });
    await res.body.getReader().read();
    ctl.abort();
  };
  for (let i = 0; i < 260; i++) await openThenClose(`churn-${i}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  const healthAfter = await (await fetch(`${BASE}/api/health`)).json();
  check(
    "closed event streams do not accumulate past the cap",
    healthAfter.clients <= 200,
    `clients=${healthAfter.clients} after 260 closed streams`
  );

  // Queue snapshot on re-attach, driven by test/fake-pi.js so it needs no
  // credentials: pi emits queue_update only when the queue changes, so a tab
  // that switches away and back must be told what its process still holds —
  // otherwise the dock looks empty while the messages are in fact pending.
  await queueSnapshotChecks();
} finally {
  stopServer();
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.rmSync(FOLLOWUP_DIR, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  if (serverLog.trim()) console.error(`\nserver log:\n${serverLog.trim()}`);
  process.exit(1);
}
console.log("\nall smoke checks passed");
