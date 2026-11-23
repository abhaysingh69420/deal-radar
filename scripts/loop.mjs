// Continuous updater for GitHub Actions: refresh deals every INTERVAL_SEC and publish
// public/deals.json to the orphan `data` branch (served via raw.githubusercontent.com).
// Runs for DURATION_MIN minutes, then exits so the workflow can start the next run.
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./fetch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DURATION = (+process.env.DURATION_MIN || 340) * 60e3;
const INTERVAL = (+process.env.INTERVAL_SEC || 300) * 1e3;
const REPO = process.env.GITHUB_REPOSITORY;
const started = Date.now();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const authHeader = (() => { try { return git(ROOT, "config", "--get", "http.https://github.com/.extraheader"); } catch { return ""; } })();

// Never print secrets: strip the auth header and any token from error text.
const redact = (msg) => {
  let out = String(msg || "");
  for (const v of [authHeader, authHeader.split(" ").pop(), process.env.DEEPSEEK_API_KEY, process.env.TELEGRAM_BOT_TOKEN, process.env.GH_TOKEN, process.env.GITHUB_TOKEN])
    if (v && v.length > 8) out = out.split(v).join("***");
  return out.replace(/AUTHORIZATION:[^\s'"]+(\s+[^\s'"]+)?/gi, "AUTHORIZATION: ***");
};

function publish() {
  const dir = mkdtempSync(join(tmpdir(), "deals-"));
  copyFileSync(join(ROOT, "public", "deals.json"), join(dir, "deals.json"));
  git(dir, "init", "-q");
  git(dir, "checkout", "-q", "--orphan", "data");
  git(dir, "config", "user.name", "deal-radar-bot");
  git(dir, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  if (authHeader) git(dir, "config", "http.https://github.com/.extraheader", authHeader);
  git(dir, "add", "deals.json");
  git(dir, "commit", "-q", "-m", `deals ${new Date().toISOString()}`);
  git(dir, "push", "-q", "-f", `https://github.com/${REPO}.git`, "data");
}

let i = 0;
while (Date.now() - started < DURATION) {
  const t0 = Date.now();
  try {
    const { okCount } = await run();
    if (i === 0) delete process.env.PREVIOUS_URL; // later rounds merge with the local file
    if (okCount && REPO) { publish(); console.log("  published to data branch"); }
  } catch (e) { console.error("round failed:", redact(e.message)); }
  i++;
  const wait = INTERVAL - (Date.now() - t0);
  if (Date.now() - started + wait >= DURATION) break;
  await new Promise((r) => setTimeout(r, Math.max(5000, wait)));
}
console.log(`done after ${i} rounds`);
