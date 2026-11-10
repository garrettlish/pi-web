/* pi-web frontend: talks to the local bridge server (server.js) which
 * proxies a `pi --mode rpc` subprocess. No framework, no build step. */
"use strict";

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** parse a trusted static markup string into DOM nodes. DOMParser documents
 *  are inert — scripts never run — and every current caller passes either
 *  pre-escaped content (renderMarkdown) or hardcoded SVG markup (DIR_ICON). */
function htmlFragment(markup) {
  return [...new DOMParser().parseFromString(markup, "text/html").body.childNodes];
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.replaceChildren(...htmlFragment(v));
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function fmtTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(d) {
  if (d == null) return "";
  return d >= 1000 ? `${(d / 1000).toFixed(1)}s` : `${Math.round(d)}ms`;
}
function fmtCost(c) {
  if (!c) return "$0";
  return c >= 0.01 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}
function fmtTokens(n) {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
/** exact token counts for the header/context popover: 60000 -> "60,000" */
function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}
/** compact k-unit counts for the ctx pill: 60000 -> "60k", 1000000 -> "1,000k" */
function fmtK(n) {
  if (n == null || isNaN(n)) return "—";
  if (n < 1000) return Math.round(n).toLocaleString("en-US");
  const k = n / 1000;
  return `${Number.isInteger(k) ? k.toLocaleString("en-US") : k.toFixed(1)}k`;
}

function toast(message, type = "info", ms = 5000) {
  const t = el("div", { class: `toast ${type}`, text: message });
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

/** keydown handler that activates an element with Enter/Space (for focusable rows) */
function onActivate(fn) {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const TAB_KEY = "piweb-sidebar-tab";
const SIDEBAR_COLLAPSED_KEY = "piweb-sidebar-collapsed";
const PROMPT_HISTORY_KEY = "piweb-prompt-history";
const PROMPT_HISTORY_MAX = 200;

const state = {
  items: [], // transcript items (ordered, active branch + live)
  executions: new Map(), // toolCallId -> { status, updates[], result, isError, durationMs }
  isStreaming: false,
  isCompacting: false,
  sessionFile: null,
  sessionId: null,
  sessionName: null,
  leafId: null, // active-branch leaf from get_entries
  model: null,
  /** Date.now() of the last user-initiated model pick; guards against stale
   *  get_state snapshots (issued before the pick) resetting the selection */
  modelPickedAt: 0,
  models: [],
  commands: [], // discoverable slash commands (extension commands, prompt templates, skills)
  thinkingLevel: null,
  thinkingLevels: [],
  stats: null,
  queued: { steering: [], followUp: [] },
  sessions: [],
  cwd: null,
  /** selected workspace cwd; null = workspace list view; undefined = not yet initialized */
  workspace: undefined,
  /** sidebar view: "recent" = flat list across all workspaces, "workspaces" = two-level */
  sidebarTab: localStorage.getItem(TAB_KEY) === "workspaces" ? "workspaces" : "recent",
};

// ---------------------------------------------------------------------------
// sidebar collapse / expand
// ---------------------------------------------------------------------------
function sidebarCollapsed() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
}

function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  document.getElementById("btn-sidebar-expand").classList.toggle("hidden", !collapsed);
}

function toggleSidebar() {
  const collapsed = !sidebarCollapsed();
  if (collapsed) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
  else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  applySidebarCollapsed(collapsed);
}

document.getElementById("btn-sidebar-collapse").addEventListener("click", toggleSidebar);
document.getElementById("btn-sidebar-expand").addEventListener("click", toggleSidebar);
applySidebarCollapsed(sidebarCollapsed());

// ---------------------------------------------------------------------------
// server bridge
// ---------------------------------------------------------------------------
// One client id per browser tab: each tab attaches to its own pi session
// process on the server, so tabs run independent sessions in parallel.
const CLIENT_ID = crypto.randomUUID();

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function cmd(type, extra = {}) {
  const res = await fetch("/api/cmd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: CLIENT_ID, type, ...extra }),
  });
  const body = await res.json();
  if (body && body.success === false) {
    const err = new Error(body.error || `${type} failed`);
    err.response = body;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// markdown (small subset, all input pre-escaped)
// ---------------------------------------------------------------------------
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/** true for a markdown table separator row, e.g. "| --- | :---: |" */
function isTableSep(line) {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** true when line i is a table header row (contains | and next line is a separator) */
function isTableStart(lines, i) {
  return lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]);
}

function renderMarkdown(text) {
  const out = [];
  const lines = esc(text).split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      const lang = fence[1] ? `<span class="code-lang">${esc(fence[1])}</span>` : "";
      // buf is already HTML-escaped (renderMarkdown escapes up front), which also
      // makes it attribute-safe; dataset.code decodes it back to the raw text
      out.push(
        `<div class="code-block"><div class="code-head">${lang}<button class="code-copy" type="button" data-code="${buf.join("\n")}">copy</button></div><pre><code>${buf.join("\n")}</code></pre></div>`
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const buf = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        buf.push(`<li>${inlineMd(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${buf.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(inlineMd(lines[i].replace(/^\s*>\s?/, "")));
        i++;
      }
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
      continue;
    }
    // table: | header | ... | followed by a | --- | ... | separator row
    if (isTableStart(lines, i)) {
      const splitRow = (row) => {
        let t = row.trim();
        if (t.startsWith("|")) t = t.slice(1);
        if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
        return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      };
      const head = splitRow(lines[i]);
      // column alignment from the separator row: :--- / :---: / ---:
      const aligns = splitRow(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : null
      );
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cell = (text, tag, k) =>
        `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inlineMd(text)}</${tag}>`;
      const thead = `<thead><tr>${head.map((c, k) => cell(c, "th", k)).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c, k) => cell(c, "td", k)).join("")}</tr>`).join("")}</tbody>`;
      out.push(`<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    // paragraph: gather until blank line
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|\s*>\s?)/.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      buf.push(inlineMd(lines[i]));
      i++;
    }
    out.push(`<p>${buf.join("<br>")}</p>`);
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// transcript item model
// ---------------------------------------------------------------------------

function blocksOf(message) {
  // Normalize message content into our block list.
  if (!message) return [];
  if (typeof message.content === "string") {
    return message.role === "assistant" ? [] : [{ type: "text", text: message.content }];
  }
  const blocks = [];
  for (const b of message.content || []) {
    if (b.type === "text") blocks.push({ type: "text", text: b.text });
    else if (b.type === "thinking") blocks.push({ type: "thinking", thinking: b.thinking || "", redacted: b.redacted });
    else if (b.type === "toolCall")
      blocks.push({ type: "toolcall", call: { id: b.id, name: b.name, arguments: b.arguments || {} } });
    else if (b.type === "image") blocks.push({ type: "image", data: b.data, mimeType: b.mimeType });
  }
  return blocks;
}

/** Attach a toolResult message to the toolCall block that issued it, in place.
 *  Live events deliver a result as its own message pair; the transcript renders
 *  results inside their call's block, so both the start and the end of that
 *  pair resolve it here instead of creating a row. Returns false when no block
 *  claims the call — a result left over from a branch the view no longer shows,
 *  which is the only case that deserves an orphan row. */
function attachToolResult(m) {
  const toolCallId = m?.toolCallId;
  if (!toolCallId) return false;
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.kind !== "assistant") continue;
    const block = item.blocks.find((b) => b.type === "toolcall" && b.call.id === toolCallId);
    if (!block) continue;
    block.result = { content: m.content, details: m.details, isError: m.isError, usage: m.usage, ts: m.timestamp };
    item.dirty = true;
    return true;
  }
  return false;
}

/** Build transcript items from ordered session entries (active branch). */
function buildItemsFromEntries(entries) {
  const items = [];
  const callIndex = new Map(); // toolCallId -> {item, blockIdx}

  const findCall = (toolCallId) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind !== "assistant") continue;
      const bi = it.blocks.findIndex((b) => b.type === "toolcall" && b.call.id === toolCallId);
      if (bi >= 0) return { item: it, blockIdx: bi };
    }
    return null;
  };

  for (const entry of entries) {
    if (entry.type !== "message") {
      if (entry.type === "compaction") {
        items.push({
          kind: "summary",
          title: `Compaction (${fmtTokens(entry.tokensBefore)} tokens summarized)`,
          text: entry.summary,
        });
      } else if (entry.type === "branch_summary") {
        items.push({ kind: "summary", title: "Branch summary", text: entry.summary });
      } else if (entry.type === "model_change") {
        items.push({ kind: "notice", text: `model → ${entry.provider}/${entry.modelId}` });
      } else if (entry.type === "thinking_level_change") {
        items.push({ kind: "notice", text: `thinking level → ${entry.thinkingLevel}` });
      } else if (entry.type === "usage") {
        items.push({
          kind: "notice",
          text: `usage [${entry.kind}] ${entry.model || entry.provider || ""} ${fmtTokens(entry.usage?.totalTokens)} tok · ${fmtCost(entry.usage?.cost?.total)}`,
        });
      } else if (entry.type === "label") {
        items.push({ kind: "notice", text: `label: ${entry.label}` });
      } else if (entry.type === "session_info") {
        // shown in header
      } else if (entry.type === "custom") {
        items.push({ kind: "notice", text: `custom entry [${entry.customType}]`, data: entry });
      } else if (entry.type === "context_edit") {
        items.push({ kind: "notice", text: "context edit", data: entry });
      }
      continue;
    }

    const m = entry.message;
    const ts = m?.timestamp;
    switch (m?.role) {
      case "system": {
        const text = typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text).join("\n");
        items.push({ kind: "system", text, entry });
        break;
      }
      case "user": {
        const images = [];
        let text = "";
        if (typeof m.content === "string") text = m.content;
        else
          for (const b of m.content || []) {
            if (b.type === "text") text += (text ? "\n" : "") + b.text;
            else if (b.type === "image") images.push(b);
          }
        items.push({ kind: "user", text, images, ts, entry });
        break;
      }
      case "assistant": {
        items.push({
          kind: "assistant",
          blocks: blocksOf(m),
          meta: assistantMeta(m),
          streaming: false,
          ts,
          entry,
        });
        const it = items[items.length - 1];
        it.blocks.forEach((b, bi) => {
          if (b.type === "toolcall") callIndex.set(b.call.id, { item: it, blockIdx: bi });
        });
        break;
      }
      case "toolResult": {
        const found = findCall(m.toolCallId);
        if (found) {
          found.item.blocks[found.blockIdx].result = {
            content: m.content,
            details: m.details,
            isError: m.isError,
            usage: m.usage,
            ts,
          };
        } else {
          items.push({ kind: "toolResultOrphan", message: m, ts, entry });
        }
        break;
      }
      case "bashExecution": {
        items.push({ kind: "bash", message: m, ts, entry });
        break;
      }
      case "custom": {
        const text = typeof m.content === "string" ? m.content : (m.content || []).map((b) => b.text || "[image]").join("\n");
        items.push({ kind: "summary", title: `custom [${m.customType}]`, text, data: m });
        break;
      }
      case "branchSummary": {
        items.push({ kind: "summary", title: "Branch summary", text: m.summary, ts });
        break;
      }
      case "compactionSummary": {
        items.push({
          kind: "summary",
          title: `Compaction summary (${fmtTokens(m.tokensBefore)} tokens before)`,
          text: m.summary,
          ts,
        });
        break;
      }
      default:
        items.push({ kind: "notice", text: `message [${m?.role}]`, data: m });
    }
  }
  return items;
}

function assistantMeta(m) {
  if (!m || m.role !== "assistant") return null;
  const u = m.usage || {};
  return {
    model: m.model,
    provider: m.provider,
    usage: u,
    stopReason: m.stopReason,
    errorMessage: m.errorMessage,
    ts: m.timestamp,
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function argsSummary(call) {
  const a = call.arguments || {};
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path + (a.command ? `  ${a.command}` : "");
  if (typeof a.file_path === "string") return a.file_path;
  if (typeof a.query === "string") return a.query;
  if (typeof a.pattern === "string") return a.pattern;
  if (typeof a.url === "string") return a.url;
  const keys = Object.keys(a);
  if (keys.length) return keys.map((k) => `${k}=${JSON.stringify(a[k]).slice(0, 40)}`).join(" ");
  return "";
}

function resultText(content) {
  if (!content) return "";
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : JSON.stringify(b)))
    .join("\n");
}

function jsonBlock(obj, cls = "tc-json") {
  return el("pre", { class: cls, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) });
}

/** true when a tool response contains a unified diff body (hunk headers) */
function looksLikeDiff(text) {
  let hunks = 0, changes = 0;
  for (const line of text.split("\n")) {
    if (/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) hunks++;
    else if (line.startsWith("+") || line.startsWith("-")) changes++;
    if (hunks > 0 && changes > 0) return true;
  }
  return false;
}

/** one diff row: sign gutter, old/new line-number gutters, then the body */
function diffRow({ sign = "", oldNum = "", newNum = "", text = "", cls = "" }) {
  const row = el("div", { class: `dline${cls ? ` ${cls}` : ""}` });
  row.append(
    el("span", { class: "dsign", text: sign || " " }),
    el("span", { class: "dnum", text: String(oldNum) }),
    el("span", { class: "dnum", text: String(newNum) }),
    el("span", { class: "dbody", text: text || " " })
  );
  return row;
}

/** colored side-by-side-numbered diff view, GitHub style: green additions,
 *  red deletions, blue hunk/file headers, gray skipped-context markers.
 *  Accepts two shapes:
 *  - pi edit diffs: rows like "+12 body" / "-  5 body" (sign, space-padded
 *    line number, body), " 12 body" for context and "     ..." skip markers —
 *    these never carry @@ hunk headers
 *  - unified diffs: @@ hunk headers, ---/+++ file headers, +/-/space rows —
 *    any preamble before the first hunk stays plain */
function diffBlock(text) {
  const wrap = el("div", { class: "tc-text tc-diff" });
  const lines = String(text ?? "").split("\n");
  // @@ hunk headers only appear in unified diffs; without one, rows are
  // pi-edit rows, so a stat line like "+9 -6" is never colored
  const isUnified = lines.some((l) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(l));
  let inUnified = false;
  let oldNum = 0, newNum = 0;
  for (const line of lines) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      // unified hunk header: seed the counters so +/-/context rows track both
      // sides from here on
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNum = m ? parseInt(m[1], 10) : 0;
      newNum = m ? parseInt(m[2], 10) : 0;
      inUnified = true;
      wrap.append(diffRow({ cls: "dhunk", text: line }));
      continue;
    }
    if (inUnified) {
      if (/^(---|\+\+\+) /.test(line)) {
        wrap.append(diffRow({ cls: "dfile", text: line }));
      } else if (/^\\ No newline/.test(line)) {
        wrap.append(diffRow({ cls: "dmeta", text: line }));
      } else if (line.startsWith("+")) {
        wrap.append(diffRow({ cls: "dadd", sign: "+", newNum: newNum++, text: line.slice(1) }));
      } else if (line.startsWith("-")) {
        wrap.append(diffRow({ cls: "ddel", sign: "-", oldNum: oldNum++, text: line.slice(1) }));
      } else {
        wrap.append(diffRow({ oldNum: oldNum++, newNum: newNum++, text: line.slice(1) }));
      }
      continue;
    }
    if (!isUnified) {
      // pi edit diff row: sign, space-padded line number, body
      if (/^ *\.{3}$/.test(line)) {
        wrap.append(diffRow({ cls: "dskip", text: line.trim() }));
      } else {
        const m = line.match(/^([+-]?)\s*(\d+)\s(.*)$/);
        if (m) {
          const num = parseInt(m[2], 10);
          if (m[1] === "+") {
            wrap.append(diffRow({ cls: "dadd", sign: "+", newNum: num, text: m[3] }));
          } else if (m[1] === "-") {
            wrap.append(diffRow({ cls: "ddel", sign: "-", oldNum: num, text: m[3] }));
          } else {
            wrap.append(diffRow({ oldNum: num, newNum: num, text: m[3] }));
          }
        } else {
          // headers or plain preamble — no coloring
          wrap.append(diffRow({ text: line }));
        }
      }
      continue;
    }
    wrap.append(diffRow({ text: line }));
  }
  return wrap;
}

/** added/deleted line counts for a pi edit diff (lines look like "+12 text"
 *  / "-  5 text" — sign, space-padded line number, then the line body) */
function editDiffStats(diffText) {
  let added = 0, deleted = 0;
  for (const line of String(diffText ?? "").split("\n")) {
    if (/^\+\s*\d+\s/.test(line)) added++;
    else if (/^-\s*\d+\s/.test(line)) deleted++;
  }
  return { added, deleted };
}

/** derive the live view state for one tool call block (shared by the row and
 *  the popup, so both agree on status, result and duration) */
function toolcallState(block) {
  const call = block.call;
  const ex = state.executions.get(call.id);
  const result = block.result || (ex && ex.result != null ? { content: ex.result.content, isError: ex.isError, details: ex.result.details } : null);
  const exec = ex || { status: block.result ? "done" : "pending", updates: [] };
  if (block.result) exec.status = block.result.isError ? "error" : "ok";
  const statusText = exec.status === "running" ? "running" : exec.status === "pending" ? "queued" : result?.isError || exec.isError ? "error" : "done";
  return { call, ex, result, exec, statusText };
}

// Tool output is unbounded (a grep over a repo, a full file read). The popup
// scrolls, so text is shown in full up to this cap instead of being clipped
// behind a "show all" toggle.
const MAX_TOOL_TEXT = 200000;
function capText(t) {
  const s = String(t ?? "");
  return s.length > MAX_TOOL_TEXT ? `${s.slice(0, MAX_TOOL_TEXT)}\n… truncated (${s.length} chars total)` : s;
}

/** True when a tool response carries no image block but the result payload is
 *  only image metadata — the shape a file-reading tool returns for a picture
 *  it cannot inline ({content: "", totalLines: 0, fileSize: N}). In that case
 *  the popup can still show the picture by asking the server for the bytes at
 *  the path the call names. */
function imageMetadataPath(call, result) {
  if (!result || result.isError) return null;
  const content = result.content || [];
  if (content.some((b) => b && b.type === "image")) return null;
  const target = call.arguments?.path ?? call.arguments?.file_path ?? call.arguments?.file;
  if (typeof target !== "string" || !target.startsWith("/")) return null;
  const text = content.map((b) => (b && b.type === "text" ? b.text : "")).join("").trim();
  if (!text) return null;
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    return null;
  }
  // Only the empty-content metadata shape: a text result that happens to sit
  // next to a path must never turn into an unrequested file fetch.
  if (!meta || typeof meta !== "object") return null;
  if (typeof meta.fileSize !== "number" || meta.content !== "") return null;
  if (!/\.(png|jpe?g|gif|webp)$/i.test(target)) return null;
  return target;
}

/** Full-window image viewer. Clicking a picture inside a tool popup must not
 *  replace that popup: openPopup() swaps the modal's whole body, which is why
 *  the request/response disappeared. And the modal is only 860px wide, so a
 *  "zoomed" image there renders no bigger than the thumbnail. This overlay
 *  sits above the modal and sizes the picture against the window instead. */
function openImageViewer(src, alt = "tool result image") {
  const img = $("#image-overlay-img");
  img.src = src;
  img.alt = alt;
  $("#image-overlay").classList.remove("hidden");
}
function closeImageViewer() {
  const overlay = $("#image-overlay");
  if (overlay.classList.contains("hidden")) return;
  overlay.classList.add("hidden");
  $("#image-overlay-img").removeAttribute("src");
}
// click anywhere (the image included) dismisses it — the cursor says zoom-out
$("#image-overlay").addEventListener("click", closeImageViewer);

/** clickable image that enlarges into the viewer above. A failed fetch (the
 *  file is gone, or the server refuses it) is reported in place: a broken-image
 *  icon in the middle of a tool popup says nothing about why. */
function imageEl(src) {
  const img = el("img", { src, alt: "tool result image", title: "Click to enlarge", onclick: () => openImageViewer(src) });
  img.addEventListener("error", () => {
    img.replaceWith(el("div", { class: "tc-text dim", text: `image could not be loaded: ${src.startsWith("data:") ? "inline image data is invalid" : decodeURIComponent(src)}` }));
  });
  return el("div", { class: "tc-image-wrap" }, img);
}

/** image section for a tool result, from an inline block or a served path */
function imageResultSection(title, blocks) {
  const sec = el("div", { class: "tc-section" }, el("div", { class: "tc-label", text: title }));
  for (const src of blocks) sec.append(imageEl(src));
  return sec;
}

// ---------------------------------------------------------------------------
// subagent runs
// ---------------------------------------------------------------------------
// The subagents extension reports a run through the generic tool channel: a
// `subagent` call whose result carries `details.results[]` (one row per child)
// plus a `progress` snapshot that is re-sent whole on every
// tool_execution_update. Everything below reads only that documented shape —
// unknown fields are ignored, so a newer extension version degrades to the
// generic tool view instead of breaking the transcript.
const SUBAGENT_TOOL = "subagent";
/** children listed under the card head; the popup holds the rest */
const SUBAGENT_INLINE_MAX = 6;
const REDACTED_TASK = "[prompt redacted]";

/** Child task texts from the call arguments, in launch order. The results
 *  themselves redact `task`, so the request is the only place the prompt the
 *  user actually saw still exists. */
function subagentTasks(call) {
  const a = call?.arguments || {};
  const out = [];
  const push = (agent, task) =>
    out.push({ agent: typeof agent === "string" && agent ? agent : null, task: typeof task === "string" ? task : "" });
  if (Array.isArray(a.tasks)) for (const t of a.tasks) push(t?.agent, t?.task);
  if (Array.isArray(a.chain)) {
    for (const step of a.chain) {
      if (Array.isArray(step?.parallel)) for (const t of step.parallel) push(t?.agent, t?.task);
      else push(step?.agent, step?.task);
    }
  }
  if (!out.length && (a.agent || a.task)) push(a.agent, a.task);
  return out;
}

/** Most recent streamed details snapshot of a running subagent call. */
function liveSubagentDetails(exec) {
  const updates = exec?.updates || [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const d = updates[i]?.details;
    if (d && Array.isArray(d.results)) return d;
  }
  return null;
}

function subagentStatus(progressStatus, exitCode, error) {
  if (["pending", "running", "detached", "completed", "failed"].includes(progressStatus)) return progressStatus;
  if (exitCode != null) return exitCode === 0 ? "completed" : "failed";
  return error ? "failed" : "completed";
}

/** css tone for a child state: "running" | "ok" | "error" | "" */
function subagentTone(status) {
  if (status === "running" || status === "pending") return "running";
  if (status === "failed") return "error";
  if (status === "completed") return "ok";
  return "";
}

function subagentStatusText(status) {
  return { pending: "queued", running: "running", completed: "done", failed: "error", detached: "detached" }[status] || status || "";
}

/** Normalize one `subagent` call + its result into child rows both the card and
 *  the popup render from, so the two never disagree about state. */
function subagentView(call, exec, result) {
  const finalDetails = result?.details && Array.isArray(result.details.results) ? result.details : null;
  const live = liveSubagentDetails(exec);
  const details = finalDetails || live;
  const tasks = subagentTasks(call);

  const progressByIndex = new Map();
  for (const p of [...(details?.progress || []), ...(live?.progress || [])]) {
    if (p && Number.isInteger(p.index)) progressByIndex.set(p.index, p);
  }

  const rows = (details?.results || []).map((raw, i) => {
    const index = Number.isInteger(raw.index) ? raw.index : i;
    const liveRow = Array.isArray(live?.results) ? live.results[i] : null;
    const progress = raw.progress || liveRow?.progress || progressByIndex.get(index) || null;
    const usage = raw.usage || {};
    const task = tasks[index];
    const taskText = [task?.task, progress?.task]
      .find((t) => typeof t === "string" && t.trim() && t !== REDACTED_TASK) || "";
    const tokens = progress?.tokens || (usage.input || 0) + (usage.output || 0) || null;
    return {
      agent: raw.agent || progress?.agent || task?.agent || "subagent",
      name: raw.sessionName || progress?.sessionName || null,
      task: taskText,
      status: subagentStatus(progress?.status, raw.exitCode, raw.error),
      model: progress?.model || raw.model || raw.requestedModel || null,
      thinking: progress?.thinking || raw.thinking || null,
      currentTool: progress?.currentTool || null,
      currentToolArgs: progress?.currentToolArgs || null,
      recentTools: Array.isArray(progress?.recentTools) ? progress.recentTools.slice(-3) : [],
      recentOutput: Array.isArray(progress?.recentOutput) ? progress.recentOutput.slice(-8) : [],
      tokens,
      cost: usage.cost?.total || null,
      // 0 is "not measured yet" for a queued child, not an instant run
      durationMs: progress?.durationMs || raw.progressSummary?.durationMs || null,
      toolCount: progress?.toolCount ?? raw.progressSummary?.toolCount ?? null,
      error: raw.error || progress?.error || null,
      output: typeof raw.finalOutput === "string" ? raw.finalOutput : "",
      sessionFile: raw.sessionFile || null,
    };
  });

  return {
    mode: details?.mode || null,
    runId: details?.runId || null,
    /** A background launch answers immediately with no child rows: the run is
     *  detached and its result arrives later as a completion message. */
    asyncId: details?.asyncId || null,
    background: !!details?.background,
    rows,
    running: rows.filter((r) => r.status === "running" || r.status === "pending" || r.status === "detached").length,
    failed: rows.filter((r) => r.status === "failed").length,
    tokens: rows.reduce((sum, r) => sum + (r.tokens || 0), 0) || null,
    cost: rows.reduce((sum, r) => sum + (r.cost || 0), 0) || null,
    durationMs: rows.reduce((max, r) => Math.max(max, r.durationMs || 0), 0) || null,
  };
}

/** true when the tool result is a subagent run this module can render richly.
 *  Management calls (`status`, `stop`, agent CRUD) answer with the same envelope
 *  but are not runs, so they keep the generic tool view. */
function isSubagentRun(call, exec, result) {
  if (call?.name !== SUBAGENT_TOOL) return false;
  const live = liveSubagentDetails(exec);
  const details = result?.details && Array.isArray(result.details.results) ? result.details : live;
  if (!details || details.mode === "management") return false;
  return details.results.length > 0 || details.mode === "single" || !!details.asyncId || !!live;
}

function subagentHeadline(view) {
  if (!view.rows.length) {
    if (view.background || view.asyncId) return "background run · detached";
    return view.mode ? `${view.mode} run` : "starting…";
  }
  const agents = view.rows.map((r) => r.agent);
  const unique = [...new Set(agents)];
  if (view.rows.length === 1) {
    const one = view.rows[0];
    return one.task ? `${one.agent} · ${truncate(one.task, 90)}` : one.agent;
  }
  // "2 × reviewer" reads better than "2 agents · reviewer, reviewer"
  const who = unique.length === 1 ? `${view.rows.length} × ${unique[0]}` : unique.join(", ");
  return truncate(who, 90);
}

/** one line of live activity for a child row */
function subagentActivity(row) {
  if (row.status === "failed" && row.error) return truncate(row.error, 160);
  if (row.currentTool) {
    const args = row.currentToolArgs ? ` ${truncate(String(row.currentToolArgs), 80)}` : "";
    return `${row.currentTool}${args}`;
  }
  const lastOutput = row.recentOutput[row.recentOutput.length - 1];
  if (lastOutput) return truncate(lastOutput.trim(), 160);
  if (row.status === "pending") return "queued";
  if (row.status === "running") return "working…";
  // A finished row is identified by what it was asked to do, not by a tool count
  if (row.task) return truncate(row.task, 160);
  if (row.status === "completed") return "done";
  return "";
}

function subagentMeta(row) {
  const parts = [];
  if (row.toolCount) parts.push(`${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}`);
  if (row.durationMs) parts.push(fmtDuration(row.durationMs));
  if (row.tokens) parts.push(`${fmtTokens(row.tokens)} tok`);
  return parts.join(" · ");
}

/** inline card: the run on one head line, its children as compact rows. A
 *  subagent's children are the part worth seeing without opening a popup. */
function renderSubagentCard(call, block) {
  const { result, exec, statusText } = toolcallState(block);
  const view = subagentView(call, exec, result);
  const done = view.rows.length - view.running - view.failed;
  // A run with one failed child is not itself a failure: pi still returned a
  // usable result. Only an all-failed run (or a failed tool result) gets the
  // error accent; a partial failure gets the warning one.
  const allFailed = view.rows.length > 0 && view.failed === view.rows.length;
  const accent = statusText === "error" || allFailed ? "error" : view.failed ? "partial" : "";
  const card = el("div", {
    class: `toolcall subagent ${exec.status === "running" || view.running ? "running" : ""} ${accent}`,
    "data-call-id": call.id,
  });

  const open = () => openSubagent(call, block);
  const headOpts = {
    class: "tc-head",
    role: "button",
    tabindex: "0",
    title: "Open subagent run",
    "aria-haspopup": "dialog",
    onclick: open,
    onkeydown: onActivate(open),
  };
  card.append(
    el(
      "div",
      headOpts,
      el("span", { class: "tc-open-icon", text: "⧉" }),
      el("span", { class: "tc-name", text: "subagent" }),
      el("span", { class: "tc-summary", text: subagentHeadline(view) }),
      view.running ? el("span", { class: "sa-count running", text: `${view.running} running` }) : null,
      view.failed ? el("span", { class: "sa-count error", text: `${view.failed} failed` }) : null,
      done > 0 && view.running ? el("span", { class: "sa-count", text: `${done} done` }) : null,
      view.durationMs != null ? el("span", { class: "tc-duration", text: fmtDuration(view.durationMs) }) : null,
      view.tokens != null ? el("span", { class: "tc-duration", text: `${fmtTokens(view.tokens)} tok` }) : null,
      el("span", { class: `tc-status ${statusText}`, text: statusText })
    )
  );

  if (view.rows.length) {
    const rows = el("div", { class: "sa-rows" });
    for (const row of view.rows.slice(0, SUBAGENT_INLINE_MAX)) rows.append(subagentChildRow(row, open));
    if (view.rows.length > SUBAGENT_INLINE_MAX) {
      rows.append(
        el("div", {
          class: "sa-more",
          role: "button",
          tabindex: "0",
          text: `+${view.rows.length - SUBAGENT_INLINE_MAX} more — open the run`,
          onclick: open,
          onkeydown: onActivate(open),
        })
      );
    }
    card.append(rows);
  }
  return card;
}

function subagentChildRow(row, open) {
  const tone = subagentTone(row.status);
  return el(
    "div",
    {
      class: `sa-child ${tone}`,
      role: "button",
      tabindex: "0",
      title: row.task || row.name || row.agent,
      onclick: open,
      onkeydown: onActivate(open),
    },
    el("span", { class: `sa-dot ${tone}` }),
    el("span", { class: "sa-agent", text: row.agent }),
    el("span", { class: "sa-what", text: subagentActivity(row) }),
    el("span", { class: "sa-meta", text: subagentMeta(row) })
  );
}

/** Rich popup body for one subagent run: a summary strip plus one panel per
 *  child with its task, live activity, output and session file. */
let subagentRequestOpen = false;
function buildSubagentBody(call, exec, result) {
  const view = subagentView(call, exec, result);
  const body = el("div", { class: "sa-body" });

  const strip = el("div", { class: "sa-strip" });
  const chip = (text, tone = "") => el("span", { class: `sa-chip ${tone}`, text });
  if (view.mode) strip.append(chip(`mode: ${view.mode}${view.background ? " · background" : ""}`));
  strip.append(chip(`${view.rows.length} child${view.rows.length === 1 ? "" : "ren"}`));
  if (view.running) strip.append(chip(`${view.running} running`, "running"));
  if (view.failed) strip.append(chip(`${view.failed} failed`, "error"));
  if (view.durationMs != null) strip.append(chip(`wall ${fmtDuration(view.durationMs)}`));
  if (view.tokens != null) strip.append(chip(`${fmtTokens(view.tokens)} tok`));
  if (view.cost) strip.append(chip(fmtCost(view.cost)));
  if (view.runId) {
    const run = chip(`run ${view.runId.slice(0, 8)}`);
    run.title = `${view.runId}\nClick to copy`;
    run.style.cursor = "pointer";
    run.addEventListener("click", () =>
      navigator.clipboard.writeText(view.runId).then(() => toast("run id copied"), () => toast("copy failed", "error"))
    );
    strip.append(run);
  }
  body.append(strip);

  if (!view.rows.length) {
    const text = resultText(result?.content).trim();
    const note = view.background || view.asyncId
      ? el("div", { class: "sa-note" }, el("span", { text: "This run continues in the background. " }),
          el("span", { text: "Its result arrives as a completion message; the child rows appear once the run reports them." }))
      : null;
    if (note) body.append(note);
    body.append(el("div", { class: "tc-text", text: capText(text || "(no child results reported yet)") }));
  }

  for (const row of view.rows) {
    body.append(subagentPanel(row));
  }

  const request = el("details", { class: "sa-request" });
  // A running run repaints this body on every progress tick; remember whether
  // the reader expanded the request so the repaint does not collapse it.
  request.open = subagentRequestOpen;
  request.addEventListener("toggle", () => {
    subagentRequestOpen = request.open;
  });
  request.append(el("summary", { text: "request · arguments" }), jsonBlock(call.arguments ?? call.argsRaw ?? {}));
  body.append(request);
  return body;
}

function subagentPanel(row) {
  const tone = subagentTone(row.status);
  const panel = el("div", { class: `sa-panel ${tone}` });

  const head = el(
    "div",
    { class: "sa-panel-head" },
    el("span", { class: `sa-dot ${tone}` }),
    el("span", { class: "sa-agent", text: row.agent }),
    el("span", { class: `sa-state ${tone}`, text: subagentStatusText(row.status) }),
    row.model ? el("span", { class: "sa-chip", text: row.model }) : null,
    row.thinking ? el("span", { class: "sa-chip", text: `think: ${row.thinking}` }) : null,
    el("span", { class: "spacer" }),
    row.toolCount ? el("span", { class: "sa-dim", text: `${row.toolCount} tools` }) : null,
    row.tokens ? el("span", { class: "sa-dim", text: `${fmtTokens(row.tokens)} tok` }) : null,
    row.durationMs ? el("span", { class: "sa-dim", text: fmtDuration(row.durationMs) }) : null
  );
  panel.append(head);

  const content = el("div", { class: "sa-panel-body" });
  if (row.task) content.append(el("div", { class: "sa-task", text: row.task }));

  if (row.currentTool) {
    const tool = el("div", { class: "sa-tool current" });
    tool.append(
      el("span", { class: "sa-tool-name", text: row.currentTool }),
      el("span", { class: "sa-tool-args", text: truncate(String(row.currentToolArgs || "running…"), 200) })
    );
    content.append(el("div", { class: "tc-label", text: "now" }), tool);
  }

  if (row.recentTools.length) {
    const list = el("div", { class: "sa-tools" });
    for (const t of row.recentTools) {
      const line = el("div", { class: "sa-tool" });
      line.append(
        el("span", { class: "sa-tool-name", text: t.tool || "tool" }),
        el("span", { class: "sa-tool-args", text: truncate(String(t.args || ""), 160) })
      );
      list.append(line);
    }
    content.append(el("div", { class: "tc-label", text: "recent tools" }), list);
  }

  if (row.recentOutput.length) {
    content.append(
      el("div", { class: "tc-label", text: "recent output" }),
      el("pre", { class: "sa-log", text: capText(row.recentOutput.join("\n")) })
    );
  }

  if (row.error) {
    content.append(el("div", { class: "tc-label", text: "error" }), el("div", { class: "tc-text sa-error", text: row.error }));
  }

  if (row.output.trim()) {
    const out = el("div", { class: "sa-output assistant-text" });
    out.replaceChildren(...htmlFragment(renderMarkdown(row.output)));
    content.append(el("div", { class: "tc-label", text: "output" }), out);
  }

  if (row.sessionFile) {
    const foot = el("div", { class: "sa-session" });
    const copy = el("button", {
      class: "ghost sa-open",
      text: "open transcript",
      title: row.sessionFile,
      onclick: () => openChildSession(row.sessionFile),
    });
    foot.append(copy, el("span", { class: "sa-session-path", text: row.sessionFile, title: row.sessionFile }));
    content.append(foot);
  }

  panel.append(content);
  return panel;
}

/** Open a finished child's own session in this tab. Switching spawns a pi
 *  process for that file, exactly like any other session switch. */
async function openChildSession(file) {
  if (!file) return;
  closeModal();
  const meta = state.sessions.find((s) => s.file === file);
  await switchSession(file, meta?.cwd || state.cwd);
}

function openSubagent(call, block) {
  const { exec, result } = toolcallState(block);
  const view = subagentView(call, exec, result);
  subagentRequestOpen = false;
  const label = view.rows.length === 1 ? `: ${view.rows[0].agent}` : view.rows.length > 1 ? `: ${view.rows.length} children` : "";
  openPopup(`subagent${label}`, {
    paint: () => {
      const st = toolcallState(block);
      return buildSubagentBody(st.call, st.exec, st.result);
    },
    payload: () => {
      const st = toolcallState(block);
      return { toolCall: st.call, execution: st.exec || null, toolResult: st.result };
    },
  });
}

/** rich body for one tool call: arguments, live execution updates, response.
 *  Rendered inside the popup — never inline, so it cannot shove the rest of
 *  the transcript off screen. */
function buildToolcallBody(call, exec, result) {
  if (isSubagentRun(call, exec, result)) return buildSubagentBody(call, exec, result);
  const body = el("div", { class: "tc-body" });
  const diff = typeof result?.details?.diff === "string" ? result.details.diff : null;

  // A tool that read a picture and could only report its size is the common
  // case worth leading with: show the image itself, above the JSON.
  const imagePath = imageMetadataPath(call, result);
  if (imagePath) {
    body.append(imageResultSection("image", [`/api/image?path=${encodeURIComponent(imagePath)}`]));
  }

  // edit calls lead with the colored diff — seeing what changed is the point
  // of the popup; the raw request/response follow below
  if (call.name === "edit" && diff) {
    body.append(
      el("div", { class: "tc-section tc-diff-section" }, el("div", { class: "tc-label", text: "diff" }), diffBlock(diff))
    );
  }

  // request
  const reqPre = el("div", { class: "tc-section" }, el("div", { class: "tc-label", text: "request · arguments" }));
  try {
    reqPre.append(jsonBlock(call.arguments ?? call.argsRaw ?? {}));
  } catch {
    reqPre.append(jsonBlock(capText(call.argsRaw)));
  }
  body.append(reqPre);

  // execution updates (live partial results)
  if (exec.updates && exec.updates.length) {
    const sec = el("div", { class: "tc-section" }, el("div", { class: "tc-label", text: `execution updates (${exec.updates.length})` }));
    const last = exec.updates[exec.updates.length - 1];
    const txt = resultText(last?.content) || JSON.stringify(last);
    sec.append(el("div", { class: "tc-text", text: capText(txt) }));
    body.append(sec);
  }

  // response
  if (result) {
    const sec = el("div", { class: `tc-section tc-result ${result.isError ? "is-error" : ""}` }, el("div", { class: "tc-label", text: `response ${result.isError ? "· ERROR" : ""}` }));
    for (const b of result.content || []) {
      if (b.type === "text") {
        const txt = capText(b.text || "");
        sec.append(looksLikeDiff(txt) ? diffBlock(txt) : el("div", { class: "tc-text", text: txt }));
      } else if (b.type === "image") {
        sec.append(imageEl(`data:${b.mimeType};base64,${b.data}`));
      }
    }
    if (result.details != null && !(call.name === "edit" && diff)) {
      // edit results carry a computed diff — already shown above for edit
      if (typeof result.details.diff === "string") {
        sec.append(el("div", { class: "tc-label", text: "diff" }), diffBlock(result.details.diff));
      } else {
        sec.append(el("div", { class: "tc-label", text: "details" }), jsonBlock(result.details));
      }
    }
    body.append(sec);
  }
  return body;
}

/** one tool call row: a single line in the transcript. Clicking it opens the
 *  full request/response in the popup — expanding in place pushed everything
 *  after the card (notably the assistant's summary) below the fold. */
function renderToolcall(_item, block) {
  const { call, result, exec, statusText } = toolcallState(block);

  // A subagent call is a fan-out, not a single request/response: its children
  // get their own rows so progress is readable without opening anything.
  if (isSubagentRun(call, exec, result)) return renderSubagentCard(call, block);

  const card = el("div", {
    class: `toolcall ${exec.status === "running" ? "running" : ""} ${statusText === "error" ? "error" : ""}`,
    "data-call-id": call.id,
  });

  const open = () => openToolcall(call, block);
  const headOpts = {
    class: "tc-head",
    role: "button",
    tabindex: "0",
    title: "Open request / response",
    "aria-haspopup": "dialog",
    onclick: open,
    onkeydown: onActivate(open),
  };

  // edit calls get the compact pi-style header: pencil, file name, +/- counts.
  // Clicking still opens the full request/response popup shared by all tools.
  if (call.name === "edit") {
    const filePath = String(call.arguments?.path || call.arguments?.file_path || "");
    const base = filePath.split(/[\\/]/).pop() || filePath;
    const stats = result?.details?.diff != null ? editDiffStats(result.details.diff) : null;
    card.append(
      el(
        "div",
        headOpts,
        el("span", { class: "tc-open-icon", text: "✎" }),
        el("span", { class: "tc-name", text: "edit" }),
        el("span", { class: "tc-summary", text: base }),
        stats ? el("span", { class: "tc-stat add", text: `+${stats.added}` }) : null,
        stats ? el("span", { class: "tc-stat del", text: `−${stats.deleted}` }) : null,
        statusText !== "done" ? el("span", { class: `tc-status ${statusText}`, text: statusText }) : null
      )
    );
    return card;
  }

  const summary = argsSummary(call) || JSON.stringify(call.arguments || {}).slice(0, 80);
  const head = el(
    "div",
    headOpts,
    el("span", { class: "tc-open-icon", text: "↗" }),
    el("span", { class: "tc-name", text: call.name }),
    el("span", { class: "tc-summary", text: summary }),
    exec.durationMs != null ? el("span", { class: "tc-duration", text: fmtDuration(exec.durationMs) }) : null,
    el("span", { class: `tc-status ${statusText}`, text: statusText })
  );
  card.append(head);
  return card;
}

function renderAssistantMeta(meta) {
  if (!meta) return null;
  const u = meta.usage || {};
  const c = u.cost || {};
  const parts = [];
  if (meta.model) parts.push(`${meta.provider || ""}/${meta.model}`);
  if (u.totalTokens) parts.push(`${fmtTokens(u.input)}→ in · ${fmtTokens(u.output)} out${u.cacheRead ? ` · ${fmtTokens(u.cacheRead)} cache` : ""}`);
  if (c.total) parts.push(fmtCost(c.total));
  if (meta.stopReason) parts.push(`stop: ${meta.stopReason}`);
  if (meta.ts) parts.push(fmtTime(meta.ts));
  const line = el(
    "div",
    { class: "assistant-meta", title: "Click for full message JSON" },
    meta.errorMessage ? el("span", { class: "stop-error", text: `error: ${meta.errorMessage}` }) : null,
    ...parts.map((p) => el("span", { text: p }))
  );
  line.addEventListener("click", () => openJson("assistant message", meta._raw || meta));
  return line;
}

function renderItem(item) {
  switch (item.kind) {
    case "user": {
      const box = el("div", { class: "item item-user" });
      box.append(el("div", { class: "who", text: `you · ${fmtTime(item.ts)}` }));
      const body = el("div");
      body.style.whiteSpace = "pre-wrap";
      body.textContent = item.text;
      box.append(body);
      for (const img of item.images || []) box.append(el("img", { src: `data:${img.mimeType};base64,${img.data}` }));
      return box;
    }
    case "assistant": {
      const box = el("div", { class: "item item-assistant" });
      box.append(el("div", { class: "who", text: `pi · ${fmtTime(item.ts || (item.meta && item.meta.ts))}` }));
      const blocks = el("div", { class: "blocks" });
      for (const b of item.blocks) {
        if (b.type === "text") {
          const d = el("div", { class: "assistant-text" });
          // renderMarkdown escapes the source text up front, so the markup it
          // emits is safe to parse; htmlFragment keeps it off innerHTML
          d.replaceChildren(...htmlFragment(renderMarkdown(b.text || "")));
          blocks.append(d);
        } else if (b.type === "thinking") {
          if (b.redacted && !b.thinking) {
            blocks.append(el("div", { class: "item-thinking", text: "[redacted thinking]" }));
          } else {
            const wrap = el("details", { class: "item-thinking" });
            wrap.append(el("summary", { text: "thinking" }), el("div", { text: b.thinking || "" }));
            wrap.style.whiteSpace = "pre-wrap";
            blocks.append(wrap);
          }
        } else if (b.type === "toolcall") {
          blocks.append(renderToolcall(item, b));
        } else if (b.type === "image") {
          blocks.append(el("img", { src: `data:${b.mimeType};base64,${b.data}`, style: "max-width:320px;border-radius:6px" }));
        }
      }
      if (item.streaming && !item.blocks.length) blocks.append(el("div", { class: "dim", text: "…" }));
      box.append(blocks);
      if (!item.streaming && item.meta) {
        item.meta._raw = item._rawMessage || item.meta;
        const m = renderAssistantMeta(item.meta);
        if (m) box.append(m);
      }
      return box;
    }
    case "toolResultOrphan": {
      const m = item.message;
      // orphaned results can carry a huge payload (e.g. every replayed read);
      // one summary row — the popup holds the payload
      const key = `orphan-${m.toolCallId || m.timestamp || ""}`;
      const statusText = m.isError ? "error" : "done";
      const card = el("div", { class: `toolcall ${m.isError ? "error" : ""}`, "data-call-id": key });
      const open = () => openRawTool(`tool result: ${m.toolName}`, () => el("div", { class: "tc-body" }, el("div", { class: "tc-text", text: capText(resultText(m.content)) })), m);
      const head = el(
        "div",
        {
          class: "tc-head",
          role: "button",
          tabindex: "0",
          title: "Open tool result",
          "aria-haspopup": "dialog",
          onclick: open,
          onkeydown: onActivate(open),
        },
        el("span", { class: "tc-open-icon", text: "↗" }),
        el("span", { class: "tc-name", text: m.toolName }),
        el("span", { class: "tc-summary", text: "(orphaned tool result)" }),
        el("span", { class: `tc-status ${statusText}`, text: statusText })
      );
      card.append(head);
      return el("div", { class: "item" }, card);
    }
    case "bash": {
      const m = item.message;
      return el(
        "div",
        { class: "item item-bash" },
        el("div", { class: "who", text: `bash · ${fmtTime(item.ts)}` }),
        el("div", { class: "bash-cmd", text: `$ ${m.command}` }),
        m.output ? el("pre", { text: m.output }) : null,
        m.exitCode != null && m.exitCode !== 0 ? el("div", { class: "dim", text: `exit ${m.exitCode}${m.cancelled ? " (cancelled)" : ""}` }) : null
      );
    }
    case "system": {
      const short = (item.text || "").slice(0, 300);
      const box = el("details", { class: "item item-system" });
      box.append(el("summary", { text: `system · ${short.slice(0, 80)}…` }), el("div", { text: item.text }));
      return box;
    }
    case "summary": {
      const chip = el("div", { class: "notice-chip" }, el("div", { class: "n-title", text: item.title }), el("div", { class: "n-body", text: (item.text || "").slice(0, 2000) }));
      chip.addEventListener("click", () => openJson(item.title, { title: item.title, text: item.text, data: item.data }));
      return el("div", { class: "item item-notice" }, chip);
    }
    case "notice": {
      const chip = el("div", { class: "notice-chip", text: item.text });
      if (item.data) chip.addEventListener("click", () => openJson("entry", item.data));
      return el("div", { class: "item item-notice" }, chip);
    }
    default:
      return el("div", { class: "item dim", text: `[${item.kind}]` });
  }
}

// Transcript DOM reconciliation: each item keeps a cached node; re-render only
// dirty items, append/remove as needed.
const transcriptEl = $("#transcript");
// one delegated listener for all "copy" buttons inside rendered code blocks
transcriptEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".code-copy");
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.code).then(() => {
    btn.textContent = "copied";
    btn.classList.add("done");
    setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("done"); }, 1500);
  }).catch(() => toast("copy failed", "error"));
});
function renderTranscript({ follow = true } = {}) {
  const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 120;
  const nodes = [];
  for (const item of state.items) {
    if (!item.node || item.dirty) {
      item.node = renderItem(item);
      item.dirty = false;
    }
    nodes.push(item.node);
  }
  // reconcile children
  const cur = [...transcriptEl.children];
  // NOTE: on removal the next child shifts into index i, so i must NOT
  // advance — otherwise bulk removals (e.g. clearing the transcript for a new
  // session) only delete every other node and stale messages stay on screen.
  let i = 0;
  while (i < cur.length || i < nodes.length) {
    if (cur[i] === nodes[i]) {
      i++;
    } else if (nodes[i]) {
      transcriptEl.insertBefore(nodes[i], cur[i] || null);
      cur.splice(i, 0, nodes[i]);
      i++;
    } else {
      cur[i].remove();
      cur.splice(i, 1);
    }
  }
  // auto-follow the bottom is for streaming content only — a re-render must not
  // fling a user who has scrolled up back to the bottom
  if (follow && nearBottom) scrollBottom();
  updateJumpButton();
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderTranscript();
  });
}

function scrollBottom() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}
function updateJumpButton() {
  const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 120;
  $("#btn-jump").classList.toggle("hidden", nearBottom);
}
transcriptEl.addEventListener("scroll", updateJumpButton);
$("#btn-jump").addEventListener("click", scrollBottom);

// ---------------------------------------------------------------------------
// header / sidebar
// ---------------------------------------------------------------------------
function renderHeader() {
  $("#session-name").textContent = state.sessionName || (state.sessionFile ? state.sessionFile.split("/").pop().replace(/\.jsonl$/, "") : "—");
  const cu = state.stats?.contextUsage;
  // `tokens`/`percent` are null right after compaction until a fresh response;
  // contextWindow comes from the active model, so fall back to it for the max.
  const cuTokens = cu?.tokens != null ? Number(cu.tokens) : NaN;
  const cuMax = cu?.contextWindow != null ? Number(cu.contextWindow) : Number(state.model?.contextWindow);
  const pct = cu?.percent != null ? Number(cu.percent) : NaN;
  const ctxEl = $("#context-usage");
  ctxEl.textContent = isNaN(cuTokens)
    ? isNaN(pct) ? "ctx —" : `ctx — / ${fmtK(cuMax)} · ${pct.toFixed(2)}%`
    : `ctx ${fmtK(cuTokens)} / ${fmtK(cuMax)}${isNaN(pct) ? "" : ` · ${pct.toFixed(2)}%`}`;
  const st = state.stats;
  ctxEl.title = st
    ? `Context window usage\nused: ${isNaN(cuTokens) ? "—" : fmtNum(cuTokens)} tokens\nmax: ${fmtNum(cuMax)} tokens\npercent: ${isNaN(pct) ? "—" : `${pct.toFixed(2)}%`}`
    : "Context window usage";
  if (st) {
    $("#session-cost").textContent = `${fmtCost(st.cost)} · ${fmtTokens(st.tokens?.total)} tok`;
  } else $("#session-cost").textContent = "—";
  // only rebuild the popover when it is on screen; a hidden one is refreshed
  // on open, so header re-renders stay cheap
  if (!$("#session-info-pop").classList.contains("hidden")) renderSessionInfo();

  renderModelPicker();
  renderThinkingPicker();
}

/** Header label of a picker button: the current value, or a placeholder when
 *  nothing is selected yet. */
function pickerLabel(text) {
  return `<span class="picker-label">${esc(text)}</span>`;
}

function renderModelPicker() {
  const btn = $("#model-picker-btn");
  const menu = $("#model-menu");
  if (!state.models.length) {
    btn.classList.add("hidden");
    setPickerOpen(menu, false);
    return;
  }
  btn.classList.remove("hidden");
  const current = state.model
    ? state.models.find((m) => m.provider === state.model.provider && m.id === state.model.id)
    : null;
  btn.replaceChildren(...htmlFragment(pickerLabel(current ? current.name || current.id : "select model")));

  // Rebuild only when the option set or the selection changed: renderHeader
  // runs on nearly every event, and rebuilding the open menu would drop focus.
  const sig = `${state.models.map((m) => `${m.provider}/${m.id}`).join("|")}#${current ? `${current.provider}/${current.id}` : ""}`;
  if (menu.dataset.sig === sig) return;
  menu.dataset.sig = sig;
  menu.innerHTML = "";

  const byProvider = new Map();
  for (const m of state.models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  for (const [provider, models] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    menu.append(el("div", { class: "picker-group", text: provider }));
    for (const m of models) {
      const isCurrent = current && current.provider === m.provider && current.id === m.id;
      menu.append(
        el(
          "button",
          {
            class: `picker-item${isCurrent ? " selected" : ""}`,
            role: "option",
            "aria-selected": String(!!isCurrent),
            title: `${m.provider}/${m.id}`,
            onclick: () => pickModel(m.provider, m.id),
          },
          el("span", { class: "picker-check", text: isCurrent ? "✓" : "" }),
          el("span", { class: "picker-text", text: m.name || m.id })
        )
      );
    }
  }
}

function renderThinkingPicker() {
  const btn = $("#thinking-picker-btn");
  const menu = $("#thinking-menu");
  if (!state.thinkingLevels.length) {
    btn.classList.add("hidden");
    setPickerOpen(menu, false);
    return;
  }
  btn.classList.remove("hidden");
  btn.replaceChildren(...htmlFragment(pickerLabel(`think: ${state.thinkingLevel || "—"}`)));

  const sig = `${state.thinkingLevels.join("|")}#${state.thinkingLevel || ""}`;
  if (menu.dataset.sig === sig) return;
  menu.dataset.sig = sig;
  menu.innerHTML = "";
  for (const lv of state.thinkingLevels) {
    const isCurrent = lv === state.thinkingLevel;
    menu.append(
      el(
        "button",
        {
          class: `picker-item${isCurrent ? " selected" : ""}`,
          role: "option",
          "aria-selected": String(isCurrent),
          onclick: () => pickThinkingLevel(lv),
        },
        el("span", { class: "picker-check", text: isCurrent ? "✓" : "" }),
        el("span", { class: "picker-text", text: lv })
      )
    );
  }
}

/** Open/close a header picker menu. When opening, the menu is anchored to the
 *  BOTTOM of its button and its height is clamped to the space left below it:
 *  opening downward is what the user expects, and a menu that never exceeds
 *  the viewport cannot push its first rows off screen. */
function setPickerOpen(menu, open) {
  // Unhide first: the horizontal fit below reads the menu's real width, which
  // is 0 while it is display:none.
  menu.classList.toggle("hidden", !open);
  if (open) positionPickerMenu(menu);
  const btn = menu.previousElementSibling;
  if (btn) btn.setAttribute("aria-expanded", String(open));
}

/** Clamp an open menu under its button: height limited to the room below (so
 *  it scrolls instead of running past the viewport edge) and horizontal
 *  placement kept inside the window for narrow layouts. */
function positionPickerMenu(menu) {
  const btn = menu.previousElementSibling;
  if (!btn) return;
  menu.style.maxHeight = "";
  menu.style.left = "";
  menu.style.right = "";
  const b = btn.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const below = window.innerHeight - b.bottom - gap - margin;
  // Keep it below at all times: on a very short window the list simply gets
  // shorter and scrolls rather than flipping above the button and clipping.
  menu.style.maxHeight = `${Math.max(120, Math.min(420, below))}px`;
  // Right-aligned by default (matches the right-hand header cluster); switch
  // to left alignment only when that would push the menu off the left edge.
  const width = Math.max(menu.offsetWidth, 180);
  if (b.right - width < margin) {
    menu.style.right = "auto";
    menu.style.left = "0";
  } else {
    menu.style.right = "0";
    menu.style.left = "auto";
  }
}

function closePickers() {
  setPickerOpen($("#model-menu"), false);
  setPickerOpen($("#thinking-menu"), false);
}

/** Bind a header picker button to its menu. Opening one closes the other, and
 *  inner clicks must not reach the click-away handler on document. */
function wirePicker(btnSel, menuSel) {
  const btn = $(btnSel);
  const menu = $(menuSel);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.classList.contains("hidden");
    closePickers();
    setPickerOpen(menu, open);
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
}
wirePicker("#model-picker-btn", "#model-menu");
wirePicker("#thinking-picker-btn", "#thinking-menu");
document.addEventListener("click", closePickers);
// A resize changes the room below the button, so an open menu must re-clamp:
// without this it keeps the old max-height and can run past the new edge.
window.addEventListener("resize", () => {
  for (const menu of [$("#model-menu"), $("#thinking-menu")]) {
    if (!menu.classList.contains("hidden")) positionPickerMenu(menu);
  }
});

async function pickModel(provider, modelId) {
  closePickers();
  // record intent BEFORE the RPC round-trip: a refresh() get_state issued
  // earlier but resolving later carries the pre-pick model and must not
  // overwrite this selection
  state.modelPickedAt = Date.now();
  try {
    await cmd("set_model", { provider, modelId });
    const st = await cmd("get_state");
    state.model = st.data?.model;
    state.thinkingLevel = st.data?.thinkingLevel;
    const lv = await cmd("get_available_thinking_levels");
    state.thinkingLevels = lv.data?.levels || [];
    renderHeader();
    toast(`model → ${provider}/${modelId}`);
  } catch (err) {
    toast(`set model failed: ${err.message}`, "error");
    loadModels();
  }
}

async function pickThinkingLevel(level) {
  closePickers();
  try {
    await cmd("set_thinking_level", { level });
    state.thinkingLevel = level;
    renderHeader();
  } catch (err) {
    toast(`set thinking failed: ${err.message}`, "error");
  }
}

/**
 * Session-details popover: the full session file path plus the session/model
 * facts that no longer fit on the single-line header.
 */
function renderSessionInfo() {
  const pop = $("#session-info-pop");
  pop.innerHTML = "";
  const st = state.stats;
  const cu = st?.contextUsage;
  const cuMax = cu?.contextWindow != null ? Number(cu.contextWindow) : Number(state.model?.contextWindow);
  const rows = [
    ["session", state.sessionName || "—"],
    ["file", state.sessionFile || "—"],
    ["id", state.sessionId || "—"],
    ["cwd", state.cwd || "—"],
    ["model", state.model ? `${state.model.provider}/${state.model.id}` : "—"],
    ["thinking", state.thinkingLevel || "—"],
    ["messages", st ? `${st.userMessages} user · ${st.assistantMessages} assistant · ${st.toolCalls} tools` : "—"],
    ["cost", st ? fmtCost(st.cost) : "—"],
    ["tokens", st ? `${fmtNum(st.tokens?.total)} total (in ${fmtNum(st.tokens?.input)}, out ${fmtNum(st.tokens?.output)}, cache r/w ${fmtNum(st.tokens?.cacheRead)}/${fmtNum(st.tokens?.cacheWrite)})` : "—"],
    ["context", cu ? `${fmtNum(cu.tokens)} / ${fmtNum(cuMax)} tokens · ${cu.percent != null ? `${Number(cu.percent).toFixed(2)}%` : "—"}` : "—"],
  ];
  for (const [k, v] of rows) {
    pop.append(
      el("div", { class: "info-row" }, el("span", { class: "info-key", text: k }), el("span", { class: "info-val", text: v, title: v }))
    );
  }
  if (state.sessionFile) {
    pop.append(
      el("button", {
        class: "ghost info-copy",
        text: "Copy path",
        onclick: () => navigator.clipboard.writeText(state.sessionFile).then(() => toast("path copied"), () => toast("copy failed", "error")),
      })
    );
  }
}

const sessionInfoBtn = $("#btn-session-info");
function setSessionInfoOpen(open) {
  $("#session-info-pop").classList.toggle("hidden", !open);
  sessionInfoBtn.setAttribute("aria-expanded", String(open));
}
sessionInfoBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renderSessionInfo();
  setSessionInfoOpen($("#session-info-pop").classList.contains("hidden"));
});
// Click-away and Esc close it; clicks inside the popover must not bubble out.
$("#session-info-pop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => setSessionInfoOpen(false));

/**
 * User-prompt outline: lists every user message in the current session;
 * clicking an entry scrolls the transcript to that message and flashes it.
 */
function collectUserPrompts() {
  const prompts = [];
  for (const item of state.items) if (item.kind === "user") prompts.push(item);
  return prompts;
}

function renderPromptList() {
  const pop = $("#prompt-list-pop");
  pop.innerHTML = "";
  const prompts = collectUserPrompts();
  if (!prompts.length) {
    pop.append(el("div", { class: "pl-empty", text: "no user prompts in this session yet" }));
    return;
  }
  prompts.forEach((item, n) => {
    const text = (item.text || "").replace(/\s+/g, " ").trim() || "(images only)";
    pop.append(
      el("div", {
        class: "pl-entry",
        title: item.text || "",
        onclick: () => {
          setPromptListOpen(false);
          scrollToUserPrompt(item);
        },
      },
        el("span", { class: "pl-num", text: String(n + 1) }),
        el("span", { class: "pl-text", text: text }),
        el("span", { class: "pl-time", text: item.ts ? fmtTime(item.ts) : "" })
      )
    );
  });
}

function scrollToUserPrompt(item) {
  // the item's cached node lives in the DOM (renderTranscript reconciles 1:1);
  // force a sync re-render first if a pending dirty flag would replace it
  if (item.dirty || !item.node) item.node = renderItem(item);
  const node = item.node;
  if (!node || !node.isConnected) return;
  node.scrollIntoView({ block: "start", behavior: "smooth" });
  flashNode(node);
}

/** brief highlight drawing the eye to a node that was just jumped to */
function flashNode(node) {
  node.classList.remove("prompt-flash");
  void node.offsetWidth; // restart the animation if it is already flashing
  node.classList.add("prompt-flash");
  setTimeout(() => node.classList.remove("prompt-flash"), 1600);
}

const promptListBtn = $("#btn-prompt-list");
function setPromptListOpen(open) {
  $("#prompt-list-pop").classList.toggle("hidden", !open);
  promptListBtn.setAttribute("aria-expanded", String(open));
}
promptListBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renderPromptList(); // rebuild on every open so new prompts are included
  setPromptListOpen($("#prompt-list-pop").classList.contains("hidden"));
});
$("#prompt-list-pop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => setPromptListOpen(false));

function renderStatus() {
  const bar = $("#status-bar");
  if (state.isStreaming) {
    bar.textContent = state.isCompacting ? "compacting…" : "pi is working…";
    bar.classList.remove("hidden");
  } else bar.classList.add("hidden");
  $("#btn-abort").classList.toggle("hidden", !state.isStreaming);
  const q = state.queued || {};
  const qb = $("#queue-bar");
  qb.innerHTML = "";
  const chips = [];
  (q.steering || []).forEach((text, i) => chips.push({ lane: "steer", label: "steer", text, i }));
  (q.followUp || []).forEach((text, i) => chips.push({ lane: "follow_up", label: "follow-up", text, i }));
  if (chips.length) {
    for (const c of chips) {
      qb.append(
        el(
          "span",
          { class: "q-item", title: c.text },
          el("span", { class: "q-lane", text: c.label }),
          el("span", { class: "q-text", text: truncate(c.text, 60) }),
          el("button", {
            class: "q-remove",
            text: "✕",
            title: "Remove this queued message",
            "aria-label": "Remove queued message",
            onclick: () => removeQueued(c.lane, c.i),
          })
        )
      );
    }
    qb.append(
      el("button", { class: "q-remove q-clear", text: "clear all", title: "Clear the whole queue", onclick: clearAllQueued })
    );
    qb.classList.remove("hidden");
  } else qb.classList.add("hidden");
}

let queueOpBusy = false;
/** Undo one queued message. pi's RPC only offers clear_queue (the whole
 *  queue), so per-item undo = clear + re-queue the survivors in order. */
async function removeQueued(lane, index) {
  if (queueOpBusy) return;
  const q = state.queued || {};
  const steering = [...(q.steering || [])];
  const followUp = [...(q.followUp || [])];
  const survivors = lane === "steer" ? steering : followUp;
  if (index >= survivors.length) return;
  survivors.splice(index, 1); // the undone item; the rest are re-queued below
  queueOpBusy = true;
  try {
    await cmd("clear_queue");
    // A re-queue that fails means the run ended mid-undo (steer/follow_up only
    // queue while streaming) — surface the dropped text so it is not lost.
    for (const msg of steering) await requeueOne("steer", msg);
    for (const msg of followUp) await requeueOne("follow_up", msg);
  } catch (err) {
    toast(`undo failed: ${err.message}`, "error");
  } finally {
    queueOpBusy = false;
  }
}

async function requeueOne(lane, msg) {
  try {
    await cmd(lane, { message: msg });
  } catch {
    toast(`queue changed while undoing — dropped: ${truncate(msg, 200)}`, "warning", 10000);
  }
}

async function clearAllQueued() {
  if (queueOpBusy) return;
  queueOpBusy = true;
  try {
    await cmd("clear_queue");
  } catch (err) {
    toast(`clear queue failed: ${err.message}`, "error");
  } finally {
    queueOpBusy = false;
  }
}
function truncate(s, n) {
  s = s.replace(/\n/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const WS_KEY = "piweb-workspace";
const WS_PINNED_KEY = "piweb-pinned-workspaces";

/** two-level display name, e.g. /home/me/work/pi-web -> "work/pi-web" */
function wsLabel(p) {
  if (!p || p === "(unknown)") return p || "";
  const segs = String(p).replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length <= 2) return segs.join("/") || p;
  return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

/** keep the URL hash in sync so sessions are addressable/bookmarkable:
 *  #ws=<encoded cwd>&session=<encoded file|new> */
function syncHash() {
  const params = new URLSearchParams();
  if (state.workspace) params.set("ws", state.workspace);
  params.set("session", state.sessionFile || "new");
  const hash = `#${params.toString()}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

/** restore workspace/session from the URL hash, if present */
function hashState() {
  if (!location.hash || location.hash === "#") return null;
  try {
    const p = new URLSearchParams(location.hash.slice(1));
    return {
      ws: p.get("ws") || null,
      session: p.get("session") || null, // "new" or a session file path
    };
  } catch {
    return null;
  }
}

/** workspaces the user picked via the directory dialog (persisted, may have no sessions yet) */
function pinnedWorkspaces() {
  try {
    const arr = JSON.parse(localStorage.getItem(WS_PINNED_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function pinWorkspace(cwd) {
  const pinned = pinnedWorkspaces();
  if (!pinned.includes(cwd)) {
    pinned.push(cwd);
    localStorage.setItem(WS_PINNED_KEY, JSON.stringify(pinned));
  }
}

/** group sessions by cwd -> [{ cwd, name, sessions, last, cost }] sorted by recency; merges pinned dirs */
function workspaces() {
  const map = new Map();
  const ensure = (key) => {
    const w = map.get(key) || { cwd: key, name: key === "(unknown)" ? key : wsLabel(key), sessions: [], last: 0, cost: 0 };
    map.set(key, w);
    return w;
  };
  for (const p of pinnedWorkspaces()) ensure(p);
  for (const s of state.sessions) {
    const w = ensure(s.cwd || "(unknown)");
    w.sessions.push(s);
    w.last = Math.max(w.last, s.lastTimestamp ? Date.parse(s.lastTimestamp) || 0 : s.mtime || 0);
    w.cost += s.cost || 0;
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}

function selectWorkspace(cwd) {
  state.workspace = cwd;
  localStorage.setItem(WS_KEY, cwd);
  renderSidebar();
}

/** last-activity time of a session in ms; falls back to file mtime */
function sessionLastMs(s) {
  const t = s.lastTimestamp ? Date.parse(s.lastTimestamp) : NaN;
  return isNaN(t) ? s.mtime || 0 : t;
}

function renderSidebar() {
  const list = $("#session-list");
  list.innerHTML = "";
  const filter = $("#session-filter").value.trim().toLowerCase();
  const crumb = $("#sidebar-crumb");

  // view tabs: "recent" (flat, all workspaces) vs "workspaces" (two-level)
  const recent = state.sidebarTab === "recent";
  $("#tab-workspaces").classList.toggle("active", !recent);
  $("#tab-recent").classList.toggle("active", recent);
  $("#tab-workspaces").setAttribute("aria-selected", String(!recent));
  $("#tab-recent").setAttribute("aria-selected", String(recent));

  if (recent) {
    // flat list: every session, most recent first, workspace shown as a chip
    crumb.classList.add("hidden");
    const all = state.sessions
      .filter(
        (s) =>
          !filter ||
          (s.name || "").toLowerCase().includes(filter) ||
          (s.title || "").toLowerCase().includes(filter) ||
          (s.cwd || "").toLowerCase().includes(filter)
      )
      .sort((a, b) => sessionLastMs(b) - sessionLastMs(a));
    for (const s of all) {
      const active = s.file === state.sessionFile;
      list.append(
        el(
          "div",
          {
            class: `session-item ${active ? "active" : ""}`,
            tabindex: "0",
            title: `${s.cwd || ""}\n${s.name || s.title || ""}`,
            onclick: () => switchSession(s.file, s.cwd),
            onkeydown: onActivate(() => switchSession(s.file, s.cwd)),
          },
          el(
            "div",
            { class: "s-title" },
            s.active ? el("span", { class: `s-dot${s.streaming ? " streaming" : ""}`, title: s.streaming ? "running in background" : "open in background" }) : null,
            s.name || s.title || "(untitled)"
          ),
          el(
            "div",
            { class: "s-meta" },
            el("span", { class: "s-ws", text: wsLabel(s.cwd) || "(unknown)" }),
            el("span", { text: fmtDate(sessionLastMs(s)) }),
            el("span", { text: `${s.messages} msg` }),
            s.cost ? el("span", { text: fmtCost(s.cost) }) : null
          )
        )
      );
    }
    if (!all.length) list.append(el("div", { class: "list-empty", text: "No sessions yet" }));
    return;
  }

  if (state.workspace == null) {
    // level 1: workspaces
    crumb.classList.add("hidden");
    const ws = workspaces().filter((w) => !filter || w.name.toLowerCase().includes(filter) || w.cwd.toLowerCase().includes(filter));
    for (const w of ws) {
      list.append(
        el(
          "div",
          {
            class: "ws-item",
            tabindex: "0",
            title: w.cwd,
            onclick: () => selectWorkspace(w.cwd),
            onkeydown: onActivate(() => selectWorkspace(w.cwd)),
          },
          el("div", { class: "ws-icon", "aria-hidden": "true", text: (w.name[0] || "?").toUpperCase() }),
          el(
            "div",
            { class: "ws-info" },
            el(
              "div",
              { class: "ws-name-row" },
              el("span", { class: "ws-name", text: w.name }),
              w.cwd === state.cwd ? el("span", { class: "ws-here", text: "here" }) : null
            ),
            el("div", { class: "ws-meta", text: `${w.sessions.length} session${w.sessions.length === 1 ? "" : "s"} · ${fmtDate(w.last)}` })
          )
        )
      );
    }
    if (!ws.length) list.append(el("div", { class: "list-empty", text: "No workspaces match" }));
    return;
  }

  // level 2: sessions of the selected workspace
  crumb.classList.remove("hidden");
  $("#crumb-name").textContent = wsLabel(state.workspace);
  $("#crumb-name").title = state.workspace;
  const inWs = state.sessions
    .filter((s) => (s.cwd || "(unknown)") === state.workspace)
    .filter((s) => !filter || (s.name || "").toLowerCase().includes(filter) || (s.title || "").toLowerCase().includes(filter));
  for (const s of inWs) {
    const active = s.file === state.sessionFile;
    list.append(
      el(
        "div",
        {
          class: `session-item ${active ? "active" : ""}`,
          tabindex: "0",
          title: s.name || s.title || "",
          onclick: () => switchSession(s.file, s.cwd),
          onkeydown: onActivate(() => switchSession(s.file, s.cwd)),
        },
        el(
          "div",
          { class: "s-title" },
          s.active ? el("span", { class: `s-dot${s.streaming ? " streaming" : ""}`, title: s.streaming ? "running in background" : "open in background" }) : null,
          s.name || s.title || "(untitled)"
        ),
        el(
          "div",
          { class: "s-meta" },
          el("span", { text: fmtDate(s.lastTimestamp ? Date.parse(s.lastTimestamp) : s.mtime) }),
          el("span", { text: `${s.messages} msg` }),
          s.cost ? el("span", { text: fmtCost(s.cost) }) : null
        )
      )
    );
  }
  if (!inWs.length) list.append(el("div", { class: "list-empty", text: "No sessions here yet — use the new-session button" }));
}

async function loadSessions() {
  try {
    const data = await api("/api/sessions");
    // The 8s status poll feeds the background-run dots; re-render only when
    // the list actually changed so the sidebar is not rebuilt under the cursor.
    const changed =
      state.workspace === undefined || JSON.stringify(data.sessions) !== JSON.stringify(state.sessions);
    state.sessions = data.sessions;
    if (state.workspace === undefined) {
      // hash wins over localStorage over server cwd
      const hs = hashState();
      const saved = localStorage.getItem(WS_KEY);
      const ws = workspaces();
      const hashWs = hs?.ws && ws.find((w) => w.cwd === hs.ws);
      const savedWs = saved && ws.find((w) => w.cwd === saved);
      const here = ws.find((w) => w.cwd === state.cwd);
      state.workspace = hashWs ? hashWs.cwd : savedWs ? savedWs.cwd : here ? here.cwd : null;
    }
    if (changed) renderSidebar();
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// cross-session search
// ---------------------------------------------------------------------------
// The sidebar filter only matches a session's title (its first prompt). This
// dialog queries the server's index, which covers every prompt, response, tool
// request and tool result in every workspace, and jumps to the occurrence.
const searchOverlay = $("#search-overlay");
const searchInput = $("#search-input");
const searchResultsEl = $("#search-results");
const searchCountEl = $("#search-count");
const SEARCH_LIMIT = 200;
let searchHits = [];
let searchIndex = 0;
let searchTimer = null;
let searchGen = 0; // guards against a slow earlier query overwriting a newer one
let searchReturnFocus = null;

function searchRoleLabel(hit) {
  if (hit.role === "user") return "you";
  if (hit.role === "assistant") return "pi";
  if (hit.role === "toolResult") return hit.toolName ? `result: ${hit.toolName}` : "result";
  if (hit.role === "tool") return hit.toolName ? `call: ${hit.toolName}` : "call";
  return hit.role;
}

function setSearchOpen(open) {
  searchOverlay.classList.toggle("hidden", !open);
  $("#btn-search").setAttribute("aria-expanded", String(open));
  if (open) {
    searchReturnFocus = document.activeElement;
    searchInput.focus();
    searchInput.select();
    // the dialog reopens with its previous query and hits still rendered; the
    // selection is re-applied because the rows were rebuilt while it was hidden
    if (searchHits.length) selectSearchIndex(searchIndex, { scroll: true });
  } else if (searchReturnFocus && searchReturnFocus.isConnected) {
    searchReturnFocus.focus({ preventScroll: true });
  }
}

/** Move the selection without rebuilding the list (mouse hover and arrows). */
function selectSearchIndex(i, { scroll = false } = {}) {
  const rows = searchResultsEl.querySelectorAll(".sr-item");
  if (!rows.length || i < 0 || i >= rows.length) return;
  searchIndex = i;
  rows.forEach((row, k) => {
    row.classList.toggle("selected", k === i);
    row.setAttribute("aria-selected", String(k === i));
  });
  // the combobox points at the active row so screen readers announce it
  searchInput.setAttribute("aria-activedescendant", rows[i].id);
  if (scroll) rows[i].scrollIntoView({ block: "nearest" });
}

/** render the result rows, or a single explanatory line when there are none */
function renderSearchResults(emptyMessage) {
  searchResultsEl.innerHTML = "";
  searchInput.setAttribute("aria-expanded", String(searchHits.length > 0));
  if (!searchHits.length) {
    searchInput.removeAttribute("aria-activedescendant");
    searchResultsEl.append(el("div", { class: "sr-empty", text: emptyMessage || "No matches in any session" }));
    return;
  }
  const byFile = new Map(state.sessions.map((s) => [s.file, s]));
  searchHits.forEach((hit, i) => {
    const meta = byFile.get(hit.sessionFile);
    const label = meta?.name || meta?.title || hit.sessionFile.split("/").pop().replace(/\.jsonl$/, "");
    searchResultsEl.append(
      el(
        "div",
        {
          class: `sr-item${i === searchIndex ? " selected" : ""}`,
          id: `sr-${i}`,
          role: "option",
          "aria-selected": String(i === searchIndex),
          onclick: () => openSearchHit(hit),
          onmouseenter: () => selectSearchIndex(i),
        },
        el(
          "div",
          { class: "sr-top" },
          el("span", { class: `sr-role ${hit.role}`, text: searchRoleLabel(hit) }),
          el("span", { class: "sr-ws", text: wsLabel(hit.cwd) || "(unknown)", title: hit.cwd || "" }),
          el("span", { class: "sr-session", text: label, title: hit.sessionFile }),
          el("span", { class: "sr-time", text: hit.ts ? fmtDate(Date.parse(hit.ts)) : "" })
        ),
        el(
          "div",
          { class: "sr-text" },
          document.createTextNode(hit.before || ""),
          el("mark", { text: hit.match || "" }),
          document.createTextNode(hit.after || "")
        )
      )
    );
  });
}

async function runSearch(query) {
  const q = query.trim();
  const gen = ++searchGen;
  if (!q) {
    searchHits = [];
    searchIndex = 0;
    searchCountEl.textContent = "";
    renderSearchResults("Type to search every prompt, response and tool output");
    return;
  }
  searchCountEl.textContent = "searching…";
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    if (gen !== searchGen) return; // a newer query already took over
    searchHits = Array.isArray(data.hits) ? data.hits : [];
    searchIndex = 0;
    renderSearchResults();
    searchResultsEl.scrollTop = 0;
    const n = searchHits.length;
    searchCountEl.textContent = data.truncated ? `first ${n} matches` : n ? `${n} match${n === 1 ? "" : "es"}` : "";
  } catch (err) {
    if (gen !== searchGen) return;
    searchCountEl.textContent = "";
    renderSearchResults(`search failed: ${err.message}`);
  }
}

function queueSearch(delay = 180) {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    runSearch(searchInput.value);
  }, delay);
}

/** scroll to the entry a hit points at and flash it; tool hits open their popup
 *  because the transcript row is one line and the match lives in the body */
function findOccurrence(hit) {
  // tool calls and their results both live inside the assistant item that made
  // the call, so they are located by call id before the entry id is tried
  if (hit.toolCallId) {
    for (const item of state.items) {
      if (item.kind !== "assistant") continue;
      const block = item.blocks.find((b) => b.type === "toolcall" && b.call.id === hit.toolCallId);
      if (block) return { item, block };
    }
  }
  for (const item of state.items) {
    if (item.entry && item.entry.id === hit.entryId) return { item, block: null };
  }
  // a result whose call is gone still renders as its own orphan row
  if (hit.toolCallId) {
    for (const item of state.items) {
      if (item.kind === "toolResultOrphan" && item.message?.toolCallId === hit.toolCallId) return { item, block: null };
    }
    for (const item of state.items) {
      if (item.kind === "toolResultOrphan" && item.message?.timestamp === hit.ts) return { item, block: null };
    }
  }
  return null;
}

async function revealOccurrence(hit) {
  let found = findOccurrence(hit);
  if (!found && !state.isStreaming) {
    // the cached view may predate the entry (or a compaction moved the branch).
    // Skipped while streaming: refresh() rebuilds from persisted entries and a
    // run in flight would lose the item it is still writing to.
    await refresh({ sessions: false });
    found = findOccurrence(hit);
  }
  if (!found) {
    toast("that message is not on this session's active branch", "warning", 7000);
    return;
  }
  const { item, block } = found;
  if (item.dirty || !item.node) {
    // renderTranscript() reconciles cached nodes 1:1; rendering an item without
    // it would leave a detached node that scrollIntoView cannot reach
    item.dirty = true;
    renderTranscript({ follow: false });
  }
  const node = item.node;
  const host = block
    ? node?.querySelector(`.toolcall[data-call-id="${CSS.escape(block.call.id)}"]`) || node
    : node;
  if (!host || !host.isConnected) {
    toast("could not locate that message in the transcript", "warning", 7000);
    return;
  }
  host.scrollIntoView({ block: scrollBlockFor(host), behavior: "smooth" });
  flashNode(host);
  if (block) openToolcall(block.call, block);
}

/** Center a short target, but align a target taller than the transcript
 *  viewport to its top — centering one would push its first lines (where a
 *  prompt starts) above the fold with no way to tell it was scrolled to. */
function scrollBlockFor(node) {
  const viewport = transcriptEl.clientHeight;
  return node.getBoundingClientRect().height > viewport * 0.8 ? "start" : "center";
}

async function openSearchHit(hit) {
  setSearchOpen(false);
  if (hit.sessionFile !== state.sessionFile) {
    const meta = state.sessions.find((s) => s.file === hit.sessionFile);
    await switchSession(hit.sessionFile, hit.cwd || meta?.cwd || undefined);
    if (hit.sessionFile !== state.sessionFile) return; // switch failed; it toasted
  }
  await revealOccurrence(hit);
}

searchInput.addEventListener("input", () => {
  searchIndex = 0;
  queueSearch();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return; // IME candidate selection
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectSearchIndex(Math.min(searchIndex + 1, searchHits.length - 1), { scroll: true });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectSearchIndex(Math.max(searchIndex - 1, 0), { scroll: true });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const hit = searchHits[searchIndex];
    if (hit) openSearchHit(hit);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation(); // do not fall through to the global Esc actions
    setSearchOpen(false);
  }
});
$("#btn-search").addEventListener("click", () => setSearchOpen(searchOverlay.classList.contains("hidden")));
$("#search-close").addEventListener("click", () => setSearchOpen(false));
searchOverlay.addEventListener("click", (e) => {
  if (e.target === searchOverlay) setSearchOpen(false);
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    setSearchOpen(searchOverlay.classList.contains("hidden"));
  }
});
renderSearchResults("Type to search every prompt, response and tool output");

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function refresh({ sessions = false, stats = true } = {}) {
  try {
    const entriesRes = await cmd("get_entries");
    const entries = entriesRes.data?.entries || [];
    state.leafId = entriesRes.data?.leafId ?? null;

    // Reconstruct the active branch: walk leaf -> root, then reverse.
    const byId = new Map(entries.map((e) => [e.id, e]));
    const branch = [];
    let cur = state.leafId ? byId.get(state.leafId) : null;
    const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      branch.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    branch.reverse();

    state.items = buildItemsFromEntries(branch);
    // Executions map is live-run data; persisted results now cover it.
    state.executions.clear();
    // state.items now mirrors the persisted branch — live events appended
    // after the last refresh are folded back in, so a stashed view of this
    // session can trust state.leafId again (see stashCurrentView).
    entriesDirty = false;
    renderTranscript();
    if (stats) await refreshMeta();
    renderHeader();
    renderStatus();
    if (sessions) await loadSessions();
  } catch (err) {
    console.error(err);
    toast(`refresh failed: ${err.message}`, "error");
  }
}

/** Header/status state that does not depend on the transcript: stats, the
 *  get_state snapshot, thinking levels and slash commands. Shared by the full
 *  refresh and the incremental cached-session refresh. */
async function refreshMeta() {
  try {
    const s = await cmd("get_session_stats");
    state.stats = s.data;
  } catch {}
  try {
    // captured before the query: a pick made while it is in flight wins
    const askedAt = Date.now();
    const st = await cmd("get_state");
    // `|| null` (not `|| state.sessionFile`): a fresh/new session reports
    // sessionFile=null and must CLEAR the old one — keeping it would leave
    // the old title in the header and the old session id in the URL hash.
    state.sessionFile = st.data?.sessionFile || null;
    state.sessionId = st.data?.sessionId;
    state.sessionName = st.data?.sessionName || null;
    // A model the user picked after this query was issued must win over
    // the snapshot pi returned: an in-flight get_state still carries the
    // pre-pick model (typically the first available one) and would
    // silently reset the dropdown even though the picked model is still
    // listed. pi itself keeps the pick (set_model wrote a model_change
    // entry), so dropping the stale snapshot is always safe.
    const m = st.data?.model;
    const stalesPick = state.modelPickedAt > askedAt && m && !sameModel(m, state.model);
    if (m && !stalesPick) state.model = m;
    state.thinkingLevel = st.data?.thinkingLevel ?? state.thinkingLevel;
    state.isStreaming = !!st.data?.isStreaming;
  } catch {}
  try {
    const lv = await cmd("get_available_thinking_levels");
    state.thinkingLevels = lv.data?.levels || [];
  } catch {}
  // refresh the slash-command list too: skills/templates/extensions can
  // change between sessions (different cwd) or after a pi /reload
  loadCommands();
}

// Extensions register asynchronously after the pi process spawns (e.g.
// pi-provider-workbuddy resolves credentials and fetches its model catalog
// over the network before calling registerProvider), so a model query sent
// right after /api/open can come back missing them. With retry:true, keep
// polling until the model set has been identical across three consecutive
// polls (or the cap), re-rendering as the list grows. Two identical polls do
// NOT prove stability: workbuddy-style extensions may register seconds after
// spawn, so a late registration can land between two early identical polls —
// a third poll after an unchanged gap must also see no change. A token guards
// against overlapping loops if loadModels is called again mid-retry.
let loadModelsToken = 0;
function modelInList(m) {
  return !!m && state.models.some((x) => x.provider === m.provider && x.id === m.id);
}
function sameModel(a, b) {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}
async function loadModels({ retry = false } = {}) {
  const token = ++loadModelsToken;
  let prevSig = null;
  let stableStreak = 0; // consecutive polls that returned the same model set
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await cmd("get_available_models");
      state.models = res.data?.models || [];
    } catch {}
    renderHeader();
    const sig = state.models.map((m) => `${m.provider}/${m.id}`).sort().join("|");
    if (retry && sig && sig === prevSig) stableStreak++;
    else stableStreak = 0;
    prevSig = sig;
    const stable = stableStreak >= 2; // three identical polls in a row
    const done =
      !retry ||
      token !== loadModelsToken ||
      (state.models.length && (modelInList(state.model) || stable)) ||
      attempt >= 12;
    if (done) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

/** pi's get_commands lists every discoverable command (extension commands,
 *  prompt templates, skills); sending "/name" through `prompt` runs it. */
async function loadCommands() {
  try {
    const res = await cmd("get_commands");
    state.commands = (res.data?.commands || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    state.commands = []; // older pi without get_commands: autocomplete off, prompts still work
  }
}

async function sendPrompt() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text) {
    // pi's user message always carries a text block; an empty one can be
    // rejected by providers, so images need at least a short message
    if (attachments.length) toast("type a short message for the image(s), then send", "warning");
    return;
  }
  input.value = "";
  autosize(input);
  closeCmdMenu();
  rememberPrompt(text);
  const images = attachments.splice(0, attachments.length);
  renderAttachments();
  const extra = state.isStreaming ? { streamingBehavior: "steer" } : {};
  if (images.length) extra.images = images.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
  const restore = () => {
    input.value = text;
    autosize(input);
    attachments.unshift(...images);
    renderAttachments();
  };
  try {
    const res = await cmd("prompt", { message: text, ...extra });
    const disp = res.data?.disposition;
    $("#composer-hint").textContent = disp ? `disposition: ${disp}` : "";
  } catch (err) {
    // if racing a running agent, retry as steer (steer accepts images too)
    if (state.isStreaming) {
      try {
        const res = await cmd("prompt", { message: text, ...extra });
        $("#composer-hint").textContent = `disposition: ${res.data?.disposition}`;
        return;
      } catch {}
    }
    toast(`prompt failed: ${err.message}`, "error");
    restore();
  }
}

async function abort() {
  try {
    await cmd("abort");
  } catch (err) {
    toast(`abort failed: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// per-session view cache
//
// Switching back to a recently seen session reuses the already-rendered items
// (DOM nodes included) instead of rebuilding the whole transcript, then pulls
// only the entries appended since the cached leaf via the get_entries `since`
// cursor. In-memory only: items hold live DOM nodes and must not be persisted.
// ---------------------------------------------------------------------------
const viewCache = new Map(); // sessionFile -> { items, leafId }
const VIEW_CACHE_MAX = 8;
let switchGen = 0; // guards the optimistic switch against overlapping switches
// Live events (message_start/message_end) append items without touching
// state.leafId, so a stashed leafId would under-count the branch until the
// next full refresh folds them in.
let entriesDirty = false;

/** Remember the current session's rendered transcript for fast switch-back. */
function stashCurrentView() {
  const file = state.sessionFile;
  // A streaming view cannot be cached: its tail items are still mutating and
  // the persisted branch has not caught up with what is on screen.
  if (!file || state.isStreaming || state.isCompacting) return;
  viewCache.set(file, { items: state.items, leafId: entriesDirty ? null : state.leafId });
  while (viewCache.size > VIEW_CACHE_MAX) viewCache.delete(viewCache.keys().next().value);
}

/** True if `entries` chain parent-to-child from `fromId` and end at `leafId`,
 *  i.e. they linearly extend the cached branch and can be appended to it. */
function extendsBranch(entries, fromId, leafId) {
  let prev = fromId;
  for (const e of entries) {
    if (e.parentId !== prev) return false;
    prev = e.id;
  }
  return leafId === prev;
}

/** Refresh after attaching to a session whose view was rendered from cache:
 *  append only the new entries when they extend the cached branch, else fall
 *  back to a full refresh (cursor rejected, branch moved, compacted, ...). */
async function refreshCachedView(file) {
  const cached = viewCache.get(file);
  if (cached && state.items === cached.items && cached.leafId) {
    try {
      const res = await cmd("get_entries", { since: cached.leafId });
      const entries = res.data?.entries || [];
      const leafId = res.data?.leafId ?? null;
      if (extendsBranch(entries, cached.leafId, leafId)) {
        state.leafId = leafId;
        cached.leafId = leafId;
        if (entries.length) state.items.push(...buildItemsFromEntries(entries));
        await refreshMeta();
        renderHeader();
        renderStatus();
        renderTranscript();
        return;
      }
    } catch {
      // `since` rejected or RPC hiccup — full refresh below
    }
  }
  await refresh({ sessions: false });
}

async function switchSession(file, cwd) {
  if (file === state.sessionFile) return;
  const gen = ++switchGen;
  const prevFile = state.sessionFile;
  const prevView = { items: state.items, leafId: state.leafId };
  stashCurrentView();

  // Optimistic switch: update highlight, hash and transcript area up front so
  // a cold spawn (~2s) does not leave the previous session on screen. The
  // /api/open round-trip below waits for pi to answer RPC before resolving.
  // NOTE: the previously attached session is NOT aborted — it keeps running
  // in its own pi process on the server and can be re-attached anytime.
  state.sessionFile = file;
  state.executions.clear();
  // queue chips belong to the previous session's process — leaving them set
  // would keep showing the old session's queued messages after a switch
  // (pi has no get_queue RPC, so this is the only source of truth)
  state.queued = { steering: [], followUp: [] };
  state.isStreaming = false;
  state.isCompacting = false;
  currentAssistant = null;
  $("#composer-hint").textContent = "";
  const cached = viewCache.get(file);
  state.items = cached ? cached.items : [{ kind: "notice", text: "loading session…" }];
  state.leafId = cached ? cached.leafId : null;
  renderTranscript({ follow: false });
  renderSidebar();
  syncHash();

  try {
    const resp = await api("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: CLIENT_ID, sessionFile: file, ...(cwd ? { cwd } : {}) }),
    });
    if (gen !== switchGen) return; // a newer switch took over the UI
    if (resp.cwd) state.cwd = resp.cwd;
    // prefer the caller's cwd, fall back to what the server resolved
    const ws = cwd || resp.cwd;
    if (ws) {
      state.workspace = ws;
      localStorage.setItem(WS_KEY, ws);
    }
    // /api/open either attaches to the already-running process for this file
    // (spawning one is avoided) or starts a fresh one with `--session <file>`.
    // A fresh process avoids the stale-extension-ctx error that in-process
    // switch_session triggers in extensions holding captured contexts.
    await waitPiReady(file);
    if (gen !== switchGen) return;
    await refreshCachedView(file);
    renderSidebar(); // re-render so the .active highlight follows the clicked row
  } catch (err) {
    if (gen !== switchGen) return;
    // Revert the optimistic switch: put the previous session's view back.
    state.sessionFile = prevFile;
    state.items = prevView.items;
    state.leafId = prevView.leafId;
    renderTranscript({ follow: false });
    renderSidebar();
    syncHash();
    toast(`switch failed: ${err.message}`, "error");
  }
}

async function newSession() {
  try {
    // On the workspace list there is no active workspace to start a session in.
    if (state.workspace == null) {
      toast("Select a workspace first — pick one from the list or use the folder button", "error");
      return;
    }
    const cwd = state.workspace || state.cwd;
    stashCurrentView();
    const resp = await api("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: CLIENT_ID, sessionFile: null, ...(cwd ? { cwd } : {}) }),
    });
    if (resp.cwd) state.cwd = resp.cwd;
    if (cwd) {
      state.workspace = cwd;
      localStorage.setItem(WS_KEY, cwd);
    }
    await waitPiReady(null);
    state.sessionFile = null;
    state.executions.clear();
    state.queued = { steering: [], followUp: [] };
    state.isStreaming = false;
    state.isCompacting = false;
    currentAssistant = null;
    // clear the transcript immediately — refresh() below rebuilds from the
    // fresh (empty) session, but this makes the reset visible without delay
    state.items = [];
    renderTranscript({ follow: false });
    $("#composer-hint").textContent = "";
    await refresh({ sessions: true });
    syncHash();
  } catch (err) {
    toast(`new session failed: ${err.message}`, "error");
  }
}

/** Poll until pi is up and (optionally) reports the expected session file. */
async function waitPiReady(expectedFile) {
  let lastErr;
  for (let i = 0; i < 40; i++) {
    try {
      const st = await cmd("get_state");
      const sf = st.data?.sessionFile || null;
      if (!expectedFile || sf === expectedFile) return st;
      lastErr = new Error(`pi opened ${sf}, expected ${expectedFile}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr || new Error("pi did not become ready");
}

// ---------------------------------------------------------------------------
// live event handling
// ---------------------------------------------------------------------------
let currentAssistant = null; // streaming assistant item

function findStreamingAssistant() {
  if (currentAssistant && state.items.includes(currentAssistant)) return currentAssistant;
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.kind === "assistant" && it.streaming) return it;
  }
  return null;
}

function ensureBlock(item, idx, type) {
  while (item.blocks.length <= idx) item.blocks.push({ type: "text", text: "" });
  if (item.blocks[idx].type !== type) item.blocks[idx] = { type, text: "" };
  return item.blocks[idx];
}

function handleEvent(record) {
  switch (record.type) {
    case "server": {
      if (record.event === "pi_exit") {
        $("#pi-status").textContent = `pi exited (code ${record.code ?? "?"}) — click to restart`;
        $("#pi-status").className = "pi-status bad";
        $("#pi-status").onclick = restartPi;
        state.isStreaming = false;
        renderStatus();
      } else if (record.event === "pi_error") {
        $("#pi-status").textContent = `pi failed to start: ${record.error}`;
        $("#pi-status").className = "pi-status bad";
      } else if (record.event === "hello") {
        $("#pi-status").textContent = "pi running";
        $("#pi-status").className = "pi-status ok";
      }
      break;
    }
    case "agent_start":
      state.isStreaming = true;
      renderStatus();
      // a late extension registration can add models after boot's retry loop
      // gave up; top up the picker before the run picks its model
      if (!state.models.length || (state.model && !modelInList(state.model))) loadModels();
      break;
    case "turn_start":
      break;
    case "message_start": {
      // New live items extend the persisted branch without updating leafId —
      // mark the sync dirty so a stashed view falls back to a full refresh.
      entriesDirty = true;
      const m = record.message;
      if (m.role === "user") {
        for (const it of buildItemsFromEntries([{ type: "message", message: m }])) {
          it._live = true;
          state.items.push(it);
        }
      } else if (m.role === "assistant") {
        const item = { kind: "assistant", blocks: [], streaming: true, meta: null, ts: m.timestamp, _live: true };
        state.items.push(item);
        currentAssistant = item;
      } else if (m.role === "toolResult") {
        // A tool result is not its own transcript item: it belongs to the
        // toolCall block of the assistant turn that issued it. Attaching here
        // (and again at message_end) keeps the row filling in live and avoids
        // the placeholder this branch used to push — buildItemsFromEntries
        // sees a single message in isolation, so it could never resolve the
        // call and every result became an orphan row.
        attachToolResult(m);
      } else {
        for (const it of buildItemsFromEntries([{ type: "message", message: m }])) {
          it._live = true;
          state.items.push(it);
        }
      }
      scheduleRender();
      break;
    }
    case "message_update": {
      const ev = record.assistantMessageEvent || {};
      const item = findStreamingAssistant();
      if (!item) break;
      const idx = ev.contentIndex ?? 0;
      if (ev.type === "text_delta") {
        const b = ensureBlock(item, idx, "text");
        b.text += ev.delta || "";
        item.dirty = true;
      } else if (ev.type === "text_end") {
        ensureBlock(item, idx, "text").text = ev.content ?? "";
        item.dirty = true;
      } else if (ev.type === "thinking_delta") {
        const b = ensureBlock(item, idx, "thinking");
        b.thinking = (b.thinking || "") + (ev.delta || "");
        item.dirty = true;
      } else if (ev.type === "thinking_end") {
        const b = ensureBlock(item, idx, "thinking");
        b.thinking = ev.content ?? b.thinking;
        item.dirty = true;
      } else if (ev.type === "toolcall_start") {
        item.blocks[idx] = { type: "toolcall", call: { id: ev.id, name: ev.toolName, argsRaw: "" } };
        state.executions.set(ev.id, { status: "pending", updates: [] });
        item.dirty = true;
      } else if (ev.type === "toolcall_delta") {
        const b = item.blocks[idx];
        if (b && b.type === "toolcall") b.call.argsRaw = (b.call.argsRaw || "") + (ev.delta || "");
        item.dirty = true;
      } else if (ev.type === "toolcall_end") {
        const b = item.blocks[idx];
        if (b && b.type === "toolcall") {
          b.call = { id: ev.toolCall.id, name: ev.toolCall.name, arguments: ev.toolCall.arguments || {} };
          try {
            b.call.argsRaw = JSON.stringify(ev.toolCall.arguments);
          } catch {}
        }
        item.dirty = true;
      }
      scheduleRender();
      break;
    }
    case "message_end": {
      const m = record.message;
      if (m.role === "assistant") {
        scheduleStatsRefresh();
        const item = findStreamingAssistant();
        const built = { kind: "assistant", blocks: blocksOf(m), meta: assistantMeta(m), streaming: false, ts: m.timestamp, _rawMessage: m };
        if (item) {
          const i = state.items.indexOf(item);
          state.items[i] = built;
          built.node = item.node;
        } else {
          state.items.push(built);
        }
        currentAssistant = null;
      } else if (m.role === "toolResult") {
        // The authoritative result for the call. message_start already attached
        // it; this repeat keeps the final payload when they differ, and only a
        // result no block claims becomes an orphan row (deduplicated by call id,
        // since start and end both report the same result).
        if (!attachToolResult(m)) {
          const key = m.toolCallId || m.timestamp;
          const exists = state.items.some(
            (it) => it.kind === "toolResultOrphan" && (it.message?.toolCallId || it.message?.timestamp) === key
          );
          if (!exists) state.items.push({ kind: "toolResultOrphan", message: m, ts: m.timestamp, _live: true });
        }
      } else {
        // replace the tentative live item pushed by message_start
        const kind = roleKind(m.role);
        let idx = -1;
        for (let i = state.items.length - 1; i >= 0; i--) {
          if (state.items[i]._live && state.items[i].kind === kind) {
            idx = i;
            break;
          }
        }
        const built = buildItemsFromEntries([{ type: "message", message: m }])[0];
        if (idx < 0) {
          // A refresh() that ran between message_start and message_end rebuilt
          // state.items from persisted entries, wiping the _live marker. Match
          // the trailing same-kind item (same timestamp/text) instead of
          // pushing a second copy of the message.
          for (let i = state.items.length - 1; i >= 0; i--) {
            const it = state.items[i];
            if (it.kind !== kind || it._live) continue;
            const sameTs = it.ts === m.timestamp || it.entry?.message?.timestamp === m.timestamp;
            const sameText = it.text === built.text;
            // only the trailing item may merge on text alone — an older
            // identical message followed by a reply must stay distinct
            const isLast = i === state.items.length - 1;
            if (sameTs || (isLast && sameText)) {
              idx = i;
              break;
            }
          }
        }
        if (idx >= 0) {
          built.node = state.items[idx].node;
          state.items.splice(idx, 1, built);
        } else {
          state.items.push(built);
        }
      }
      scheduleRender();
      break;
    }
    case "tool_execution_start": {
      const ex = state.executions.get(record.toolCallId) || { updates: [] };
      ex.status = "running";
      state.executions.set(record.toolCallId, ex);
      markToolcallDirty(record.toolCallId);
      break;
    }
    case "tool_execution_update": {
      const ex = state.executions.get(record.toolCallId) || { updates: [], status: "running" };
      ex.status = ex.status === "pending" ? "running" : ex.status;
      if (record.partialResult != null) {
        // A subagent re-sends its whole progress snapshot on every tick; only
        // the latest one is ever read, so keeping the history would grow the
        // tab's memory for the whole length of a fan-out.
        if (record.toolName === SUBAGENT_TOOL) ex.updates = [record.partialResult];
        else ex.updates.push(record.partialResult);
      }
      state.executions.set(record.toolCallId, ex);
      markToolcallDirty(record.toolCallId);
      break;
    }
    case "tool_execution_end": {
      const ex = state.executions.get(record.toolCallId) || { updates: [] };
      ex.status = "done";
      ex.result = record.result;
      ex.isError = !!record.isError;
      ex.durationMs = record.durationMs;
      state.executions.set(record.toolCallId, ex);
      markToolcallDirty(record.toolCallId);
      break;
    }
    case "turn_end":
      break;
    case "agent_end":
      break;
    case "agent_settled": {
      state.isStreaming = false;
      renderStatus();
      scheduleSettledRefresh();
      break;
    }
    case "queue_update":
      state.queued = { steering: record.steering || [], followUp: record.followUp || [] };
      renderStatus();
      break;
    case "session_info_changed":
      state.sessionName = record.name || null;
      renderHeader();
      loadSessions();
      break;
    case "thinking_level_changed":
      state.thinkingLevel = record.level;
      renderHeader();
      break;
    case "compaction_start":
      state.isCompacting = true;
      toast(`compacting (${record.reason})…`);
      renderStatus();
      break;
    case "compaction_end":
      state.isCompacting = false;
      if (record.result) toast(`compacted: ${fmtTokens(record.result.tokensBefore)} → ~${fmtTokens(record.result.estimatedTokensAfter)} tokens`);
      else if (record.errorMessage) toast(`compaction failed: ${record.errorMessage}`, "error");
      scheduleSettledRefresh();
      renderStatus();
      break;
    case "auto_retry_start":
      toast(`retrying (${record.attempt}/${record.maxAttempts}) in ${(record.delayMs / 1000) | 0}s: ${truncate(record.errorMessage || "", 120)}`, "warning", 8000);
      break;
    case "auto_retry_end":
      if (!record.success) toast(`giving up after ${record.attempt} attempts: ${truncate(record.finalError || "", 200)}`, "error", 10000);
      break;
    case "extension_error":
      toast(`extension error: ${record.error}`, "error", 8000);
      break;
    case "extension_ui_request":
      handleExtensionUI(record);
      break;
    case "bash_execution_update":
      break; // only produced by direct RPC `bash` commands (unused by the UI)
    default:
      break;
  }
}

function roleKind(role) {
  return { user: "user", system: "system", bashExecution: "bash" }[role] || "notice";
}

function markToolcallDirty(toolCallId) {
  for (const item of state.items) {
    if (item.kind !== "assistant") continue;
    for (const b of item.blocks) {
      if (b.type === "toolcall" && b.call.id === toolCallId) {
        item.dirty = true;
      }
    }
  }
  scheduleRender();
  // an open popup for this call follows the run live
  repaintModal();
}

let refreshTimer = null;
function scheduleSettledRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    // Re-pull persisted entries (now includes the just-finished run).
    try {
      await refresh({ sessions: true });
    } catch {}
  }, 250);
}

// The ctx/cost badges in the header update per assistant message, not only at
// agent_settled — a multi-turn run otherwise shows stale totals until it ends.
let statsTimer = null;
function scheduleStatsRefresh() {
  if (statsTimer) return;
  statsTimer = setTimeout(async () => {
    statsTimer = null;
    try {
      const s = await cmd("get_session_stats");
      state.stats = s.data;
      renderHeader();
    } catch {}
  }, 300);
}

async function restartPi() {
  try {
    // reopen this tab's session in a fresh process (the old one exited);
    // every other session in the pool keeps running untouched
    await api("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: CLIENT_ID,
        ...(state.sessionFile
          ? { sessionFile: state.sessionFile }
          : { cwd: state.workspace || state.cwd }),
      }),
    });
    await waitPiReady(state.sessionFile);
    $("#pi-status").textContent = "pi running";
    $("#pi-status").className = "pi-status ok";
    $("#pi-status").onclick = null;
    state.queued = { steering: [], followUp: [] }; // queue died with the process
    await refresh({ sessions: false });
    syncHash();
  } catch (err) {
    toast(`restart failed: ${err.message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// extension UI dialogs
// ---------------------------------------------------------------------------
function handleExtensionUI(record) {
  if (!["select", "confirm", "input", "editor"].includes(record.method)) {
    if (record.method === "notify") toast(record.message || "", record.notifyType || "info", 6000);
    return;
  }
  const overlay = $("#dialog-overlay");
  const title = $("#dialog-title");
  const body = $("#dialog-body");
  const hint = $("#dialog-hint");
  title.textContent = record.title || record.method;
  hint.textContent = record.timeout ? `auto-resolves in ${Math.round(record.timeout / 1000)}s` : "";

  const send = (payload) => {
    overlay.classList.add("hidden");
    fetch("/api/ui-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: CLIENT_ID, id: record.id, ...payload }),
    }).catch((err) => toast(`dialog response failed: ${err.message}`, "error"));
  };
  $("#dialog-cancel").onclick = () => send({ cancelled: true });

  body.innerHTML = "";
  if (record.method === "select") {
    for (const opt of record.options || []) {
      body.append(el("div", { class: "opt", text: opt, onclick: () => send({ value: opt }) }));
    }
  } else if (record.method === "confirm") {
    const msg = el("div", { text: record.message || "", style: "white-space:pre-wrap;margin-bottom:12px" });
    const yes = el("button", { text: "Yes", onclick: () => send({ confirmed: true }) });
    const no = el("button", { text: "No", onclick: () => send({ confirmed: false }) });
    yes.style.marginRight = "8px";
    body.append(msg, el("div", {}, yes, no));
  } else if (record.method === "input" || record.method === "editor") {
    const inp =
      record.method === "editor"
        ? Object.assign(document.createElement("textarea"), { value: record.prefill || "" })
        : el("input", { placeholder: record.placeholder || "" });
    const ok = el("button", { text: "OK", onclick: () => send({ value: inp.value }) });
    body.append(inp, el("div", { style: "margin-top:10px" }, ok));
    inp.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return; // IME candidate confirmation
      if (e.key === "Enter" && record.method === "input" && !e.shiftKey) send({ value: inp.value });
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send({ value: inp.value });
    });
    setTimeout(() => inp.focus(), 30);
  }
  overlay.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// popup: tool request/response viewer, and the raw JSON inspector
// ---------------------------------------------------------------------------
// `livePaint` renders the rich view and is re-run when the tool emits more
// output, so an open popup follows a running call. `payload` is evaluated
// lazily for the Raw JSON toggle and Copy.
let livePaint = null;
let payloadFn = null;
let showRaw = false;

function renderModalBody() {
  const body = $("#modal-body");
  body.innerHTML = "";
  const rawBtn = $("#modal-raw");
  const canToggle = Boolean(livePaint && payloadFn);
  rawBtn.classList.toggle("hidden", !canToggle);
  rawBtn.textContent = showRaw ? "Rendered" : "Raw JSON";
  if (livePaint && !showRaw) body.append(livePaint());
  else if (payloadFn) body.append(jsonBlock(payloadFn(), ""));
  else body.append(el("div", { class: "dim", text: "(nothing to show)" }));
}

function openPopup(title, { paint = null, payload = null } = {}) {
  livePaint = paint;
  payloadFn = payload;
  showRaw = false; // a fresh popup always opens rendered
  $("#modal-title").textContent = title;
  renderModalBody();
  $("#modal-body").scrollTop = 0;
  $("#modal-overlay").classList.remove("hidden");
  $("#modal-close").focus({ preventScroll: true });
}

function closeModal() {
  $("#modal-overlay").classList.add("hidden");
  livePaint = null;
  payloadFn = null;
  showRaw = false;
}

/** repaint an open live popup without moving its scroll position */
function repaintModal() {
  if (!livePaint || showRaw || $("#modal-overlay").classList.contains("hidden")) return;
  const keep = $("#modal-body").scrollTop;
  renderModalBody();
  $("#modal-body").scrollTop = keep;
}

/** open one tool call: arguments, execution updates and response in a popup */
function openToolcall(call, block) {
  // the subagent popup leads with the child fan-out, not a generic payload dump
  const current = toolcallState(block);
  if (isSubagentRun(current.call, current.exec, current.result)) {
    openSubagent(call, block);
    return;
  }
  // edit popups carry the target file name in the title
  const title =
    call.name === "edit" && call.arguments?.path
      ? `edit: ${String(call.arguments.path).split(/[\\/]/).pop()}`
      : `tool: ${call.name}`;
  openPopup(title, {
    paint: () => {
      // re-read live state so a running call stays current between repaints
      const st = toolcallState(block);
      return buildToolcallBody(st.call, st.exec, st.result);
    },
    payload: () => {
      const st = toolcallState(block);
      return { toolCall: st.call, execution: st.exec || null, toolResult: st.result };
    },
  });
}

/** raw JSON popup for a message / entry / summary chip */
function openJson(title, payload) {
  openPopup(title, { payload: () => payload });
}

/** orphaned tool result (a result whose call is gone): plain-text body in a popup */
function openRawTool(title, buildBody, payload) {
  openPopup(title, { paint: buildBody, payload: () => payload });
}

$("#modal-close").addEventListener("click", closeModal);
$("#modal-overlay").addEventListener("click", (e) => {
  if (e.target === $("#modal-overlay")) closeModal();
});
$("#modal-raw").addEventListener("click", () => {
  showRaw = !showRaw;
  renderModalBody();
  $("#modal-body").scrollTop = 0;
});
$("#modal-copy").addEventListener("click", () => {
  const text = JSON.stringify(payloadFn ? payloadFn() : null, null, 2);
  navigator.clipboard.writeText(text).then(() => toast("copied"), () => toast("copy failed", "error"));
});

// ---------------------------------------------------------------------------
// composer
// ---------------------------------------------------------------------------
function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
}
// ---------------------------------------------------------------------------
// slash-command autocomplete: typing "/" at the start of the composer lists
// the session's discoverable commands (skills, prompt templates, extensions)
// ---------------------------------------------------------------------------
const cmdMenuEl = el("div", { class: "cmd-menu hidden", role: "listbox", "aria-label": "Slash commands" });
$("#composer").append(cmdMenuEl);
let cmdMatches = [];
let cmdIndex = 0;

/** the word being typed after a leading "/", or null when not composing a command */
function cmdToken() {
  const v = inputEl.value;
  const pos = inputEl.selectionStart;
  if (!v.startsWith("/") || pos == null || inputEl.selectionEnd !== pos) return null;
  const typed = v.slice(1, pos);
  return /\s/.test(typed) ? null : typed;
}

function closeCmdMenu() {
  cmdMenuEl.classList.add("hidden");
  cmdMenuEl.innerHTML = "";
  cmdMatches = [];
  cmdIndex = 0;
}

/** true when the caret sits on the first (ArrowUp) / last (ArrowDown) visual
 *  line of the textarea — arrows must keep their native caret movement while
 *  the user is navigating inside a multi-line draft */
function cursorOnOuterLine(ta) {
  const pos = ta.selectionStart;
  if (pos == null || ta.selectionEnd !== pos) return false;
  if (ta.value.slice(0, pos).includes("\n")) return false; // ArrowUp: not on the first line
  if (ta.value.slice(pos).includes("\n")) return false; // ArrowDown: not on the last line
  return true;
}

function updateCmdMenu() {
  const token = cmdToken();
  // token === "" is valid: a bare "/" lists every command
  if (token == null || !state.commands.length) {
    closeCmdMenu();
    return;
  }
  const q = token.toLowerCase();
  cmdMatches = state.commands
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 200);
  cmdIndex = 0;
  renderCmdMenu();
}

function renderCmdMenu() {
  if (!cmdMatches.length) {
    closeCmdMenu();
    return;
  }
  cmdMenuEl.innerHTML = "";
  cmdMenuEl.classList.remove("hidden");
  cmdMatches.forEach((c, i) => {
    const selected = i === cmdIndex;
    cmdMenuEl.append(
      el(
        "div",
        {
          class: `cmd-item${selected ? " selected" : ""}`,
          role: "option",
          "aria-selected": String(selected),
          // mousedown (not click) so the composer never loses focus
          onmousedown: (e) => {
            e.preventDefault();
            applyCmdIndex(i);
          },
        },
        el("span", { class: `cmd-source ${c.source || ""}`, text: c.source || "cmd" }),
        el("span", { class: "cmd-name", text: `/${c.name}` }),
        c.description ? el("span", { class: "cmd-desc", text: c.description }) : null
      )
    );
  });
}

function moveCmdIndex(delta) {
  if (!cmdMatches.length) return;
  cmdIndex = (cmdIndex + delta + cmdMatches.length) % cmdMatches.length;
  renderCmdMenu();
  cmdMenuEl.querySelector(".cmd-item.selected")?.scrollIntoView({ block: "nearest" });
}

/** replace the typed "/word" with "/name", keep any args typed after it */
function applyCmdIndex(i) {
  const c = cmdMatches[i];
  if (!c) return;
  const v = inputEl.value;
  const sp = v.search(/\s/);
  const tail = sp === -1 ? "" : v.slice(sp); // args already typed after the first word
  inputEl.value = tail ? `/${c.name}${tail}` : `/${c.name} `;
  const caret = c.name.length + (tail ? 1 : 2);
  inputEl.setSelectionRange(caret, caret);
  autosize(inputEl);
  closeCmdMenu();
  inputEl.focus();
}

const inputEl = $("#input");

// ---------------------------------------------------------------------------
// prompt history: ArrowUp/ArrowDown (terminal-style) recalls previously sent
// prompts; ArrowDown past the newest restores the in-progress draft.
// ---------------------------------------------------------------------------
function promptHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function rememberPrompt(text) {
  const hist = promptHistory().filter((s) => s !== text);
  hist.push(text); // most recent last
  if (hist.length > PROMPT_HISTORY_MAX) hist.splice(0, hist.length - PROMPT_HISTORY_MAX);
  localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(hist));
}

// -1 = not browsing; otherwise an offset back from the newest entry:
// 0 = newest prompt, 1 = the one before it, …
let historyIndex = -1;
let historyDraft = "";

function resetHistoryBrowse() {
  historyIndex = -1;
}

function showHistoryEntry() {
  const hist = promptHistory();
  const pos = hist.length - 1 - historyIndex;
  if (pos < 0 || pos >= hist.length) return;
  inputEl.value = hist[pos];
  autosize(inputEl);
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function historyMove(delta) {
  const hist = promptHistory();
  if (!hist.length) return;
  if (historyIndex === -1) {
    // not browsing yet: ArrowDown is a no-op, ArrowUp enters history at the
    // newest prompt and parks the current draft
    if (delta < 0) return;
    historyDraft = inputEl.value;
    historyIndex = 0;
  } else {
    const next = historyIndex + delta; // ArrowUp = older, ArrowDown = newer
    if (next >= hist.length) return; // already at the oldest entry
    if (next < 0) {
      // walked forward past the newest entry: restore the parked draft
      historyIndex = -1;
      inputEl.value = historyDraft;
      autosize(inputEl);
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      return;
    }
    historyIndex = next;
  }
  showHistoryEntry();
}
inputEl.addEventListener("input", () => {
  autosize(inputEl);
  updateCmdMenu();
  resetHistoryBrowse();
});
inputEl.addEventListener("blur", closeCmdMenu);
inputEl.addEventListener("keydown", (e) => {
  // IME (e.g. Chinese pinyin) in flight: Enter confirms the candidate and must
  // not send or trigger the command menu (keyCode 229 = IME on old Safari/Edge)
  if (e.isComposing || e.keyCode === 229) return;
  if (!cmdMenuEl.classList.contains("hidden")) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveCmdIndex(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveCmdIndex(-1);
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      // Tab always completes; Enter completes unless the typed word already
      // is an exact command name — then it falls through and sends.
      const typed = inputEl.value.slice(1, inputEl.selectionStart);
      const exact = state.commands.some((c) => c.name === typed);
      if (e.key === "Tab" || !exact) {
        e.preventDefault();
        applyCmdIndex(cmdIndex);
        return;
      }
    }
    if (e.key === "Escape") {
      // close the menu without triggering the global Esc actions (abort)
      e.preventDefault();
      e.stopPropagation();
      closeCmdMenu();
      return;
    }
  }
  if (e.key === "ArrowUp" && !e.altKey && !e.ctrlKey && !e.metaKey && cursorOnOuterLine(inputEl)) {
    e.preventDefault();
    historyMove(1);
    return;
  }
  if (e.key === "ArrowDown" && !e.altKey && !e.ctrlKey && !e.metaKey && cursorOnOuterLine(inputEl)) {
    e.preventDefault();
    historyMove(-1);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  } else if (e.key === "Escape" && state.isStreaming) {
    abort();
  }
});

// ---------------------------------------------------------------------------
// composer image attachments: drag screenshots in for quick triage
// ---------------------------------------------------------------------------
const attachmentsEl = $("#attachments");
const attachments = []; // { data: base64 payload, mimeType, url: dataURL }

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.toggle("hidden", !attachments.length);
  attachments.forEach((a, i) => {
    // clicking a thumbnail opens the full image in the popup for detail review
    const zoom = () => openPopup("attachment", { paint: () => el("div", { class: "attachment-zoom" }, el("img", { src: a.url, alt: "attachment" })) });
    attachmentsEl.append(
      el(
        "div",
        { class: "attachment" },
        el("img", { src: a.url, alt: "attachment preview", title: "Click to enlarge", onclick: zoom }),
        el("button", {
          class: "attachment-remove",
          title: "Remove attachment",
          "aria-label": "Remove attachment",
          text: "✕",
          onclick: () => {
            attachments.splice(i, 1);
            renderAttachments();
          },
        })
      )
    );
  });
}

function addImageFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    added++;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result); // data:<mime>;base64,<payload>
      attachments.push({ data: url.slice(url.indexOf(",") + 1), mimeType: f.type, url });
      renderAttachments();
    };
    reader.readAsDataURL(f);
  }
  if (added) inputEl.focus();
  else toast("unsupported file — images only", "error");
}

// The attach button opens the OS file picker; dropping files still works.
// The input is cleared after every pick so choosing the same file twice in a
// row still fires a change event.
$("#btn-attach").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => {
  const files = [...(e.target.files || [])];
  if (files.length) addImageFiles(files);
  e.target.value = "";
});

// File drops are accepted anywhere on the page and routed to the composer.
// Cancelling at window level is what actually prevents the browser's default
// action (opening the dropped image in a tab / navigating away) — a composer-
// scoped handler misses every drop that lands a few pixels outside it.
// Text/URL drags carry no "Files" type and keep their default behavior.
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
window.addEventListener("dragenter", (e) => hasFiles(e) && e.preventDefault());
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.add("dropping");
});
window.addEventListener("dragleave", (e) => {
  // dragleave fires on every element crossing; relatedTarget is null only
  // when the pointer actually leaves the window
  if (!e.relatedTarget) document.body.classList.remove("dropping");
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.remove("dropping");
  if (e.dataTransfer?.files?.length) addImageFiles([...e.dataTransfer.files]);
});

$("#btn-send").addEventListener("click", sendPrompt);
$("#btn-abort").addEventListener("click", abort);
$("#btn-new-session").addEventListener("click", newSession);
$("#session-filter").addEventListener("input", renderSidebar);
function showWorkspaces() {
  state.workspace = null;
  localStorage.removeItem(WS_KEY);
  renderSidebar();
}
$("#btn-back-workspaces").addEventListener("click", showWorkspaces);
$("#btn-workspaces").addEventListener("click", openWsPicker);
function selectTab(tab) {
  if (state.sidebarTab === tab) return;
  state.sidebarTab = tab;
  localStorage.setItem(TAB_KEY, tab);
  renderSidebar();
}
$("#tab-workspaces").addEventListener("click", () => selectTab("workspaces"));
$("#tab-recent").addEventListener("click", () => selectTab("recent"));

// ---------------------------------------------------------------------------
// workspace directory picker (local folder chooser dialog)
// ---------------------------------------------------------------------------
const DIR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
let wsBrowse = null; // { path, parent, dirs, home }

async function browseWs(dir) {
  try {
    wsBrowse = await api(`/api/browse?path=${encodeURIComponent(dir || "")}`);
    renderWsDirs();
  } catch (err) {
    toast(`cannot open directory: ${err.message}`, "error");
  }
}

function renderWsDirs() {
  if (!wsBrowse) return;
  $("#ws-path").textContent = wsBrowse.path;
  $("#ws-path").title = wsBrowse.path;
  $("#ws-up").disabled = !wsBrowse.parent;
  const list = $("#ws-dirs");
  list.innerHTML = "";
  if (!wsBrowse.dirs.length) {
    list.append(el("div", { class: "list-empty", text: "No subdirectories" }));
  }
  for (const name of wsBrowse.dirs) {
    list.append(
      el(
        "div",
        {
          class: "ws-dir",
          onclick: () => browseWs(`${wsBrowse.path}/${name}`),
        },
        el("span", { html: DIR_ICON, "aria-hidden": "true" }),
        el("span", { text: name })
      )
    );
  }
}

function openWsPicker() {
  $("#ws-overlay").classList.remove("hidden");
  browseWs(state.workspace || state.cwd || "");
}

function closeWsPicker() {
  $("#ws-overlay").classList.add("hidden");
}

async function chooseWsDir() {
  if (!wsBrowse) return;
  const cwd = wsBrowse.path;
  closeWsPicker();
  pinWorkspace(cwd);
  state.workspace = cwd;
  localStorage.setItem(WS_KEY, cwd);
  renderSidebar();
  // start a fresh session in the chosen workspace — newSession() owns the
  // restart + transcript clear + URL sync so every "new session" path behaves
  // identically (this used to skip the transcript clear, leaving the old chat
  // on screen after switching workspace)
  await newSession();
}

$("#ws-up").addEventListener("click", () => wsBrowse?.parent && browseWs(wsBrowse.parent));
$("#ws-home").addEventListener("click", () => browseWs(wsBrowse?.home || ""));
$("#ws-cancel").addEventListener("click", closeWsPicker);
$("#ws-choose").addEventListener("click", chooseWsDir);
$("#ws-overlay").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeWsPicker();
});

// ---------------------------------------------------------------------------
// sidebar resize divider
// ---------------------------------------------------------------------------
const SIDEBAR_WIDTH_KEY = "piweb-sidebar-width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;

function applySidebarWidth(px) {
  const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px));
  $("#sidebar").style.width = `${w}px`;
  $("#sidebar").style.minWidth = `${w}px`;
}

$("#resizer").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = $("#sidebar").getBoundingClientRect().width;
  $("#resizer").classList.add("dragging");
  document.body.classList.add("resizing");
  $("#resizer").setPointerCapture(e.pointerId);
  const onMove = (ev) => applySidebarWidth(startW + (ev.clientX - startX));
  const onUp = (ev) => {
    applySidebarWidth(startW + (ev.clientX - startX));
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round($("#sidebar").getBoundingClientRect().width)));
    $("#resizer").classList.remove("dragging");
    document.body.classList.remove("resizing");
    $("#resizer").removeEventListener("pointermove", onMove);
    $("#resizer").removeEventListener("pointerup", onUp);
    $("#resizer").removeEventListener("pointercancel", onUp);
  };
  $("#resizer").addEventListener("pointermove", onMove);
  $("#resizer").addEventListener("pointerup", onUp);
  $("#resizer").addEventListener("pointercancel", onUp);
});
$("#resizer").addEventListener("dblclick", () => {
  localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  $("#sidebar").style.width = "";
  $("#sidebar").style.minWidth = "";
});
applySidebarWidth(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 280);

// ---------------------------------------------------------------------------
// theme (light / dark)
// ---------------------------------------------------------------------------
const ICON_SUN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const ICON_MOON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
/** parse a static SVG string into a live element (no untrusted input) */
function svgIcon(markup) {
  return document.importNode(new DOMParser().parseFromString(markup, "image/svg+xml").documentElement, true);
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("piweb-theme", theme);
  $("#btn-theme").replaceChildren(svgIcon(theme === "light" ? ICON_MOON : ICON_SUN));
  // keep the browser chrome (mobile address bar, PWA shell) on the same page color
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f5f7fa" : "#0d1117");
}
$("#btn-theme").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#model-menu").classList.contains("hidden") || !$("#thinking-menu").classList.contains("hidden")) {
      closePickers();
    } else if (!$("#session-info-pop").classList.contains("hidden")) {
      setSessionInfoOpen(false);
    } else if (!$("#prompt-list-pop").classList.contains("hidden")) {
      setPromptListOpen(false);
    } else if (!searchOverlay.classList.contains("hidden")) {
      setSearchOpen(false);
    } else if (!$("#ws-overlay").classList.contains("hidden")) {
      closeWsPicker();
    } else if (!$("#dialog-overlay").classList.contains("hidden")) {
      $("#dialog-cancel").click();
    } else if (!$("#image-overlay").classList.contains("hidden")) {
      // the viewer sits above the tool popup, so it closes first
      closeImageViewer();
    } else if (!$("#modal-overlay").classList.contains("hidden")) {
      closeModal();
    } else if (state.isStreaming && document.activeElement !== inputEl) {
      abort();
    }
  }
});

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------
function connectEvents() {
  // one SSE stream per tab: only events of the session this tab is attached
  // to arrive here, so parallel tabs never interleave each other's output
  const es = new EventSource(`/api/events?client=${encodeURIComponent(CLIENT_ID)}`);
  es.onmessage = (m) => {
    try {
      handleEvent(JSON.parse(m.data));
    } catch (err) {
      console.error("bad event", err);
    }
  };
  es.onerror = () => {
    $("#pi-status").textContent = "connection lost — retrying…";
    $("#pi-status").className = "pi-status bad";
  };
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function boot() {
  applyTheme(localStorage.getItem("piweb-theme") || "light");
  const cfg = await api("/api/config").catch(() => null);
  state.cwd = cfg?.cwd;
  connectEvents();
  // Sessions are no longer auto-started by the server: this tab opens its own
  // (a fresh one in the server cwd; the hash deep link below may re-point it
  // to an existing file, attaching to that file's process if one is live).
  await api("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: CLIENT_ID }),
  }).catch(() => {});
  // Not awaited: the retry loop re-renders the picker as providers land, and
  // boot must not stall on a slow extension registration.
  loadModels({ retry: true });
  await refresh({ sessions: true });
  // poll the session list so the sidebar's background-run dots stay current
  setInterval(() => loadSessions().catch(() => {}), 8000);
  // deep link: #ws=<cwd>&session=<file|new> — open the hashed session if it
  // differs from what this tab started with
  const hs = hashState();
  const target = hs?.session && hs.session !== "new" ? hs.session : null;
  if (target && target !== state.sessionFile) {
    const meta = state.sessions.find((s) => s.file === target);
    await switchSession(target, meta?.cwd || hs.ws || undefined);
  } else {
    syncHash();
  }
  inputEl.focus();
})();
