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
const SIDEBAR_TABS = ["recent", "workspaces", "favorites", "followups"];
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
  mcps: null, // { servers, errors } from /api/mcp; null = not fetched yet
  mcpsAt: 0, // when that snapshot was taken
  thinkingLevel: null,
  thinkingLevels: [],
  stats: null,
  queued: { steering: [], followUp: [] },
  sessions: [],
  /** saved follow-ups (summaries kept out of their session), newest first */
  followups: [],
  /** open follow-up in the main column, or null; while set, the transcript is
   *  not shown and no pi process is involved */
  openFollowup: null,
  /** true while the open follow-up is being edited in place (title + body) */
  followupEditing: false,
  cwd: null,
  /** selected workspace cwd; null = workspace list view; undefined = not yet initialized */
  workspace: undefined,
  /** sidebar view: "recent" = flat list across all workspaces, "workspaces" = two-level,
   *  "favorites" = flat list of sessions starred by the user, "followups" = saved summaries */
  sidebarTab: SIDEBAR_TABS.includes(localStorage.getItem(TAB_KEY)) ? localStorage.getItem(TAB_KEY) : "recent",
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
    // http(s) opens in a new tab; file: cannot, because Chrome refuses to
    // navigate an http page to a local path ("Not allowed to load local
    // resource"). It is still rendered as a link — a silent, unclickable one
    // would be worse — and the click handler below turns it into the one thing
    // the reader can act on: the path on the clipboard.
    .replace(/\[([^\]]+)\]\(((?:https?|file):\/\/[^)\s]+)\)/g, (match, text, href) =>
      href.startsWith("file:")
        ? `<a class="local-link" href="${href}" title="A browser page cannot open a local file — clicking copies the path">${text}</a>`
        : `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
    );
}

/** pi expands a skill invocation into a user message whose text is its own
 *  `<skill name="…" location="…">` block wrapping the whole SKILL.md, plus the
 *  arguments the user typed after it. Rendering that raw turns a one-line
 *  request into thousands of words of instruction text that is not part of the
 *  conversation. Parse it so the transcript can show the invocation and the
 *  prompt, and keep the body behind a disclosure. Format and the
 *  close-then-blank-line-then-prompt shape are pi's own (see parseSkillBlock in
 *  pi's agent-session.ts), so a change there fails loudly as a normal message
 *  rather than mis-rendering. */
function parseSkillBlock(text) {
  const match = String(text || "").match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return { name: match[1], location: match[2], content: match[3], userMessage: match[4] ? match[4].trim() : "" };
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

/** Inline styles for the clipboard HTML. Pasting a summary into an email client
 *  or a document only keeps what the HTML carries: classes and external CSS are
 *  dropped, so headings collapse into paragraphs, tables lose their borders and
 *  every cell runs together. These are the same rules as the transcript, written
 *  inline and in plain pixels so no editor has to understand a stylesheet. */
const EMAIL_INLINE = {
  p: "margin:0 0 10px",
  h2: "margin:18px 0 8px;font-size:20px;font-weight:600;line-height:1.3",
  h3: "margin:16px 0 8px;font-size:17px;font-weight:600;line-height:1.3",
  h4: "margin:14px 0 6px;font-size:15px;font-weight:600;line-height:1.3",
  ul: "margin:0 0 10px;padding-left:24px",
  ol: "margin:0 0 10px;padding-left:24px",
  li: "margin:3px 0",
  blockquote: "margin:10px 0;padding-left:12px;border-left:3px solid #c8c8cd;color:#55555c",
  a: "color:#1a6fd4",
  table: "border-collapse:collapse;width:100%;margin:0 0 12px;font-size:13px",
  th: "padding:7px 12px;text-align:left;vertical-align:top;border:1px solid #d6d6db;background:#f0f0f3;font-weight:600",
  td: "padding:7px 12px;text-align:left;vertical-align:top;border:1px solid #d6d6db",
  pre: "margin:0 0 12px;padding:10px 14px;background:#f5f5f7;border:1px solid #d6d6db;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word",
  code: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#f0f0f3;padding:1px 4px;border-radius:3px",
};

/** The transcript's Markdown, as one self-contained HTML block for the
 *  clipboard. It reuses renderMarkdown — the single parser — then rewrites the
 *  few wrapper elements (code cards, table cards, copy buttons) that mean
 *  nothing outside this page. */
function emailHtml(text) {
  const holder = el("div", { class: "assistant-text" });
  holder.replaceChildren(...htmlFragment(renderMarkdown(text || "")));
  for (const btn of holder.querySelectorAll("button")) btn.remove();
  for (const card of [...holder.querySelectorAll(".code-block")]) {
    const code = card.querySelector("code");
    const pre = el("pre", { text: code ? code.textContent : "" });
    card.replaceWith(pre);
  }
  for (const wrap of [...holder.querySelectorAll(".md-table-wrap")]) {
    const table = wrap.querySelector("table");
    if (table) wrap.replaceWith(table);
    else wrap.remove();
  }
  const apply = (node) => {
    const style = EMAIL_INLINE[node.tagName.toLowerCase()];
    if (!style) return;
    // a cell may already carry an alignment from the Markdown separator row;
    // that one must survive, and must not be duplicated
    const align = node.style.textAlign;
    node.setAttribute("style", align ? `${style};text-align:${align}` : style);
  };
  apply(holder);
  for (const node of holder.querySelectorAll(Object.keys(EMAIL_INLINE).join(","))) apply(node);
  // a code sample inside a <pre> already sits on the block's own fill; the
  // inline chip style there would double it up
  for (const code of holder.querySelectorAll("pre code")) {
    code.setAttribute("style", "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:none;padding:0");
  }
  holder.setAttribute(
    "style",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1c1c1e"
  );
  return holder.outerHTML;
}

/** Copy Markdown as both flavours: rich HTML so a mail client keeps headings,
 *  lists, tables and code, and the Markdown source for anything that only takes
 *  plain text. Falls back to plain text where the async clipboard is missing. */
async function copyRichText(source) {
  const plain = String(source ?? "");
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([emailHtml(plain)], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      return true;
    }
    throw new Error("rich clipboard unavailable");
  } catch {
    try {
      await navigator.clipboard.writeText(plain);
      return true;
    } catch {
      return false;
    }
  }
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
        // a prompt the composer sent with a document carries its text in a
        // block of ours; the transcript shows a chip for it, not the body
        const { text: typed, files } = splitAttachedFiles(text);
        items.push({ kind: "user", text: typed, images, files, ts, entry });
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

/** Cursor reports an edit as activity text, not as a pi edit result: the
 *  response starts with "edit <path>", then its own "+N -M" count, then a
 *  unified diff. Recover the same { path, added, deleted } the edit tool
 *  carries so both tools share one transcript header. Returns null for every
 *  other activity of that tool (readLints diagnostics, subagent fan-out, ...).
 *
 *  The count is taken while the change is still streaming too: arguments
 *  already name the file and the activity, so the row does not switch shape
 *  when the result lands. */
function cursorEditInfo(call, result) {
  if (call?.name !== "cursor") return null;
  const lines = result ? resultText(result.content).trimStart().split("\n") : [];
  const head = lines[0] || "";
  const args = call.arguments || {};
  // "Cursor edit" is what the tool sets for a write to the workspace; the
  // result's first line is the authoritative form once it exists
  const path = head.startsWith("edit ")
    ? head.slice(5).trim()
    : /^cursor edit$/i.test(String(args.activityTitle || "")) ? String(args.path || "") : "";
  if (!path) return null;

  let added = null;
  let deleted = null;
  for (const line of lines.slice(1, 6)) {
    const m = line.trim().match(/^\+(\d+) -(\d+)$/);
    if (m) {
      added = Number(m[1]);
      deleted = Number(m[2]);
      break;
    }
  }
  if (added == null) {
    // fallback for a report that omitted its count: count the body, skipping
    // the ---/+++ file headers. A truncated diff undercounts, which is why the
    // tool's own numbers are preferred above.
    let seenHunk = false;
    let a = 0;
    let d = 0;
    for (const line of lines) {
      if (line.startsWith("@@")) seenHunk = true;
      else if (!seenHunk || /^(---|\+\+\+) /.test(line)) continue;
      else if (line.startsWith("+")) a++;
      else if (line.startsWith("-")) d++;
    }
    if (seenHunk) {
      added = a;
      deleted = d;
    }
  }
  return { path, added, deleted };
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

/** Split a Cursor activity response into its prose preamble and its unified
 *  diff. Cursor sends both in one text block ("edit <path>\n\n+1 -0\n\n---
 *  a/x\n+++ b/x\n@@ …"), which lets the popup lead with the colored diff
 *  while the preamble stays as plain text. Null when there is no hunk. */
function splitCursorDiff(text) {
  const lines = String(text ?? "").split("\n");
  const hunk = lines.findIndex((l) => /^@@ -\d/.test(l));
  if (hunk < 0) return null;
  let start = hunk;
  while (start > 0 && /^(---|\+\+\+) /.test(lines[start - 1])) start--;
  return { preamble: lines.slice(0, start).join("\n").trim(), diff: lines.slice(start).join("\n") };
}

/** The change an edit reports, from wherever that tool keeps it: pi's `edit`
 *  carries it in details.diff, Cursor's activity sends the whole report
 *  ("edit <path>\n\n+1 -0\n\n--- a/x …") as response text and, in newer
 *  sessions, repeats the patch in details. Null for every other tool, so their
 *  popups keep the shape they had. */
function editDiffOf(call, result) {
  if (!result) return null;
  if (call?.name === "edit") return typeof result.details?.diff === "string" ? result.details.diff : null;
  if (call?.name !== "cursor" || !cursorEditInfo(call, result)) return null;
  const fromDetails = typeof result.details?.diff === "string" ? result.details.diff : null;
  return fromDetails || splitCursorDiff(resultText(result.content))?.diff || null;
}

/** rich body for one tool call: arguments, live execution updates, response.
 *  Rendered inside the popup — never inline, so it cannot shove the rest of
 *  the transcript off screen. */
function buildToolcallBody(call, exec, result) {
  if (isSubagentRun(call, exec, result)) return buildSubagentBody(call, exec, result);
  const body = el("div", { class: "tc-body" });
  const diff = editDiffOf(call, result);
  // A tool that read a picture and could only report its size is the common
  // case worth leading with: show the image itself, above the JSON.
  const imagePath = imageMetadataPath(call, result);
  if (imagePath) {
    body.append(imageResultSection("image", [`/api/image?path=${encodeURIComponent(imagePath)}`]));
  }

  // edit calls lead with the colored diff — seeing what changed is the point
  // of the popup; the raw request/response follow below. A Cursor edit takes
  // this same branch, so both tools' popups open on the patch.
  if (diff) {
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
        // a Cursor edit's text block is "edit <path>", the counts and the
        // patch; the patch is the diff section above, so only the preamble is
        // left to print — the same role pi's "edited" text plays below its diff
        const rest = call.name === "cursor" && diff ? splitCursorDiff(b.text || "") : null;
        if (rest) {
          if (rest.preamble) sec.append(el("div", { class: "tc-text", text: capText(rest.preamble) }));
          continue;
        }
        const txt = capText(b.text || "");
        sec.append(looksLikeDiff(txt) ? diffBlock(txt) : el("div", { class: "tc-text", text: txt }));
      } else if (b.type === "image") {
        sec.append(imageEl(`data:${b.mimeType};base64,${b.data}`));
      }
    }
    if (result.details != null && !diff) {
      // A popup that led with the diff has nothing left to say here: pi's edit
      // details carry the patch, and Cursor's carry a second copy of it plus
      // the counts the row already shows. The raw JSON keeps both.
      sec.append(el("div", { class: "tc-label", text: "details" }), jsonBlock(result.details));
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
  // A Cursor edit is reported as `cursor` activity rather than as an `edit`
  // result, but its response carries the same "+N -M" numbers plus a unified
  // diff, so it renders through this same branch. Clicking still opens the
  // full request/response popup shared by all tools.
  const cursorEdit = call.name === "edit" ? null : cursorEditInfo(call, result);
  if (call.name === "edit" || cursorEdit) {
    const filePath = cursorEdit
      ? cursorEdit.path
      : String(call.arguments?.path || call.arguments?.file_path || "");
    const base = filePath.split(/[\\/]/).pop() || filePath;
    const stats = cursorEdit
      ? cursorEdit.added == null
        ? null
        : { added: cursorEdit.added, deleted: cursorEdit.deleted }
      : result?.details?.diff != null
        ? editDiffStats(result.details.diff)
        : null;
    card.append(
      el(
        "div",
        headOpts,
        el("span", { class: "tc-open-icon", text: "✎" }),
        el("span", { class: "tc-name", text: "edit" }),
        el("span", { class: "tc-summary", text: base, title: filePath }),
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

/** an inline prompt image in a user turn: a thumbnail that opens the popup,
 *  then the full-window viewer */
function promptImage(img) {
  const src = `data:${img.mimeType};base64,${img.data}`;
  return el("img", { src, alt: "prompt image", title: "Click to enlarge", onclick: () => openImagePopup(src, "prompt image") });
}

/** A document the prompt carried, shown as a chip with its name and page count.
 *  The text itself stays out of the way — it is what the model read, not what
 *  the reader typed — and opens in a popup on click, laid out like a tool
 *  result's text body. */
function attachedDocChip(doc) {
  // the badge already names the format, so the meta line carries only what is
  // not visible: how big the document is and whether it was cut short
  const meta = [];
  if (doc.pages) meta.push(`${doc.pages} page${doc.pages === 1 ? "" : "s"}`);
  meta.push(`${fmtTokens(doc.body.length)} chars`);
  if (doc.truncated) meta.push("truncated");
  const chip = el(
    "div",
    {
      class: "prompt-file",
      role: "button",
      tabindex: "0",
      title: "Open the text this prompt attached",
    },
    el("span", { class: "attachment-ext", text: fileExt(doc.name) }),
    el(
      "span",
      { class: "attachment-file-text" },
      el("span", { class: "attachment-name", text: doc.name }),
      el("span", { class: "attachment-meta", text: meta.join(" · ") })
    ),
    el("span", { class: "tc-open-icon", text: "↗" })
  );
  const open = () =>
    openPopup(`attachment: ${doc.name}`, {
      paint: () => el("pre", { class: "tc-text doc-body", text: doc.body }),
      payload: () => doc,
    });
  chip.addEventListener("click", open);
  chip.addEventListener("keydown", onActivate(open));
  return chip;
}

/** the visible part of a skill invocation: a chip naming the skill, the prompt
 *  the user typed after it, and the expanded SKILL.md folded away. The chip is
 *  the highlight — a skill call is an event in the run, and the definition it
 *  pulled in is not conversation. */
function renderSkillInvocation(skill) {
  const name = skill.name.replace(/^skill:/, "");
  const body = el(
    "div",
    { class: "skill-invoke" },
    el("span", { class: "skill-tag", text: "skill" }),
    el("span", { class: "skill-name", text: name, title: skill.location || "" })
  );
  if (skill.userMessage) {
    const prompt = el("div", { class: "skill-prompt" });
    prompt.style.whiteSpace = "pre-wrap";
    prompt.textContent = skill.userMessage;
    body.append(prompt);
  }
  const def = el("details", { class: "skill-def" });
  def.append(
    el("summary", { text: `definition · ${skill.content.split("\n").length} lines` }),
    el("div", { class: "skill-def-body", text: skill.content })
  );
  body.append(def);
  return body;
}

/** The answer text of one assistant turn: its text blocks, joined. This is what
 *  the turn actions copy and what a saved follow-up keeps — thinking and tool
 *  cards are not the answer. */
function answerTextOf(item) {
  return (item.blocks || [])
    .filter((b) => b.type === "text" && (b.text || "").trim())
    .map((b) => b.text.trim())
    .join("\n\n");
}

/** True when this turn is the summary of its run: the last assistant turn of
 *  the current run, settled and carrying answer text. The prompt outline's
 *  summary jump and the search's summary scope name the same turn, so a
 *  mid-loop answer is never offered as a summary to keep. */
function isRunSummaryItem(item) {
  if (item.kind !== "assistant" || item.streaming || !answerTextOf(item)) return false;
  if (!isRunSettled(item)) return false;
  const at = state.items.indexOf(item);
  if (at < 0) return false;
  for (let i = at + 1; i < state.items.length; i++) {
    const it = state.items[i];
    if (it.kind === "user") return true;
    if (it.kind === "assistant") return false;
  }
  return true;
}

/** The user prompt that opened this run, for a follow-up's title. */
function promptOfRun(item) {
  const at = state.items.indexOf(item);
  for (let i = at - 1; i >= 0; i--) {
    if (state.items[i].kind === "user") return state.items[i];
  }
  return null;
}

/** The actions a reader wants on an assistant turn: copy its answer as rich
 *  text always, and keep it as a follow-up when the turn is the run's summary —
 *  a mid-loop answer is not what "the summary" names. */
function renderTurnActions(item, { followup = false } = {}) {
  const row = el("div", { class: "turn-actions" });
  // A turn that already kept its answer offers the same control in its pressed
  // state, so the second press can take it back. It stays on screen even if the
  // turn later stops being the run's summary, or the saved copy could no longer
  // be un-kept from where it was made.
  const saved = savedFollowupOf(item);
  if (followup || saved) {
    row.append(
      el(
        "button",
        {
          class: `turn-action followup-toggle${saved ? " kept" : ""}`,
          "aria-pressed": String(!!saved),
          title: saved
            ? "Saved to Follow-ups — press again to remove it"
            : "Save this summary to Follow-ups — readable later without loading the session",
          onclick: () => toggleFollowup(item),
        },
        el("span", { class: "turn-action-icon", html: FOLLOWUP_ICON }),
        el("span", { text: "Follow-up" })
      )
    );
  }
  row.append(
    el(
      "button",
      { class: "turn-action", title: "Copy the answer as rich text (Markdown on the clipboard too)", onclick: () => copyTurn(item) },
      el("span", { class: "turn-action-icon", html: COPY_ICON }),
      el("span", { text: "Copy" })
    )
  );
  return row;
}

/** Copy one turn's answer as rich text, plus its Markdown source. */
async function copyTurn(item) {
  const text = answerTextOf(item);
  if (!text) return;
  toast((await copyRichText(text)) ? "copied as rich text" : "copy failed", "info");
}

function renderItem(item) {
  switch (item.kind) {
    case "user": {
      const box = el("div", { class: "item item-user" });
      box.append(el("div", { class: "who", text: `you · ${fmtTime(item.ts)}` }));
      // a skill invocation arrives as one user message: the whole SKILL.md in a
      // <skill> block, then the prompt. Show the invocation as a chip and the
      // prompt as the message; the body stays behind a disclosure, because a
      // definition pi expanded itself is context, not something the reader wrote.
      const skill = parseSkillBlock(item.text);
      if (skill) {
        box.append(renderSkillInvocation(skill));
        for (const doc of item.files || []) box.append(attachedDocChip(doc));
        for (const img of item.images || []) box.append(promptImage(img));
        return box;
      }
      const body = el("div");
      body.style.whiteSpace = "pre-wrap";
      body.textContent = item.text;
      box.append(body);
      for (const doc of item.files || []) box.append(attachedDocChip(doc));
      for (const img of item.images || []) box.append(promptImage(img));
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
      const summary = isRunSummaryItem(item);
      if (answerTextOf(item)) box.append(renderTurnActions(item, { followup: summary }));
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
      // A titled block, not a pill: an error or summary body runs to many lines
      // with unbreakable paths, which a 999px radius turned into a giant oval
      // that spilled past the transcript's padding.
      const chip = el(
        "div",
        { class: "notice-chip notice-chip-block" },
        el("div", { class: "n-title", text: item.title }),
        el("div", { class: "n-body", text: (item.text || "").slice(0, 2000) })
      );
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

// A file:// link cannot be followed from an http page: Chrome answers the
// click with "Not allowed to load local resource" and stays put. Rather than
// drop the link, keep it and make the click hand over the one thing the reader
// can actually use — the path, ready to paste into an editor or `open`.
// Document-level so it also covers a follow-up body and the summary document,
// which are not inside #transcript.
document.addEventListener("click", (e) => {
  const link = e.target.closest("a.local-link");
  if (!link) return;
  e.preventDefault();
  navigator.clipboard.writeText(link.getAttribute("href")).then(
    () => toast("local path copied — open it from your terminal", "info"),
    () => toast("copy failed", "error")
  );
});

function renderTranscript({ follow = true } = {}) {
  const nearBottom = transcriptAtBottom();
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
/** within a screen of the bottom, i.e. the view is following the stream */
function transcriptAtBottom() {
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 120;
}
function updateJumpButton() {
  $("#btn-jump").classList.toggle("hidden", transcriptAtBottom());
}
transcriptEl.addEventListener("scroll", updateJumpButton);
$("#btn-jump").addEventListener("click", scrollBottom);

// ---------------------------------------------------------------------------
// header / sidebar
// ---------------------------------------------------------------------------
/** Sidebar metadata for the open session. `sessionName` is only ever set when a
 *  session has been explicitly renamed (pi reports it exclusively through
 *  set_session_name / --name), so an ordinary session has no name and has to
 *  fall back to its first prompt — the same title the sidebar row shows. */
function currentSessionMeta() {
  if (!state.sessionFile) return null;
  return state.sessions.find((s) => s.file === state.sessionFile) || null;
}

function renderHeader() {
  const meta = currentSessionMeta();
  const fallback = state.sessionFile ? state.sessionFile.split("/").pop().replace(/\.jsonl$/, "") : "—";
  // a follow-up on screen is what the tab is reading, even though the session
  // stays attached underneath: the header has to name the thing being read
  $("#session-name").textContent = state.openFollowup
    ? state.openFollowup.title || "(untitled follow-up)"
    : state.sessionName || meta?.title || fallback;
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
  renderFavoriteButton();
}

/** Header star: filled + "remove" label when the current session is starred,
 *  outlined + "add" when it is not. Hidden for an unsaved new session, which
 *  has no file to star yet. */
function renderFavoriteButton() {
  const btn = $("#btn-favorite");
  const file = state.sessionFile;
  btn.classList.toggle("hidden", !file);
  if (!file) {
    btn.dataset.sig = "";
    return;
  }
  // renderHeader runs on nearly every event; only rebuild when the starred
  // state of this session actually changed, so an in-progress click is not
  // swapped out from under the pointer
  const on = isFavorite(file);
  const sig = `${file}#${on}`;
  if (btn.dataset.sig === sig) return;
  btn.dataset.sig = sig;
  btn.replaceChildren(...htmlFragment(on ? STAR_ICON : STAR_OUTLINE_ICON));
  btn.classList.toggle("starred", on);
  btn.setAttribute("aria-pressed", String(on));
  const label = on ? "Remove from Favorites" : "Add to Favorites";
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

$("#btn-favorite").addEventListener("click", () => {
  if (!state.sessionFile) return;
  const added = toggleFavorite(state.sessionFile);
  renderFavoriteButton();
  renderSidebar();
  toast(added ? "added to favorites" : "removed from favorites");
});

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
  setPickerOpen($("#theme-menu"), false);
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
    ["session", state.sessionName || currentSessionMeta()?.title || "—"],
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

/** The turn that concludes a run: stopReason says the model finished (or was
 *  truncated by the length cap), as opposed to toolUse (the loop was still
 *  going), deferred (the provider's answer is still being retrieved) or
 *  aborted/error (the run was cut off). A run that did not settle has no
 *  summary. */
function isRunSettled(item) {
  const stop = item.meta && item.meta.stopReason;
  return stop === "stop" || stop === "length";
}

/** Whether a turn carries an answer at all — thinking and tool calls alone are
 *  not something to land a reader on. */
function hasAnswerText(item) {
  return (item.blocks || []).some((b) => b.type === "text" && (b.text || "").trim());
}

/** Which block inside the summary turn to land on: its last answer text, so a
 *  turn that ends in a tool card still lands on the words above it. */
function summaryAnchorBlock(item) {
  const blocks = item.blocks || [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "text" && (b.text || "").trim()) return i;
  }
  return 0;
}

/** Map each user prompt to the summary of its run. Built in one pass so the
 *  outline does not rescan state.items once per entry.
 *
 *  A run is everything between two user prompts, and its summary is the last
 *  turn of that run. The row is offered only when that turn both settled and
 *  carries answer text: a run still streaming, aborted or failed, cut off mid
 *  tool loop, or ended on an empty response has nothing to jump to, and a dead
 *  shortcut is worse than no row. */
function buildReplyJumpMap() {
  const map = new Map(); // user item -> { item, blockIdx }
  let pending = null;
  let last = null;
  const settle = () => {
    if (pending && last && !last.streaming && isRunSettled(last) && hasAnswerText(last)) {
      map.set(pending, { item: last, blockIdx: summaryAnchorBlock(last) });
    }
    pending = null;
    last = null;
  };
  for (const item of state.items) {
    if (item.kind === "user") {
      settle();
      pending = item;
    } else if (pending && item.kind === "assistant") {
      last = item;
    }
  }
  settle();
  return map;
}

function renderPromptList() {
  const pop = $("#prompt-list-pop");
  pop.innerHTML = "";
  const prompts = collectUserPrompts();
  if (!prompts.length) {
    pop.append(el("div", { class: "pl-empty", text: "no user prompts in this session yet" }));
    return;
  }
  const replies = buildReplyJumpMap();
  prompts.forEach((item, n) => {
    // a skill invocation puts its chip first, then the prompt the user typed, so
    // the outline matches the transcript instead of listing "<skill name=…"
    const skill = parseSkillBlock(item.text);
    const files = item.files || [];
    const typed = (item.text || "").replace(/\s+/g, " ").trim();
    const text = skill
      ? [skill.name.replace(/^skill:/, ""), skill.userMessage].filter(Boolean).join(" · ")
      : typed || (files.length ? "(file only)" : item.images?.length ? "(images only)" : "");
    const group = el("div", { class: "pl-group" },
      el("div", {
        class: "pl-entry",
        title: skill ? `${skill.name}\n\n${skill.userMessage}` : [typed, ...files.map((f) => `[attached: ${f.name}]`)].filter(Boolean).join("\n"),
        onclick: () => {
          setPromptListOpen(false);
          scrollToUserPrompt(item);
        },
      },
        el("span", { class: "pl-num", text: String(n + 1) }),
        skill ? el("span", { class: "pl-skill", text: "skill" }) : null,
        files.length ? el("span", { class: "pl-file", text: files.length === 1 ? fileExt(files[0].name) : `+${files.length} files` }) : null,
        el("span", { class: "pl-text", text: text }),
        el("span", { class: "pl-time", text: item.ts ? fmtTime(item.ts) : "" })
      )
    );
    // Indented second row: the prompt above answers "what did I ask", this one
    // answers "where did pi conclude", which is otherwise a long scroll past the    // run's tool cards. A run that was interrupted before concluding has no
    // summary, so it gets no row rather than a dead shortcut.
    const summary = replies.get(item);
    if (summary) {
      const stamp = summary.item.ts ? fmtTime(summary.item.ts) : "";
      group.append(
        el("button", {
          class: "pl-jump",
          title: "Jump to pi's summary of this prompt",
          onclick: () => {
            setPromptListOpen(false);
            scrollToSummary(summary);
          },
        },
          el("span", { class: "pl-jump-arrow", text: "↳" }),
          el("span", { class: "pl-jump-label", text: "summary" }),
          el("span", { class: "pl-jump-time", text: stamp })
        )
      );
    }
    pop.append(group);
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

/** Jump to the answer text inside a run's summary turn. Scrolling the whole
 *  item to its top is not enough: the turn's tool cards can run for screens, so
 *  the answer is far below the head the item would land on. */
function scrollToSummary(summary) {
  const item = summary.item;
  // reconcile first when the turn is unsaved or not yet in the DOM, so the
  // block index below refers to the nodes actually on screen
  if (item.dirty || !item.node || !item.node.isConnected) renderTranscript({ follow: false });
  const box = item.node;
  if (!box || !box.isConnected) return;
  const blocksEl = box.querySelector(".blocks");
  const blockNode = blocksEl ? blocksEl.children[summary.blockIdx] : null;
  const target = blockNode && blockNode.isConnected ? blockNode : box;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  flashNode(target);
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

// ---------------------------------------------------------------------------
// resources panel (Models / Skills / MCPs)
// ---------------------------------------------------------------------------
// The status row at the bottom of the sidebar is the one place that always
// describes the agent process itself, so the button that explains what that
// process has loaded lives there. It opens a centered modal rather than a
// sidebar-anchored popover: these lists are long and every row carries a path,
// a description and a set of numbers, none of which fit in a sidebar column.
// Everything is read-only: this is an inspector for what pi discovered, not a
// settings editor.
const resourcesBtn = $("#btn-resources");
const resourcesOverlay = $("#resources-overlay");
const resourcesBody = $("#res-body");
const RES_TABS = ["models", "skills", "mcps"];
const RES_HINT = {
  models: "Models come from the running agent, already filtered by enabledModels in settings.json",
  skills: "Skills pi advertises to the model; the body loads only when a task needs it",
  mcps: "From `pi mcp list --json`, run in this session's workspace; click the tab again to re-read",
};
let resTab = "models";
let resLoading = null; // in-flight MCP fetch, so a second tab click does not spawn a second `pi mcp list`
let resReturnFocus = null;

function setResourcesOpen(open) {
  resourcesOverlay.classList.toggle("hidden", !open);
  resourcesBtn.setAttribute("aria-expanded", String(open));
  if (!open) {
    if (resReturnFocus && resReturnFocus.isConnected) resReturnFocus.focus({ preventScroll: true });
    return;
  }
  resReturnFocus = document.activeElement;
  $("#res-close").focus({ preventScroll: true });
  if (!(state.models || []).length) loadModels(); // a tab opened before a session existed
  renderResources();
  // Server state is the one thing that has to be asked for, is slow (it
  // connects every server), and goes stale (sign-in, edits, crashes), so it is
  // refetched on open rather than kept for the life of the page.
  if (resTab === "mcps" && Date.now() - (state.mcpsAt || 0) > 60000) loadMcps({ refresh: true });
}

function setResTab(tab) {
  if (!RES_TABS.includes(tab)) return;
  const again = resTab === tab;
  resTab = tab;
  for (const t of RES_TABS) {
    const btn = $(`#res-tab-${t}`);
    btn.classList.toggle("active", t === tab);
    btn.setAttribute("aria-selected", String(t === tab));
  }
  // clicking the tab already showing is the only way to ask for a fresh read
  if (tab === "mcps") loadMcps({ refresh: again || state.mcps == null });
  renderResources();
}

async function loadMcps({ refresh = false } = {}) {
  if (resLoading) return resLoading;
  if (state.mcps && !refresh) return;
  state.mcps = null;
  renderResources();
  resLoading = api(`/api/mcp?client=${encodeURIComponent(CLIENT_ID)}`)
    .then((res) => {
      state.mcps = res;
      state.mcpsAt = Date.now();
    })
    .catch((err) => {
      state.mcps = { servers: [], errors: [{ message: err.message }], unavailable: true };
      state.mcpsAt = Date.now();
    })
    .finally(() => {
      resLoading = null;
      // the panel may have been closed or switched while this was in flight
      if (!resourcesOverlay.classList.contains("hidden") && resTab === "mcps") renderResources();
    });
  return resLoading;
}

function resTag(text, kind = "") {
  return el("span", { class: `res-tag ${kind}`.trim(), text });
}

/** One uniform row: name on the left, a state tag on the right, then the
 *  detail lines the dialog has room for. `facts` renders as uppercase
 *  key/value pairs that wrap side by side; `tools` as chips. Every value
 *  arrives from pi or mcp.json, so it is set as text and never as markup. */
function resItem({ name, tag, sub, desc, facts, tools, error }) {
  const factNodes = (facts || [])
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => el("span", { class: "res-fact" }, el("b", { text: k }), el("span", { text: String(v) })));
  return el(
    "div",
    { class: "res-item" },
    el("div", { class: "res-line" }, el("span", { class: "res-name", text: name, title: name }), tag || null),
    sub ? el("div", { class: "res-sub", text: sub, title: sub }) : null,
    desc ? el("div", { class: "res-desc", text: desc }) : null,
    factNodes.length ? el("div", { class: "res-facts" }, factNodes) : null,
    tools?.length ? el("div", { class: "res-tools" }, tools.map((t) => el("span", { class: "res-tool", text: t }))) : null,
    error ? el("div", { class: "res-error", text: error }) : null
  );
}

function renderModels() {
  const models = state.models || [];
  if (!models.length) return [el("div", { class: "res-empty", text: "no models reported yet — open a session first" })];
  // the current model first: it is what the next prompt will use, and the list
  // is long enough that finding it by scrolling is the wrong default
  const sorted = models.slice().sort((a, b) => {
    const cur = Number(sameModel(b, state.model)) - Number(sameModel(a, state.model));
    if (cur) return cur;
    return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
  });
  return sorted.map((m) => {
    const cost = m.cost || {};
    const money = (n) => (n == null ? "—" : `$${n}`);
    return resItem({
      name: m.name || m.id,
      tag: sameModel(m, state.model) ? resTag("current", "current") : m.reasoning ? resTag("reasoning") : null,
      sub: `${m.provider}/${m.id}`,
      facts: [
        ["ctx", m.contextWindow ? fmtNum(m.contextWindow) : "—"],
        ["max out", m.maxTokens ? fmtNum(m.maxTokens) : "—"],
        ["in /M", money(cost.input)],
        ["out /M", money(cost.output)],
        ["cache r/w", `${money(cost.cacheRead)} / ${money(cost.cacheWrite)}`],
        ["api", m.api],
        ["input", Array.isArray(m.input) ? m.input.join(", ") : null],
        ["thinking", m.thinkingLevels?.length ? m.thinkingLevels.join(", ") : null],
      ],
    });
  });
}

function renderSkills() {
  const skills = (state.commands || []).filter((c) => c.source === "skill");
  if (!skills.length) return [el("div", { class: "res-empty", text: "no skills discovered for this session" })];
  return skills.map((c) => {
    const info = c.sourceInfo || {};
    return resItem({
      name: c.name.replace(/^skill:/, ""),
      tag: resTag(info.scope || "skill"),
      sub: info.path || "",
      desc: c.description || "",
      facts: [
        ["origin", info.origin],
        ["from", info.source],
        ["package", info.package],
      ],
    });
  });
}

function renderMcps() {
  const data = state.mcps;
  if (!data) return [el("div", { class: "res-empty", text: resLoading ? "asking pi about its MCP servers…" : "loading…" })];
  const nodes = [];
  if (data.unavailable) {
    nodes.push(el("div", { class: "res-empty", text: "could not read MCP server state from pi" }));
  }
  for (const e of data.errors || []) {
    nodes.push(resItem({ name: "configuration error", tag: resTag("invalid", "bad"), error: e.message || JSON.stringify(e) }));
  }
  for (const s of data.servers || []) {
    const state = s.state === "connected" ? "ok" : s.state === "needs-auth" ? "warn" : s.enabled === false ? "" : "bad";
    const label = s.enabled === false ? "disabled" : s.state === "connected" ? "connected" : s.state === "needs-auth" ? "sign in" : s.state || "unknown";
    nodes.push(
      resItem({
        name: s.name,
        tag: resTag(label, state),
        sub: s.transport || "",
        facts: [
          ["scope", s.scope],
          ["exposure", s.exposure],
          ["auth", s.authProvider],
          ["source", s.source],
          ["resources", s.resources ? "yes" : null],
          ["tool exposure", s.toolExposure ? Object.entries(s.toolExposure).map(([k, v]) => `${k}=${v}`).join(", ") : null],
        ],
        tools: s.tools || [],
        error: s.error || null,
      })
    );
  }
  if (!nodes.length) {
    nodes.push(
      el("div", { class: "res-empty", text: "no MCP servers configured\nadd them to ~/.pi/agent/mcp.json or .pi/mcp.json" })
    );
  }
  if (data.note) nodes.push(el("div", { class: "res-error", text: data.note }));
  return nodes;
}

function renderResources() {
  const body = resourcesBody;
  const keepScroll = body.scrollTop;
  body.replaceChildren();
  const items = resTab === "models" ? renderModels() : resTab === "skills" ? renderSkills() : renderMcps();
  const count =
    resTab === "models"
      ? `${(state.models || []).length} models`
      : resTab === "skills"
        ? `${(state.commands || []).filter((c) => c.source === "skill").length} skills`
        : state.mcps
          ? `${(state.mcps.servers || []).length} servers`
          : "";
  $("#res-count").textContent = count;
  $("#res-hint").textContent = RES_HINT[resTab];
  for (const item of items) body.append(item);
  body.scrollTop = keepScroll;
}

resourcesBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setResourcesOpen(resourcesOverlay.classList.contains("hidden"));
});
// clicks inside the dialog must not reach the overlay's click-away handler
$("#resources-dialog").addEventListener("click", (e) => e.stopPropagation());
resourcesOverlay.addEventListener("click", () => setResourcesOpen(false));
$("#res-close").addEventListener("click", () => setResourcesOpen(false));
for (const t of RES_TABS) $(`#res-tab-${t}`).addEventListener("click", () => setResTab(t));

function renderStatus() {
  const bar = $("#status-bar");
  if (state.isStreaming) {
    $("#status-text").textContent = state.isCompacting ? "compacting…" : "pi is working…";
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
/** session files (absolute paths) the user starred; rendered by the Favorites tab */
const FAV_KEY = "piweb-favorites";
/** star glyphs: filled = starred, outlined = not starred */
const STAR_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.75-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z"/></svg>`;
const STAR_OUTLINE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.75-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z"/></svg>`;
/** a bookmark: keeping a summary is a save, not a star */
const FOLLOWUP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-4-6.5 4V5a1 1 0 0 1 1-1z"/></svg>`;
const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15"/></svg>`;
const EDIT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20z"/></svg>`;

/** two-level display name, e.g. /home/me/work/pi-web -> "work/pi-web" */
function wsLabel(p) {
  if (!p || p === "(unknown)") return p || "";
  const segs = String(p).replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length <= 2) return segs.join("/") || p;
  return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

/** keep the URL hash in sync so sessions are addressable/bookmarkable:
 *  #ws=<encoded cwd>&session=<encoded file|new>[&followup=<id>] */
function syncHash() {
  const params = new URLSearchParams();
  if (state.workspace) params.set("ws", state.workspace);
  params.set("session", state.sessionFile || "new");
  if (state.openFollowup) params.set("followup", state.openFollowup.id);
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
      followup: p.get("followup") || null, // a saved follow-up shown instead
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

/** session files the user starred, newest star first */
function favoriteFiles() {
  try {
    const arr = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function isFavorite(file) {
  return !!file && favoriteFiles().includes(file);
}

/** star / unstar a session file; returns true when it was added */
function toggleFavorite(file) {
  const favs = favoriteFiles();
  const at = favs.indexOf(file);
  if (at === -1) favs.unshift(file); // newest star first; the order is stable, so rows do not jump around
  else favs.splice(at, 1);
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
  return at === -1;
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

/** true when the sidebar filter matches a session's title/name (and, for flat
 *  cross-workspace lists, its workspace path) */
function sessionMatches(s, filter, { includeCwd = true } = {}) {
  return (
    !filter ||
    (s.name || "").toLowerCase().includes(filter) ||
    (s.title || "").toLowerCase().includes(filter) ||
    (includeCwd && (s.cwd || "").toLowerCase().includes(filter))
  );
}

/** One sidebar row for a saved follow-up: its title, the workspace it came from,
 *  when it was kept, and a delete control. Opening it reads one JSON file — no
 *  session is loaded and no pi process is involved. */
function followupRow(f) {
  const active = state.openFollowup?.id === f.id;
  const repo = wsLabel(f.cwd) || "(no workspace)";
  return el(
    "div",
    {
      class: `session-item ${active ? "active" : ""}`,
      tabindex: "0",
      title: `${f.title}\n${f.sessionTitle || f.sessionFile || ""}`,
      onclick: () => openFollowup(f.id),
      onkeydown: onActivate(() => openFollowup(f.id)),
    },
    el(
      "div",
      { class: "s-title" },
      el("span", { class: "s-title-text", text: f.title || "(untitled follow-up)" })
    ),
    el("div", { class: "s-repo", title: f.cwd || repo, text: repo }),
    el(
      "div",
      { class: "s-meta" },
      el("span", { text: fmtDate(f.createdAt) }),
      el("span", { text: `${fmtNum(f.chars || 0)} chars` }),
      el("button", {
        class: "s-delete",
        title: "Delete this follow-up",
        "aria-label": "Delete this follow-up",
        text: "✕",
        onclick: (e) => {
          // the row itself opens the follow-up; the delete control must not
          e.stopPropagation();
          deleteFollowup(f.id);
        },
        onkeydown: (e) => e.stopPropagation(),
      })
    )
  );
}

async function loadFollowups() {
  try {
    const data = await api("/api/followups");
    state.followups = Array.isArray(data.followups) ? data.followups : [];
    // the list is what the Follow-up controls read, so a fresh copy (boot, a
    // delete from another tab's sidebar) has to reach the turns on screen
    syncFollowupControls();
    if (state.sidebarTab === "followups") renderSidebar();
  } catch (err) {
    console.error(err);
  }
}

/** The saved follow-up kept from this turn, if any. The id the save returned is
 *  remembered on the item, so a turn's own save is found even if the list has
 *  not been reloaded yet; the fallback matches the stored record by session
 *  file plus the turn's timestamp, which is what makes the control still read
 *  as "kept" after a reload. */
function savedFollowupOf(item) {
  if (item.followupId) {
    const byId = state.followups.find((f) => f.id === item.followupId);
    if (byId) return byId;
  }
  if (!item.ts || !state.followups.length) return null;
  const file = state.sessionFile || null;
  return state.followups.find((f) => f.ts === item.ts && (f.sessionFile || null) === file) || null;
}

/** Press the Follow-up control: keep this turn's answer the first time, take it
 *  back the second. A press while the request is in flight is dropped: the
 *  toggle invites a double click, and two POSTs would leave two copies of the
 *  same summary. */
function toggleFollowup(item) {
  if (item.followupBusy) return;
  const saved = savedFollowupOf(item);
  if (saved) unsaveFollowup(item, saved);
  else saveFollowup(item);
}

/** The Follow-up control reads state.followups, so a save, an unsave or a
 *  delete from the sidebar has to be reflected on the turns already on screen.
 *  Their state is patched in place rather than re-rendering the transcript: a
 *  full re-render would throw away the node the click came from and can move
 *  the reader's scroll position. */
function syncFollowupControls() {
  let rerender = false;
  for (const it of state.items) {
    if (it.kind !== "assistant" || it.streaming || !it.node) continue;
    const saved = savedFollowupOf(it);
    const btn = it.node.querySelector(".turn-action.followup-toggle");
    if (!btn) {
      // a turn that was rendered without the control now has something to
      // offer (only reachable when the list arrived after the turn did)
      if (saved) {
        it.dirty = true;
        rerender = true;
      }
      continue;
    }
    btn.classList.toggle("kept", !!saved);
    btn.setAttribute("aria-pressed", String(!!saved));
    btn.title = saved
      ? "Saved to Follow-ups — press again to remove it"
      : "Save this summary to Follow-ups — readable later without loading the session";
  }
  if (rerender) scheduleRender();
}

/** Keep one turn's answer as a follow-up. The text stored is the same Markdown
 *  the transcript rendered, so reopening it needs neither pi nor the session.
 *  The id is kept on the item so a turn's own save is unambiguous even when two
 *  turns of the same session end in the same millisecond. */
async function saveFollowup(item) {
  const text = answerTextOf(item);
  if (!text) return;
  const prompt = promptOfRun(item);
  const promptLine = prompt ? (parseSkillBlock(prompt.text)?.userMessage || prompt.text || "").replace(/\s+/g, " ").trim() : "";
  const meta = currentSessionMeta();
  const title = promptLine ? truncate(promptLine, 90) : (state.sessionName || meta?.title || "Follow-up");
  item.followupBusy = true;
  try {
    const data = await api("/api/followups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        text,
        ts: item.ts || null,
        cwd: state.workspace || meta?.cwd || state.cwd || null,
        sessionFile: state.sessionFile || null,
        sessionTitle: state.sessionName || meta?.title || null,
      }),
    });
    item.followupId = data.followup?.id || null;
    // loadFollowups() re-reads the list the control reads and re-syncs it
    await loadFollowups();
    toast("saved to Follow-ups — press Follow-up again to remove it");
  } catch (err) {
    toast(`could not save follow-up: ${err.message}`, "error");
  } finally {
    item.followupBusy = false;
  }
}

/** Un-keep the follow-up saved from this turn: the button is a toggle, so a
 *  second press on the same turn removes what the first press stored. */
async function unsaveFollowup(item, saved) {
  item.followupBusy = true;
  try {
    if (!(await deleteFollowup(saved.id, { quiet: true }))) return;
    item.followupId = null;
    toast("removed from Follow-ups");
  } finally {
    item.followupBusy = false;
  }
}

/** Delete one saved follow-up. Returns false when the server refused, so a
 *  caller that also has on-screen state to update does not clear it on a
 *  delete that did not happen. */
async function deleteFollowup(id, { quiet = false } = {}) {
  try {
    const res = await fetch(`/api/followups/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`server said ${res.status}`);
  } catch (err) {
    toast(`could not delete follow-up: ${err.message}`, "error");
    return false;
  }
  if (state.openFollowup?.id === id) closeFollowup();
  // loadFollowups() re-reads the list the Follow-up controls read and re-syncs them
  await loadFollowups();
  if (!quiet) toast("follow-up deleted");
  return true;
}

/** One sidebar row for a session. `showWorkspace` picks the timestamp that
 *  reads best in a flat list (last activity) versus a workspace-scoped one
 *  (the session's own last timestamp); `unstar` adds the remove-from-favorites
 *  control (Favorites tab).
 *
 *  Three blocks: a title of up to two lines, then the repository on a line of
 *  its own, then the metadata. The repository used to share its line with the
 *  date and message count, which cut long `owner/name` pairs to an unusable
 *  stub; the title used to be a single ellipsized line, which hid the subject
 *  of most sessions. */
function sessionRow(s, { showWorkspace = false, unstar = false } = {}) {
  const active = s.file === state.sessionFile;
  const repo = wsLabel(s.cwd) || "(unknown)";
  return el(
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
      el("span", { class: "s-title-text", text: s.name || s.title || "(untitled)" })
    ),
    el("div", { class: "s-repo", title: s.cwd || repo, text: repo }),
    el(
      "div",
      { class: "s-meta" },
      el("span", { text: fmtDate(showWorkspace ? sessionLastMs(s) : s.lastTimestamp ? Date.parse(s.lastTimestamp) : s.mtime) }),
      el("span", { text: `${s.messages} msg` }),
      s.cost ? el("span", { text: fmtCost(s.cost) }) : null,
      unstar
        ? el("button", {
            class: "s-unstar",
            title: "Remove from Favorites",
            "aria-label": "Remove from Favorites",
            html: STAR_ICON,
            onclick: (e) => {
              // the row itself opens the session; the star must not
              e.stopPropagation();
              toggleFavorite(s.file);
              renderSidebar();
              renderHeader();
              toast("removed from favorites");
            },
            onkeydown: (e) => e.stopPropagation(),
          })
        : null
    )
  );
}

function renderSidebar() {
  const list = $("#session-list");
  list.innerHTML = "";
  const filter = $("#session-filter").value.trim().toLowerCase();
  const crumb = $("#sidebar-crumb");

  // view tabs: "recent" (flat, all workspaces), "workspaces" (two-level),
  // "favorites" (flat, starred only), "followups" (saved summaries)
  const tab = state.sidebarTab;
  for (const name of SIDEBAR_TABS) {
    const btn = $(`#tab-${name}`);
    btn.classList.toggle("active", tab === name);
    btn.setAttribute("aria-selected", String(tab === name));
  }

  if (tab === "favorites") {
    // flat list of starred sessions, in star order (newest star first); a
    // starred file whose session disappeared from disk is simply not rendered
    crumb.classList.add("hidden");
    const favs = favoriteFiles();
    const byFile = new Map(state.sessions.map((s) => [s.file, s]));
    const starred = favs.map((f) => byFile.get(f)).filter((s) => s && sessionMatches(s, filter));
    for (const s of starred) list.append(sessionRow(s, { showWorkspace: true, unstar: true }));
    if (!starred.length) {
      list.append(
        el("div", {
          class: "list-empty",
          text: favs.length ? "No favorites match" : "No favorites yet — star a session from the header",
        })
      );
    }
    return;
  }

  if (tab === "followups") {
    // flat list of saved summaries, newest first; each row opens its own file —
    // no session is loaded and no pi process is involved
    crumb.classList.add("hidden");
    const hits = state.followups.filter(
      (f) => !filter || (f.title || "").toLowerCase().includes(filter) || (f.sessionTitle || "").toLowerCase().includes(filter)
    );
    for (const f of hits) list.append(followupRow(f));
    if (!hits.length) {
      list.append(
        el("div", {
          class: "list-empty",
          text: state.followups.length
            ? "No follow-ups match"
            : "No follow-ups yet — open a summary and press Follow-up",
        })
      );
    }
    return;
  }

  if (tab === "recent") {
    // flat list: every session, most recent first, workspace shown as a chip
    crumb.classList.add("hidden");
    const all = state.sessions
      .filter((s) => sessionMatches(s, filter))
      .sort((a, b) => sessionLastMs(b) - sessionLastMs(a));
    for (const s of all) list.append(sessionRow(s, { showWorkspace: true }));
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
    .filter((s) => sessionMatches(s, filter, { includeCwd: false }));
  for (const s of inWs) list.append(sessionRow(s));
  if (!inWs.length) list.append(el("div", { class: "list-empty", text: "No sessions here yet — use the new-session button" }));
}

// ---------------------------------------------------------------------------
// follow-up view
// ---------------------------------------------------------------------------
// A saved summary is a document, not a transcript: it is rendered from one JSON
// file into the main column, with the composer hidden and no agent attached.
// Nothing about it needs pi — that is the point, a follow-up opens instantly.
function renderFollowup(rec) {
  const view = $("#followup-view");
  const editing = state.followupEditing;
  const head = el(
    "div",
    { class: "fu-head" },
    el(
      "button",
      {
        class: "fu-back",
        // while editing, leaving would silently drop the typed title and body,
        // so Back discards the edit first and a second press leaves
        title: editing ? "Discard the edit (Esc)" : "Back to the session (Esc)",
        onclick: () => (editing ? cancelFollowupEdit() : closeFollowup()),
      },
      el("span", { class: "fu-back-arrow", text: "←" }),
      el("span", { text: "Back" })
    ),
    editing
      ? el("input", {
          class: "fu-title-input",
          id: "fu-title-input",
          value: rec.title || "",
          placeholder: "(untitled follow-up)",
          "aria-label": "Follow-up title",
          maxlength: "300",
          onkeydown: (e) => onFollowupEditKey(e, rec),
        })
      : el("div", { class: "fu-title", text: rec.title || "(untitled follow-up)" }),
    el(
      "div",
      { class: "fu-meta" },
      el("span", { text: fmtDate(rec.createdAt) }),
      rec.cwd ? el("span", { text: wsLabel(rec.cwd), title: rec.cwd }) : null
    ),
    editing
      ? el(
          "div",
          { class: "fu-actions" },
          el("button", {
            class: "turn-action primary",
            title: "Save title and body (Cmd/Ctrl+Enter)",
            onclick: () => commitFollowupEdit(rec),
          }, el("span", { text: "Save" })),
          el("button", {
            class: "turn-action",
            title: "Discard changes (Esc)",
            onclick: () => cancelFollowupEdit(),
          }, el("span", { text: "Cancel" }))
        )
      : el(
          "div",
          { class: "fu-actions" },
          el("button", {
            class: "turn-action",
            title: "Copy as rich text (Markdown on the clipboard too)",
            onclick: async () => {
              toast((await copyRichText(rec.text)) ? "copied as rich text" : "copy failed", "info");
            },
          }, el("span", { class: "turn-action-icon", html: COPY_ICON }), el("span", { text: "Copy" })),
          el("button", {
            class: "turn-action",
            title: "Edit the title and the summary text",
            onclick: () => startFollowupEdit(rec),
          }, el("span", { class: "turn-action-icon", html: EDIT_ICON }), el("span", { text: "Edit" })),
          el("button", {
            class: "turn-action",
            title: "Open the session this summary came from",
            onclick: () => openFollowupSession(rec),
          }, el("span", { text: "Open session" })),
          el("button", {
            class: "turn-action danger",
            title: "Delete this follow-up",
            onclick: () => deleteFollowup(rec.id),
          }, el("span", { text: "Delete" }))
        )
  );
  if (editing) {
    // Markdown source, not rendered output: the stored text is what a later
    // open re-renders, so editing the source is the only edit that survives
    const area = el("textarea", {
      class: "fu-body-input",
      id: "fu-body-input",
      "aria-label": "Follow-up text (Markdown)",
      spellcheck: "false",
    });
    area.value = rec.text || "";
    area.addEventListener("keydown", (e) => onFollowupEditKey(e, rec));
    view.replaceChildren(head, area);
    setTimeout(() => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      area.scrollTop = 0;
    }, 0);
  } else {
    const body = el("div", { class: "assistant-text fu-body" });
    // renderMarkdown escapes the source text up front; htmlFragment keeps the
    // result off innerHTML, exactly as the transcript does
    body.replaceChildren(...htmlFragment(renderMarkdown(rec.text || "")));
    view.replaceChildren(head, body);
  }
}

/** Edit in place rather than in a dialog: the summary is the thing being
 *  changed, so it has to stay on screen while the title and body are typed. */
function startFollowupEdit(rec) {
  state.followupEditing = true;
  renderFollowup(rec);
}

function cancelFollowupEdit() {
  if (!state.followupEditing) return;
  state.followupEditing = false;
  if (state.openFollowup) renderFollowup(state.openFollowup);
}

/** Esc cancels the edit rather than leaving the follow-up, and Cmd/Ctrl+Enter
 *  saves. Escape is stopped here so the document-level handler — which closes
 *  the follow-up — never sees it. */
function onFollowupEditKey(e, rec) {
  if (e.isComposing || e.keyCode === 229) return; // IME candidate confirmation
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    cancelFollowupEdit();
    return;
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.stopPropagation();
    commitFollowupEdit(rec);
  }
}

/** Persist the title and Markdown body, then re-render the document and the
 *  sidebar row from what the server stored. */
async function commitFollowupEdit(rec) {
  const titleEl = $("#fu-title-input");
  const bodyEl = $("#fu-body-input");
  const title = (titleEl?.value || "").trim();
  const text = bodyEl?.value ?? "";
  if (!text.trim()) {
    toast("a follow-up needs some text", "error");
    bodyEl?.focus();
    return;
  }
  let saved;
  try {
    const data = await api(`/api/followups/${encodeURIComponent(rec.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, text }),
    });
    saved = data.followup;
  } catch (err) {
    toast(`could not save follow-up: ${err.message}`, "error");
    return;
  }
  state.followupEditing = false;
  state.openFollowup = saved;
  renderFollowup(saved);
  renderHeader();
  await loadFollowups();
  toast("follow-up updated");
}

/** Show one saved follow-up in the main column. The transcript is hidden, not
 *  destroyed: its items and scroll offset stay, so returning to a session is
 *  as cheap as showing it again. */
async function openFollowup(id) {
  let rec;
  try {
    const data = await api(`/api/followups/${encodeURIComponent(id)}`);
    rec = data.followup;
  } catch (err) {
    toast(`could not open follow-up: ${err.message}`, "error");
    return;
  }
  if (!rec) return;
  state.openFollowup = rec;
  state.followupEditing = false;
  renderFollowup(rec);
  $("#followup-view").classList.remove("hidden");
  $("#transcript-wrap").classList.add("hidden");
  $("#composer-dock").classList.add("hidden");
  $("#followup-view").scrollTop = 0;
  renderHeader();
  syncHash();
  renderSidebar();
}

function closeFollowup() {
  if (!state.openFollowup) return;
  state.openFollowup = null;
  state.followupEditing = false;
  $("#followup-view").classList.add("hidden");
  $("#transcript-wrap").classList.remove("hidden");
  $("#composer-dock").classList.remove("hidden");
  renderHeader();
  syncHash();
  renderSidebar();
  inputEl.focus();
}

/** Jump from a follow-up to the session it was saved from, when that file still
 *  exists and the sidebar knows it. */
async function openFollowupSession(rec) {
  const file = rec.sessionFile;
  if (!file) {
    toast("this follow-up did not record a session file", "error");
    return;
  }
  if (!state.sessions.some((s) => s.file === file)) {
    toast("the session this follow-up came from is no longer on disk", "error");
    return;
  }
  closeFollowup();
  await switchSession(file, rec.cwd || undefined);
}

async function loadSessions() {
  try {
    const data = await api("/api/sessions");
    // The 8s status poll feeds the background-run dots; re-render only when
    // the list actually changed so the sidebar is not rebuilt under the cursor.
    const changed =
      state.workspace === undefined || JSON.stringify(data.sessions) !== JSON.stringify(state.sessions);
    const prevTitle = currentSessionMeta()?.title || null;
    state.sessions = data.sessions;
    // the open session's display title comes from this list (a session only
    // carries an explicit name once renamed), so a first prompt landing or a
    // rename has to reach the header without waiting for a full refresh
    if ((currentSessionMeta()?.title || null) !== prevTitle) renderHeader();
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
// The search button beside the workspace button (or Cmd/Ctrl+K) opens this
// dialog, which queries the server's index. Three tabs share it: "Prompts"
// narrows the index to what the user typed, so a common word in tool output
// cannot bury the prompt that asked for it, and it is the default; "Summary"
// narrows the same query to the answer each run concluded with — the same turn
// the prompt outline offers a jump to, so the two features name one thing;
// "Everything" widens it to every prompt, response, tool request and tool
// result in every workspace.
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
// "all" | "prompts" | "summary" — held in memory only, so a reload always
// starts from the same default scope while switching tabs inside one tab of the
// app keeps the choice. Prompts is the default: the question "where did I
// already ask this" is the common one, and a word that recurs in tool output
// cannot bury it.
let searchScope = "prompts";

const SEARCH_PLACEHOLDER = {
  all: "Search prompts, responses and tool output in every workspace…",
  prompts: "Search prompts in every workspace…",
  summary: "Search what pi concluded in every workspace…",
};
const SEARCH_HINT = {
  all: "Type to search every prompt, response and tool output",
  prompts: "Type to search every prompt",
  summary: "Type to search the summary of every run",
};

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
    renderSearchResults(SEARCH_HINT[searchScope]);
    return;
  }
  searchCountEl.textContent = "searching…";
  try {
    const scopeParam = searchScope === "all" ? "" : `&scope=${searchScope}`;
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}${scopeParam}`);
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

/** switch the search scope and re-run the current query under it; switching
 *  without re-running would leave hits from the other scope on screen and make
 *  a role pill ("result: grep") look like a bug in the Prompts tab */
function setSearchScope(scope) {
  // the tab was clicked to narrow or widen the question being typed, so hand
  // focus back to the field in every case — including a click on the tab that
  // is already active, where the only sensible next keystroke is still typing
  searchInput.focus();
  if (searchScope === scope) return;
  searchScope = scope;
  for (const [id, name] of [["#search-tab-prompts", "prompts"], ["#search-tab-summary", "summary"], ["#search-tab-all", "all"]]) {
    const active = scope === name;
    $(id).classList.toggle("active", active);
    $(id).setAttribute("aria-selected", String(active));
  }
  searchInput.placeholder = SEARCH_PLACEHOLDER[scope];
  searchIndex = 0;
  if (searchTimer) clearTimeout(searchTimer); // the pending keystroke query would rerun the same text
  searchTimer = null;
  runSearch(searchInput.value);
}

$("#search-tab-all").addEventListener("click", () => setSearchScope("all"));
$("#search-tab-prompts").addEventListener("click", () => setSearchScope("prompts"));
$("#search-tab-summary").addEventListener("click", () => setSearchScope("summary"));

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
renderSearchResults(SEARCH_HINT[searchScope]);

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
  // the resources panel may be open on the model list this just filled in
  if (!resourcesOverlay.classList.contains("hidden") && resTab === "models") renderResources();
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
  // the resources panel may be showing the skill list this just replaced
  if (!resourcesOverlay.classList.contains("hidden") && resTab === "skills") renderResources();
}

async function sendPrompt() {
  const input = $("#input");
  const text = input.value.trim();
  const pending = attachments.some((a) => a.state === "reading");
  // a document that could not be read contributes nothing, so it must not look
  // like part of the prompt; it stays in the row (marked) for the user to remove
  const ready = attachments.filter((a) => a.kind === "doc" ? a.state === "ready" : true);
  const failed = attachments.filter((a) => a.kind === "doc" && a.state === "error");
  if (!text) {
    // pi's user message always carries a text block; an empty one can be
    // rejected by providers, so an attachment needs at least a short message
    if (attachments.length) toast(`type a short message for the ${failed.length ? "attachment(s)" : "file(s)"}, then send`, "warning");
    return;
  }
  if (pending) {
    toast("still reading the attached file — send again in a moment", "warning");
    return;
  }
  if (failed.length) {
    toast(`${failed.map((a) => a.name).join(", ")} could not be read — remove it to send`, "error");
    return;
  }
  const images = ready.filter((a) => a.kind === "image");
  const docs = ready.filter((a) => a.kind === "doc");
  input.value = "";
  autosize(input);
  closeCmdMenu();
  rememberPrompt(text);
  attachments.splice(0, attachments.length);
  renderAttachments();
  const extra = state.isStreaming ? { streamingBehavior: "steer" } : {};
  if (images.length) extra.images = images.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
  // a document is appended to the message rather than sent beside it: pi's RPC
  // prompt has no file block, and text is what the model reads anyway. The block
  // is markup so the transcript can show a chip instead of dumping the body.
  const message = docs.length ? [text, ...docs.map(attachedFileBlock)].join("\n\n") : text;
  const restore = () => {
    input.value = text;
    autosize(input);
    attachments.unshift(...ready);
    renderAttachments();
  };
  try {
    const res = await cmd("prompt", { message, ...extra });
    const disp = res.data?.disposition;
    $("#composer-hint").textContent = disp ? `disposition: ${disp}` : "";
  } catch (err) {
    // if racing a running agent, retry as steer (steer accepts images too)
    if (state.isStreaming) {
      try {
        const res = await cmd("prompt", { message, ...extra });
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
// Scroll position per session, keyed like viewCache but kept separately: the
// offset stays meaningful even when the rendered view itself was not cached.
const scrollCache = new Map(); // sessionFile -> { top, atBottom }
const SCROLL_CACHE_MAX = 20;
// Live events (message_start/message_end) append items without touching
// state.leafId, so a stashed leafId would under-count the branch until the
// next full refresh folds them in.
let entriesDirty = false;

/** Remember where this session's transcript was scrolled to. Called before
 *  leaving a session, so returning to it lands on the same line. */
function rememberScroll(file = state.sessionFile) {
  if (!file) return;
  scrollCache.set(file, { top: transcriptEl.scrollTop, atBottom: transcriptAtBottom() });
  while (scrollCache.size > SCROLL_CACHE_MAX) scrollCache.delete(scrollCache.keys().next().value);
}

/** Put the transcript back where the session was left. A view that was
 *  following the stream resumes following it, so messages that arrived while
 *  the user was elsewhere are visible instead of leaving them mid-history. */
function restoreScroll(file) {
  const saved = file ? scrollCache.get(file) : null;
  if (!saved) {
    // never opened in this tab: start at the latest message, like a fresh load
    scrollBottom();
    return;
  }
  if (saved.atBottom) scrollBottom();
  else transcriptEl.scrollTop = saved.top;
  updateJumpButton();
}

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
        renderTranscript({ follow: false }); // the caller restores this session's offset
        return;
      }
    } catch {
      // `since` rejected or RPC hiccup — full refresh below
    }
  }
  await refresh({ sessions: false });
}

async function switchSession(file, cwd) {
  // a session row always wins over a follow-up on screen: leaving the follow-up
  // also restores the transcript and composer this session needs
  if (state.openFollowup) closeFollowup();
  if (file === state.sessionFile) return;
  const gen = ++switchGen;
  const prevFile = state.sessionFile;
  const prevView = { items: state.items, leafId: state.leafId };
  rememberScroll(prevFile);
  stashCurrentView();

  // Optimistic switch: update highlight, hash and transcript area up front so
  // a cold spawn (~2s) does not leave the previous session on screen. The
  // /api/open round-trip below waits for pi to answer RPC before resolving.
  // NOTE: the previously attached session is NOT aborted — it keeps running
  // in its own pi process on the server and can be re-attached anytime.
  state.sessionFile = file;
  state.executions.clear();
  // queue chips belong to the previous session's process — leaving them set
  // would keep showing the old session's queued messages after a switch. The
  // server re-sends this session's queue once the tab re-attaches.
  state.queued = { steering: [], followUp: [] };
  state.isStreaming = false;
  state.isCompacting = false;
  currentAssistant = null;
  $("#composer-hint").textContent = "";
  renderStatus(); // drop the previous session's queue chips now, not after the spawn
  const cached = viewCache.get(file);
  state.items = cached ? cached.items : [{ kind: "notice", text: "loading session…" }];
  state.leafId = cached ? cached.leafId : null;
  renderTranscript({ follow: false });
  restoreScroll(file); // this session's own offset, not the previous session's
  renderFavoriteButton(); // the star reflects this session, not the previous one
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
    restoreScroll(file); // re-renders above may have moved the offset
    renderSidebar(); // re-render so the .active highlight follows the clicked row
  } catch (err) {
    if (gen !== switchGen) return;
    // Revert the optimistic switch: put the previous session's view back.
    state.sessionFile = prevFile;
    state.items = prevView.items;
    state.leafId = prevView.leafId;
    renderTranscript({ follow: false });
    restoreScroll(prevFile);
    renderFavoriteButton();
    renderSidebar();
    syncHash();
    toast(`switch failed: ${err.message}`, "error");
  }
}

async function newSession() {
  try {
    // a follow-up is a document, not a session: starting a session puts the
    // transcript and composer back before anything else runs
    if (state.openFollowup) closeFollowup();
    // On the workspace list there is no active workspace to start a session in.
    if (state.workspace == null) {
      toast("Select a workspace first — pick one from the list or use the folder button", "error");
      return;
    }
    const cwd = state.workspace || state.cwd;
    rememberScroll(); // the session being left keeps its offset
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
    transcriptEl.scrollTop = 0;
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

/** Re-render the newest assistant turn: its Follow-up control depends on where
 *  the run ended, which only the following message can tell. */
function markLastAssistantDirty() {
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (state.items[i].kind === "assistant") {
      state.items[i].dirty = true;
      return;
    }
  }
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
        // the queue died with the process; leaving the chips up would offer a
        // per-item undo that cannot work
        state.queued = { steering: [], followUp: [] };
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
      // which turn carries a run's summary depends on what follows it: a new
      // turn either makes the previous assistant turn the summary (a prompt
      // arrived) or stops it from being one (another turn in the same run)
      markLastAssistantDirty();
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

/** Enlarge an image from the transcript in the modal. Same presentation as a
 *  composer attachment (`attachment-zoom`): the inline thumbnail stays in the
 *  flow, the popup shows the picture at up to 70vh so details are readable.
 *  Clicking it there goes one step further, to the full-window viewer — the
 *  same two-step path a tool-result image takes. */
function openImagePopup(src, title = "image") {
  openPopup(title, {
    paint: () =>
      el(
        "div",
        { class: "attachment-zoom" },
        el("img", { src, alt: title, title: "Click for full screen", onclick: () => openImageViewer(src, title) })
      ),
  });
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
  // edit popups carry the target file name in the title — a Cursor edit is one
  // too, even though its tool name is `cursor`
  const editPath = call.name === "edit" ? call.arguments?.path : cursorEditInfo(call, current.result)?.path;
  const title = editPath ? `edit: ${String(editPath).split(/[\\/]/).pop()}` : `tool: ${call.name}`;
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
// composer attachments: images ride along as image blocks, documents are read
// into text by the server and ride inside the prompt
//
// pi's RPC prompt takes text and images only, so a PDF, .docx, .html or text
// file is turned into text by `POST /api/extract` and appended to the message.
// The block below is the wire format both sides agree on: the composer writes
// it, the transcript parses it back into a chip instead of showing a document
// inline, and the server leaves the body out of titles and the search index.
// ---------------------------------------------------------------------------
const attachmentsEl = $("#attachments");
const attachments = []; // { kind: "image", data, mimeType, url } | { kind: "doc", … }

const ATTACHED_NAME_MAX = 200;
/** Attribute values go through `esc`, so a quote in a file name cannot break out
 *  of the attribute and the block stays one well-formed element. */
/** The body must not contain the block's own closing tag: a document that
 *  quotes pi-web's markup would otherwise end the block early and spill the
 *  rest of its text into the prompt as loose prose. Breaking the tag with a
 *  space keeps the text readable and the framing unambiguous. */
function safeAttachedBody(text) {
  return String(text || "").replace(/<(\/?)attached-file\b/gi, "<$1 attached-file");
}

function attachedFileBlock(doc) {
  // doc.kind is the composer's "image"|"doc" switch; the block records how the
  // text was extracted (pdf, docx, html, text), which is what a reader of the
  // saved session needs to know
  const attrs = [`name="${esc(doc.name)}"`, `kind="${esc(doc.fileKind || "text")}"`];
  if (doc.pages) attrs.push(`pages="${doc.pages}"`);
  if (doc.truncated) attrs.push(`truncated="true"`);
  return `<attached-file ${attrs.join(" ")}>\n${safeAttachedBody(doc.text)}\n</attached-file>`;
}

const ATTACHED_FILE_RE =
  /<attached-file name="([^"]*)" kind="([^"]*)"(?: pages="(\d+)")?( truncated="true")?>\n([\s\S]*?)\n<\/attached-file>/g;
const unescAttr = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Split a user message into the words the user typed and the documents the
 *  composer appended. A message without any block comes back unchanged, so the
 *  cost on an ordinary prompt is one failed match. */
function splitAttachedFiles(text) {
  const files = [];
  const body = String(text || "").replace(ATTACHED_FILE_RE, (_, name, kind, pages, truncated, content) => {
    files.push({
      name: unescAttr(name),
      kind: kind || "text",
      pages: pages ? Number(pages) : null,
      truncated: Boolean(truncated),
      body: content,
    });
    return "";
  });
  return files.length ? { text: body.replace(/\n{3,}/g, "\n\n").trim(), files } : { text: String(text || ""), files };
}

/** A readable name for a document chip: the extension is the badge, so the name
 *  does not need to repeat it. */
function fileExt(name) {
  return (String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "file").toUpperCase();
}

function docMeta(doc) {
  const parts = [];
  if (doc.pages) parts.push(`${doc.pages} page${doc.pages === 1 ? "" : "s"}`);
  if (doc.state === "reading") parts.push("reading…");
  else if (doc.state === "error") parts.push(doc.error || "could not be read");
  else {
    parts.push(`${fmtTokens(doc.text.length)} chars`);
    if (doc.truncated) parts.push("truncated");
  }
  return parts.join(" · ");
}

function removeAttachment(i) {
  attachments.splice(i, 1);
  renderAttachments();
}

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.toggle("hidden", !attachments.length);
  attachments.forEach((a, i) => {
    const remove = el("button", {
      class: "attachment-remove",
      title: "Remove attachment",
      "aria-label": "Remove attachment",
      text: "✕",
      onclick: () => removeAttachment(i),
    });
    if (a.kind === "doc") {
      // a document is a chip, not a picture: what identifies it is the name and
      // how much text it will add, and the popup is the extracted text itself
      const chip = el(
        "div",
        { class: `attachment-file${a.state === "error" ? " error" : ""}` },
        el("span", { class: "attachment-ext", text: fileExt(a.name) }),
        el(
          "span",
          { class: "attachment-file-text" },
          el("span", { class: "attachment-name", text: a.name, title: a.name }),
          el("span", { class: "attachment-meta", text: docMeta(a) })
        ),
        remove
      );
      if (a.state === "ready") {
        chip.title = "Click to read the extracted text";
        chip.addEventListener("click", (e) => {
          if (e.target.closest(".attachment-remove")) return;
          openPopup(`attachment: ${a.name}`, {
            paint: () => el("pre", { class: "doc-body", text: a.text }),
            payload: () => ({ name: a.name, kind: a.kind, pages: a.pages, truncated: a.truncated, text: a.text }),
          });
        });
      }
      attachmentsEl.append(chip);
      return;
    }
    // clicking a thumbnail opens the full image in the popup for detail review
    const zoom = () => openImagePopup(a.url, "attachment");
    attachmentsEl.append(
      el("div", { class: "attachment" }, el("img", { src: a.url, alt: "attachment preview", title: "Click to enlarge", onclick: zoom }), remove)
    );
  });
}

/** Files an attachment can be built from. Anything else is refused by name so a
 *  mistyped extension is not silently ignored. */
const DOC_EXTENSIONS = new Set(["pdf", "docx", "html", "htm", "txt", "md", "markdown", "csv", "json", "log", "yaml", "yml"]);
/** A file this size goes to the server as base64 in a JSON body, which is 4/3 of
 *  it, so it has to stay clear of the server's 32 MB body cap. Refusing it here
 *  is the difference between a named reason and "Failed to fetch". */
const ATTACH_FILE_MAX_MB = 20;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("could not read the file"));
    reader.readAsDataURL(file);
  });
}

/** Turn a dropped or picked file into an attachment. An image is kept as base64
 *  and sent as an image block; anything else is posted to the server, which
 *  extracts its text. The placeholder goes in first, so a slow PDF shows up in
 *  the row immediately with "reading…" rather than after a pause. */
async function addFile(file) {
  if (file.size > ATTACH_FILE_MAX_MB * 1024 * 1024) {
    toast(`${file.name} is larger than ${ATTACH_FILE_MAX_MB} MB — attach a smaller file`, "error");
    return;
  }
  if (file.type.startsWith("image/")) {
    const url = await readAsDataUrl(file);
    attachments.push({ kind: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type, url });
    renderAttachments();
    return;
  }
  const ext = String(file.name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  if (!DOC_EXTENSIONS.has(ext)) {
    toast(`unsupported file: ${file.name} — attach an image, PDF, .docx, .html or a text file`, "error");
    return;
  }
  const doc = { kind: "doc", name: file.name.slice(0, ATTACHED_NAME_MAX), fileKind: ext, state: "reading" };
  attachments.push(doc);
  renderAttachments();
  try {
    const url = await readAsDataUrl(file);
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: doc.name, data: url.slice(url.indexOf(",") + 1) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    Object.assign(doc, { state: "ready", kind: "doc", text: body.text, pages: body.pages || null, truncated: !!body.truncated, fileKind: body.kind });
  } catch (err) {
    doc.state = "error";
    doc.error = err.message;
  }
  renderAttachments();
}

async function addFiles(files) {
  const list = [...files];
  if (!list.length) return;
  inputEl.focus();
  // one at a time: every document becomes a request, and a burst of ten would
  // only make the row jump around while they land out of order
  for (const file of list) await addFile(file);
}

// The attach button opens the OS file picker; dropping files still works.
// The input is cleared after every pick so choosing the same file twice in a
// row still fires a change event.
$("#btn-attach").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => {
  const files = [...(e.target.files || [])];
  if (files.length) addFiles(files);
  e.target.value = "";
});

// File drops are accepted anywhere on the page and routed to the composer.
// Cancelling at window level is what actually prevents the browser's default
// action (opening the dropped file in a tab / navigating away) — a composer-
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
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
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
$("#tab-favorites").addEventListener("click", () => selectTab("favorites"));
$("#tab-followups").addEventListener("click", () => {
  selectTab("followups");
  loadFollowups();
});

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
// theme
//
// Six standalone palettes, not a light/dark or depth ramp: the button opens a
// listbox of swatches and picking one re-points the tokens in style.css. The
// theme name is also the document attribute, so no per-theme class juggling is
// needed and an unknown saved value falls back to the default.
// ---------------------------------------------------------------------------
const ICON_SUN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const ICON_MOON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
/** the palette list, lightest mood first: this order is the menu order */
const THEMES = ["mono", "sky", "grove", "ember", "elegant", "night"];
const DEFAULT_THEME = "sky";
const THEME_CHROME = {
  mono: "#eef0f2",
  sky: "#e8f0fa",
  grove: "#e9f2e8",
  ember: "#fbf2e9",
  elegant: "#f2eef9",
  night: "#1c1c1e",
};
/** a saved value from an older build (a retired palette, or "light"/"dark")
 *  still has to resolve, so anything unknown maps onto the closest match */
function normalizeTheme(theme) {
  if (THEMES.includes(theme)) return theme;
  return theme === "dark" ? "night" : DEFAULT_THEME;
}
/** parse a static SVG string into a live element (no untrusted input) */
function svgIcon(markup) {
  return document.importNode(new DOMParser().parseFromString(markup, "image/svg+xml").documentElement, true);
}
function renderThemePicker(current) {
  const menu = $("#theme-menu");
  menu.innerHTML = "";
  for (const name of THEMES) {
    const isCurrent = name === current;
    menu.append(
      el(
        "button",
        {
          class: `picker-item theme-item${isCurrent ? " selected" : ""}`,
          role: "option",
          "aria-selected": String(isCurrent),
          "data-theme-name": name,
          onclick: () => applyTheme(name),
        },
        el("span", { class: `theme-swatch swatch-${name}`, "aria-hidden": "true" }),
        el("span", { class: "theme-name", text: name }),
        el("span", { class: "theme-dot", text: isCurrent ? "✓" : "" })
      )
    );
  }
}
/** index of a palette name in THEMES, or -1 when it is not one */
function themeIndex(name) {
  return THEMES.indexOf(name);
}
function applyTheme(theme) {
  const next = normalizeTheme(theme);
  document.documentElement.dataset.theme = next;
  localStorage.setItem("piweb-theme", next);
  // the icon echoes the polarity, not the palette: sun while dark, moon while light
  $("#btn-theme").replaceChildren(svgIcon(next === "night" ? ICON_SUN : ICON_MOON));
  renderThemePicker(next);
  // keep the browser chrome (mobile address bar, PWA shell) on the same page color
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_CHROME[next]);
}
wirePicker("#btn-theme", "#theme-menu");
document.addEventListener("keydown", (e) => {
  // the theme list is a radio group: arrows move the selection while it is open
  if ($("#theme-menu").classList.contains("hidden")) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const step = e.key === "ArrowDown" ? 1 : -1;
  const at = themeIndex(document.documentElement.dataset.theme);
  applyTheme(THEMES[Math.min(THEMES.length - 1, Math.max(0, at + step))]);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (
      !$("#model-menu").classList.contains("hidden") ||
      !$("#thinking-menu").classList.contains("hidden") ||
      !$("#theme-menu").classList.contains("hidden")
    ) {
      closePickers();
    } else if (!$("#session-info-pop").classList.contains("hidden")) {
      setSessionInfoOpen(false);
    } else if (!$("#prompt-list-pop").classList.contains("hidden")) {
      setPromptListOpen(false);
    } else if (!resourcesOverlay.classList.contains("hidden")) {
      setResourcesOpen(false);
    } else if (!searchOverlay.classList.contains("hidden")) {
      setSearchOpen(false);
    } else if (!$("#followup-view").classList.contains("hidden")) {
      // an in-place edit takes Escape first: cancelling the edit must not also
      // close the document being edited
      if (state.followupEditing) cancelFollowupEdit();
      else closeFollowup();
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
  applyTheme(localStorage.getItem("piweb-theme") || DEFAULT_THEME);
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
  // Follow-ups are read once at boot so the tab is populated before it is
  // clicked; the list is a directory read, not a session parse.
  loadFollowups();
  // poll the session list so the sidebar's background-run dots stay current
  setInterval(() => loadSessions().catch(() => {}), 8000);
  // deep link: #ws=<cwd>&session=<file|new>[&followup=<id>] — open the hashed
  // session if it differs from what this tab started with
  const hs = hashState();
  const target = hs?.session && hs.session !== "new" ? hs.session : null;
  if (target && target !== state.sessionFile) {
    const meta = state.sessions.find((s) => s.file === target);
    await switchSession(target, meta?.cwd || hs.ws || undefined);
  } else {
    syncHash();
  }
  if (hs?.followup) await openFollowup(hs.followup);
  inputEl.focus();
})();
