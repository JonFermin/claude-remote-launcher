import { createServer, request as httpRequest } from "node:http";
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, normalize, basename } from "node:path";

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
// Session tracking + persistence
// ---------------------------------------------------------------------------
const sessions = new Map(); // id -> { process, prompt, cwd, startedAt, status }
const STALE_THRESHOLD_MS = 120_000; // 2 minutes without stdout = stale
const SESSIONS_FILE = new URL("sessions.json", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

function persistSessions() {
  const data = [...sessions.values()].map(({ proc, ...rest }) => rest);
  try { writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2)); } catch { /* best effort */ }
}

function loadSessions() {
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

loadSessions();

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
// Liveness helpers
// ---------------------------------------------------------------------------
function isProcessAlive(proc) {
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

function checkSessionHealth(session) {
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
setInterval(() => {
  for (const session of sessions.values()) {
    checkSessionHealth(session);
  }
}, 30_000);

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
// GET /dev-servers  — detect running dev servers
// ---------------------------------------------------------------------------
function getTailscaleHostname() {
  try {
    const out = execSync("tailscale status --json", { timeout: 5000 }).toString();
    const info = JSON.parse(out);
    // DNSName ends with "." — strip it
    return info.Self.DNSName.replace(/\.$/, "");
  } catch {
    return null;
  }
}

let cachedTsHostname = null;

function probePort(port) {
  return new Promise((resolve) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path: "/", method: "GET", timeout: 800 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d.toString().slice(0, 2000)));
      res.on("end", () => resolve({ port, status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function identifyServer(probe) {
  if (!probe) return null;
  const { port, headers, body } = probe;
  const server = headers["x-powered-by"] || "";
  const lower = (body || "").toLowerCase();

  // Expo (Metro bundler)
  if (lower.includes("expo") || lower.includes("metro") || server.includes("metro")) {
    return { port, type: "expo", name: "Expo (Metro)" };
  }
  // Vite
  if (lower.includes("vite") || lower.includes("/@vite") || server.includes("vite")) {
    return { port, type: "vite", name: "Vite" };
  }
  // Next.js
  if (headers["x-nextjs-page"] || lower.includes("__next") || lower.includes("next.js")) {
    return { port, type: "next", name: "Next.js" };
  }
  // Generic React / CRA
  if (lower.includes("react") || lower.includes("create-react-app")) {
    return { port, type: "react", name: "React" };
  }
  // Tauri / generic dev server
  if (lower.includes("tauri")) {
    return { port, type: "tauri", name: "Tauri" };
  }
  // Express / Node
  if (server.includes("Express")) {
    return { port, type: "express", name: "Express" };
  }
  // FastAPI / Uvicorn
  if (server.includes("uvicorn") || lower.includes("fastapi")) {
    return { port, type: "fastapi", name: "FastAPI" };
  }
  // Fallback — something is listening
  return { port, type: "unknown", name: "Dev Server" };
}

async function handleDevServers(res) {
  if (!cachedTsHostname) cachedTsHostname = getTailscaleHostname();
  const tsHost = cachedTsHostname;

  // Find listening ports via PowerShell
  let ports = [];
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 9999 } | Select-Object -ExpandProperty LocalPort -Unique | Sort-Object"',
      { timeout: 5000 }
    ).toString();
    ports = out.trim().split(/\r?\n/).map(Number).filter((p) => p && p !== PORT);
  } catch { /* fallback: empty */ }

  // Probe each port
  const probes = await Promise.all(ports.map(probePort));
  const servers = probes.map(identifyServer).filter(Boolean).map((s) => ({
    ...s,
    url: tsHost ? `http://${tsHost}:${s.port}` : `http://localhost:${s.port}`,
    expoUrl: s.type === "expo" && tsHost ? `exp://${tsHost}:${s.port}` : null,
  }));

  json(res, 200, { servers, tailscaleHost: tsHost });
}

// ---------------------------------------------------------------------------
// GET /  — mobile-friendly web UI
// ---------------------------------------------------------------------------
function handleUI(req, res) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Claude Remote Launcher</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 20px; min-height: 100vh; }
  h1 { font-size: 1.4rem; margin-bottom: 20px; text-align: center; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  label { display: block; font-size: 0.85rem; color: #8b949e; margin-bottom: 6px; }
  select, input, button { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 1rem; margin-bottom: 12px; }
  button { background: #238636; border: none; font-weight: 600; cursor: pointer; }
  button:active { background: #2ea043; }
  button:disabled { opacity: 0.5; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { display:inline-block; width:14px; height:14px; border:2px solid #30363d; border-top-color:#58a6ff; border-radius:50%; animation:spin .8s linear infinite; vertical-align:middle; margin-right:6px; }
  .sessions { font-size: 0.85rem; }
  .sessions .entry { padding: 8px 0; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; }
  .sessions .entry button { width: auto; padding: 4px 12px; background: #da3633; font-size: 0.8rem; margin: 0; }
  .sessions .entry.inactive { opacity: 0.45; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; }
  .tag.ready { background: #238636; }
  .tag.connecting { background: #9e6a03; }
  .tag.stopped, .tag.error { background: #da3633; }
  .tag.running { background: #1f6feb; }
  .tag.stale { background: #9e6a03; }
  #token-setup { text-align: center; padding: 40px 20px; }
  #token-setup input { max-width: 400px; margin: 0 auto 12px; display: block; }
  #token-setup button { max-width: 400px; margin: 0 auto; display: block; }
</style>
</head>
<body>
<div id="app"></div>
<script>
const app = document.getElementById('app');
let token = localStorage.getItem('launcher_token');
let refreshTimer = null;
let cachedProjects = null;

function headers() { return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }; }

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

// --- Session list rendering (updates without re-rendering the whole page) ---
const ACTIVE_STATUSES = new Set(['ready','connecting','stale']);

function renderSessionList(sessions) {
  const container = document.getElementById('session-list');
  if (!container) { console.warn('[launcher] #session-list not in DOM'); return; }
  if (!sessions || !sessions.length) {
    container.innerHTML = '';
    console.log('[launcher] No sessions to render');
    return;
  }

  console.log('[launcher] Sessions:', sessions.map(s => s.id + '=' + s.status).join(', '));

  // Sort: active first, then stopped/error
  const sorted = [...sessions].sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
    return aActive - bActive;
  });
  const activeCount = sorted.filter(s => ACTIVE_STATUSES.has(s.status)).length;

  container.innerHTML = '<div class="card sessions"><label>Sessions (' + activeCount + ' active / ' + sorted.length + ' total)</label>' +
    sorted.map(s => {
      const ago = s.lastActivityAt ? timeAgo(s.lastActivityAt) : '';
      const aliveIcon = s.alive ? '\\u2022' : '\\u25cb';
      const aliveColor = s.alive ? '#238636' : '#da3633';
      const inactive = !ACTIVE_STATUSES.has(s.status) ? ' inactive' : '';
      const dirName = s.cwd ? s.cwd.replace(/\\\\/g, '/').split('/').pop() : s.prompt;
      const stopped = s.status === 'stopped' || s.status === 'error';
      const buttons = stopped
        ? \`<button onclick="relaunchSession('\${s.cwd}','\${s.permMode || 'bypassPermissions'}')" style="background:#238636">Relaunch</button><button onclick="killSession('\${s.id}')" style="margin-left:6px">Kill</button>\`
        : \`<button onclick="killSession('\${s.id}')">Kill</button>\`;
      const spinnerHtml = s.status === 'connecting' ? '<span class="spinner"></span>' : '';
      return \`<div class="entry\${inactive}">
        <div>\${spinnerHtml}<b>\${dirName}</b> <span class="tag \${s.status}">\${s.status}</span> <span style="color:\${aliveColor};font-size:0.9rem">\${aliveIcon}</span><br><span style="color:#8b949e;font-size:0.75rem">\${s.permMode || '—'}\${ago ? ' · ' + ago : ''} · \${s.id}</span></div>
        <div style="display:flex">\${buttons}</div>
      </div>\`;
    }).join('') + '</div>';
}

async function refreshSessions() {
  try {
    const { sessions } = await api('GET', '/sessions');
    renderSessionList(sessions);
  } catch { /* ignore fetch errors during refresh */ }
}

function renderDevServers(servers) {
  const container = document.getElementById('dev-servers');
  if (!container) return;
  if (!servers || !servers.length) {
    container.innerHTML = '';
    return;
  }

  const TYPE_COLORS = { expo: '#4630EB', vite: '#646CFF', next: '#000', react: '#61DAFB', express: '#333', fastapi: '#009688', tauri: '#FFC131', unknown: '#8b949e' };

  container.innerHTML = '<div class="card sessions"><label>Dev Servers (' + servers.length + ')</label>' +
    servers.map(s => {
      const color = TYPE_COLORS[s.type] || TYPE_COLORS.unknown;
      const expoLink = s.expoUrl ? ' <a href="' + s.expoUrl + '" style="color:#4630EB;font-size:0.8rem">Open in Expo Go</a>' : '';
      return \`<div class="entry">
        <div><span class="tag" style="background:\${color}">\${s.name}</span> <b>:\${s.port}</b>\${expoLink}<br><a href="\${s.url}" style="color:#58a6ff;font-size:0.75rem">\${s.url}</a></div>
      </div>\`;
    }).join('') + '</div>';
}

async function refreshDevServers() {
  try {
    const { servers } = await api('GET', '/dev-servers');
    renderDevServers(servers);
  } catch { /* ignore */ }
}

async function refreshAll() {
  await Promise.all([refreshSessions(), refreshDevServers()]);
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(refreshAll, 5000);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// --- Page rendering ---
function renderTokenSetup() {
  stopAutoRefresh();
  app.innerHTML = \`
    <div id="token-setup">
      <h1>Claude Remote Launcher</h1>
      <label>Enter your launcher token</label>
      <input id="tok" type="password" placeholder="Bearer token">
      <button onclick="saveToken()">Connect</button>
    </div>\`;
}

function saveToken() {
  const t = document.getElementById('tok').value.trim();
  if (!t) return;
  token = t;
  localStorage.setItem('launcher_token', t);
  renderMain();
}

async function renderMain() {
  stopAutoRefresh();
  app.innerHTML = '<h1>Claude Remote Launcher</h1><div class="card"><p>Loading...</p></div>';

  const [projData, sessData] = await Promise.all([
    cachedProjects ? Promise.resolve({ projects: cachedProjects }) : api('GET', '/projects'),
    api('GET', '/sessions'),
  ]);
  cachedProjects = projData.projects;
  const opts = cachedProjects.map(p => '<option value="' + p.path + '">' + p.name + '</option>').join('');

  app.innerHTML = \`
    <h1>Claude Remote Launcher</h1>
    <div id="session-list"></div>
    <div class="card">
      <label>Project</label>
      <select id="project">\${opts}</select>
      <label>Permission Mode</label>
      <select id="perm-mode">
        <option value="bypassPermissions">Bypass Permissions</option>
        <option value="acceptEdits">Accept Edits</option>
        <option value="dontAsk">Don't Ask</option>
        <option value="default">Default (ask each time)</option>
        <option value="plan">Plan Mode</option>
      </select>
      <button id="launch-btn" onclick="launch()">Launch Remote Control</button>
    </div>
    <div id="dev-servers"></div>
    <div style="text-align:center;margin-top:20px;display:flex;gap:12px;justify-content:center">
      <button onclick="refreshAll()" style="background:#1f6feb;width:auto;padding:8px 16px">Refresh</button>
      <button onclick="stopAutoRefresh();localStorage.removeItem('launcher_token');location.reload()" style="background:#30363d;width:auto;padding:8px 16px">Logout</button>
    </div>\`;

  renderSessionList(sessData.sessions);
  refreshDevServers();
  startAutoRefresh();
}

async function launch() {
  const btn = document.getElementById('launch-btn');
  const cwd = document.getElementById('project').value;
  const permissionMode = document.getElementById('perm-mode').value;
  btn.disabled = true;
  btn.textContent = 'Launching…';

  try {
    await api('POST', '/remote-control', { cwd, permissionMode });
    await refreshSessions();
  } catch (e) {
    console.error('[launcher] launch failed', e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Launch Remote Control';
  }
}

async function killSession(id) {
  await api('DELETE', '/session/' + id);
  await refreshSessions();
}

let _relaunchBusy = false;
async function relaunchSession(cwd, permissionMode) {
  if (_relaunchBusy) return;
  _relaunchBusy = true;

  // Disable all relaunch buttons while in flight
  document.querySelectorAll('button').forEach(b => {
    if (b.textContent === 'Relaunch') { b.disabled = true; b.textContent = 'Launching…'; }
  });

  try {
    await api('POST', '/remote-control', { cwd, permissionMode });
    await refreshSessions();
  } catch (e) {
    console.error('[launcher] relaunch failed', e);
  } finally {
    _relaunchBusy = false;
    // Buttons restored on next refreshSessions render
  }
}

if (token) renderMain(); else renderTokenSetup();
</script>
</body>
</html>`);
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
      return handleDevServers(res);
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
