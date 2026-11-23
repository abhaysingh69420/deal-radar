// Finds the same deal posted on several sites (or as both a researched pick and a feed post) and keeps one.
// Two deals are the same when they share an Amazon ASIN or shop URL at about the same price, or when their
// titles name the same product at the same price. The kept deal gets the best data from all copies.

const STOP = new Set(("fur fuer für bei mit und oder der die das den dem ein eine einen im in auf zum zur von vom ab nur noch jetzt neu " +
  "the and for with at on of to new only now deal deals angebot preis preisfehler gratis free black week friday cyber monday " +
  "amazon prime ebay otto mediamarkt saturn lidl aldi kaufland versand inkl inklusive gb tb mm cm stk stück pack set").split(" "));
const tokens = (t) => new Set(String(t || "").toLowerCase()
  .replace(/[\d.,]+\s*(?:€|eur|euro)\b/g, " ")      // prices in the title
  .replace(/[^a-z0-9äöüß]+/g, " ").split(" ")
  .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w)));
// Rare words (model names, titles) count more than common ones ("digital", "apple", "switch").
const similar = (a, b, w) => { let both = 0, all = 0; for (const x of a) { all += w(x); if (b.has(x)) both += w(x); } for (const x of b) if (!a.has(x)) all += w(x); return all ? both / all : 0; };
const shop = (d) => String(d.merchant || d.store || "").toLowerCase().replace(/^www\./, "").match(/[a-zäöü0-9]+/)?.[0] || "";
const sameShop = (a, b) => { const x = shop(a), y = shop(b); return !x || !y || x === y; };
const urlKey = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "")).toLowerCase(); } catch { return null; } };
const samePrice = (a, b) => a.price != null && b.price != null && Math.abs(a.price - b.price) <= Math.max(0.5, 0.03 * Math.max(a.price, b.price));

// Higher is the better copy to keep.
const quality = (d) =>
  (d.asin ? 4 : 0) + (d.shopUrl ? 3 : 0) + (d.image ? 3 : 0) + (d.wasPrice ? 1 : 0) + (d.ai ? 1 : 0) +
  (d.source === "mydealz" ? 2 : 0) + Math.min(3, (d.temperature || 0) / 200) + (d.flags?.includes("picked") ? 1 : 0);

function merge(keep, other) {
  for (const k of ["image", "asin", "shopUrl", "code", "wasPrice", "pctOff", "basis", "save", "ai", "cashback", "shipping"])
    if (keep[k] == null || keep[k] === "") if (other[k] != null && other[k] !== "") keep[k] = other[k];
  if (other.temperature != null && (keep.temperature == null || other.temperature > keep.temperature)) keep.temperature = other.temperature;
  keep.flags = [...new Set([...(keep.flags || []), ...(other.flags || [])])];
  if (other.isAmazon) keep.isAmazon = true;
  if (new Date(other.firstSeen) < new Date(keep.firstSeen)) keep.firstSeen = other.firstSeen;
  if (other.tg) keep.tg = 1;
  keep.dupIds = [...new Set([...(keep.dupIds || []), other.id, ...(other.dupIds || [])])];
  keep.alsoOn = [...(keep.alsoOn || []), { source: other.source, link: other.link }, ...(other.alsoOn || [])].slice(0, 6);
}

export function dedupe(deals) {
  const df = new Map();
  for (const d of deals) for (const t of tokens(d.title)) df.set(t, (df.get(t) || 0) + 1);
  const w = (t) => Math.log(1 + deals.length / (df.get(t) || 1));
  const list = deals.map((d) => ({ d, q: quality(d), t: tokens(d.title), u: d.shopUrl ? urlKey(d.shopUrl) : null }))
    .sort((a, b) => b.q - a.q);
  const kept = [], byAsin = new Map(), byUrl = new Map(), byPrice = new Map();
  let removed = 0;
  for (const it of list) {
    const { d } = it;
    const bucket = d.price != null ? Math.round(d.price) : null;
    let match = null;
    if (d.asin) match = (byAsin.get(d.asin) || []).find((k) => samePrice(k.d, d));
    if (!match && it.u) match = (byUrl.get(it.u) || []).find((k) => samePrice(k.d, d));
    if (!match && bucket != null && it.t.size >= 2)
      for (const b of [bucket - 1, bucket, bucket + 1])
        for (const k of byPrice.get(b) || [])
          if (!match && samePrice(k.d, d) && sameShop(k.d, d) && similar(k.t, it.t, w) >= 0.6) match = k;
    if (match) { merge(match.d, d); removed++; continue; }
    kept.push(it);
    if (d.asin) byAsin.set(d.asin, [...(byAsin.get(d.asin) || []), it]);
    if (it.u) byUrl.set(it.u, [...(byUrl.get(it.u) || []), it]);
    if (bucket != null) byPrice.set(bucket, [...(byPrice.get(bucket) || []), it]);
  }
  const keptSet = new Set(kept.map((k) => k.d));
  return { deals: deals.filter((d) => keptSet.has(d)), removed };
}
