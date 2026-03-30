import { execSync } from "node:child_process";
import { request as httpRequest } from "node:http";

// ---------------------------------------------------------------------------
// Dev server discovery
// ---------------------------------------------------------------------------
let cachedTsHostname = null;
let lastDevServers = [];

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

export async function handleDevServers(res, json, PORT) {
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

  // Cache successful results so transient PowerShell failures don't blank the UI
  if (servers.length > 0) lastDevServers = servers;

  json(res, 200, { servers: servers.length > 0 ? servers : lastDevServers, tailscaleHost: tsHost });
}
