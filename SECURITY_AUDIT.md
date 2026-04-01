# Security Audit — Claude Remote Launcher

**Date:** 2026-04-01
**Scope:** Full codebase review (`server.js`, `lib/sessions.js`, `lib/handlers.js`, `lib/dev-servers.js`, `lib/ui.js`, `lib/ui-client.js`, install scripts)

---

## Summary

The application is a webhook server that spawns Claude Code `remote-control` sessions. It listens on HTTP, relies on Tailscale for network-level encryption, and uses a bearer token for API authentication. The codebase is small (~1,200 lines) with zero npm dependencies, which significantly reduces supply-chain risk.

**7 issues fixed in this audit (across 2 rounds). Additional findings documented below for awareness.**

**Methodology:** Initial audit followed by 3 independent agent teams (injection/XSS, auth/DoS, network/config) that cross-validated findings and discovered 3 additional issues.

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

### 5. [MEDIUM] XSS in Dev Server `copyToClipboard` onclick + `javascript:` URLs

**File:** `lib/ui-client.js:506-535`
**Found by:** Agent Team 1 (Injection), corroborated cross-team
**Description:** Dev server URLs were escaped with `escapeAttr()` (HTML-only) and injected into `onclick="copyToClipboard('...')"`, the same HTML-entity-decode XSS pattern as finding #1. Additionally, server-discovered URLs had no protocol allowlist, so a crafted `javascript:` URL in an `<a href>` could execute arbitrary code.

**Fix:** Added `escapeJsStringInAttr()` for the onclick handler. Added protocol allowlist (`http`, `https`, `exp`) that sanitizes URLs before rendering into `href` or onclick attributes.

### 6. [MEDIUM] Server Bound to 0.0.0.0 (All Interfaces)

**File:** `server.js:209`
**Found by:** Agent Team 3 (Network)
**Description:** `server.listen(PORT)` without a host bound to all network interfaces. Since Tailscale Serve proxies from localhost, the server was unnecessarily reachable on LAN/Wi-Fi interfaces without Tailscale's encryption or ACLs.

**Fix:** Changed to `server.listen(PORT, "127.0.0.1")`.

### 7. [LOW] Token Length Oracle in Auth Comparison

**File:** `server.js:118`
**Found by:** Agent Team 2 (Auth)
**Description:** The `h.length === expected.length` guard before `timingSafeEqual` leaked whether the submitted token had the correct length via timing differences. An attacker could binary-search the token length (though this alone is not exploitable).

**Fix:** Replaced with HMAC-based comparison that hashes both values to fixed-length digests before `timingSafeEqual`, eliminating the length check entirely.

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

### 10. [MEDIUM] Active Sessions Can Escape 24h Pruning

**File:** `lib/sessions.js:129`
**Found by:** Agent Team 2 (DoS)
**Description:** The 24h pruning only targets `stopped` or `error` sessions. A session stuck in `ready` or `stale` with a null `proc` (e.g., after server restart + status flip) could persist indefinitely. The health sweep should catch most cases via `checkSessionHealth`, but edge cases exist.

**Recommendation:** Add a maximum absolute age (e.g., 48h) that prunes any session regardless of status.

### 11. [LOW] .env Parser Does Not Strip Quotes

**File:** `server.js:21`
**Found by:** Agent Team 3 (Config)
**Description:** `LAUNCHER_TOKEN="abc123"` would include the quotes in the token value, causing silent auth mismatches. Users familiar with dotenv-style configs may expect quote stripping.

**Recommendation:** Strip matching outer quotes from values.

### 12. [LOW] sessions.json Written with Default Permissions (0644)

**File:** `lib/sessions.js:34`
**Found by:** Agent Team 3 (Config)
**Description:** On shared systems, other users could read session stdout/stderr which may contain sensitive Claude output. `writeFileSync` uses the process umask (typically 0644).

**Recommendation:** Use `writeFileSync(path, data, { mode: 0o600 })`.

### 13. [LOW] Missing HSTS Header

**Found by:** Agent Team 3 (Network)
**Description:** When accessed via Tailscale Serve (HTTPS), no `Strict-Transport-Security` header is set to prevent protocol downgrade.

**Recommendation:** Add `res.setHeader("Strict-Transport-Security", "max-age=31536000")`.

### 14. [INFO] CSP Allows `unsafe-inline` for Scripts and Styles

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
