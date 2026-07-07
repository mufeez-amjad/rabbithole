import http from "node:http";
import { log, error as logError } from "./logger.js";
import { escapeHtml } from "./utils.js";
import { listHoles, saveDraft } from "./storage.js";
import { openStandaloneSession } from "./rabbithole.js";
import { isAgentConnected } from "./presence.js";
import { parseRequestBody } from "./transport/http.js";

/**
 * The hub is the standing local server behind the `rabbithole` CLI: a long-lived
 * daemon that lists your saved holes and opens one on demand. Opening a hole
 * spins up an ordinary (detached) session on its own port and 302-redirects the
 * browser to it, so the whole canvas machinery is reused unchanged. The hub
 * itself stays up across opens — closing a hole's tab never takes it down.
 *
 * The agent↔hole binding is 1:1: an attached agent blocks in the
 * open_rabbithole → answer_branch loop on exactly one hole. So starting a NEW
 * hole isn't "attach an agent to a hub page" — it's a FRESH agent opening a new
 * rabbithole. POST /new therefore doesn't create anything; it stashes the typed
 * content as a draft and hands back an `open_rabbithole { file_path }` command
 * to paste into a fresh agent, which creates + opens the hole live (its own tab).
 * The presence marker (see presence.js) is only an advisory "is any agent even
 * running?" hint, since a running agent may already be busy with another hole.
 */

const DEFAULT_HUB_PORT = 4173;
const RECENT_LIMIT = 3;

export async function startHub({ port } = {}) {
  const server = http.createServer(handleHubRequest);
  server.on("error", (err) => logError(`Hub server error: ${err.message}`));
  const desired = Number(port ?? process.env.RABBITHOLE_HUB_PORT ?? DEFAULT_HUB_PORT) || 0;
  const url = await listen(server, desired);
  log(`Rabbithole hub listening at ${url}`);
  return { server, url };
}

// Bind to the requested port, but fall back to an OS-assigned one if it's taken
// so a second `rabbithole` (or any port clash) still comes up instead of dying.
function listen(server, desired) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("error", onError);
      if (err && err.code === "EADDRINUSE" && desired !== 0) {
        log(`Hub port ${desired} in use — falling back to a random port`);
        listen(server, 0).then(resolve, reject);
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(desired, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine hub address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function handleHubRequest(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return renderHome(res);
  }
  if (req.method === "GET" && url.pathname === "/all") {
    return renderAll(res);
  }
  if (req.method === "GET" && url.pathname === "/open") {
    return openHole(res, url.searchParams.get("id"));
  }
  if (req.method === "POST" && url.pathname === "/new") {
    return startHole(req, res);
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, agent_connected: isAgentConnected() }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

// ---- routes ----------------------------------------------------------------

async function renderHome(res) {
  const holes = await safeListHoles();
  html(res, 200, buildHomeHtml(holes.slice(0, RECENT_LIMIT), holes.length));
}

async function renderAll(res) {
  const holes = await safeListHoles();
  html(res, 200, buildAllHtml(holes));
}

async function openHole(res, id) {
  const holeId = String(id ?? "").trim();
  if (!holeId) {
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }
  try {
    const session = await openStandaloneSession(holeId);
    res.writeHead(302, { Location: session.url });
    res.end();
  } catch (err) {
    logError(`Hub failed to open hole ${holeId}: ${err.message}`);
    html(res, 404, buildMessageHtml("Couldn't open that hole", err.message));
  }
}

// Start a new hole: stash the content and hand back a command for a FRESH agent
// to open it (1:1). The hub creates no hole and no session of its own here.
async function startHole(req, res) {
  let payload;
  try {
    payload = await parseRequestBody(req, res);
  } catch (err) {
    if (err?.statusCode === 413) return; // parseRequestBody already replied
    json(res, 400, { ok: false, reason: "bad_request", error: err?.message || String(err) });
    return;
  }

  const content = String(payload?.content ?? "").trim();
  if (!content) {
    json(res, 400, { ok: false, reason: "empty" });
    return;
  }
  try {
    const title = deriveTitle(content);
    const filePath = await saveDraft(content);
    json(res, 200, {
      ok: true,
      title,
      file_path: filePath,
      command: newHoleCommand(title, filePath),
      // Advisory only — a fresh agent connection is what actually opens the hole.
      agent_connected: isAgentConnected(),
    });
  } catch (err) {
    logError(`Hub failed to prepare a new hole: ${err.message}`);
    json(res, 500, { ok: false, reason: "error", error: err.message });
  }
}

function newHoleCommand(title, filePath) {
  return (
    `Open a new Rabbithole titled "${title}" from the file ${filePath} — ` +
    `call open_rabbithole with that title and file_path, then answer my questions as I explore.`
  );
}

async function safeListHoles() {
  try {
    return await listHoles();
  } catch (err) {
    logError(`Hub failed to list holes: ${err.message}`);
    return [];
  }
}

// First non-empty line, stripped of a leading markdown heading marker, as the
// hole's title; the whole text becomes the root document.
function deriveTitle(content) {
  const firstLine = String(content).split(/\r?\n/).find((l) => l.trim()) || "Untitled";
  const cleaned = firstLine.replace(/^#{1,6}\s*/, "").trim();
  return cleaned.length > 60 ? cleaned.slice(0, 60).trimEnd() + "…" : cleaned || "Untitled";
}

// ---- pages (self-contained) ------------------------------------------------

function buildHomeHtml(recent, total) {
  const grid = recent.length
    ? `<div class="grid">${recent.map(holeCardHtml).join("")}</div>`
    : `<p class="empty">No holes yet — start one above, or ask your agent to open a document.</p>`;
  const viewAll = total > recent.length
    ? `<a class="viewall" href="/all">View all ${total} →</a>`
    : "";

  return page(
    "Rabbithole",
    `<div class="hero">
      <h1 class="agenda">What do you want to explore?</h1>
      ${composerHtml()}
      ${agentStatusHtml()}
      <section class="recent">
        <div class="recent-head"><span>Recent holes</span>${viewAll}</div>
        ${grid}
      </section>
    </div>`,
    HOME_SCRIPT
  );
}

function buildAllHtml(holes) {
  const grid = holes.length
    ? `<div class="grid">${holes.map(holeCardHtml).join("")}</div>`
    : `<p class="empty">No saved holes yet.</p>`;
  return page(
    "All holes · Rabbithole",
    `<header class="all-head">
      <a class="back" href="/">← New</a>
      <h1>All holes${holes.length ? ` · ${holes.length}` : ""}</h1>
    </header>
    ${grid}`
  );
}

function composerHtml() {
  return `<form class="composer" id="composer" autocomplete="off">
    <textarea id="prompt" rows="1" placeholder="Start a new rabbit hole — paste a document or a topic…"></textarea>
    <div class="composer-row">
      <button type="submit" class="send" id="send" aria-label="Start">${sendSvg()}</button>
    </div>
    <div class="handoff" id="handoff" hidden>
      <div class="handoff-title">Start this in a fresh agent</div>
      <div class="handoff-sub">Paste into a new Claude Code / Codex conversation — it opens a brand-new hole and attaches to it live.</div>
      <div class="notice-cmd">
        <code id="handoff-cmd"></code>
        <button type="button" class="copy" id="copy-cmd">Copy</button>
      </div>
    </div>
  </form>`;
}

function agentStatusHtml() {
  return `<div class="agent-status" id="agent-status" data-state="unknown">
    <div class="agent-row"><span class="dot"></span><span id="agent-label">Checking for an MCP client…</span></div>
    <div class="agent-connect" id="agent-connect" hidden>
      Connect Rabbithole to your MCP client, then it'll show up here:
      <div class="notice-cmd">
        <code id="setup-cmd">claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole</code>
        <button type="button" class="copy" id="copy-setup">Copy</button>
      </div>
    </div>
  </div>`;
}

function holeCardHtml(hole) {
  const title = escapeHtml(hole.title || "Untitled");
  const count = Number(hole.node_count) || 0;
  const meta = `${count} ${count === 1 ? "node" : "nodes"} · ${escapeHtml(relativeTime(hole.updated_at))}`;
  return `<a class="card" href="/open?id=${encodeURIComponent(hole.hole_id)}">
    <span class="card-title">${title}</span>
    <span class="card-meta">${meta}</span>
  </a>`;
}

function buildMessageHtml(title, detail) {
  return page(
    escapeHtml(title),
    `<header class="all-head"><a class="back" href="/">← Back</a><h1>${escapeHtml(title)}</h1></header>
     <p class="empty">${escapeHtml(detail || "")}</p>`
  );
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "recently";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

// ---- inline icons ----------------------------------------------------------

function sendSvg() {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12.5V4M8 4 4.2 7.8M8 4l3.8 3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// ---- page shell + client script --------------------------------------------

const HOME_SCRIPT = `
  var form = document.getElementById("composer");
  var prompt = document.getElementById("prompt");
  var send = document.getElementById("send");
  var handoff = document.getElementById("handoff");
  var handoffCmd = document.getElementById("handoff-cmd");

  function grow(){ prompt.style.height = "auto"; prompt.style.height = Math.min(prompt.scrollHeight, 320) + "px"; }
  prompt.addEventListener("input", function(){ grow(); handoff.hidden = true; });
  prompt.addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); form.requestSubmit(); }
  });

  function copy(text){
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var ta = document.createElement("textarea"); ta.value = text; ta.style.position="fixed"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.select(); try{ document.execCommand("copy"); }catch(e){} document.body.removeChild(ta);
    return Promise.resolve();
  }
  function wireCopy(btnId, srcId){
    document.getElementById(btnId).addEventListener("click", function(){
      var self = this;
      copy(document.getElementById(srcId).textContent).then(function(){
        self.textContent = "Copied"; setTimeout(function(){ self.textContent = "Copy"; }, 1400);
      });
    });
  }
  wireCopy("copy-cmd", "handoff-cmd");
  wireCopy("copy-setup", "setup-cmd");

  function submit(){
    var content = prompt.value.trim();
    if (!content) return;
    send.disabled = true;
    fetch("/new", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ content: content }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        send.disabled = false;
        if (res && res.ok && res.command){
          handoffCmd.textContent = res.command;
          handoff.hidden = false;
        }
      })
      .catch(function(){ send.disabled = false; });
  }
  form.addEventListener("submit", function(e){ e.preventDefault(); submit(); });

  // Live agent-connection indicator: poll the hub's presence signal so starting
  // (or stopping) an agent reflects here within a few seconds.
  var statusEl = document.getElementById("agent-status");
  var labelEl = document.getElementById("agent-label");
  var connectEl = document.getElementById("agent-connect");
  function setAgent(connected){
    statusEl.dataset.state = connected ? "on" : "off";
    labelEl.textContent = connected ? "MCP client connected · ready for a new hole" : "No MCP client connected";
    connectEl.hidden = connected;
  }
  function refreshAgent(){
    fetch("/health", { cache:"no-store" })
      .then(function(r){ return r.json(); })
      .then(function(h){ setAgent(!!(h && h.agent_connected)); })
      .catch(function(){ setAgent(false); });
  }
  refreshAgent();
  setInterval(refreshAgent, 4000);
  prompt.focus();
`;

function page(title, body, script) {
  const scriptTag = script
    ? `<script>(function(){${script}})();</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
${scriptTag}
</body>
</html>`;
}

const PAGE_CSS = `
  :root { color-scheme: light dark;
    --bg:#ffffff; --fg:#0d0d0d; --muted:#8f8f8f; --card:#ffffff; --card-hover:#f7f7f5;
    --border:#e5e5e2; --field:#ffffff; --field-border:#d8d8d4; --accent:#0d0d0d; --shadow:rgba(13,13,13,.06); }
  @media (prefers-color-scheme: dark){ :root{
    --bg:#212121; --fg:#ececec; --muted:#9a9a9a; --card:#2a2a2a; --card-hover:#323232;
    --border:#3a3a3a; --field:#303030; --field-border:#4a4a4a; --accent:#ececec; --shadow:rgba(0,0,0,.35); } }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { min-height:100%; max-width:760px; margin:0 auto; padding:0 20px 64px; }

  /* home hero (ChatGPT-style) */
  .hero { min-height:100vh; display:flex; flex-direction:column; justify-content:center; gap:0; padding:64px 0; }
  .agenda { text-align:center; font-size:30px; font-weight:600; letter-spacing:-.02em; margin:0 0 22px; }

  .composer { background:var(--field); border:1px solid var(--field-border); border-radius:26px;
    padding:14px 16px 10px; box-shadow:0 2px 10px var(--shadow); }
  .composer textarea { display:block; width:100%; border:0; outline:0; resize:none; background:transparent;
    color:var(--fg); font:inherit; line-height:1.5; max-height:320px; padding:2px 4px 8px; }
  .composer textarea::placeholder { color:var(--muted); }
  .composer-row { display:flex; align-items:center; justify-content:flex-end; }
  .send { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; border:0;
    border-radius:50%; background:var(--accent); color:var(--bg); cursor:pointer; }
  .send:disabled { opacity:.4; cursor:default; }

  .handoff { margin-top:12px; border-top:1px solid var(--border); padding-top:12px; font-size:13.5px; color:var(--fg); }
  .handoff-title { font-weight:600; }
  .handoff-sub { color:var(--muted); margin-top:2px; }
  .notice-cmd { display:flex; align-items:center; gap:8px; margin:10px 0; }
  .notice-cmd code { flex:1; overflow-x:auto; white-space:nowrap; background:var(--bg); border:1px solid var(--border);
    border-radius:8px; padding:8px 10px; font-size:12.5px; }
  .copy { border:1px solid var(--field-border); background:var(--card); color:var(--fg);
    border-radius:8px; padding:7px 12px; font-size:13px; cursor:pointer; flex-shrink:0; }
  .copy:hover { background:var(--card-hover); }

  /* live agent-connection indicator below the composer */
  .agent-status { margin:10px 4px 0; }
  .agent-row { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--muted); }
  .agent-status .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex-shrink:0; }
  .agent-status[data-state="on"] .agent-row { color:var(--fg); }
  .agent-status[data-state="on"] .dot { background:#19c37d; box-shadow:0 0 0 3px rgba(25,195,125,.18); }
  .agent-status[data-state="off"] .dot { background:#c4823a; }
  .agent-connect { margin-top:10px; color:var(--muted); font-size:12.5px; }

  /* recent + grid */
  .recent { margin-top:32px; }
  .recent-head { display:flex; align-items:baseline; justify-content:space-between; margin:0 4px 12px;
    font-size:13px; font-weight:600; color:var(--muted); letter-spacing:.02em; text-transform:uppercase; }
  .viewall { color:var(--fg); text-decoration:none; font-weight:500; text-transform:none; letter-spacing:0; }
  .viewall:hover { text-decoration:underline; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px; }
  .card { display:flex; flex-direction:column; gap:8px; padding:15px 16px; border-radius:14px;
    background:var(--card); border:1px solid var(--border); text-decoration:none; color:inherit;
    transition:background .12s ease, border-color .12s ease, transform .12s ease; }
  .card:hover { background:var(--card-hover); border-color:var(--field-border); transform:translateY(-1px); }
  .card-title { font-weight:600; font-size:15.5px; letter-spacing:-.01em; }
  .card-meta { color:var(--muted); font-size:12.5px; }
  .empty { color:var(--muted); margin:4px; }

  /* all-holes page */
  .all-head { display:flex; align-items:center; gap:14px; padding:36px 4px 24px; }
  .all-head h1 { font-size:22px; margin:0; letter-spacing:-.01em; }
  .back { color:var(--muted); text-decoration:none; font-size:14px; }
  .back:hover { color:var(--fg); }
`;

// ---- tiny response helpers -------------------------------------------------

function html(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  });
  res.end(body);
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
