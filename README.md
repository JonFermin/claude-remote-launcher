# Claude Remote Launcher

Launch and manage [Claude Code](https://claude.ai/code) sessions remotely from your phone, tablet, or another machine. Pick a project, tap launch, and get a link to a live Claude Code session.

## How it works

A lightweight Node.js server runs on your dev machine and exposes an API + mobile-friendly web UI. It spawns `claude remote-control` sessions and returns the session URL. Tailscale Serve exposes it securely to your devices.

```
Phone/Tablet  -->  Tailscale (WireGuard)  -->  Your PC  -->  Claude CLI
```

## Project Structure

```
server.js              Entry point — config, HTTP routing, route handlers
lib/
  sessions.js          Session lifecycle — tracking, persistence, health checks
  dev-servers.js       Dev server discovery — port probing, server identification
  ui.js                Serves the web UI
  ui.html              Mobile-friendly web UI (HTML/CSS/JS)
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
- Generate a token: `npm run generate-token`
- Set `ALLOWED_DIRS` to your project root (comma-separated for multiple)

### 3. Install Tailscale

Install [Tailscale](https://tailscale.com/download) on both your dev machine and your phone/tablet. Join the same tailnet.

### 4. Run

```bash
node server.js
```

The server starts on port 3777 and automatically runs `tailscale serve` to expose itself to your tailnet. Open the URL it prints (e.g. `https://your-machine.tail12345.ts.net/`) on your phone.

### 5. Use the Web UI

1. Enter your bearer token from `.env`
2. Pick a project from the dropdown
3. Choose a permission mode
4. Tap **Launch Remote Control**
5. Tap the session link to open Claude Code

## Run as a Service

### Windows (Task Scheduler)

Run in an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File install-task-scheduler.ps1
```

Starts at login, restarts up to 3 times on failure.

### macOS (launchd)

```bash
bash install-launchd.sh
```

Starts at login, restarts on crash. Logs to `~/Library/Logs/claude-remote-launcher/`.

## iOS Shortcut

See [SHORTCUT-SETUP.md](SHORTCUT-SETUP.md) for a one-tap shortcut that skips the web UI entirely.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Mobile web UI |
| `GET` | `/health` | Health check (no auth) |
| `GET` | `/projects` | List project directories |
| `POST` | `/remote-control` | Start a remote-control session |
| `GET` | `/status/:id` | Poll session status |
| `GET` | `/sessions` | List all sessions |
| `DELETE` | `/session/:id` | Kill/remove a session |

## Security

### What protects you

**Two layers of defense:**

1. **Tailscale tailnet** — The server is only reachable by devices on your personal Tailscale network. Tailscale uses WireGuard encryption and requires device authentication. No ports are open to the public internet.

2. **Bearer token** — Every API request (except `/health` and the UI page itself) requires a 256-bit random token in the `Authorization` header. The token is stored in `.env` (gitignored) and entered once in the web UI.

Someone would need **both** access to your tailnet **and** your bearer token to do anything.

### What you should know

- **Three layers of security.** An attacker would need access to your Tailscale tailnet, your bearer token, **and** your Claude account login to do anything. The server only spawns `remote-control` sessions — it cannot execute arbitrary prompts headlessly.

- **Don't use Tailscale Funnel.** `tailscale serve` keeps traffic within your tailnet. `tailscale funnel` exposes the server to the public internet — avoid this.

- **`bypassPermissions` mode gives Claude full shell access.** When selected, Claude can run any command without asking. Use `acceptEdits` or `default` mode for repos you care about.

- **Treat your `.env` like a password.** Anyone with the token and tailnet access has full control.

### Recommendations

- Use `/remote-control` over `/launch` when possible
- Use `acceptEdits` or `default` permission mode for repos you care about
- Keep Tailscale access controls tight — don't share your tailnet broadly
- Rotate your token periodically: `npm run generate-token`

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `LAUNCHER_TOKEN` | (required) | Bearer token for API auth |
| `PORT` | `3777` | Server port |
| `ALLOWED_DIRS` | Current directory | Comma-separated allowed working directories |
| `MAX_SESSIONS` | `3` | Max concurrent Claude sessions |

## License

MIT
