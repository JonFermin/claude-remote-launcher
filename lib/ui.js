import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const htmlTemplate = readFileSync(new URL("ui.html", import.meta.url), "utf-8");
const css = readFileSync(new URL("ui.css", import.meta.url), "utf-8");
const clientJs = readFileSync(new URL("ui-client.js", import.meta.url), "utf-8");

export function handleUI(req, res) {
  // Per-request nonce so we can tighten CSP and drop 'unsafe-inline' in
  // browsers that support nonces (all modern evergreens).
  const nonce = randomBytes(16).toString("base64");
  const page = htmlTemplate
    .replace("<!-- INJECT:CSS -->", `<style nonce="${nonce}">\n${css}\n</style>`)
    .replace("<!-- INJECT:JS -->", `<script nonce="${nonce}">\n${clientJs}\n</script>`);

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // script-src: nonce only (no unsafe-inline) — all event handlers use delegation.
    // style-src keeps 'unsafe-inline' for the many inline style="..." attributes.
    "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`,
  });
  res.end(page);
}
