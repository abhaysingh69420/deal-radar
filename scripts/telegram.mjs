// Posts new deals to Telegram channels. Needs TELEGRAM_BOT_TOKEN (GitHub secret) and channel names in public/config.js.
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const hide = (m) => (TOKEN ? String(m).split(TOKEN).join("***") : String(m));
const DRY = !!process.env.TELEGRAM_DRY_RUN;
const PER_CHANNEL = 8; // max posts per channel per round (Telegram allows ~20/min per channel)

// Which deals go to which channel.
const RULES = {
  preisfehler: (d) => d.flags.includes("preisfehler"),
  gratis: (d) => d.flags.includes("gratis"),
  hot: (d) => (d.temperature ?? 0) >= 300 || (d.ai?.score ?? 0) >= 9,
  tech: (d) => (d.ai ? d.ai.category === "tech" : d.flags.includes("tech")) && ((d.ai?.score ?? 0) >= 7 || (d.temperature ?? 0) >= 150 || (d.pctOff ?? 0) >= 30),
  gaming: (d) => (d.ai ? d.ai.category === "gaming" : d.flags.includes("gaming")) && ((d.ai?.score ?? 0) >= 6 || (d.temperature ?? 0) >= 100 || d.price === 0),
};

async function siteConfig() {
  const src = await readFile(join(ROOT, "public", "config.js"), "utf8");
  const str = (k) => (src.match(new RegExp(`${k}\\s*:\\s*"([^"]*)"`)) || [])[1] || "";
  const channels = {};
  const block = (src.match(/telegramChannels\s*:\s*\{([\s\S]*?)\}/) || [])[1] || "";
  for (const m of block.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) if (m[2]) channels[m[1]] = m[2];
  return { amazonTag: str("amazonTag"), skimlinksId: str("skimlinksId"), sovrnKey: str("sovrnKey"), siteUrl: str("siteUrl") || "https://deals.maskali.dev", channels };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const eur = (n) => n == null ? "" : n === 0 ? "GRATIS" : n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });

function buyLink(d, c) {
  if (d.asin) return { url: `https://www.amazon.de/dp/${d.asin}?tag=${c.amazonTag}`, label: "Amazon*" };
  if (/amazon/i.test(d.merchant || "")) return { url: `https://www.amazon.de/s?k=${encodeURIComponent(d.title.split(/\s(für|ab|nur)\s/)[0].slice(0, 80))}&tag=${c.amazonTag}`, label: "Amazon*" };
  if (d.shopUrl) {
    const u = c.skimlinksId ? `https://go.skimresources.com/?id=${c.skimlinksId}&xs=1&url=${encodeURIComponent(d.shopUrl)}`
      : c.sovrnKey ? `https://redirect.viglink.com?key=${c.sovrnKey}&u=${encodeURIComponent(d.shopUrl)}` : d.shopUrl;
    return { url: u, label: (d.merchant || "Shop") + (c.skimlinksId || c.sovrnKey ? "*" : "") };
  }
  // No known shop link: search the product on Amazon (tagged), never link the deal site.
  return { url: `https://www.amazon.de/s?k=${encodeURIComponent(d.title.split(/\s(für|ab|nur)\s/)[0].slice(0, 80))}&tag=${c.amazonTag}`, label: "Auf Amazon suchen*" };
}

function message(d, c, channel) {
  const head = channel === "preisfehler" ? "⚠️ PREISFEHLER" : channel === "gratis" ? "🎁 GRATIS" : channel === "hot" ? "🔥 HOT" : "";
  const price = d.price != null ? `<b>${eur(d.price)}</b>${d.wasPrice ? ` <s>${eur(d.wasPrice)}</s> (−${d.pctOff}%)` : ""}` : "";
  const buy = buyLink(d, c);
  const lines = [
    head && `<b>${head}</b>`,
    `<b>${esc(d.title)}</b>`,
    [price, esc(d.merchant || "")].filter(Boolean).join(" · "),
    d.ai?.verdict && `🤖 ${esc(d.ai.verdict)}`,
    d.code && `Code: <code>${esc(d.code)}</code>`,
    "",
    [buy && `<a href="${esc(buy.url)}">👉 ${esc(buy.label)}</a>`, `<a href="${c.siteUrl}/?q=${encodeURIComponent((d.ai?.type || d.title).slice(0, 40))}">Mehr Deals</a>`].filter(Boolean).join(" · "),
    buy?.label.endsWith("*") ? "<i>*Affiliate-Link. Als Amazon-Partner verdiene ich an qualifizierten Verkäufen.</i>" : "",
  ];
  return lines.filter((l) => l !== false && l != null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function postNew(deals, state) {
  const c = await siteConfig();
  const active = Object.keys(c.channels).filter((k) => RULES[k]);
  if (!active.length || (!TOKEN && !DRY)) return { posted: 0, skipped: !TOKEN ? "no token" : "no channels" };
  // First run: mark everything as already seen so channels don't get flooded with old deals.
  if (!state.tgInit) { for (const d of deals) d.tg = 1; state.tgInit = true; return { posted: 0, init: true }; }
  let posted = 0;
  for (const ch of active) {
    const fresh = deals.filter((d) => !d.expired && !(d.tgSent || []).includes(ch) && RULES[ch](d) && Date.now() - new Date(d.firstSeen).getTime() < 6 * 36e5 && !d.tg);
    for (const d of fresh.slice(0, PER_CHANNEL)) {
      const text = message(d, c, ch);
      if (DRY) { console.log(`--- [${ch}] ${c.channels[ch]}\n${text}`); }
      else {
        try {
          const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: c.channels[ch], text, parse_mode: "HTML", disable_web_page_preview: false }),
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) { console.error(`  Telegram ${ch} HTTP ${r.status}: ${hide((await r.text()).slice(0, 120))}`); if (r.status === 401) return { posted }; continue; }
        } catch (e) { console.error("  Telegram error:", hide(e.message)); continue; }
        await new Promise((res) => setTimeout(res, 1200));
      }
      d.tgSent = [...(d.tgSent || []), ch];
      posted++;
    }
  }
  return { posted };
}
