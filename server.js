import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { normalize, join, sep } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual, createHmac } from "node:crypto";

import { sessions, persistSessionsNow, loadSessions, checkSessionHealth, startHealthSweep } from "./lib/sessions.js";
import { createHandlers } from "./lib/handlers.js";
import { handleDevServers } from "./lib/dev-servers.js";
import { handleUI } from "./lib/ui.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ENV_PATH = new URL(".env", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const VALID_ENV_KEYS = new Set(["LAUNCHER_TOKEN", "PORT", "ALLOWED_DIRS", "MAX_SESSIONS", "TAILNET_DOMAIN", "STDOUT_BUFFER_KB"]);
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)/);
    if (m && VALID_ENV_KEYS.has(m[1])) process.env[m[1]] = m[2].trim();
  }
}

// Ensure npm global bin is on PATH (Task Scheduler doesn't load shell profile)
const npmGlobalBin = join(homedir(), "AppData", "Roaming", "npm");
if (!process.env.PATH.includes(npmGlobalBin)) {
  process.env.PATH = npmGlobalBin + ";" + process.env.PATH;
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
const TAILNET_DOMAIN = process.env.TAILNET_DOMAIN || "";

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
loadSessions();
startHealthSweep();

function isAllowedDir(dir) {
  // Use platform-native separator so this works on both Windows and Unix
  const norm = normalize(dir).replace(/[\\/]$/, "") + sep;
  return ALLOWED_DIRS.some((prefix) => {
    const p = normalize(prefix).replace(/[\\/]$/, "") + sep;
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

// ---------------------------------------------------------------------------
// Auth with brute-force rate limiting
// ---------------------------------------------------------------------------
const AUTH_WINDOW_MS = 60_000; // 1 minute window
const AUTH_MAX_FAILURES = 10;  // max failures per IP per window
const authFailures = new Map(); // ip -> { count, resetAt }

// Periodically purge expired rate-limit entries to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of authFailures) {
    if (now >= record.resetAt) authFailures.delete(ip);
  }
}, AUTH_WINDOW_MS);

function auth(req) {
  const h = req.headers.authorization || "";
  const expected = `Bearer ${TOKEN}`;

  // Rate-limit check
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const record = authFailures.get(ip);
  if (record && record.count >= AUTH_MAX_FAILURES && now < record.resetAt) {
    return false; // rate-limited, reject without even checking
  }

  // Compare using HMAC to avoid leaking token length via the length check
  // (timingSafeEqual requires equal-length buffers, so we hash both to fixed-length)
  let ok = false;
  try {
    const key = "auth-compare";
    const a = createHmac("sha256", key).update(h).digest();
    const b = createHmac("sha256", key).update(expected).digest();
    ok = timingSafeEqual(a, b);
  } catch {}

  if (!ok) {
    if (!record || now >= record.resetAt) {
      authFailures.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    } else {
      record.count++;
    }
  } else {
    // Successful auth — clear failures for this IP
    authFailures.delete(ip);
  }

  return ok;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const { handleStatus, handleList, handlePing, handleDelete, handleRemoteControl, handleProjects } = createHandlers({
  json, MAX_SESSIONS, ALLOWED_DIRS, VALID_PERMISSION_MODES, VALID_SPAWN_MODES, NAME_RE, isAllowedDir,
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  // Security headers on all responses
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // Health check (no auth)
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true });
  }

  // Web UI (no auth — token entered in-page)
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    return handleUI(req, res);
  }

  // Auth check for all other routes
  if (!auth(req)) {
    // Return 429 if rate-limited, 401 otherwise
    const ip = req.socket.remoteAddress || "unknown";
    const record = authFailures.get(ip);
    if (record && record.count >= AUTH_MAX_FAILURES && Date.now() < record.resetAt) {
      return json(res, 429, { error: "Too many failed attempts, try again later" });
    }
    return json(res, 401, { error: "Unauthorized" });
  }

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
      return handleDevServers(res, json, PORT, TAILNET_DOMAIN);
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      return handleList(res);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/session/")) {
      return handleDelete(res, url.pathname.split("/")[2]);
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[server] Unhandled error:", err);
    json(res, 500, { error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Listen + Tailscale
// ---------------------------------------------------------------------------
server.listen(PORT, "127.0.0.1", () => {
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

  const ts = spawn("tailscale", ["serve", "--bg", String(PORT)], { shell: false });
  ts.stdout.on("data", (d) => console.log(`[tailscale] ${d.toString().trim()}`));
  ts.stderr.on("data", (d) => console.log(`[tailscale] ${d.toString().trim()}`));
  ts.on("close", (code) => {
    if (code === 0) console.log(`\nTailscale Serve active — exposed on port ${PORT}`);
    else console.warn(`\n[tailscale] serve exited with code ${code} — run "tailscale serve --bg ${PORT}" manually`);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}, cleaning up...`);

  for (const session of sessions.values()) {
    if (session.proc && !session.proc.killed) {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(session.proc.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          session.proc.kill("SIGTERM");
        }
      } catch { /* already dead */ }
      session.status = "stopped";
    }
  }

  persistSessionsNow();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
