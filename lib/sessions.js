import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Session TTL — auto-expire after 3 hours
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

// ---------------------------------------------------------------------------
// Ring buffer for bounded stdout/stderr accumulation
// ---------------------------------------------------------------------------
const STDOUT_BUFFER_SIZE = parseInt(process.env.STDOUT_BUFFER_KB || "64", 10) * 1024;

export function createRingBuffer(maxBytes = STDOUT_BUFFER_SIZE) {
  let buf = "";
  return {
    append(str) { buf += str; if (buf.length > maxBytes) buf = buf.slice(buf.length - maxBytes); },
    toString() { return buf; },
    get length() { return buf.length; },
  };
}

// ---------------------------------------------------------------------------
// Session tracking + persistence
// ---------------------------------------------------------------------------
export const sessions = new Map(); // id -> { process, prompt, cwd, startedAt, status }
const STALE_THRESHOLD_MS = 120_000; // 2 minutes without stdout = stale
const SESSIONS_FILE = new URL("../sessions.json", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

let debounceTimer = null;

export function persistSessionsNow() {
  debounceTimer = null;
  const data = [...sessions.values()].map(({ proc, stdout, stderr, ...rest }) => ({
    ...rest,
    stdout: stdout?.toString?.() ?? stdout ?? "",
    stderr: stderr?.toString?.() ?? stderr ?? "",
  }));
  try { writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2)); } catch { /* best effort */ }
}

export function persistSessions() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(persistSessionsNow, 5000);
}

// Safety net: flush on unexpected exit (writeFileSync works in 'exit' handlers)
process.on("exit", () => { if (debounceTimer) persistSessionsNow(); });

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
      const result = spawnSync("tasklist", ["/FI", `PID eq ${proc.pid}`, "/NH"], {
        stdio: "pipe", encoding: "utf-8", timeout: 5000,
      });
      // tasklist prints "INFO: No tasks..." when the PID is gone
      return (result.stdout || "").includes(String(proc.pid));
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

  // Mark sessions as disconnected if we know the client dropped
  if (session.clientConnected === false && session.lastClientEventAt) {
    // We saw an explicit disconnect event — mark as stale immediately
    if (session.status === "ready") {
      session.status = "stale";
    }
  }
}

// ---------------------------------------------------------------------------
// Force-kill a session's process tree
// ---------------------------------------------------------------------------
export function killSessionProcess(session) {
  if (!session.proc) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(session.proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
    } else {
      session.proc.kill("SIGTERM");
    }
  } catch { /* best effort */ }
  session.proc = null;
}

// ---------------------------------------------------------------------------
// Remove a session (kill process + delete from map + persist)
// ---------------------------------------------------------------------------
export function removeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  killSessionProcess(session);
  sessions.delete(id);
  persistSessions();
}

// Periodic health sweep — every 30s
export function startHealthSweep() {
  return setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      // TTL: expire sessions older than 3 hours
      const age = now - new Date(session.startedAt).getTime();
      if (age > SESSION_TTL_MS) {
        console.log(`[${id}] TTL expired (${Math.round(age / 3600000)}h old) — removing`);
        removeSession(id);
        continue;
      }

      checkSessionHealth(session);

      // Clean up dead sessions (no live process) after 5 minutes
      if ((session.status === "stopped" || session.status === "error") && !isProcessAlive(session.proc)) {
        const deadFor = session.lastActivityAt
          ? now - new Date(session.lastActivityAt).getTime()
          : age;
        if (deadFor > 60 * 60 * 1000) {
          console.log(`[${id}] Dead session cleanup (stopped ${Math.round(deadFor / 60000)}m ago)`);
          removeSession(id);
        }
      }
    }
  }, 30_000);
}
