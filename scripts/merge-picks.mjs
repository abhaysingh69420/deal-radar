// Merge research JSON files into data/picks.json.
// Usage: node scripts/merge-picks.mjs <dir-with-json-files>
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "picks.json");
const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/merge-picks.mjs <dir>"); process.exit(1); }

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9äöüß]+/g, " ").trim();
const urlKey = (u) => String(u || "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
const CATS = new Set(["tech", "gaming", "home", "apple", "fashion", "food", "other"]);

let existing = [];
try { existing = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const out = new Map(existing.map((p) => [urlKey(p.url), p]));
const titles = new Set(existing.map((p) => norm(p.title)));
const stats = { read: 0, kept: 0, dupes: 0, rejected: [] };
const now = new Date().toISOString();

for (const f of (await readdir(dir)).filter((f) => f.endsWith(".json"))) {
  let items;
  try { items = JSON.parse(await readFile(join(dir, f), "utf8")); } catch (e) { stats.rejected.push(`${f}: invalid JSON`); continue; }
  for (const p of Array.isArray(items) ? items : []) {
    stats.read++;
    const why =
      typeof p.title !== "string" || !p.title.trim() ? "no title" :
      typeof p.price !== "number" || p.price < 0 ? "bad price" :
      !/^https?:\/\//.test(p.url || "") ? "bad url" :
      p.wasPrice != null && (typeof p.wasPrice !== "number" || p.wasPrice <= p.price) ? "wasPrice not above price" :
      p.confidence === "low" ? "low confidence" :
      /corrected|korrigiert|expired|abgelaufen|storniert|cancel/i.test(p.conditions || "") && p.isPriceError ? "price error no longer live" :
      null;
    if (why) { stats.rejected.push(`${f}: ${why} · ${String(p.title).slice(0, 50)}`); continue; }
    const key = urlKey(p.url), t = norm(p.title);
    if (out.has(key) || titles.has(t)) { stats.dupes++; continue; }
    out.set(key, {
      title: p.title.trim(), price: p.price, wasPrice: p.wasPrice ?? null, wasBasis: p.wasBasis ?? null,
      store: p.store || "", url: p.url, sourceUrl: p.sourceUrl || p.url,
      category: CATS.has(p.category) ? p.category : "other", code: p.code || null, conditions: p.conditions || null,
      isPriceError: !!p.isPriceError, seenDate: p.seenDate || now.slice(0, 10), confidence: p.confidence || "medium",
      note: p.note || "", expires: p.expires || null, addedAt: now, from: f.replace(/\.json$/, ""),
    });
    titles.add(t);
    stats.kept++;
  }
}

// Find the Amazon product id (ASIN) for each pick; follow amzn.to / link.amazon short links once.
const ASIN_RE = /amazon\.de\/(?:[^\s"'<>]*?\/)?(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i;
async function resolveAsin(url) {
  let m = url.match(ASIN_RE);
  if (m) return m[1].toUpperCase();
  if (!/amzn\.(to|eu)|link\.amazon|a\.co\//i.test(url)) return null;
  let cur = url;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(cur, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      const loc = r.headers.get("location");
      if (!loc) return null;
      cur = new URL(loc, cur).href;
      m = cur.match(ASIN_RE);
      if (m) return m[1].toUpperCase();
    } catch { return null; }
  }
  return null;
}
let resolved = 0;
for (const p of out.values()) {
  if (p.asin !== undefined) continue;
  p.asin = await resolveAsin(p.url) || await resolveAsin(p.sourceUrl || "");
  if (p.asin) resolved++;
}
console.log(`ASINs found: ${resolved}`);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify([...out.values()], null, 1));
console.log(`read ${stats.read} · added ${stats.kept} · duplicates ${stats.dupes} · rejected ${stats.rejected.length} · total picks ${out.size}`);
if (stats.rejected.length) console.log(stats.rejected.map((r) => "  - " + r).join("\n"));
