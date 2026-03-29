import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
// Session tracking
// ---------------------------------------------------------------------------
const sessions = new Map(); // id -> { process, prompt, cwd, startedAt, status }

function isAllowedDir(dir) {
  const norm = normalize(dir);
  return ALLOWED_DIRS.some((prefix) => norm.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
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
// POST /launch  — spawn a claude session
// Body: { prompt, cwd?, model?, timeout? }
// Returns: { id, status: "running" }
// ---------------------------------------------------------------------------
function handleLaunch(req, res, body) {
  if (sessions.size >= MAX_SESSIONS) {
    return json(res, 429, { error: "Too many concurrent sessions", max: MAX_SESSIONS });
  }

  const { prompt, cwd, model, timeout } = body;
  if (!prompt) return json(res, 400, { error: "prompt is required" });

  const workDir = cwd ? resolve(cwd) : resolve(ALLOWED_DIRS[0]);
  if (!isAllowedDir(workDir)) {
    return json(res, 403, { error: "Working directory not allowed", allowed: ALLOWED_DIRS });
  }

  const id = randomUUID().slice(0, 8);
  const args = [
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--output-format", "json",
  ];
  if (model) args.push("--model", model);

  const timeoutMs = Math.min((timeout || 300) * 1000, 600_000); // default 5min, max 10min

  const proc = spawn("claude", args, {
    cwd: workDir,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const session = {
    id,
    prompt,
    cwd: workDir,
    startedAt: new Date().toISOString(),
    status: "running",
    stdout: "",
    stderr: "",
    exitCode: null,
  };

  proc.stdout.on("data", (d) => { session.stdout += d.toString(); });
  proc.stderr.on("data", (d) => { session.stderr += d.toString(); });

  proc.on("close", (code) => {
    session.status = code === 0 ? "completed" : "failed";
    session.exitCode = code;
  });

  proc.on("error", (err) => {
    session.status = "error";
    session.stderr += err.message;
  });

  // Auto-kill after timeout
  const timer = setTimeout(() => {
    if (session.status === "running") {
      proc.kill("SIGTERM");
      session.status = "timeout";
    }
  }, timeoutMs);
  proc.on("close", () => clearTimeout(timer));

  sessions.set(id, session);
  json(res, 202, { id, status: "running", cwd: workDir });
}

// ---------------------------------------------------------------------------
// GET /status/:id  — poll session result
// ---------------------------------------------------------------------------
function handleStatus(res, id) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: "Session not found" });

  const { proc, ...safe } = s; // don't serialize the process object
  const result = { ...safe };
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
  const list = [...sessions.values()].map(({ id, prompt, permMode, cwd, startedAt, status, exitCode }) => ({
    id, prompt: prompt.slice(0, 80), permMode, cwd, startedAt, status, exitCode,
  }));
  json(res, 200, { sessions: list, count: list.length });
}

// ---------------------------------------------------------------------------
// DELETE /session/:id  — kill or remove a session
// ---------------------------------------------------------------------------
function handleDelete(res, id) {
  const s = sessions.get(id);
  if (!s) return json(res, 404, { error: "Session not found" });
  if (s.proc) s.proc.kill("SIGTERM");
  sessions.delete(id);
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
    shell: true,
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
    proc,
  };

  proc.stdout.on("data", (d) => {
    const chunk = d.toString();
    session.stdout += chunk;

    // Parse the session URL from stdout
    const urlMatch = chunk.match(/https:\/\/claude\.ai\/code\/[^\s\x1b]*/);
    if (urlMatch && !session.url) {
      session.url = urlMatch[0];
      session.status = "ready";
    }

    // Also check for "connected" / "ready" signals
    if (/connected|ready|listening/i.test(chunk) && session.status === "connecting") {
      session.status = "ready";
    }
  });

  proc.stderr.on("data", (d) => { session.stderr += d.toString(); });

  proc.on("close", (code) => {
    session.status = "stopped";
    session.exitCode = code;
  });

  proc.on("error", (err) => {
    session.status = "error";
    session.stderr += err.message;
  });

  sessions.set(id, session);

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
// POST /launch-stream  — spawn and stream stdout as it arrives (SSE)
// ---------------------------------------------------------------------------
function handleLaunchStream(req, res, body) {
  if (sessions.size >= MAX_SESSIONS) {
    return json(res, 429, { error: "Too many concurrent sessions" });
  }

  const { prompt, cwd, model, timeout } = body;
  if (!prompt) return json(res, 400, { error: "prompt is required" });

  const workDir = cwd ? resolve(cwd) : resolve(ALLOWED_DIRS[0]);
  if (!isAllowedDir(workDir)) {
    return json(res, 403, { error: "Working directory not allowed" });
  }

  const args = [
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
  ];
  if (model) args.push("--model", model);

  const timeoutMs = Math.min((timeout || 300) * 1000, 600_000);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const proc = spawn("claude", args, {
    cwd: workDir,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  proc.stdout.on("data", (d) => {
    res.write(`data: ${d.toString().replace(/\n/g, "\ndata: ")}\n\n`);
  });

  proc.stderr.on("data", (d) => {
    res.write(`event: error\ndata: ${d.toString()}\n\n`);
  });

  proc.on("close", (code) => {
    res.write(`event: done\ndata: {"exitCode":${code}}\n\n`);
    res.end();
  });

  const timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeoutMs);
  proc.on("close", () => clearTimeout(timer));

  req.on("close", () => { proc.kill("SIGTERM"); clearTimeout(timer); });
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
  .status { padding: 12px; border-radius: 8px; background: #161b22; border: 1px solid #30363d; word-break: break-all; }
  .status a { color: #58a6ff; }
  .sessions { font-size: 0.85rem; }
  .sessions .entry { padding: 8px 0; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; }
  .sessions .entry button { width: auto; padding: 4px 12px; background: #da3633; font-size: 0.8rem; margin: 0; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; }
  .tag.ready { background: #238636; }
  .tag.connecting { background: #9e6a03; }
  .tag.stopped, .tag.error { background: #da3633; }
  .tag.running { background: #1f6feb; }
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

function headers() { return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }; }

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  return r.json();
}

function renderTokenSetup() {
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
  app.innerHTML = '<h1>Claude Remote Launcher</h1><div class="card"><p>Loading projects...</p></div>';
  const { projects } = await api('GET', '/projects');
  const { sessions } = await api('GET', '/sessions');

  const opts = projects.map(p => '<option value="' + p.path + '">' + p.name + '</option>').join('');
  const active = sessions.filter(s => s.status === 'running' || s.status === 'ready' || s.status === 'connecting');

  let sessHtml = '';
  if (active.length) {
    sessHtml = '<div class="card sessions"><label>Active Sessions</label>' +
      active.map(s => \`<div class="entry">
        <div><b>\${s.cwd ? s.cwd.split('/').pop() : s.prompt}</b> <span class="tag \${s.status}">\${s.status}</span><br><span style="color:#8b949e;font-size:0.75rem">\${s.permMode || '—'}</span></div>
        <button onclick="killSession('\${s.id}')">Kill</button>
      </div>\`).join('') + '</div>';
  }

  app.innerHTML = \`
    <h1>Claude Remote Launcher</h1>
    \${sessHtml}
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
    <div id="result"></div>
    <div style="text-align:center;margin-top:20px;display:flex;gap:12px;justify-content:center">
      <button onclick="renderMain()" style="background:#1f6feb;width:auto;padding:8px 16px">Refresh</button>
      <button onclick="localStorage.removeItem('launcher_token');location.reload()" style="background:#30363d;width:auto;padding:8px 16px">Logout</button>
    </div>\`;
}

async function launch() {
  const btn = document.getElementById('launch-btn');
  const result = document.getElementById('result');
  const cwd = document.getElementById('project').value;
  const permissionMode = document.getElementById('perm-mode').value;
  btn.disabled = true;
  btn.textContent = 'Launching...';
  result.innerHTML = '<div class="status">Starting session...</div>';

  const data = await api('POST', '/remote-control', { cwd, permissionMode });
  if (data.url) {
    result.innerHTML = '<div class="status">Ready! <a href="' + data.url + '">' + data.url + '</a></div>';
    btn.disabled = false;
    btn.textContent = 'Launch Remote Control';
  } else {
    // Poll for URL
    const poll = setInterval(async () => {
      const s = await api('GET', '/status/' + data.id);
      if (s.url) {
        clearInterval(poll);
        result.innerHTML = '<div class="status">Ready! <a href="' + s.url + '">' + s.url + '</a></div>';
        btn.disabled = false;
        btn.textContent = 'Launch Remote Control';
      } else if (s.status === 'error' || s.status === 'stopped') {
        clearInterval(poll);
        result.innerHTML = '<div class="status">Failed: ' + (s.stderr || 'unknown error') + '</div>';
        btn.disabled = false;
        btn.textContent = 'Launch Remote Control';
      }
    }, 1000);
  }
}

async function killSession(id) {
  await api('DELETE', '/session/' + id);
  renderMain();
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
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // Health check (no auth)
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, sessions: sessions.size });
  }

  // Web UI (no auth — token entered in-page)
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    return handleUI(req, res);
  }

  // Auth check for all other routes
  if (!auth(req)) return json(res, 401, { error: "Unauthorized" });

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "POST" && url.pathname === "/launch") {
      return handleLaunch(req, res, await readBody(req));
    }
    if (req.method === "POST" && url.pathname === "/remote-control") {
      return handleRemoteControl(req, res, await readBody(req));
    }
    if (req.method === "POST" && url.pathname === "/launch-stream") {
      return handleLaunchStream(req, res, await readBody(req));
    }
    if (req.method === "GET" && url.pathname.startsWith("/status/")) {
      return handleStatus(res, url.pathname.split("/")[2]);
    }
    if (req.method === "GET" && url.pathname === "/projects") {
      return handleProjects(res);
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
  console.log(`  POST /launch         — fire-and-forget, poll /status/:id`);
  console.log(`  POST /remote-control — start remote-control session, returns URL for phone`);
  console.log(`  POST /launch-stream  — SSE stream of claude output`);
  console.log(`  GET  /status/:id     — get session result`);
  console.log(`  GET  /sessions       — list all sessions`);
  console.log(`  DELETE /session/:id  — kill/remove session`);
  console.log(`  GET  /health         — health check (no auth)`);

  // Auto-expose via Tailscale Serve
  const ts = spawn("tailscale", ["serve", "--bg", String(PORT)], { shell: true });
  ts.stdout.on("data", (d) => console.log(`[tailscale] ${d.toString().trim()}`));
  ts.stderr.on("data", (d) => console.log(`[tailscale] ${d.toString().trim()}`));
  ts.on("close", (code) => {
    if (code === 0) console.log(`\nTailscale Serve active — exposed on port ${PORT}`);
    else console.warn(`\n[tailscale] serve exited with code ${code} — run "tailscale serve --bg ${PORT}" manually`);
  });
});
