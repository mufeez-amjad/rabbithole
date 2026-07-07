import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cross-process "is an agent connected?" signal.
 *
 * The MCP server (bin/mcp-server.js) is a separate process from the standalone
 * hub, so the hub can't see it directly. Instead each running MCP server drops a
 * marker file at ~/.rabbithole/agents/<pid>.json while it's up and removes it on
 * exit; the hub reads that directory to decide whether a new hole can be started.
 *
 * Markers are keyed by pid and validated with a liveness probe, so a crash that
 * skips cleanup self-heals: the next reader sees the pid is dead and deletes the
 * stale marker. Everything here is synchronous so it can run inside a process
 * 'exit' handler (async work never completes there).
 */

function baseDir() {
  return process.env.RABBITHOLE_DIR || path.join(os.homedir(), ".rabbithole");
}

function agentsDir() {
  return path.join(baseDir(), "agents");
}

function markerPath(pid) {
  return path.join(agentsDir(), `${pid}.json`);
}

/** Drop this process's marker. Called once when the MCP server starts. */
export function registerAgent() {
  try {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(
      markerPath(process.pid),
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })
    );
  } catch {
    // Presence is best-effort — a failure here must never take the server down.
  }
}

/** Remove this process's marker. Safe to call more than once. */
export function unregisterAgent() {
  try {
    fs.rmSync(markerPath(process.pid), { force: true });
  } catch {}
}

/**
 * True if any live MCP server has a marker. Stale markers (whose process is
 * gone) are pruned as they're encountered so the signal stays honest.
 */
export function isAgentConnected() {
  let entries;
  try {
    entries = fs.readdirSync(agentsDir());
  } catch {
    return false;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const pid = Number(name.slice(0, -5));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (isAlive(pid)) return true;
    try {
      fs.rmSync(path.join(agentsDir(), name), { force: true });
    } catch {}
  }
  return false;
}

// Signal 0 doesn't touch the process — it just resolves to success if the pid
// exists and to EPERM if it exists but we can't signal it (still alive).
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}
