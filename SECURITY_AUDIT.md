# Security Audit — Claude Remote Launcher

**Date:** 2026-04-01
**Scope:** Full codebase review (`server.js`, `lib/sessions.js`, `lib/handlers.js`, `lib/dev-servers.js`, `lib/ui.js`, `lib/ui-client.js`, install scripts)

---

## Summary

The application is a webhook server that spawns Claude Code `remote-control` sessions. It listens on HTTP, relies on Tailscale for network-level encryption, and uses a bearer token for API authentication. The codebase is small (~1,200 lines) with zero npm dependencies, which significantly reduces supply-chain risk.

**4 issues fixed in this audit. 6 additional findings documented below for awareness.**

---

## Fixed Issues

### 1. [HIGH] XSS via HTML Entity Decode in onclick Handlers

**File:** `lib/ui-client.js:406-447`
**Description:** Values like `safeCwd` and `safeId` were escaped with `escapeAttr()` (HTML entity encoding) and then injected into `onclick="fn('...')"` attributes. The HTML parser decodes entities *before* passing the attribute value to the JavaScript engine, so a path containing `'` (e.g., `C:\Users\O'Brien\Projects`) would break out of the JS string literal, enabling XSS.

**Fix:** Added `escapeJsStringInAttr()` that JS-escapes (`\`, `'`, `"`) first, then HTML-encodes. All onclick injections now use this function.

### 2. [HIGH] Unbounded Memory Growth in Rate Limiter

**File:** `server.js:93-96`
**Description:** The `authFailures` Map stored rate-limit records per IP but never cleaned up expired entries. An attacker sending requests from many source IPs (e.g., via a botnet or IPv6 rotation) could grow this Map indefinitely, eventually exhausting server memory (DoS).

**Fix:** Added a periodic `setInterval` that purges expired entries every 60 seconds.

### 3. [MEDIUM] Server Filesystem Paths Leaked in 403 Response

**File:** `lib/handlers.js:101`
**Description:** When a `POST /remote-control` request used a disallowed `cwd`, the 403 response included `allowed: ALLOWED_DIRS`, revealing the full server filesystem paths to the client. This is an information disclosure that aids attackers in reconnaissance.

**Fix:** Removed `allowed` field from the error response.

### 4. [MEDIUM] Stopped Sessions Never Pruned from Memory

**File:** `lib/sessions.js:119-126`
**Description:** Dead sessions (status `stopped` or `error`) remained in the in-memory `Map` and on-disk `sessions.json` forever. Over weeks/months of use, this would cause memory growth and increasingly large persistence files.

**Fix:** The health sweep now auto-prunes dead sessions older than 24 hours.

---

## Remaining Findings (Not Fixed — Require Design Decisions)

### 5. [MEDIUM] Default Permission Mode is `bypassPermissions`

**File:** `lib/handlers.js:107`
**Description:** When no `permissionMode` is specified in the request body, the server defaults to `bypassPermissions`. This gives spawned Claude sessions full unrestricted access to the filesystem within `cwd`. If an attacker obtains the bearer token, they can immediately spawn sessions with maximum privileges.

**Recommendation:** Consider changing the default to `default` or `acceptEdits`, requiring callers to explicitly opt into `bypassPermissions`.

### 6. [MEDIUM] Token Transmitted Over Plaintext HTTP

**File:** `server.js:201`
**Description:** The server listens on plain HTTP. It relies on Tailscale to provide encryption, but:
- Local connections (e.g., from `localhost`) are unencrypted
- If Tailscale Funnel is enabled (option 2 in `setup-tailscale.sh`), traffic *is* HTTPS-terminated by Tailscale, but the local hop is still HTTP
- If the server is accidentally exposed without Tailscale, the bearer token is sent in plaintext

**Recommendation:** Document clearly that direct HTTP access should never be used over untrusted networks. Consider binding to `127.0.0.1` only when Tailscale Serve is active.

### 7. [MEDIUM] `sessions.json` Persists Sensitive Session Output

**File:** `lib/sessions.js:27-35`
**Description:** Session stdout/stderr (which may contain code, secrets, API keys, or other sensitive content from Claude sessions) is persisted to `sessions.json` on disk. This file is world-readable by default and not encrypted.

**Recommendation:** Consider excluding stdout/stderr from persistence, or at minimum ensure the file has restrictive permissions (e.g., `0600`).

### 8. [LOW] TOCTOU Race in Directory Validation

**File:** `lib/handlers.js:98-100`
**Description:** The `cwd` path is resolved via `realpathSync()` and then checked against `ALLOWED_DIRS`. Between this check and the actual `spawn()` call, a symlink at the path could be swapped to point elsewhere. This is a classic time-of-check-time-of-use (TOCTOU) race condition. Exploitation requires local filesystem access, making it low severity for this threat model.

**Recommendation:** Acceptable risk given the Tailscale-only deployment model.

### 9. [LOW] `tailscale serve` Runs Automatically with No Confirmation

**File:** `server.js:216`
**Description:** On startup, the server automatically runs `tailscale serve --bg <PORT>`, exposing the HTTP server to the Tailnet without user confirmation. If the user didn't intend to expose the server, this could be surprising.

**Recommendation:** Consider making auto-serve opt-in via an environment variable.

### 10. [INFO] CSP Allows `unsafe-inline` for Scripts and Styles

**File:** `lib/ui.js:17`
**Description:** The Content-Security-Policy uses `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'`. This is necessary because the UI is a single-file app with inline JS/CSS, but it weakens XSS protections (mitigated by the escaping fixes above).

**Recommendation:** If the UI is ever refactored to separate files, switch to nonce-based CSP.

---

## What's Working Well

- **Timing-safe token comparison** (`timingSafeEqual`) prevents timing attacks on the bearer token
- **Request body size limit** (1MB `MAX_BODY`) prevents memory exhaustion via large payloads
- **`spawn` without `shell: true`** prevents command injection in all subprocess calls
- **Symlink resolution** via `realpathSync` in `handleRemoteControl` and symlink filtering in `handleProjects`
- **Input validation** on `name` (regex), `permissionMode` (allowlist), `spawnMode` (allowlist)
- **Security headers** (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CSP)
- **Zero npm dependencies** eliminates supply-chain attack surface
- **UUID session IDs** prevent enumeration attacks
- **Minimal environment passthrough** to spawned processes (explicit allowlist, not `process.env`)
- **XSS escaping** in UI (`escapeHtml`, DOM-based modal construction)
- **`noopener,noreferrer`** on all external links
