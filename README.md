# Deal Radar DE

A live board of Black Week deals and **Preisfehler** (price errors) in Germany: https://deals.maskali.dev

- `scripts/fetch.mjs` pulls the RSS feeds of mydealz (Preisfehler, hottest, new, Elektronik, Gaming, Freebies), MyTopDeals, DealDoktor and mein-deal, and writes `public/deals.json`.
- `public/index.html` is the website. It re-reads `deals.json` every 60 seconds and has filters, a keyword watchlist, and browser alerts for new price errors.
- `.github/workflows/update.yml` runs the fetcher every 5 minutes on GitHub Actions and publishes the site to GitHub Pages.

## Run it on your computer

```bash
npm start
```

Open http://localhost:8787. Deals refresh every 3 minutes while it runs.

## Put it online (GitHub Pages, free)

1. Create a **public** repo on GitHub (e.g. `deal-radar`) and push this folder to `main`.
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. **Actions** tab → "Update deals" → **Run workflow** once.
4. Your site is at `https://<your-username>.github.io/deal-radar/` (this repo uses the custom domain deals.maskali.dev, set under Settings → Pages).

Note: GitHub runs scheduled jobs every 5 minutes at best, and runs are often 10–15 minutes apart at busy times. GitHub pauses scheduled jobs after 60 days with no commits.

## Amazon affiliate links

Your Amazon Partner-ID lives in `public/config.js` (`amazonTag`). Every Amazon button on the site uses it:
direct product links when the deal names the product (ASIN), otherwise an Amazon search for the product.
Legal pages: `public/impressum.html` and `public/datenschutz.html`.

## Researched picks

`data/picks.json` holds hand-researched deals. Add more by dropping JSON files into a folder and running:

```bash
node scripts/merge-picks.mjs path/to/folder
```
