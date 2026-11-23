// Site settings. Change the Amazon Partner-ID here; every Amazon link on the site uses it.
window.SITE = {
  amazonTag: "thechoseno09a-21",
  amazonHost: "www.amazon.de",
  // Live deal data, refreshed every 5 minutes by the "Live updater" workflow. The built-in deals.json is the fallback.
  dataUrl: "https://raw.githubusercontent.com/abhaysingh69420/deal-radar/data/deals.json",
  // Shop links (MediaMarkt, Otto, Cyberport, …) go through ONE of these link wrappers when an ID is set.
  // Skimlinks: your Publisher ID shown as "123456X1234567" in the Skimlinks hub (Settings → Site IDs).
  // Sovrn Commerce: your API key from the Sovrn dashboard (Commerce → Settings → Site & API key).
  // Skimlinks is used if both are set. Leave both empty to link to shops directly.
  skimlinksId: "",
  sovrnKey: "34c3ebab61f067098f57b65e4fea5766",
  siteUrl: "https://deals.maskali.dev",
  // Telegram channels for alerts, e.g. "@dealradar_preisfehler". Leave empty to hide a channel.
  // The bot posts there when the TELEGRAM_BOT_TOKEN secret is set in GitHub.
  telegramChannels: {
    preisfehler: "",
    gratis: "",
    hot: "",
    tech: "",
    gaming: ""
  },
  popularSearches: ["AirPods", "PS5", "Switch 2", "OLED TV", "iPhone", "Lego", "Dyson", "Kaffeevollautomat", "SSD", "Monitor"]
};
