import { readFileSync } from "node:fs";

const html = readFileSync(new URL("ui.html", import.meta.url), "utf-8");

export function handleUI(req, res) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}
