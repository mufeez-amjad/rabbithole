#!/usr/bin/env node
/**
 * Standalone launcher: opens the Rabbithole app in your browser WITHOUT an MCP
 * client. Starts the hub (a standing local server) and points your browser at
 * a home page listing your saved holes. Open one to keep reading; questions you
 * ask are saved and answered the next time an agent resumes that hole.
 *
 * Unlike bin/mcp-server.js this is a normal CLI, so it prints to stdout.
 */
import { startHub } from "../src/core/hub.js";
import { openBrowser } from "../src/core/transport/browser.js";
import { closeAllSessions } from "../src/core/sessions.js";
import { log, error as logError } from "../src/core/logger.js";

async function main() {
  const { server, url } = await startHub();

  console.log(`\n  Rabbithole is running at ${url}`);
  console.log("  Browse your saved holes there. Press Ctrl+C to stop.\n");
  openBrowser(url);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down hub`);
    try {
      await Promise.race([closeAllSessions("hub_stopped"), new Promise((r) => setTimeout(r, 2000))]);
    } catch (err) {
      logError(`Shutdown flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    server.close(() => process.exit(0));
    // Don't let a lingering keep-alive connection wedge the exit.
    setTimeout(() => process.exit(0), 500).unref();
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => shutdown(signal));
  }
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
