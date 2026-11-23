// DeepSeek tagging: gives each new deal a product type, brand, search tags, category, a 1–10 deal score
// and a one-line verdict. Runs only when DEEPSEEK_API_KEY is set (GitHub secret). The key never reaches the website.
const KEY = process.env.DEEPSEEK_API_KEY;
const URL_ = process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions";
// Cheapest model (deepseek-flash, Nov 2026 price list). Thinking is on by default and bills extra
// output tokens, so it is turned off: tagging doesn't need it. The fixed system prompt comes first,
// so DeepSeek's automatic context cache bills it at the cache-hit rate after the first call.
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
// USD per 1M tokens (peak rates; off-peak is half): cache hit, cache miss, output.
const PRICE = { hit: 0.006, miss: 0.3, out: 1.2 };
const CATS = ["tech", "gaming", "home", "fashion", "food", "beauty", "kids", "travel", "contract", "finance", "other"];

const SYSTEM = `You rate German shopping deals for a deal website. For each deal return JSON.
Fields per deal: "i" (the given index), "type" (short English product type, e.g. "wireless earbuds"),
"brand" (or ""), "tags" (4-8 lowercase search keywords mixing English and German synonyms and use cases, e.g. ["kopfhörer","earbuds","anc","bluetooth"]),
"category" (one of ${CATS.join(", ")}), "score" (integer 1-10: how good the deal is for a typical buyer, considering discount, price level and product quality; 8+ only for genuinely great deals),
"verdict" (max 90 characters, plain English, concrete, no hype, e.g. "Lowest price for AirPods Pro 3 so far, 28% under the usual price").
Reply as {"items":[...]} only.`;

export const aiEnabled = () => !!KEY;

export async function tagDeals(deals, { maxDeals = 60, batch = 20 } = {}) {
  if (!KEY) return { tagged: 0, skipped: "no key" };
  const todo = deals.filter((d) => !d.ai && !d.expired).slice(0, maxDeals);
  let tagged = 0, failed = 0;
  const use = { hit: 0, miss: 0, out: 0 };
  for (let k = 0; k < todo.length; k += batch) {
    const chunk = todo.slice(k, k + batch);
    const list = chunk.map((d, i) => ({
      i, title: d.title, price: d.price, usualPrice: d.wasPrice ?? null, store: d.merchant || d.store || "",
      heat: d.temperature ?? null, text: (d.summary || "").slice(0, 220),
    }));
    try {
      const r = await fetch(URL_, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL, thinking: { type: "disabled" }, temperature: 0.2, response_format: { type: "json_object" },
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(list) }],
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) { failed += chunk.length; console.error("  DeepSeek HTTP", r.status, (await r.text().catch(() => "")).slice(0, 200).split(KEY).join("***")); if (r.status === 401 || r.status === 402) break; continue; }
      const res = await r.json();
      const u = res.usage || {};
      use.hit += u.prompt_cache_hit_tokens || 0;
      use.miss += u.prompt_cache_miss_tokens ?? (u.prompt_tokens || 0);
      use.out += u.completion_tokens || 0;
      const out = parseItems(res.choices?.[0]?.message?.content);
      for (const it of out) {
        const d = chunk[it.i];
        if (!d) continue;
        d.ai = {
          type: String(it.type || "").slice(0, 40), brand: String(it.brand || "").slice(0, 30),
          tags: (Array.isArray(it.tags) ? it.tags : []).map((t) => String(t).toLowerCase().slice(0, 24)).slice(0, 8),
          category: CATS.includes(it.category) ? it.category : "other",
          score: Math.max(1, Math.min(10, Math.round(+it.score || 5))),
          verdict: String(it.verdict || "").slice(0, 100),
        };
        tagged++;
      }
    } catch (e) { failed += chunk.length; console.error("  DeepSeek error:", KEY ? String(e.message).split(KEY).join("***") : e.message); }
  }
  const usd = (use.hit * PRICE.hit + use.miss * PRICE.miss + use.out * PRICE.out) / 1e6;
  if (tagged || failed) console.log(`  DeepSeek ${MODEL}: ${use.miss + use.hit} in (${use.hit} cached) / ${use.out} out tokens, about $${usd.toFixed(4)} (peak price)`);
  return { tagged, failed, usd };
}

export function parseItems(content) {
  try { const j = JSON.parse(content || "{}"); return Array.isArray(j.items) ? j.items : []; } catch { return []; }
}
