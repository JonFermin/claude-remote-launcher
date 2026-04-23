import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Session TTL — safety rail for orphaned/forgotten sessions.
// Upstream Claude Code remote-control now persists sessions across JWT
// refreshes and idle environment reaps, and polls at 10-min intervals while
// connected — so we default to a long TTL and rely on process-liveness for
// cleanup. Override with SESSION_TTL_HOURS=0 to disable entirely.
// ---------------------------------------------------------------------------
const SESSION_TTL_HOURS = Number.parseFloat(process.env.SESSION_TTL_HOURS ?? "24");
const SESSION_TTL_MS = SESSION_TTL_HOURS > 0 ? SESSION_TTL_HOURS * 60 * 60 * 1000 : Infinity;

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
// Upstream /poll runs every 10 min while connected, so a short no-stdout
// window will false-positive on healthy idle sessions. Default 15 min.
const STALE_THRESHOLD_MIN = Number.parseFloat(process.env.STALE_THRESHOLD_MIN ?? "15");
const STALE_THRESHOLD_MS = STALE_THRESHOLD_MIN * 60_000;
const SESSIONS_FILE = fileURLToPath(new URL("../sessions.json", import.meta.url));

let debounceTimer = null;

export function persistSessionsNow() {
  debounceTimer = null;
  // Strip live handles and volatile buffers — stdout/stderr aren't usable
  // after restart and may contain CLI output we don't want on disk.
  const data = [...sessions.values()].map(({ proc, stdout, stderr, ...rest }) => rest);
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
//
// The raw check on Windows spawns `tasklist`, which is comparatively expensive
// (~20–80ms). `handleList`/`handlePing` hit this once per session, and the UI
// polls every 5s — so we cache results per-pid for a short window.
// ---------------------------------------------------------------------------
const ALIVE_CACHE_MS = 1000;
const aliveCache = new Map(); // pid -> { alive, expiresAt }

function checkAliveRaw(proc) {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${proc.pid}`, "/NH"], {
        stdio: "pipe", encoding: "utf-8", timeout: 5000,
      });
      return (result.stdout || "").includes(String(proc.pid));
    } catch { return false; }
  }
  // proc.kill(0) on POSIX throws ESRCH if the process is gone.
  try { proc.kill(0); return true; } catch { return false; }
}

export function isProcessAlive(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return false;
  const now = Date.now();
  const cached = aliveCache.get(proc.pid);
  if (cached && now < cached.expiresAt) return cached.alive;
  const alive = checkAliveRaw(proc);
  aliveCache.set(proc.pid, { alive, expiresAt: now + ALIVE_CACHE_MS });
  return alive;
}

function invalidateAlive(pid) {
  if (pid != null) aliveCache.delete(pid);
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
  const pid = session.proc.pid;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
    } else {
      session.proc.kill("SIGTERM");
    }
  } catch { /* best effort */ }
  invalidateAlive(pid);
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
      // TTL: expire sessions older than SESSION_TTL_HOURS (default 24h)
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

    // Prune liveness cache entries for pids we no longer track
    const activePids = new Set();
    for (const s of sessions.values()) if (s.proc?.pid != null) activePids.add(s.proc.pid);
    for (const pid of aliveCache.keys()) if (!activePids.has(pid)) aliveCache.delete(pid);
  }, 30_000);
}
