// Checks mydealz deal pages for "isExpired" and refreshes their temperature.
// A small batch per round (oldest-checked first) keeps the load on mydealz low.
const UA = "Mozilla/5.0 (compatible; DealRadarDE/1.2; personal deal reader)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function checkExpired(deals, { limit = 40, minAgeHours = 3, recheckHours = 2 } = {}) {
  const now = Date.now();
  const due = deals
    .filter((d) => d.source === "mydealz" && !d.expired && /mydealz\.de\/deals\//.test(d.link || ""))
    .filter((d) => now - new Date(d.published).getTime() > minAgeHours * 36e5)
    .filter((d) => !d.checkedAt || now - new Date(d.checkedAt).getTime() > recheckHours * 36e5)
    .sort((a, b) => new Date(a.checkedAt || 0) - new Date(b.checkedAt || 0))
    .slice(0, limit);
  let expired = 0, checked = 0;
  for (const d of due) {
    try {
      const r = await fetch(d.link, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
      if (r.status === 404 || r.status === 410) { d.expired = true; expired++; }
      else if (r.ok) {
        const html = await r.text();
        const m = html.match(/"isExpired":(true|false)/);
        if (m) {
          checked++;
          if (m[1] === "true") { d.expired = true; expired++; }
          const t = html.match(/"temperature":(-?\d+(?:\.\d+)?)/);
          if (t) d.temperature = Math.round(+t[1]);
        }
      }
      d.checkedAt = new Date().toISOString();
    } catch {}
    await sleep(350);
  }
  return { checked, expired };
}
