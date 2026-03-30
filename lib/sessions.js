import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Session tracking + persistence
// ---------------------------------------------------------------------------
export const sessions = new Map(); // id -> { process, prompt, cwd, startedAt, status }
const STALE_THRESHOLD_MS = 120_000; // 2 minutes without stdout = stale
const SESSIONS_FILE = new URL("../sessions.json", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

export function persistSessions() {
  const data = [...sessions.values()].map(({ proc, ...rest }) => rest);
  try { writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2)); } catch { /* best effort */ }
}

export function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    for (const s of data) {
      // Restored sessions have no live process — mark as stopped
      s.proc = null;
      if (s.status !== "stopped" && s.status !== "error") s.status = "stopped";
      s.alive = false;
      sessions.set(s.id, s);
    }
    console.log(`Restored ${data.length} session(s) from disk`);
  } catch { /* ignore corrupt file */ }
}

// ---------------------------------------------------------------------------
// Liveness helpers
// ---------------------------------------------------------------------------
export function isProcessAlive(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return false;
  if (process.platform === "win32") {
    // proc.kill(0) does not work as a liveness check on Windows —
    // Node treats all signals as kill on Windows, so signal 0 either
    // throws or actually terminates the process.  Fall back to tasklist.
    try {
      const out = execSync(`tasklist /FI "PID eq ${proc.pid}" /NH`, {
        stdio: "pipe", encoding: "utf-8",
      });
      // tasklist prints "INFO: No tasks..." when the PID is gone
      return out.includes(String(proc.pid));
    } catch { return false; }
  }
  try { proc.kill(0); return true; } catch { return false; }
}

export function checkSessionHealth(session) {
  const alive = isProcessAlive(session.proc);

  // Recover sessions wrongly marked as stopped (e.g. stdio pipes closed on Windows)
  if (session.status === "stopped" && alive) {
    session.status = "ready";
    return;
  }

  if (session.status === "stopped" || session.status === "error") return;

  if (!alive) {
    // Grace period: don't mark brand-new sessions as stopped — the process
    // may not have fully started yet (especially on Windows).
    const age = Date.now() - new Date(session.startedAt).getTime();
    if (session.status === "connecting" && age < 10_000) return;

    session.status = "stopped";
    session.exitCode = session.proc?.exitCode ?? null;
    return;
  }

  // Detect stale: process alive but no stdout activity for a while
  if (session.status === "ready" && session.lastActivityAt) {
    const elapsed = Date.now() - new Date(session.lastActivityAt).getTime();
    if (elapsed > STALE_THRESHOLD_MS) {
      session.status = "stale";
    }
  }
}

// Periodic health sweep — every 30s
export function startHealthSweep() {
  return setInterval(() => {
    for (const session of sessions.values()) {
      checkSessionHealth(session);
    }
  }, 30_000);
}
