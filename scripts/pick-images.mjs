// Adds a product image to researched picks that have none, taken from the og:image / twitter:image
// of the deal's source page (or its shop page). Usage: node scripts/pick-images.mjs
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "picks.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const META = [
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i,
];
// Logos and generic site banners are worse than no image.
const BAD = /logo|favicon|thumnb|black[-_]?(?:week|friday)|placeholder|default[-_]?(?:og|share|image)|sprite|blank\.|\.svg(\?|$)/i;

export async function findImage(url) {
  if (!/^https?:\/\//.test(url || "") || /amazon\.|amzn\./i.test(url)) return null;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 400000);
    for (const re of META) {
      const m = html.match(re);
      if (m) {
        const img = new URL(m[1].replace(/&amp;/g, "&"), r.url).href;
        if (/^https:\/\//.test(img) && !BAD.test(img)) return img;
      }
    }
  } catch {}
  return null;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  // Only single-deal pages and the shop's own product page show the actual product.
  // Blog round-ups ("the 30 best Black Friday deals") show a banner, so they are skipped.
  const DEAL_PAGE = /(^|\.)(mydealz\.de\/deals|mein-deal\.com|dealdoktor\.de|mytopdeals\.net)/i;
  const picks = JSON.parse(await readFile(FILE, "utf8"));
  let found = 0, tried = 0;
  for (const p of picks) {
    if (p.image && !process.argv.includes("--redo")) continue;
    tried++;
    const src = p.sourceUrl && DEAL_PAGE.test(p.sourceUrl.replace(/^https?:\/\/(www\.)?/, "")) ? p.sourceUrl : null;
    p.image = (src && await findImage(src)) || (p.url !== p.sourceUrl ? await findImage(p.url) : null) || "";
    await new Promise((r) => setTimeout(r, 250));
  }
  const seen = {};
  for (const p of picks) if (p.image) seen[p.image] = (seen[p.image] || 0) + 1;
  for (const p of picks) if (p.image && seen[p.image] > 1) p.image = ""; // shared = a banner, not the product
  found = picks.filter((p) => p.image).length;
  await writeFile(FILE, JSON.stringify(picks, null, 1));
  console.log(`checked ${tried} picks · ${found} of ${picks.length} now have a product image`);
}
