import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, normalize } from "node:path";

import { sessions, persistSessions, loadSessions, isProcessAlive, checkSessionHealth, startHealthSweep } from "./lib/sessions.js";
import { handleDevServers } from "./lib/dev-servers.js";
import { handleUI } from "./lib/ui.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ENV_PATH = new URL(".env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const TOKEN = process.env.LAUNCHER_TOKEN;
if (!TOKEN) {
  console.error("LAUNCHER_TOKEN not set. Copy .env.example to .env and set a token.");
  console.error('Generate one with: node -e "import(\'crypto\').then(c=>console.log(c.randomBytes(32).toString(\'hex\')))"');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3777", 10);
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "3", 10);
const ALLOWED_DIRS = (process.env.ALLOWED_DIRS || process.cwd())
  .split(",")
  .map((d) => normalize(d.trim()));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
loadSessions();
startHealthSweep();

function isAllowedDir(dir) {
  const norm = normalize(dir).replace(/[\\/]$/, "") + "\\";
  return ALLOWED_DIRS.some((prefix) => {
    const p = prefix.replace(/[\\/]$/, "") + "\\";
    return norm === p || norm.startsWith(p);
  });
}

const VALID_PERMISSION_MODES = new Set(["bypassPermissions", "acceptEdits", "dontAsk", "default", "plan"]);
const VALID_SPAWN_MODES = new Set(["same-dir", "worktree", "session"]);
const NAME_RE = /^[a-zA-Z0-9 _\-]{1,64}$/;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 1024 * 1024; // 1MB
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return reject(new Error("Request body too large")); }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function auth(req) {
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
}

// ---------------------------------------------------------------------------
// GET /status/:id  — poll session result
// ---------------------------------------------------------------------------
function handleStatus(res, id) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: "Session not found" });

  checkSessionHealth(s); // refresh status before responding

  const { proc, ...safe } = s; // don't serialize the process object
  const result = { ...safe, alive: isProcessAlive(s.proc) };
  // Try to parse JSON output from claude
  if (s.type !== "remote-control" && s.status !== "running" && s.stdout) {
    try { result.output = JSON.parse(s.stdout); } catch { /* raw text */ }
  }
  // For remote-control, limit stdout noise
  if (s.type === "remote-control") {
    result.stdout = s.stdout.slice(-2000); // last 2k chars only
  }
  json(res, 200, result);
}

// ---------------------------------------------------------------------------
// GET /sessions  — list all sessions
// ---------------------------------------------------------------------------
function handleList(res) {
  const list = [...sessions.values()].map((s) => {
    checkSessionHealth(s);
    return {
      id: s.id, prompt: s.prompt.slice(0, 80), permMode: s.permMode,
      cwd: s.cwd.replace(/\\/g, "/"), startedAt: s.startedAt, status: s.status,
      exitCode: s.exitCode, lastActivityAt: s.lastActivityAt,
      alive: isProcessAlive(s.proc),
    };
  });
  json(res, 200, { sessions: list, count: list.length });
}

// ---------------------------------------------------------------------------
// GET /ping/:id  — lightweight liveness check for a session
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// DELETE /session/:id  — kill or remove a session
// ---------------------------------------------------------------------------
function handleDelete(res, id) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: "Session not found" });
  if (s.proc) s.proc.kill("SIGTERM");
  sessions.delete(id);
  persistSessions();
  json(res, 200, { deleted: id });
}

// ---------------------------------------------------------------------------
// POST /remote-control  — spawn a persistent remote-control session
// Body: { name?, cwd?, permissionMode?, spawn? }
// Returns: { id, status, url? } — polls /status/:id for the URL once ready
// ---------------------------------------------------------------------------
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

  const workDir = cwd ? resolve(cwd) : resolve(ALLOWED_DIRS[0]);
  if (!isAllowedDir(workDir)) {
    return json(res, 403, { error: "Working directory not allowed", allowed: ALLOWED_DIRS });
  }

  const id = randomUUID().slice(0, 8);
  const args = ["remote-control"];
  if (name) args.push("--name", name);
  args.push("--permission-mode", permissionMode || "bypassPermissions");
  if (spawnMode) args.push("--spawn", spawnMode);
  args.push("--verbose");

  const proc = spawn("claude", args, {
    cwd: workDir,
    shell: false,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const session = {
    id,
    type: "remote-control",
    prompt: name || "remote-control",
    permMode: permissionMode || "bypassPermissions",
    cwd: workDir,
    startedAt: new Date().toISOString(),
    status: "connecting",
    stdout: "",
    stderr: "",
    exitCode: null,
    url: null,
    lastActivityAt: new Date().toISOString(),
    proc,
  };

  proc.stdout.on("data", (d) => {
    const chunk = d.toString();
    session.stdout += chunk;
    session.lastActivityAt = new Date().toISOString();

    // If session was stale but got new output, it's alive again
    if (session.status === "stale") {
      session.status = "ready";
    }

    // Parse the session URL from stdout
    const urlMatch = chunk.match(/https:\/\/claude\.ai\/code\/[^\s\x1b]*/);
    if (urlMatch && !session.url) {
      session.url = urlMatch[0];
      session.status = "ready";
      persistSessions();
    }

    // Also check for "connected" / "ready" signals
    if (/connected|ready|listening/i.test(chunk) && session.status === "connecting") {
      session.status = "ready";
    }
  });

  proc.stderr.on("data", (d) => {
    session.stderr += d.toString();
    session.lastActivityAt = new Date().toISOString();
  });

  proc.on("close", (code) => {
    // On Windows, claude remote-control may close stdio pipes while still running.
    // Only mark stopped if the process is truly dead.
    session.exitCode = code;
    setTimeout(() => {
      if (!isProcessAlive(proc)) {
        session.status = "stopped";
        persistSessions();
      }
    }, 2000);
  });

  proc.on("error", (err) => {
    session.status = "error";
    session.stderr += err.message;
    persistSessions();
  });

  sessions.set(id, session);
  persistSessions();

  // Wait briefly for the URL to appear, then respond
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    if (session.url || session.status === "error" || session.status === "stopped" || attempts > 30) {
      clearInterval(poll);
      json(res, 202, {
        id,
        status: session.status,
        url: session.url,
        cwd: workDir,
        hint: session.url ? "Open this URL on your phone" : "Poll /status/" + id + " for the URL",
      });
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// GET /projects  — list project directories for the picker
// ---------------------------------------------------------------------------
function handleProjects(res) {
  const projects = [];
  for (const dir of ALLOWED_DIRS) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        try {
          if (statSync(full).isDirectory() && !entry.startsWith(".")) {
            projects.push({ name: entry, path: full.replace(/\\/g, "/") });
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip missing dirs */ }
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  // Add root DEVELOP directory as an option
  for (const dir of ALLOWED_DIRS) {
    projects.unshift({ name: "DEVELOP (Root)", path: dir.replace(/\\/g, "/") });
  }
  json(res, 200, { projects });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  // No CORS — UI is same-origin, no cross-origin requests needed
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // Health check (no auth)
  if (req.method === "GET" && req.url === "/health") {
    // Refresh all session statuses before reporting
    for (const s of sessions.values()) checkSessionHealth(s);
    const active = [...sessions.values()].filter(
      (s) => ["running", "ready", "connecting", "stale"].includes(s.status)
    );
    return json(res, 200, {
      ok: true,
      sessions: sessions.size,
      active: active.length,
      activeIds: active.map((s) => ({ id: s.id, status: s.status, cwd: s.cwd })),
    });
  }

  // Web UI (no auth — token entered in-page)
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    return handleUI(req, res);
  }

  // Auth check for all other routes
  if (!auth(req)) return json(res, 401, { error: "Unauthorized" });

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "POST" && url.pathname === "/remote-control") {
      return handleRemoteControl(req, res, await readBody(req));
    }
    if (req.method === "GET" && url.pathname.startsWith("/status/")) {
      return handleStatus(res, url.pathname.split("/")[2]);
    }
    if (req.method === "GET" && url.pathname.startsWith("/ping/")) {
      return handlePing(res, url.pathname.split("/")[2]);
    }
    if (req.method === "GET" && url.pathname === "/projects") {
      return handleProjects(res);
    }
    if (req.method === "GET" && url.pathname === "/dev-servers") {
      return handleDevServers(res, json, PORT);
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      return handleList(res);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/session/")) {
      return handleDelete(res, url.pathname.split("/")[2]);
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Claude Remote Launcher listening on http://localhost:${PORT}`);
  console.log(`Sessions limit: ${MAX_SESSIONS}`);
  console.log(`Allowed dirs: ${ALLOWED_DIRS.join(", ")}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /               — mobile web UI (no auth)`);
  console.log(`  GET  /projects       — list project directories`);
  console.log(`  POST /remote-control — start remote-control session, returns URL for phone`);
  console.log(`  GET  /status/:id     — get session result`);
  console.log(`  GET  /ping/:id       — lightweight liveness check`);
  console.log(`  GET  /dev-servers    — detect running dev servers`);
  console.log(`  GET  /sessions       — list all sessions`);
  console.log(`  DELETE /session/:id  — kill/remove session`);
  console.log(`  GET  /health         — health check (no auth)`);

  // Auto-expose via Tailscale Serve
  const ts = spawn("tailscale", ["serve", "--bg", String(PORT)], { shell: false });
  ts.stdout.on("data", (d) => console.log(`[tailscale] ${d.toString().trim()}`));
  ts.stderr.on("data", (d) => console.log(`[tailscale] ${d.toString().trim()}`));
  ts.on("close", (code) => {
    if (code === 0) console.log(`\nTailscale Serve active — exposed on port ${PORT}`);
    else console.warn(`\n[tailscale] serve exited with code ${code} — run "tailscale serve --bg ${PORT}" manually`);
  });
});
