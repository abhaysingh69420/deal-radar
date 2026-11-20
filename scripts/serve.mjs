// Local mode: serves public/ on http://localhost:8787 and refreshes deals every 3 minutes.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./fetch.mjs";

const PUB = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = process.env.PORT || 8787;
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUB, path === "/" ? "index.html" : path);
  if (!file.startsWith(PUB)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[file.slice(file.lastIndexOf("."))] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404).end("Not found"); }
}).listen(PORT, () => console.log(`Deal Radar running at http://localhost:${PORT}`));

const tick = () => run().catch((e) => console.error("fetch failed:", e.message));
tick();
setInterval(tick, 3 * 60 * 1000);
