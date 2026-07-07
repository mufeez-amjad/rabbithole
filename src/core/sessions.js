import { RabbitHoleSession } from "./transport/session.js";

const sessions = new Map();

export async function createSession(config) {
  const session = new RabbitHoleSession({
    ...config,
    onClose: (s) => sessions.delete(s.id),
  });
  sessions.set(session.id, session);
  await session.start();
  return session;
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Find a live (not-yet-closed) session for a hole, if any. The hub uses this to
 * redirect a second open of the same hole to the tab that's already serving it
 * instead of superseding it with a fresh session.
 */
export function getSessionForHole(holeId) {
  for (const session of sessions.values()) {
    if (session.holeId === holeId && !session.isClosed()) return session;
  }
  return null;
}

/**
 * Close any live session for the same hole (e.g. before a resume opens a new
 * one) so a stale tab shows "reopened elsewhere" instead of shimmering forever.
 */
export function closeSessionsForHole(holeId, reason = "superseded") {
  for (const session of [...sessions.values()]) {
    if (session.holeId === holeId && !session.isClosed()) session.close(reason);
  }
}

/**
 * Close every live session (broadcasting the reason to the browsers so they
 * show a "session ended" state) and wait for pending saves — call before the
 * process exits.
 */
export async function closeAllSessions(reason = "agent_exited") {
  const live = [...sessions.values()];
  for (const session of live) {
    try {
      session.close(reason);
    } catch {}
  }
  await Promise.allSettled(live.map((s) => s.savingChain));
}
