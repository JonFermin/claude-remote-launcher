import { execSync } from "node:child_process";
import { request as httpRequest } from "node:http";

// ---------------------------------------------------------------------------
// Dev server discovery
// ---------------------------------------------------------------------------
let cachedTsHostname = null;
let cachedServeMappings = null; // { localPort -> { tsPort, https } }
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

/**
 * Parse `tailscale serve status --json` to build a map of
 * localPort -> { tsPort, https } so we can generate correct URLs.
 */
function getTailscaleServeMappings() {
  try {
    const out = execSync("tailscale serve status --json", { timeout: 5000 }).toString();
    const status = JSON.parse(out);
    const mappings = new Map(); // localPort -> { tsPort, https }

    // status.Web is keyed like "hostname:port" -> { Handlers: { "/": { Proxy: "http://127.0.0.1:LOCALPORT" } } }
    if (status.Web) {
      for (const [hostPort, config] of Object.entries(status.Web)) {
        const tsPort = parseInt(hostPort.split(":").pop(), 10) || 443;
        const isHttps = status.TCP?.[String(tsPort)]?.HTTPS === true;
        if (config.Handlers) {
          for (const handler of Object.values(config.Handlers)) {
            const proxyMatch = handler.Proxy?.match(/:(\d+)/);
            if (proxyMatch) {
              const localPort = parseInt(proxyMatch[1], 10);
              mappings.set(localPort, { tsPort, https: isHttps });
            }
          }
        }
      }
    }
    return mappings;
  } catch {
    return new Map();
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

  const serverHeader = headers["server"] || "";

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
  // Nuxt
  if (lower.includes("nuxt") || lower.includes("__nuxt")) {
    return { port, type: "nuxt", name: "Nuxt" };
  }
  // SvelteKit
  if (lower.includes("svelte") || lower.includes("__sveltekit")) {
    return { port, type: "svelte", name: "SvelteKit" };
  }
  // Remix
  if (lower.includes("remix") || lower.includes("__remix")) {
    return { port, type: "remix", name: "Remix" };
  }
  // Astro
  if (lower.includes("astro") || serverHeader.includes("astro")) {
    return { port, type: "astro", name: "Astro" };
  }
  // Angular
  if (lower.includes("angular") || lower.includes("ng-") || lower.includes("ng version")) {
    return { port, type: "angular", name: "Angular" };
  }
  // Generic React / CRA
  if (lower.includes("react") || lower.includes("create-react-app")) {
    return { port, type: "react", name: "React" };
  }
  // Tauri
  if (lower.includes("tauri")) {
    return { port, type: "tauri", name: "Tauri" };
  }
  // Webpack Dev Server
  if (lower.includes("webpack") || lower.includes("webpack-dev-server")) {
    return { port, type: "webpack", name: "Webpack" };
  }
  // Express / Node
  if (server.includes("Express")) {
    return { port, type: "express", name: "Express" };
  }
  // Koa
  if (server.includes("koa") || serverHeader.includes("koa")) {
    return { port, type: "koa", name: "Koa" };
  }
  // Hono
  if (server.includes("hono") || serverHeader.includes("hono")) {
    return { port, type: "hono", name: "Hono" };
  }
  // FastAPI / Uvicorn
  if (server.includes("uvicorn") || serverHeader.includes("uvicorn") || lower.includes("fastapi")) {
    return { port, type: "fastapi", name: "FastAPI" };
  }
  // Django
  if (serverHeader.includes("WSGIServer") || serverHeader.includes("django") || lower.includes("csrfmiddlewaretoken") || lower.includes("django")) {
    return { port, type: "django", name: "Django" };
  }
  // Flask
  if (serverHeader.includes("Werkzeug") || lower.includes("flask")) {
    return { port, type: "flask", name: "Flask" };
  }
  // Starlette (catch after FastAPI since FastAPI uses Starlette)
  if (lower.includes("starlette")) {
    return { port, type: "starlette", name: "Starlette" };
  }
  // Streamlit
  if (lower.includes("streamlit") || serverHeader.includes("streamlit")) {
    return { port, type: "streamlit", name: "Streamlit" };
  }
  // Gradio
  if (lower.includes("gradio")) {
    return { port, type: "gradio", name: "Gradio" };
  }
  // Jupyter
  if (lower.includes("jupyter") || serverHeader.includes("jupyter")) {
    return { port, type: "jupyter", name: "Jupyter" };
  }
  // Ruby on Rails
  if (serverHeader.includes("Puma") || serverHeader.includes("WEBrick") || lower.includes("rails") || lower.includes("csrf-token")) {
    return { port, type: "rails", name: "Rails" };
  }
  // Go stdlib
  if (serverHeader.startsWith("Go/")) {
    return { port, type: "go", name: "Go" };
  }
  // Godot (editor HTTP server)
  if (lower.includes("godot") || serverHeader.includes("Godot")) {
    return { port, type: "godot", name: "Godot" };
  }
  // PHP built-in server
  if (serverHeader.includes("PHP") || lower.includes("<?php")) {
    return { port, type: "php", name: "PHP" };
  }
  // Fallback — something is listening
  return { port, type: "unknown", name: "Dev Server" };
}

export async function handleDevServers(res, json, PORT, TAILNET_DOMAIN) {
  if (!cachedTsHostname) cachedTsHostname = getTailscaleHostname();
  const tsHost = cachedTsHostname;

  // Refresh serve mappings each call (cheap exec, mappings change when user runs tailscale serve)
  cachedServeMappings = getTailscaleServeMappings();

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
  const servers = probes.map(identifyServer).filter(Boolean).map((s) => {
    const serve = cachedServeMappings.get(s.port);
    let url;
    if (serve && tsHost) {
      // Port is exposed via tailscale serve — use the correct protocol and TS port
      const proto = serve.https ? "https" : "http";
      url = serve.tsPort === 443
        ? `${proto}://${tsHost}`
        : `${proto}://${tsHost}:${serve.tsPort}`;
    } else if (tsHost) {
      // Not explicitly served via `tailscale serve`, but reachable over Tailscale
      // via MagicDNS + direct port access (requires --accept-routes or subnet routing)
      url = `http://${tsHost}:${s.port}`;
    } else {
      url = `http://localhost:${s.port}`;
    }

    // Servers that block unknown hosts by default — flag when not proxied through tailscale serve
    const HOST_CHECK_TYPES = new Set(["vite", "next", "nuxt", "angular", "svelte", "astro", "remix", "webpack"]);
    const needsHostAllow = !serve && tsHost && HOST_CHECK_TYPES.has(s.type);

    return {
      ...s,
      url,
      tailscaleServed: !!serve,
      needsHostAllow,
      expoUrl: s.type === "expo" && tsHost ? `exp://${tsHost}:${s.port}` : null,
    };
  });

  // Cache successful results so transient PowerShell failures don't blank the UI
  if (servers.length > 0) lastDevServers = servers;

  json(res, 200, { servers: servers.length > 0 ? servers : lastDevServers, tailscaleHost: tsHost, tailnetDomain: TAILNET_DOMAIN || null });
}
