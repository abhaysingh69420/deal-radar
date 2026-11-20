// Pulls German deal feeds, merges with the previous snapshot, writes public/deals.json.
// No dependencies. Node 18+ (global fetch).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "deals.json");
const KEEP_HOURS = 96;
const MAX_ITEMS = 800;

const FEEDS = [
  { id: "md-preisfehler", source: "mydealz", tag: "preisfehler", url: "https://www.mydealz.de/rss/gruppe/preisfehler" },
  { id: "md-hottest", source: "mydealz", tag: "hot", url: "https://www.mydealz.de/rss/hottest" },
  { id: "md-new", source: "mydealz", tag: "new", url: "https://www.mydealz.de/rss/new" },
  { id: "md-elektronik", source: "mydealz", tag: "elektronik", url: "https://www.mydealz.de/rss/gruppe/elektronik" },
  { id: "md-gaming", source: "mydealz", tag: "gaming", url: "https://www.mydealz.de/rss/gruppe/gaming" },
  { id: "md-freebies", source: "mydealz", tag: "gratis", url: "https://www.mydealz.de/rss/gruppe/freebies" },
  { id: "mytopdeals", source: "MyTopDeals", tag: "new", url: "https://www.mytopdeals.net/feed/" },
  { id: "dealdoktor", source: "DealDoktor", tag: "new", url: "https://www.dealdoktor.de/feed/" },
  { id: "mein-deal", source: "mein-deal", tag: "new", url: "https://www.mein-deal.com/feed/" },
];

const UA = "Mozilla/5.0 (compatible; BlackWeekTracker/1.0; personal deal reader)";

const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };
const attr = (xml, el, a) => { const m = xml.match(new RegExp(`<${el}[^>]*\\s${a}="([^"]*)"`)); return m ? decode(m[1]) : ""; };
const strip = (html) => decode(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// "1.299,99€" / "€ 36,37" / "ab 5,82€" -> number
function parsePrice(s) {
  if (!s) return null;
  if (/gratis|kostenlos|free\b/i.test(s)) return 0;
  const m = s.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*€|€\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/);
  const raw = m && (m[1] || m[2]);
  if (!raw) return null;
  const n = parseFloat(raw.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const PF_RE = /preisfehler|price error|glitch|fehlerpreis/i;
const FREE_RE = /\bgratis\b|kostenlos|\bfreebie|für 0[,.]?0?0?\s*€|0,00\s*€/i;
const BF_RE = /black\s*(friday|week)|cyber\s*(monday|week)|singles\s*day/i;

function parseItems(xml, feed) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  return items.map((it) => {
    const title = tag(it, "title");
    const link = tag(it, "link") || attr(it, "link", "href");
    const merchant = attr(it, "pepper:merchant", "name");
    const pepperPrice = attr(it, "pepper:merchant", "price");
    const descRaw = tag(it, "description");
    const desc = strip(descRaw).slice(0, 220);
    let image = attr(it, "media:content", "url") || attr(it, "media:thumbnail", "url");
    if (!image) { const m = decode(tag(it, "content:encoded") || descRaw).match(/<img[^>]+src="([^"]+)"/); if (m) image = m[1]; }
    const price = parsePrice(pepperPrice) ?? parsePrice(title);
    const pub = new Date(tag(it, "pubDate") || Date.now());
    const cats = [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map((m) => decode(m[1])).slice(0, 3);
    const flags = new Set([feed.tag]);
    if (feed.tag === "preisfehler" || PF_RE.test(title)) flags.add("preisfehler");
    if (feed.tag === "gratis" || price === 0 || FREE_RE.test(title)) flags.add("gratis");
    if (BF_RE.test(title + " " + desc)) flags.add("blackweek");
    flags.delete("new");
    return {
      id: (link || title).replace(/[?#].*$/, ""),
      title, link, merchant, price, image, desc,
      category: cats[0] || "",
      source: feed.source,
      flags: [...flags],
      published: isNaN(pub) ? new Date().toISOString() : pub.toISOString(),
    };
  }).filter((d) => d.title && d.link);
}

async function getFeed(feed, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(feed.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(15000), redirect: "follow" });
      const xml = await r.text();
      const items = r.ok ? parseItems(xml, feed) : [];
      if (items.length) return { ok: true, items };
    } catch {}
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  return { ok: false, items: [] };
}

async function loadPrevious() {
  // In CI the previous snapshot is read from the live site so we don't need to commit every run.
  const url = process.env.PREVIOUS_URL;
  try {
    if (url) { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (r.ok) return await r.json(); }
  } catch {}
  try { return JSON.parse(await readFile(OUT, "utf8")); } catch { return { deals: [] }; }
}

export async function run() {
  const prev = await loadPrevious();
  const byId = new Map((prev.deals || []).map((d) => [d.id, d]));
  const status = {};
  const now = new Date().toISOString();

  const results = await Promise.all(FEEDS.map(async (f) => [f, await getFeed(f)]));
  for (const [feed, res] of results) {
    status[feed.id] = { ok: res.ok, count: res.items.length };
    for (const d of res.items) {
      const old = byId.get(d.id);
      if (old) {
        d.firstSeen = old.firstSeen;
        d.flags = [...new Set([...old.flags, ...d.flags])];
        if (old.price != null && d.price != null && d.price < old.price) d.priceDrop = { from: old.price, at: now };
        else if (old.priceDrop) d.priceDrop = old.priceDrop;
      } else d.firstSeen = now;
      byId.set(d.id, { ...old, ...d });
    }
  }

  const cutoff = Date.now() - KEEP_HOURS * 3600e3;
  const deals = [...byId.values()]
    .filter((d) => new Date(d.published).getTime() > cutoff || new Date(d.firstSeen).getTime() > cutoff)
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .slice(0, MAX_ITEMS);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: now, feeds: status, deals }));
  const okCount = Object.values(status).filter((s) => s.ok).length;
  console.log(`[${now}] ${deals.length} deals · ${okCount}/${FEEDS.length} feeds ok · ${deals.filter((d) => d.flags.includes("preisfehler")).length} Preisfehler`);
  return { okCount };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  run().then(({ okCount }) => process.exit(okCount ? 0 : 1));
}
