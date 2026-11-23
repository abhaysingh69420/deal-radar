// Pulls German deal feeds, extracts price / original price / savings / coupon code / conditions,
// tags each deal with interests, merges with the previous snapshot and writes public/deals.json.
// No dependencies. Node 18+ (global fetch).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkExpired } from "./expiry.mjs";
import { tagDeals } from "./ai.mjs";
import { dedupe } from "./dedupe.mjs";
import { postNew } from "./telegram.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "deals.json");
const KEEP_HOURS = 7 * 24; // searchable index: one week; expired mydealz deals are removed sooner
const MAX_ITEMS = 4000;

const MD = "https://www.mydealz.de/rss/";
const FEEDS = [
  { id: "preisfehler", source: "mydealz", tags: ["preisfehler"], url: MD + "gruppe/preisfehler" },
  { id: "trending", source: "mydealz", tags: ["hot"], url: MD + "trending" },
  { id: "new", source: "mydealz", tags: [], url: MD + "new" },
  { id: "freebies", source: "mydealz", tags: ["gratis"], url: MD + "gruppe/freebies" },
  { id: "elektronik", source: "mydealz", tags: ["tech"], url: MD + "gruppe/elektronik" },
  { id: "apple", source: "mydealz", tags: ["tech"], url: MD + "gruppe/apple" },
  { id: "smartphone", source: "mydealz", tags: ["tech"], url: MD + "gruppe/smartphone" },
  { id: "fernseher", source: "mydealz", tags: ["tech"], url: MD + "gruppe/fernseher" },
  { id: "kopfhoerer", source: "mydealz", tags: ["tech"], url: MD + "gruppe/kopfhoerer" },
  { id: "gaming", source: "mydealz", tags: ["gaming"], url: MD + "gruppe/gaming" },
  { id: "lego", source: "mydealz", tags: ["home"], url: MD + "gruppe/lego" },
  { id: "spielzeug", source: "mydealz", tags: ["home"], url: MD + "gruppe/spielzeug" },
  { id: "home-living", source: "mydealz", tags: ["home"], url: MD + "gruppe/home-living" },
  { id: "lebensmittel", source: "mydealz", tags: ["home"], url: MD + "gruppe/lebensmittel" },
  { id: "garten-baumarkt", source: "mydealz", tags: ["home"], url: MD + "gruppe/garten-baumarkt" },
  { id: "fashion", source: "mydealz", tags: ["home"], url: MD + "gruppe/fashion-accessoires" },
  { id: "mytopdeals", source: "MyTopDeals", tags: [], url: "https://www.mytopdeals.net/feed/" },
  { id: "dealdoktor", source: "DealDoktor", tags: [], url: "https://www.dealdoktor.de/feed/" },
  { id: "mein-deal", source: "mein-deal", tags: [], url: "https://www.mein-deal.com/feed/" },
];

const UA = "Mozilla/5.0 (compatible; DealRadarDE/1.1; personal deal reader)";

// ---------- text helpers ----------
const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };
const attr = (xml, el, a) => { const m = xml.match(new RegExp(`<${el}[^>]*\\s${a}="([^"]*)"`)); return m ? decode(m[1]) : ""; };
const strip = (html) => decode(decode(html)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const NUM = String.raw`(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const toNum = (raw) => {
  if (!raw) return null;
  let s = raw.trim();
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
function parsePrice(s) {
  if (!s) return null;
  if (/\b(gratis|kostenlos|free)\b/i.test(s) && !/\d+[.,]?\d*\s*€/.test(s)) return 0;
  const m = s.match(new RegExp(NUM + String.raw`\s*(?:€|(?:Euro|EUR)\b)|€\s*` + NUM, "i"));
  return m ? toNum(m[1] || m[2]) : null;
}

// Where the "original" price comes from, in order of trust.
const WAS_RULES = [
  { label: "comparison price (Preisvergleich / idealo)", re: new RegExp(String.raw`(?:PVG|Preisvergleich|Vergleichspreis|Vergleich|idealo|geizhals|nächstbeste[rn]? (?:Preis|Anbieter)|nächster Preis)[^€\d]{0,45}?` + NUM + String.raw`\s*(?:€|Euro|EUR)`, "i") },
  { label: "manufacturer list price (UVP)", re: new RegExp(String.raw`UVP[^€\d]{0,25}?` + NUM + String.raw`\s*(?:€|Euro|EUR)`, "i") },
  { label: "regular price at the store", re: new RegExp(String.raw`(?:statt|regulär|normalerweise|sonst|Normalpreis|ursprünglich|zuvor|bisher|Originalpreis)[^€\d]{0,25}?` + NUM + String.raw`\s*(?:€|Euro|EUR)`, "i") },
];

const CONDITIONS = [
  [/\bPrime\b/i, "Amazon Prime needed for free shipping"],
  [/Newsletter/i, "Newsletter sign-up discount"],
  [/\bApp\b|in der App|App-?exklusiv/i, "Price only in the store's app"],
  [/Neukund/i, "New customers only"],
  [/Student|Studierende/i, "Students only"],
  [/Corporate Benefits/i, "Needs Corporate Benefits access"],
  [/Marketplace|Drittanbieter/i, "Sold by a marketplace seller"],
  [/Abholung|Filiale|lokal|in-?store/i, "Store pickup / local only"],
  [/versandkostenfrei|kostenloser Versand|gratis Versand/i, "Free shipping"],
  [/MBW|Mindestbestellwert/i, "Minimum order value applies"],
  [/Spar-?Abo|Sparabo|Subscribe/i, "Price via Subscribe & Save (cancel any time)"],
  [/Payback|Coupon(?!s? ?code)/i, "Extra coupon / Payback points"],
  [/Trade-?in|Eintausch|Inzahlungnahme/i, "Needs a trade-in"],
];

const INTEREST_RE = {
  tech: /iphone|ipad|macbook|airpods|apple watch|samsung|galaxy|pixel|xiaomi|oneplus|laptop|notebook|monitor|\bssd\b|\bhdd\b|\bram\b|grafikkarte|\brtx\b|\bgpu\b|\bcpu\b|ryzen|intel|router|fritz|mesh|\btv\b|fernseher|oled|qled|soundbar|kopfhörer|headphone|earbuds|bose|sony|jbl|anker|ladegerät|powerbank|smartwatch|garmin|kamera|camera|drohne|dji|tablet|kindle|e-?reader|echo|alexa|smart home|tado|ring\b|beamer|projector|usb|tastatur|keyboard|maus\b/i,
  gaming: /ps5|ps4|playstation|xbox|switch 2|nintendo|steam|epic games|\bgog\b|gaming|controller|dualsense|game pass|\bspiel\b|videospiel|\bpc-?spiel|headset|meta quest|\bvr\b|razer|logitech g|steelseries/i,
  home: /küche|kaffee|espresso|airfryer|heißluft|staubsauger|saugroboter|roborock|dyson|waschmaschine|trockner|geschirr|pfanne|topf|bettwäsche|matratze|lebensmittel|getränk|bier|wein|red bull|cola|snack|drogerie|duschgel|zahnpasta|rasierer|parfum|jacke|schuhe|sneaker|hose|jeans|adidas|nike|levi|rucksack|werkzeug|bohrmaschine|akkuschrauber|garten|lego|spielzeug|möbel|lampe|fahrrad|fitness|sport/i,
};
const HIDE_RE = {
  leasing: /leasing/i,
  travel: /\bhotel|\bflug|flüge|\breise|urlaub|kreuzfahrt|ferienhaus|\bbahn ?ticket|lufthansa|ryanair|eurowings|avios|miles ?& ?more/i,
  contracts: /tarif|allnet|handyvertrag|sim-?only|\bdsl\b|glasfaser|mbit|\b\d+ ?gb\b.*(mtl|monat)|vodafone|telekom|o2\b|freenet/i,
};
const PF_RE = /preisfehler|price error|glitch|fehlerpreis/i;
const FREE_RE = /\bgratis\b|kostenlos|\bfreebie|für 0[,.]?0?0?\s*€|\b0,00\s*€/i;
const BF_RE = /black\s*(friday|week)|cyber\s*(monday|week)/i;

// Amazon product id (ASIN) from the deal link or the post body, so the site can build a tagged link.
const ASIN_RE = /amazon\.de\/(?:[^\s"'<>]*?\/)?(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})/i;
function amazonInfo(link, html, merchant) {
  const m = (link || "").match(ASIN_RE) || (html || "").match(ASIN_RE);
  const isAmazon = /amazon/i.test(merchant || "") || /amazon\.de|amzn\./i.test(link || "") || !!m;
  return { asin: m ? m[1].toUpperCase() : null, isAmazon };
}

// Direct link to the shop's product page, taken from the post body. Links that already carry someone
// else's affiliate redirect, social/media links and deal-site links are skipped; tracking params are removed.
const NOT_SHOP = /amazon\.|link\.amazon|keepa|camelcamel|imdb|brickmerge|werzahltmehr|china-gadgets|hardwareluxx|computerbase|mydealz|pepper\.|static\.|idealo|geizhals|mytopdeals|dealdoktor|mein-deal|preisjaeger|youtube|youtu\.be|twitter|(^|\.)x\.com|facebook|instagram|wikipedia|reddit|t\.me|whatsapp|tiktok|imgur|gravatar|wp\.com|google\.|apple\.com\/de\/newsroom|topcashback|shoop|chip\.de|computerbild|netzwelt|pcgameshardware|giga\.de|pc-welt|connect-living|katzeausdemsack|gamerguru|t-online|stern\.de|bild\.de|focus\.de/i;
const AFF_HOST = /awin1|prf\.hn|tradedoubler|webmasterplan|zanox|skimresources|viglink|s\.click\.aliexpress|amzn\.(to|eu)|bit\.ly|tidd\.ly|^go\.|redirect|^clk\.|track|partners?\.|affili|linksynergy|pvn\.|digidip|belboon|adcell|financeads/i;
const TRACK_PARAM = /^(utm_\w+|tag|ref|ref_|affid|aff|aff_id|affiliate|partner|partnerid|awc|clickref|subid|sub_id|wt_mc|wt_cc\d|emid|gclid|fbclid|msclkid|mc_cid|mc_eid|campaign|cmpid|ito|ascsubtag|linkcode|creative|camp|psc|th)$/i;
function cleanShopUrl(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol) || NOT_SHOP.test(url.hostname + url.pathname) || AFF_HOST.test(url.hostname)) return null;
    for (const k of [...url.searchParams.keys()]) if (TRACK_PARAM.test(k)) url.searchParams.delete(k);
    url.hash = "";
    return url.href;
  } catch { return null; }
}
function extractShopUrl(html) {
  for (const m of (html || "").matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/g)) {
    const c = cleanShopUrl(decode(m[1]));
    if (c) return c;
  }
  return null;
}

function extractCode(text) {
  const m = text.match(/(?:Gutscheincode|Rabattcode|Promocode|Promo-Code|Aktionscode|Code)\s*[:=]?\s*[„"»'‚]?([A-Z0-9][A-Z0-9_-]{3,19})\b/);
  if (!m) return null;
  const c = m[1];
  if (!/[A-Z]/.test(c) || /^(GRATIS|PRIME|DEAL|BLACK|FRIDAY|HIER|AMAZON|UPDATE)$/.test(c)) return null;
  return c;
}

function extractWas(text, price) {
  if (price == null || price <= 0) return null;
  for (const r of WAS_RULES) {
    const re = new RegExp(r.re.source, "gi");
    let m;
    while ((m = re.exec(text))) {
      const v = toNum(m[1]);
      if (v && v > price * 1.03 && v < price * 25) return { was: v, basis: r.label };
    }
  }
  return null;
}

function parseItems(xml, feed) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  return items.map((it) => {
    let title = tag(it, "title");
    let temperature = null;
    const tm = title.match(/^\s*(-?\d{1,5})°\s*[-–]\s*/);
    if (tm) { temperature = +tm[1]; title = title.slice(tm[0].length); }
    const link = tag(it, "link") || attr(it, "link", "href");
    const merchant = attr(it, "pepper:merchant", "name");
    const pepperPrice = attr(it, "pepper:merchant", "price");
    const rawDesc = tag(it, "content:encoded") || tag(it, "description");
    let text = strip(rawDesc);
    if (merchant && pepperPrice) text = text.replace(pepperPrice, "").replace(/^\s*-\s*/, "").replace(merchant, "").trim();
    let image = attr(it, "media:content", "url") || attr(it, "media:thumbnail", "url");
    if (!image) { const m = decode(rawDesc).match(/<img[^>]+src="([^"]+)"/); if (m) image = m[1]; }
    const price = parsePrice(pepperPrice) ?? parsePrice(title);
    const full = title + " " + text;
    const pub = new Date(tag(it, "pubDate") || Date.now());
    const cats = [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/g)].map((m) => decode(m[1]));

    const flags = new Set(feed.tags);
    if (PF_RE.test(title) || feed.tags.includes("preisfehler")) flags.add("preisfehler");
    if (price === 0 || FREE_RE.test(title)) flags.add("gratis");
    if (BF_RE.test(full)) flags.add("blackweek");
    for (const [k, re] of Object.entries(INTEREST_RE)) if (re.test(title + " " + cats.join(" "))) flags.add(k);
    for (const [k, re] of Object.entries(HIDE_RE)) if (re.test(title + " " + cats.join(" "))) flags.add(k);

    const was = extractWas(full, price);
    let pctOff = null, wasPrice = null, basis = null;
    if (was) { wasPrice = was.was; basis = was.basis; pctOff = Math.round((1 - price / wasPrice) * 100); }
    else {
      const p = title.match(/(?<!bis zu\s?)-\s?(\d{2})\s?%/i);
      if (p && price > 0 && !/bis zu/i.test(title)) { pctOff = +p[1]; wasPrice = Math.round(price / (1 - pctOff / 100) * 100) / 100; basis = `estimated from the "-${p[1]}%" in the title`; }
    }
    const cashback = (full.match(/(\d{1,2})\s?%\s?(?:Cashback|Shoop)/i) || [])[1];
    const shipping = (full.match(/(?:zzgl\.?|\+)\s*(\d+(?:,\d{1,2})?)\s*€\s*Versand/i) || [])[1];

    return {
      id: (link || title).replace(/[?#].*$/, ""),
      title, link, merchant, price, image,
      wasPrice, pctOff, basis,
      save: wasPrice != null && price != null ? Math.round((wasPrice - price) * 100) / 100 : null,
      code: extractCode(full),
      cashback: cashback ? +cashback : null,
      shipping: shipping ? toNum(shipping) : null,
      conditions: CONDITIONS.filter(([re]) => re.test(full)).map(([, l]) => l).slice(0, 4),
      temperature,
      summary: text.slice(0, 300),
      ...amazonInfo(link, decode(rawDesc), merchant),
      shopUrl: extractShopUrl(decode(rawDesc)),
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
  const url = process.env.PREVIOUS_URL;
  try { if (url) { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (r.ok) return await r.json(); } } catch {}
  try { return JSON.parse(await readFile(OUT, "utf8")); } catch { return { deals: [] }; }
}

// Hand-researched picks (data/picks.json), kept until their expiry date or 10 days after they were found.
const CAT_FLAG = { tech: "tech", apple: "tech", gaming: "gaming", home: "home", fashion: "home", food: "home" };
async function loadPicks() {
  let picks = [];
  try { picks = JSON.parse(await readFile(join(ROOT, "data", "picks.json"), "utf8")); } catch { return []; }
  const today = Date.now();
  return picks.filter((p) => {
    const until = p.expires ? new Date(p.expires + "T23:59:59+01:00").getTime() : new Date(p.seenDate).getTime() + 10 * 864e5;
    return until > today && p.price != null && p.url;
  }).map((p) => {
    const flags = new Set(["picked"]);
    if (CAT_FLAG[p.category]) flags.add(CAT_FLAG[p.category]);
    if (p.isPriceError) flags.add("preisfehler");
    if (p.price === 0) flags.add("gratis");
    flags.add("blackweek");
    const save = p.wasPrice ? Math.round((p.wasPrice - p.price) * 100) / 100 : null;
    return {
      id: "pick:" + p.url, title: p.title,
      link: /link\.amazon|amzn\.(to|eu)|[?&]tag=/i.test(p.url) ? (p.asin ? `https://www.amazon.de/dp/${p.asin}` : (p.sourceUrl || p.url)) : p.url,
      merchant: p.store, price: p.price, image: p.image || "",
      wasPrice: p.wasPrice ?? null, pctOff: p.wasPrice ? Math.round((1 - p.price / p.wasPrice) * 100) : null,
      basis: p.wasBasis ? { UVP: "manufacturer list price (UVP)", "comparison price": "comparison price (Preisvergleich / idealo)", "previous price": "regular price at the store", "lowest-price-30-days": "lowest price of the last 30 days" }[p.wasBasis] || p.wasBasis : null,
      save, code: p.code || null, cashback: null, shipping: null,
      conditions: p.conditions ? [p.conditions] : [], temperature: null,
      summary: [p.note, `Checked ${p.seenDate} (${p.confidence} confidence).`, p.sourceUrl && p.sourceUrl !== p.url ? `Source: ${p.sourceUrl}` : ""].filter(Boolean).join(" "),
      asin: p.asin || null, isAmazon: !!p.asin || /amazon/i.test(p.store || ""), shopUrl: cleanShopUrl(p.url),
      category: p.category, source: "Researched pick", sourceUrl: p.sourceUrl, confidence: p.confidence,
      flags: [...flags], published: new Date(p.seenDate + "T12:00:00+01:00").toISOString(), firstSeen: p.addedAt || new Date(p.seenDate).toISOString(),
    };
  });
}

// small concurrency pool so we don't hammer one site
async function pool(list, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } }));
  return out;
}

export async function run() {
  const prev = await loadPrevious();
  const byId = new Map((prev.deals || []).map((d) => [d.id, d]));
  const expiredIds = new Set(prev.expiredIds || []);
  // Copies of a deal on other sites, merged last round: they inherit the kept deal's first-seen time and
  // Telegram state, so a copy never counts as a "new" deal.
  const dupOf = new Map();
  for (const d of prev.deals || []) for (const id of d.dupIds || []) dupOf.set(id, d);
  const SNAPSHOT_ONLY = !!process.env.SNAPSHOT_ONLY; // deploy job: no expiry checks, AI or Telegram posts
  const status = {};
  const now = new Date().toISOString();
  const cutoff = Date.now() - KEEP_HOURS * 3600e3;

  const results = await pool(FEEDS, 4, async (f) => [f, await getFeed(f)]);
  for (const [feed, res] of results) {
    status[feed.id] = { ok: res.ok, count: res.items.length };
    for (const d of res.items) {
      if (new Date(d.published).getTime() < cutoff || expiredIds.has(d.id)) continue; // old or known-expired
      const old = byId.get(d.id);
      if (old) {
        d.firstSeen = old.firstSeen || now;
        d.flags = [...new Set([...(old.flags || []), ...d.flags])];
        d.temperature = d.temperature ?? old.temperature ?? null;
        for (const k of ["wasPrice", "pctOff", "basis", "save", "code", "asin", "shopUrl", "ai", "checkedAt", "tg", "tgSent"]) if (d[k] == null && old[k] != null) d[k] = old[k];
        if (old.checkedAt && old.temperature != null) d.temperature = old.temperature; // page check is fresher than the feed
        if (old.price != null && d.price != null && d.price < old.price) d.priceDrop = { from: old.price, at: now };
        else if (old.priceDrop) d.priceDrop = old.priceDrop;
      } else if (dupOf.has(d.id)) {
        const p = dupOf.get(d.id);
        d.firstSeen = p.firstSeen || now;
        if (p.tg) d.tg = 1;
      } else d.firstSeen = now;
      byId.set(d.id, d);
    }
  }

  let feedDeals = [...byId.values()]
    .filter((d) => !d.flags.includes("picked") && !d.expired && new Date(d.published).getTime() > cutoff)
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .slice(0, MAX_ITEMS);
  let picks = await loadPicks();
  for (const p of picks) { const old = byId.get(p.id); if (old) for (const k of ["ai", "tg", "tgSent"]) if (old[k] != null) p[k] = old[k]; }

  // One entry per deal: merge the same deal posted on several sites (or as a pick and a post).
  for (const d of [...picks, ...feedDeals]) delete d.dupIds, delete d.alsoOn;
  const dd = dedupe([...picks, ...feedDeals]);
  picks = dd.deals.filter((d) => d.flags.includes("picked"));
  feedDeals = dd.deals.filter((d) => !d.flags.includes("picked"));

  const extra = [];
  const state = { tgInit: !!prev.tgInit };
  if (!SNAPSHOT_ONLY) {
    const ex = await checkExpired(feedDeals, { limit: +process.env.EXPIRY_BATCH || 40 });
    for (const d of feedDeals) if (d.expired) { expiredIds.add(d.id); for (const id of d.dupIds || []) expiredIds.add(id); }
    feedDeals = feedDeals.filter((d) => !d.expired);
    extra.push(`${ex.expired}/${ex.checked} checked expired`);
    const ai = await tagDeals([...picks, ...feedDeals], { maxDeals: +process.env.AI_MAX || 150 });
    if (ai.tagged || ai.failed) extra.push(`AI tagged ${ai.tagged}${ai.failed ? `, ${ai.failed} failed` : ""}`);
  }
  const deals = [...picks, ...feedDeals];
  if (dd.removed) extra.unshift(`${dd.removed} duplicates merged`);
  if (!SNAPSHOT_ONLY) {
    const tg = await postNew(deals, state);
    if (tg.posted || tg.init) extra.push(tg.init ? "Telegram initialised" : `Telegram posted ${tg.posted}`);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updatedAt: now, feeds: status, tgInit: state.tgInit, expiredIds: [...expiredIds].slice(-3000), deals }));
  const okCount = Object.values(status).filter((s) => s.ok).length;
  console.log(`[${now}] ${deals.length} deals · ${okCount}/${FEEDS.length} feeds ok · ${deals.filter((d) => d.flags.includes("preisfehler")).length} Preisfehler · ${deals.filter((d) => d.save != null).length} with savings${extra.length ? " · " + extra.join(" · ") : ""}`);
  return { okCount };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  run().then(({ okCount }) => process.exit(okCount ? 0 : 1));
}
