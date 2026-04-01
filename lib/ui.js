import { readFileSync } from "node:fs";

const htmlTemplate = readFileSync(new URL("ui.html", import.meta.url), "utf-8");
const css = readFileSync(new URL("ui.css", import.meta.url), "utf-8");
const clientJs = readFileSync(new URL("ui-client.js", import.meta.url), "utf-8");

const html = htmlTemplate
  .replace("<!-- INJECT:CSS -->", "<style>\n" + css + "\n</style>")
  .replace("<!-- INJECT:JS -->", "<script>\n" + clientJs + "\n</script>");

export function handleUI(req, res) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}
