/**
 * Parallel Feishu Bitable doc scraper (one browser per worker, resilient).
 * Usage: SCRAPE_WORKERS=10 node --import tsx/esm scripts/scrape-feishu-bitable-parallel.mts
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import {
  ROOT,
  type Article,
  isDone,
  pathsFor,
  scrapeArticle,
  writeArticle,
} from "./feishu-scrape-lib.mts";

const WORKERS = Math.min(16, Math.max(1, Number(process.env.SCRAPE_WORKERS ?? process.argv[2] ?? 10)));
const force = process.argv.includes("--force") || process.env.SCRAPE_FORCE === "1";
const limit = process.env.SCRAPE_LIMIT ? Number(process.env.SCRAPE_LIMIT) : Infinity;
const chrome = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const articles = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/articles.json"), "utf8")) as Article[];
const progressPath = path.join(ROOT, "catalog/progress.json");
const progress: Record<string, { ok: boolean; file?: string; error?: string; textLength?: number }> = fs.existsSync(
  progressPath,
)
  ? JSON.parse(fs.readFileSync(progressPath, "utf8"))
  : {};

const pendingAll = articles.filter((a) => !isDone(a, progress, force));
const pending = pendingAll.slice(0, Number.isFinite(limit) ? limit : pendingAll.length);
console.log(
  `parallel scrape workers=${WORKERS} pending=${pending.length}/${pendingAll.length} total=${articles.length}`,
);
if (pending.length === 0) {
  console.log("nothing to do");
  process.exit(0);
}

let cursor = 0;
let okCount = 0;
let failCount = 0;
let saveChain = Promise.resolve();

function queueSave() {
  saveChain = saveChain.then(() => {
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
  });
  return saveChain;
}

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--lang=zh-CN",
      "--disable-gpu",
      "--disable-extensions",
      "--mute-audio",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
}

async function worker(workerId: number) {
  let browser = await launchBrowser();
  let page = await browser.newPage();
  page.setDefaultNavigationTimeout(40000);
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  );

  async function revive() {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    browser = await launchBrowser();
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(40000);
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    );
  }

  while (true) {
    const idx = cursor++;
    if (idx >= pending.length) break;
    const article = pending[idx];
    const globalIndex = articles.findIndex((a) => a.id === article.id) + 1;
    const { shotPath } = pathsFor(article);

    let success = false;
    for (let attempt = 1; attempt <= 2 && !success; attempt++) {
      try {
        const extracted = await scrapeArticle(page, article);
        fs.mkdirSync(path.dirname(shotPath), { recursive: true });
        // viewport screenshot is much faster/safer than fullPage on huge help pages
        await page.screenshot({ path: shotPath, type: "png" });
        const { mdRel } = writeArticle(article, extracted);
        progress[article.id] = { ok: true, file: mdRel, textLength: extracted.textLength };
        okCount += 1;
        success = true;
        console.log(
          `[w${workerId}] OK ${globalIndex}/${articles.length} ${article.title} text=${extracted.textLength}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt === 1) {
          console.warn(`[w${workerId}] retry ${article.title}: ${msg}`);
          await revive();
        } else {
          progress[article.id] = { ok: false, error: msg };
          failCount += 1;
          console.error(`[w${workerId}] FAIL ${globalIndex}/${articles.length} ${article.title}: ${msg}`);
        }
      }
    }
    await queueSave();
  }

  try {
    await browser.close();
  } catch {
    /* ignore */
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1)));
await saveChain;
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`done ok=${okCount} fail=${failCount} elapsed=${elapsed}s`);
