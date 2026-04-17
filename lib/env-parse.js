// Minimal .env parser.
// - Accepts KEY=value lines (KEY is [A-Z_]+).
// - Strips inline `# comment` unless the value is wrapped in single/double quotes.
// - Ignores keys not in `validKeys` (when provided).
export function parseEnv(content, validKeys) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    if (validKeys && !validKeys.has(m[1])) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const idx = val.search(/\s+#/);
      if (idx !== -1) val = val.slice(0, idx).trim();
    }
    out[m[1]] = val;
  }
  return out;
}
