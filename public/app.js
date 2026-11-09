/* pi-web frontend: talks to the local bridge server (server.js) which
 * proxies a `pi --mode rpc` subprocess. No framework, no build step. */
"use strict";

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
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

const state = {
  items: [], // transcript items (ordered, active branch + live)
  executions: new Map(), // toolCallId -> { status, updates[], result, isError, durationMs }
  openToolcalls: new Set(), // toolCallId -> card expanded (per call, not per message)
  isStreaming: false,
  isCompacting: false,
  sessionFile: null,
  sessionId: null,
  sessionName: null,
  leafId: null, // active-branch leaf from get_entries
  model: null,
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
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(inlineMd(lines[i].replace(/^\s*>\s?/, ""))), i++;
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
          items.push({ kind: "toolResultOrphan", message: m, ts });
        }
        break;
      }
      case "bashExecution": {
        items.push({ kind: "bash", message: m, ts });
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

/** colored unified-diff view: red deletions, green additions, blue hunk
 *  headers — plain rendering for any non-diff preamble (title, stat line) */
function diffBlock(text) {
  const wrap = el("div", { class: "tc-text tc-diff" });
  let inDiff = false;
  for (const line of text.split("\n")) {
    if (!inDiff && /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) inDiff = true;
    let cls = "";
    if (inDiff) {
      if (/^@@/.test(line)) cls = "dhunk";
      else if (/^(---|\+\+\+) /.test(line)) cls = "dfile";
      else if (line.startsWith("+")) cls = "dadd";
      else if (line.startsWith("-")) cls = "ddel";
      else if (/^\\ No newline/.test(line)) cls = "dmeta";
    }
    const row = el("div", { class: `dline${cls ? ` ${cls}` : ""}` });
    if (cls === "dadd" || cls === "ddel") {
      // keep the body text at default color; tint the +/- sign for emphasis
      row.append(el("span", { class: "dsign", text: line[0] }), line.slice(1) || " ");
    } else {
      row.textContent = line || " ";
    }
    wrap.append(row);
  }
  return wrap;
}

/** one tool call card */
function renderToolcall(item, block) {
  const call = block.call;
  const ex = state.executions.get(call.id);
  const result = block.result || (ex && ex.result != null ? { content: ex.result.content, isError: ex.isError, details: ex.result.details } : null);
  const exec = ex || { status: block.result ? "done" : "pending", updates: [] };
  if (block.result) exec.status = block.result.isError ? "error" : "ok";

  const statusText = exec.status === "running" ? "running" : exec.status === "pending" ? "queued" : block.result?.isError || exec.isError ? "error" : "done";
  // expand state is per tool call: one assistant message can contain several
  // toolCall blocks, and a shared flag would open/close them all together
  const isOpen = state.openToolcalls.has(call.id);
  const card = el("div", { class: `toolcall ${exec.status === "running" ? "running" : ""} ${statusText === "error" ? "error" : ""} ${isOpen ? "open" : ""}`, "data-call-id": call.id });

  const summary = argsSummary(call) || JSON.stringify(call.arguments || {}).slice(0, 80);
  const head = el(
    "div",
    {
      class: "tc-head",
      role: "button",
      tabindex: "0",
      "aria-expanded": String(isOpen),
      onclick: () => toggleToolcall(item, call.id, head),
      onkeydown: onActivate(() => toggleToolcall(item, call.id, head)),
    },
    el("span", { class: "tc-chevron", text: "▸" }),
    el("span", { class: "tc-name", text: call.name }),
    el("span", { class: "tc-summary", text: summary }),
    exec.durationMs != null ? el("span", { class: "tc-duration", text: fmtDuration(exec.durationMs) }) : null,
    el("span", { class: `tc-status ${statusText}`, text: statusText })
  );
  card.append(head);

  const body = el("div", { class: "tc-body" });

  // request
  const reqPre = el("div", { class: "tc-section" }, el("div", { class: "tc-label", text: "request · arguments" }));
  try {
    reqPre.append(jsonBlock(call.arguments ?? call.argsRaw ?? {}));
  } catch {
    reqPre.append(jsonBlock(String(call.argsRaw ?? "")));
  }
  body.append(reqPre);

  // execution updates (live partial results)
  if (exec.updates && exec.updates.length) {
    const sec = el("div", { class: "tc-section" }, el("div", { class: "tc-label", text: `execution updates (${exec.updates.length})` }));
    const last = exec.updates[exec.updates.length - 1];
    const txt = resultText(last?.content) || JSON.stringify(last);
    const pre = el("div", { class: "tc-text clipped", text: txt.slice(-4000) });
    sec.append(pre);
    body.append(sec);
  }

  // response
  if (result) {
    const sec = el("div", { class: `tc-section tc-result ${result.isError ? "is-error" : ""}` }, el("div", { class: "tc-label", text: `response ${result.isError ? "· ERROR" : ""}` }));
    for (const b of result.content || []) {
      if (b.type === "text") {
        const txt = b.text || "";
        const pre = looksLikeDiff(txt) ? diffBlock(txt) : el("div", { class: "tc-text", text: txt });
        if (txt.length > 2000) {
          pre.classList.add("clipped");
          const more = el("span", { class: "tc-expand", text: `show all (${txt.length} chars)`, onclick: () => { pre.classList.toggle("clipped"); more.textContent = pre.classList.contains("clipped") ? `show all (${txt.length} chars)` : "collapse"; } });
          sec.append(pre, more);
        } else sec.append(pre);
      } else if (b.type === "image") {
        sec.append(el("img", { src: `data:${b.mimeType};base64,${b.data}` }));
      }
    }
    if (result.details != null) {
      const det = el("div", { class: "tc-label", text: "details" });
      sec.append(det, jsonBlock(result.details));
    }
    body.append(sec);
  }

  card.append(body);

  // double-click the header for the full raw JSON inspector
  head.addEventListener("dblclick", () => {
    const payload = { toolCall: call, execution: ex || null, toolResult: block.result || null };
    openModal(`tool: ${call.name}`, payload);
  });
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
  line.addEventListener("click", () => openModal("assistant message", meta._raw || meta));
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
          d.innerHTML = renderMarkdown(b.text || "");
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
      // keep them collapsed by default like normal tool cards — the head
      // toggles the body, double-click opens the raw JSON inspector
      const key = `orphan-${m.toolCallId || m.timestamp || ""}`;
      const isOpen = state.openToolcalls.has(key);
      const card = el("div", { class: `toolcall ${isOpen ? "open" : ""}`, "data-call-id": key });
      const head = el(
        "div",
        {
          class: "tc-head",
          role: "button",
          tabindex: "0",
          "aria-expanded": String(isOpen),
          title: "Click to expand · double-click for raw JSON",
          onclick: () => toggleToolcall(item, key, head),
          onkeydown: onActivate(() => toggleToolcall(item, key, head)),
        },
        el("span", { class: "tc-chevron", text: "▸" }),
        el("span", { class: "tc-name", text: m.toolName }),
        el("span", { class: "tc-summary", text: "(orphaned tool result)" }),
        el("span", { class: `tc-status ${m.isError ? "error" : "ok"}`, text: m.isError ? "error" : "done" })
      );
      head.addEventListener("dblclick", () => openModal(`tool result: ${m.toolName}`, m));
      card.append(head, el("div", { class: "tc-body" }, el("div", { class: "tc-text", text: resultText(m.content).slice(0, 4000) })));
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
      chip.addEventListener("click", () => openModal(item.title, { title: item.title, text: item.text, data: item.data }));
      return el("div", { class: "item item-notice" }, chip);
    }
    case "notice": {
      const chip = el("div", { class: "notice-chip", text: item.text });
      if (item.data) chip.addEventListener("click", () => openModal("entry", item.data));
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
  // auto-follow the bottom is for streaming content only — user-initiated
  // re-renders (e.g. expanding a tool card) must not fling the page
  if (follow && nearBottom) scrollBottom();
  updateJumpButton();
}

function rerenderItem(item) {
  item.dirty = true;
  renderTranscript({ follow: false });
}

/** toggle one tool card and keep it anchored at the same viewport position:
 *  the re-render replaces the node, so measure the card's screen position
 *  before and after and compensate scrollTop by the difference */
function toggleToolcall(item, callId, headEl) {
  const before = headEl.getBoundingClientRect().top;
  state.openToolcalls.has(callId) ? state.openToolcalls.delete(callId) : state.openToolcalls.add(callId);
  rerenderItem(item);
  const fresh = item.node && item.node.querySelector(`[data-call-id="${CSS.escape(callId)}"]`);
  if (fresh) {
    const delta = fresh.getBoundingClientRect().top - before;
    if (Math.abs(delta) > 1) transcriptEl.scrollTop += delta;
  }
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

  const modelSel = $("#model-select");
  if (state.models.length) {
    modelSel.classList.remove("hidden");
    modelSel.innerHTML = "";
    const byProvider = new Map();
    for (const m of state.models) {
      if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
      byProvider.get(m.provider).push(m);
    }
    for (const [provider, models] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const group = el("optgroup", { label: provider });
      for (const m of models) {
        const opt = el("option", { value: `${m.provider}/${m.id}`, text: m.name || m.id });
        opt.selected = state.model && state.model.provider === m.provider && state.model.id === m.id;
        group.append(opt);
      }
      modelSel.append(group);
    }
  }
  const thinkSel = $("#thinking-select");
  thinkSel.innerHTML = "";
  if (state.thinkingLevels.length) {
    thinkSel.classList.remove("hidden");
    for (const lv of state.thinkingLevels) {
      const opt = el("option", { value: lv, text: `think: ${lv}` });
      opt.selected = lv === state.thinkingLevel;
      thinkSel.append(opt);
    }
  } else {
    thinkSel.classList.add("hidden");
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
  if (!inWs.length) list.append(el("div", { class: "list-empty", text: "No sessions here yet — use + New" }));
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
    state.openToolcalls.clear();
    renderTranscript();
    if (stats) {
      try {
        const s = await cmd("get_session_stats");
        state.stats = s.data;
      } catch {}
      try {
        const st = await cmd("get_state");
        // `|| null` (not `|| state.sessionFile`): a fresh/new session reports
        // sessionFile=null and must CLEAR the old one — keeping it would leave
        // the old title in the header and the old session id in the URL hash.
        state.sessionFile = st.data?.sessionFile || null;
        state.sessionId = st.data?.sessionId;
        state.sessionName = st.data?.sessionName || null;
        state.model = st.data?.model || state.model;
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
    renderHeader();
    renderStatus();
    if (sessions) await loadSessions();
  } catch (err) {
    console.error(err);
    toast(`refresh failed: ${err.message}`, "error");
  }
}

async function loadModels() {
  try {
    const res = await cmd("get_available_models");
    state.models = res.data?.models || [];
  } catch {}
  renderHeader();
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

async function switchSession(file, cwd) {
  if (file === state.sessionFile) return;
  try {
    // NOTE: the previously attached session is NOT aborted — it keeps running
    // in its own pi process on the server and can be re-attached anytime.
    const resp = await api("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: CLIENT_ID, sessionFile: file, ...(cwd ? { cwd } : {}) }),
    });
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
    state.sessionFile = file;
    state.executions.clear();
    state.openToolcalls.clear();
    state.isStreaming = false;
    state.isCompacting = false;
    currentAssistant = null;
    $("#composer-hint").textContent = "";
    await refresh({ sessions: false });
    renderSidebar(); // re-render so the .active highlight follows the clicked row
    syncHash();
  } catch (err) {
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
    state.openToolcalls.clear();
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
      break;
    case "turn_start":
      break;
    case "message_start": {
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
      if (record.partialResult != null) ex.updates.push(record.partialResult);
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
// modal (full JSON inspector)
// ---------------------------------------------------------------------------
let modalPayload = null;
function openModal(title, payload) {
  modalPayload = payload;
  $("#modal-title").textContent = title;
  const body = $("#modal-body");
  body.innerHTML = "";
  body.append(jsonBlock(payload, ""));
  $("#modal-overlay").classList.remove("hidden");
}
$("#modal-close").addEventListener("click", () => $("#modal-overlay").classList.add("hidden"));
$("#modal-overlay").addEventListener("click", (e) => {
  if (e.target === $("#modal-overlay")) $("#modal-overlay").classList.add("hidden");
});
$("#modal-copy").addEventListener("click", () => {
  navigator.clipboard.writeText(JSON.stringify(modalPayload, null, 2)).then(() => toast("copied"), () => toast("copy failed", "error"));
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
inputEl.addEventListener("input", () => {
  autosize(inputEl);
  updateCmdMenu();
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
    attachmentsEl.append(
      el(
        "div",
        { class: "attachment" },
        el("img", { src: a.url, alt: "attachment preview" }),
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
  else toast("unsupported file — drop image files only", "error");
}

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
const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("piweb-theme", theme);
  $("#btn-theme").innerHTML = theme === "light" ? ICON_MOON : ICON_SUN;
}
$("#btn-theme").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

$("#model-select").addEventListener("change", async (e) => {
  const [provider, ...rest] = e.target.value.split("/");
  const modelId = rest.join("/");
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
});

$("#thinking-select").addEventListener("change", async (e) => {
  try {
    await cmd("set_thinking_level", { level: e.target.value });
    state.thinkingLevel = e.target.value;
  } catch (err) {
    toast(`set thinking failed: ${err.message}`, "error");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#session-info-pop").classList.contains("hidden")) {
      setSessionInfoOpen(false);
    } else if (!$("#prompt-list-pop").classList.contains("hidden")) {
      setPromptListOpen(false);
    } else if (!$("#ws-overlay").classList.contains("hidden")) {
      closeWsPicker();
    } else if (!$("#dialog-overlay").classList.contains("hidden")) {
      $("#dialog-cancel").click();
    } else if (!$("#modal-overlay").classList.contains("hidden")) {
      $("#modal-overlay").classList.add("hidden");
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
  applyTheme(localStorage.getItem("piweb-theme") || "dark");
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
  await loadModels();
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
