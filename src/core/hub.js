import http from "node:http";
import { log, error as logError } from "./logger.js";
import { escapeHtml } from "./utils.js";
import { listHoles } from "./storage.js";
import { openStandaloneSession } from "./rabbithole.js";

/**
 * The hub is the standing local server behind the `rabbithole` CLI: a long-lived
 * daemon that lists your saved holes and opens one on demand. Opening a hole
 * spins up an ordinary (detached) session on its own port and 302-redirects the
 * browser to it, so the whole canvas machinery is reused unchanged. The hub
 * itself stays up across opens — closing a hole's tab never takes it down.
 */

const DEFAULT_HUB_PORT = 4173;

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
  if (req.method === "GET" && url.pathname === "/open") {
    return openHole(res, url.searchParams.get("id"));
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

async function renderHome(res) {
  let holes = [];
  try {
    holes = await listHoles();
  } catch (err) {
    logError(`Hub failed to list holes: ${err.message}`);
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  });
  res.end(buildHomeHtml(holes));
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
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(buildMessageHtml("Couldn't open that hole", err.message));
  }
}

// ---- home page (self-contained) -------------------------------------------

function buildHomeHtml(holes) {
  const cards = holes.length
    ? holes.map(holeCardHtml).join("\n")
    : `<p class="empty">No saved holes yet. Start one from your agent with <code>open_rabbithole</code>, then it'll show up here.</p>`;

  return page(
    "Rabbithole",
    `<header>
      <h1>Rabbithole</h1>
      <p class="sub">Your saved holes${holes.length ? ` — ${holes.length}` : ""}. Open one to keep reading; ask anything and your questions are saved and answered the next time an agent picks it up.</p>
    </header>
    <main class="grid">${cards}</main>`
  );
}

function holeCardHtml(hole) {
  const title = escapeHtml(hole.title || "Untitled");
  const count = Number(hole.node_count) || 0;
  const meta = `${count} ${count === 1 ? "node" : "nodes"} · updated ${escapeHtml(relativeTime(hole.updated_at))}`;
  return `<a class="card" href="/open?id=${encodeURIComponent(hole.hole_id)}">
    <span class="card-title">${title}</span>
    <span class="card-meta">${meta}</span>
  </a>`;
}

function buildMessageHtml(title, detail) {
  return page(
    escapeHtml(title),
    `<header><h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(detail || "")}</p>
     <p><a class="back" href="/">← Back to your holes</a></p></header>`
  );
}

// Relative time without Date.now() so this file has no ambient clock quirks in
// tests; the timestamp math is against a plain `new Date()` here (hub runtime,
// not a workflow script) which is fine.
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

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#faf9f7; --fg:#1b1a17; --muted:#6b6862; --card:#ffffff; --border:#e7e3db; --accent:#b4571f; --shadow:rgba(30,25,15,.06); }
  @media (prefers-color-scheme: dark){ :root{ --bg:#171512; --fg:#efe9df; --muted:#9c968b; --card:#211e1a; --border:#332f28; --accent:#e0864a; --shadow:rgba(0,0,0,.35); } }
  * { box-sizing: border-box; }
  body { margin:0; padding:48px 24px 80px; background:var(--bg); color:var(--fg);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:760px; margin:0 auto; }
  header { margin-bottom:32px; }
  h1 { font-size:28px; margin:0 0 6px; letter-spacing:-.02em; }
  .sub { color:var(--muted); margin:0; max-width:56ch; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; }
  .card { display:flex; flex-direction:column; gap:8px; padding:16px 18px; border-radius:12px;
    background:var(--card); border:1px solid var(--border); box-shadow:0 1px 2px var(--shadow);
    text-decoration:none; color:inherit; transition:transform .12s ease, border-color .12s ease, box-shadow .12s ease; }
  .card:hover { transform:translateY(-2px); border-color:var(--accent); box-shadow:0 6px 18px var(--shadow); }
  .card-title { font-weight:600; font-size:17px; letter-spacing:-.01em; }
  .card-meta { color:var(--muted); font-size:13px; }
  .empty { color:var(--muted); }
  code { background:var(--card); border:1px solid var(--border); border-radius:5px; padding:1px 5px; font-size:.9em; }
  .back { color:var(--accent); text-decoration:none; }
  .back:hover { text-decoration:underline; }
</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}
