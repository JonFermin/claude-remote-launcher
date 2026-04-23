# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A webhook server that cold-starts Claude Code `remote-control` sessions from your phone/tablet via Tailscale. Node.js (ESM, zero dependencies), runs on Windows, auto-exposes via `tailscale serve`.

## Commands

```bash
node server.js          # Start the server (port 3777 by default)
npm run generate-token  # Generate a new LAUNCHER_TOKEN
```

Service install: `powershell -ExecutionPolicy Bypass -File install-task-scheduler.ps1` (Windows) or `bash install-launchd.sh` (macOS).

## Architecture

**`server.js`** — Entry point. Loads `.env` manually (no dotenv dep), sets up HTTP router, defines all route handlers. Routes:
- `POST /remote-control` — spawns `claude remote-control` subprocess, polls for session URL
- `GET /status/:id`, `/ping/:id`, `/sessions`, `DELETE /session/:id` — session management
- `GET /projects` — lists subdirectories of `ALLOWED_DIRS` for the UI picker
- `GET /dev-servers` — discovers running dev servers on the machine
- `GET /` — serves the web UI (no auth); all API routes require `Bearer` token

**`lib/sessions.js`** — Session lifecycle. In-memory `Map` persisted to `sessions.json`. Handles Windows-specific liveness checking via `tasklist` (since `kill(0)` doesn't work on Windows). Health sweep runs every 30s. Default TTL is 24h and staleness threshold is 15min of no stdout — both tuned around upstream Claude Code's 10-min remote-control poll cadence. Override with `SESSION_TTL_HOURS` (0 to disable) and `STALE_THRESHOLD_MIN`.

**`lib/dev-servers.js`** — Probes ports 3000-9999 via PowerShell `Get-NetTCPConnection`, then HTTP-probes each to identify server type (Expo, Vite, Next.js, etc.). Cross-references with `tailscale serve status` to generate correct remote URLs.

**`lib/ui.js` + `lib/ui.html`** — Single-file mobile web UI. `ui.js` just reads and serves the HTML. All logic is in `ui.html` (inline JS/CSS).

## Key Design Decisions

- **Zero npm dependencies** — everything uses `node:*` built-ins. No express, no dotenv.
- **Windows-first** — liveness checks use `tasklist`, port discovery uses PowerShell, paths handle backslashes. macOS support exists but is secondary.
- **Sessions persist to `sessions.json`** — restored on restart as "stopped" (no live process). This file is gitignored-worthy but currently tracked.
- **Tailscale is assumed** — the server auto-runs `tailscale serve --bg` on startup. Dev server discovery generates Tailscale URLs when possible.
- **Auth model**: `/health` and `/` (UI page) are unauthenticated. Everything else requires `Authorization: Bearer <token>`. The UI stores the token in `localStorage` and attaches it to API calls.

## Configuration

All config is via `.env` (see `.env.example`): `LAUNCHER_TOKEN` (required), `PORT` (3777), `ALLOWED_DIRS` (comma-separated), `MAX_SESSIONS` (3).
