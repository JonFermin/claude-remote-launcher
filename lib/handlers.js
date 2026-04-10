import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { sessions, persistSessions, isProcessAlive, checkSessionHealth, createRingBuffer, removeSession } from "./sessions.js";

// ---------------------------------------------------------------------------
// createHandlers(deps) — returns all route handlers closed over config
// ---------------------------------------------------------------------------
export function createHandlers({ json, MAX_SESSIONS, ALLOWED_DIRS, VALID_PERMISSION_MODES, VALID_SPAWN_MODES, NAME_RE, isAllowedDir }) {

  // GET /status/:id — poll session result
  function handleStatus(res, id) {
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: "Session not found" });

    checkSessionHealth(s);

    const { proc, ...safe } = s;
    const result = { ...safe, alive: isProcessAlive(s.proc) };
    const stdoutStr = s.stdout?.toString?.() ?? s.stdout ?? "";
    if (s.type !== "remote-control" && s.status !== "running" && stdoutStr) {
      try { result.output = JSON.parse(stdoutStr); } catch { /* raw text */ }
    }
    if (s.type === "remote-control") {
      result.stdout = stdoutStr.slice(-2000);
    }
    json(res, 200, result);
  }

  // GET /sessions — list all sessions
  function handleList(res) {
    const list = [...sessions.values()].map((s) => {
      checkSessionHealth(s);
      return {
        id: s.id, prompt: s.prompt.slice(0, 80), permMode: s.permMode,
        cwd: s.cwd.replace(/\\/g, "/"), startedAt: s.startedAt, status: s.status,
        exitCode: s.exitCode, lastActivityAt: s.lastActivityAt,
        alive: isProcessAlive(s.proc),
        clientConnected: s.clientConnected ?? false,
        lastClientEventAt: s.lastClientEventAt ?? null,
      };
    });
    json(res, 200, { sessions: list, count: list.length });
  }

  // GET /ping/:id — lightweight liveness check
  function handlePing(res, id) {
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: "Session not found" });

    checkSessionHealth(s);
    const alive = isProcessAlive(s.proc);
    const elapsed = s.lastActivityAt
      ? Math.round((Date.now() - new Date(s.lastActivityAt).getTime()) / 1000)
      : null;

    json(res, 200, {
      id,
      status: s.status,
      alive,
      lastActivityAt: s.lastActivityAt,
      silentForSeconds: elapsed,
      stale: s.status === "stale",
    });
  }

  // DELETE /session/:id — kill or remove a session
  function handleDelete(res, id) {
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: "Session not found" });
    removeSession(id);
    json(res, 200, { deleted: id });
  }

  // POST /remote-control — spawn a persistent remote-control session
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  function spawnRemoteControl(session, args, workDir) {
    const proc = spawn("claude", args, {
      cwd: workDir,
      shell: process.platform === "win32",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TERM: process.env.TERM,
        SHELL: process.env.SHELL,
        FORCE_COLOR: "0",
      },
    });

    session.proc = proc;
    session.exitCode = null;
    session.status = "connecting";
    session.stdout = createRingBuffer();
    session.stderr = createRingBuffer();
    session.lastActivityAt = new Date().toISOString();

    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      session.stdout.append(chunk);
      session.lastActivityAt = new Date().toISOString();

      if (session.status === "stale") {
        session.status = "ready";
      }

      const urlMatch = chunk.match(/https:\/\/claude\.ai\/code[/?][^\s\x00-\x1f]*/);
      if (urlMatch && !session.url) {
        session.url = urlMatch[0];
        session.status = "ready";
        persistSessions();
      }

      if (/connected|ready|listening/i.test(chunk) && session.status === "connecting") {
        session.status = "ready";
      }

      // Track client connection state from remote-control verbose output
      if (/client connected|browser connected|session connected|new connection/i.test(chunk)) {
        session.clientConnected = true;
        session.lastClientEventAt = new Date().toISOString();
        persistSessions();
      }
      if (/client disconnected|browser disconnected|session disconnected|connection closed|connection lost/i.test(chunk)) {
        session.clientConnected = false;
        session.lastClientEventAt = new Date().toISOString();
        persistSessions();
      }
    });

    proc.stderr.on("data", (d) => {
      session.stderr.append(d.toString());
      session.lastActivityAt = new Date().toISOString();
    });

    proc.on("close", (code) => {
      session.exitCode = code;
      const stderrText = session.stderr.toString();
      const isTimeout = code !== 0 && /timeout/i.test(stderrText);

      if (isTimeout && session._retries < MAX_RETRIES) {
        session._retries++;
        session.status = "retrying";
        console.log(`[${session.id}] CLI timeout, retry ${session._retries}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms`);
        persistSessions();
        setTimeout(() => spawnRemoteControl(session, args, workDir), RETRY_DELAY_MS);
        return;
      }

      setTimeout(() => {
        if (!isProcessAlive(proc)) {
          session.status = "stopped";
          session.proc = null;
          persistSessions();
        }
      }, 2000);
    });

    proc.on("error", (err) => {
      session.status = "error";
      session.stderr.append(err.message);
      persistSessions();
    });
  }

  function handleRemoteControl(req, res, body) {
    if (sessions.size >= MAX_SESSIONS) {
      return json(res, 429, { error: "Too many concurrent sessions", max: MAX_SESSIONS });
    }

    const { name, cwd, permissionMode, spawn: spawnMode } = body;

    if (name && !NAME_RE.test(name)) {
      return json(res, 400, { error: "Invalid name — alphanumeric, spaces, hyphens, underscores only (max 64 chars)" });
    }
    if (permissionMode && !VALID_PERMISSION_MODES.has(permissionMode)) {
      return json(res, 400, { error: "Invalid permissionMode", valid: [...VALID_PERMISSION_MODES] });
    }
    if (spawnMode && !VALID_SPAWN_MODES.has(spawnMode)) {
      return json(res, 400, { error: "Invalid spawn mode", valid: [...VALID_SPAWN_MODES] });
    }

    // Resolve symlinks to prevent directory-escape via symlinked paths
    let workDir = cwd ? resolve(cwd) : resolve(ALLOWED_DIRS[0]);
    try { workDir = realpathSync(workDir); } catch { /* dir may not exist yet */ }
    if (!isAllowedDir(workDir)) {
      return json(res, 403, { error: "Working directory not allowed", allowed: ALLOWED_DIRS });
    }

    const id = randomUUID();
    const args = ["remote-control"];
    if (name) args.push("--name", name);
    args.push("--permission-mode", permissionMode || "bypassPermissions");
    if (spawnMode) args.push("--spawn", spawnMode);
    args.push("--verbose");

    const session = {
      id,
      type: "remote-control",
      prompt: name || "remote-control",
      permMode: permissionMode || "bypassPermissions",
      cwd: workDir,
      startedAt: new Date().toISOString(),
      status: "connecting",
      stdout: createRingBuffer(),
      stderr: createRingBuffer(),
      exitCode: null,
      url: null,
      lastActivityAt: new Date().toISOString(),
      clientConnected: false,
      lastClientEventAt: null,
      proc: null,
      _retries: 0,
    };

    sessions.set(id, session);
    spawnRemoteControl(session, args, workDir);
    persistSessions();

    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const done = session.url || session.status === "error" || session.status === "stopped";
      const timedOut = attempts > 30;
      if (done || timedOut) {
        clearInterval(poll);
        json(res, 202, {
          id,
          status: session.status,
          url: session.url,
          cwd: workDir,
          retries: session._retries,
          hint: session.url ? "Open this URL on your phone" : "Poll /status/" + id + " for the URL",
        });
      }
    }, 500);
  }

  // GET /projects — list project directories for the picker
  function handleProjects(res) {
    const projects = [];
    for (const dir of ALLOWED_DIRS) {
      try {
        for (const entry of readdirSync(dir)) {
          const full = resolve(dir, entry);
          try {
            const stat = lstatSync(full);
            if (stat.isDirectory() && !stat.isSymbolicLink() && !entry.startsWith(".")) {
              projects.push({ name: entry, path: full.replace(/\\/g, "/") });
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip missing dirs */ }
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of ALLOWED_DIRS) {
      projects.unshift({ name: "DEVELOP (Root)", path: dir.replace(/\\/g, "/") });
    }
    json(res, 200, { projects });
  }

  return { handleStatus, handleList, handlePing, handleDelete, handleRemoteControl, handleProjects };
}
