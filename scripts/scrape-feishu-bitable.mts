/**
 * Scrape Feishu Bitable help articles into requirement docs.
 * Usage: node --import tsx/esm scripts/scrape-feishu-bitable.mts [startIndex] [limit]
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve("docs/feishu-bitable");
const articles = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/articles.json"), "utf8")) as Array<{
  id: string;
  title: string;
  url: string;
  trail: string[];
  category_id: string;
  path: string;
}>;

const start = Number(process.argv[2] ?? 0);
const limit = Number(process.argv[3] ?? articles.length);
const slice = articles.slice(start, start + limit);
const force = process.argv.includes("--force");

function slugify(title: string, id: string): string {
  const base = title
    .replace(/[\/\\?%*:|"<>]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${base || "article"}-${id}`;
}

function summarize(title: string, trail: string[], paragraphs: string[], headings: string[]): string {
  const body = paragraphs.join("\n");
  const lines: string[] = [];
  lines.push(`## 功能定位`);
  lines.push("");
  lines.push(
    `本页对应飞书帮助中心「${["多维表格", ...trail].join(" / ")}」下的「${title}」。以下需求描述依据官方说明文档提炼，用于指导 DuoWei 对标实现。`,
  );
  lines.push("");
  lines.push(`## 功能目标`);
  lines.push("");
  lines.push(paragraphs[0] || `提供与「${title}」相关的多维表格能力，行为应对齐飞书帮助文档描述。`);
  lines.push("");
  if (headings.length) {
    lines.push(`## 文档结构（官方章节）`);
    lines.push("");
    for (const h of headings.slice(0, 50)) lines.push(`- ${h}`);
    lines.push("");
  }
  lines.push(`## 详细功能说明`);
  lines.push("");
  if (paragraphs.length) {
    for (const p of paragraphs) {
      if (p.trim().length < 4) continue;
      lines.push(p.trim());
      lines.push("");
    }
  } else {
    lines.push(`（正文提取为空，请结合截图与源链接复核。）`);
    lines.push("");
  }
  lines.push(`## 实现要点（对标 DuoWei）`);
  lines.push("");
  lines.push(`1. **入口与信息架构**：在产品中明确该能力所属模块（${trail.join(" / ") || "多维表格"}），并保证用户可从对应导航触达。`);
  lines.push(`2. **核心交互**：按上文「详细功能说明」还原主要操作路径；截图中出现的按钮、字段、面板命名尽量与飞书语义一致或可映射。`);
  lines.push(`3. **数据与权限**：若文档涉及可见范围、可编辑范围、分享或高级权限，实现时需落到角色/成员模型，并保证 API/MCP 与 UI 权限一致。`);
  lines.push(`4. **边界与上限**：若文档提到数量上限、格式限制、导入导出约束，需在实现与错误提示中体现。`);
  lines.push(`5. **验收**：以本页截图场景为用例，完成「能打开 / 能配置 / 能保存 / 能被 Agent 读写（如适用）」四项检查。`);
  lines.push("");
  lines.push(`## 原始摘录摘要`);
  lines.push("");
  lines.push(`> ${body.slice(0, 800).replace(/\n+/g, " ")}${body.length > 800 ? "…" : ""}`);
  lines.push("");
  return lines.join("\n");
}

const chrome =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=zh-CN", "--disable-gpu"],
  defaultViewport: { width: 1440, height: 1100 },
});

const progressPath = path.join(ROOT, "catalog/progress.json");
const progress: Record<string, { ok: boolean; file?: string; error?: string; textLength?: number }> = fs.existsSync(
  progressPath,
)
  ? JSON.parse(fs.readFileSync(progressPath, "utf8"))
  : {};

const page = await browser.newPage();
page.setDefaultNavigationTimeout(90000);
await page.setUserAgent(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
);

let okCount = 0;
for (let i = 0; i < slice.length; i++) {
  const article = slice[i];
  const index = start + i + 1;
  const slug = slugify(article.title, article.id);
  const mdRel = `articles/${slug}.md`;
  const shotRel = `assets/screenshots/${slug}.png`;
  const mdPath = path.join(ROOT, mdRel);
  const shotPath = path.join(ROOT, shotRel);

  const prev = progress[article.id];
  const hasFiles = fs.existsSync(mdPath) && fs.existsSync(shotPath);
  const goodEnough = prev?.ok && hasFiles && (prev.textLength ?? 0) >= 200;
  if (!force && goodEnough) {
    console.log(`SKIP ${index}/${articles.length} ${article.title}`);
    continue;
  }

  try {
    await page.goto(article.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("h1, body", { timeout: 20000 });

    await page.evaluate(`(() => {
      for (const b of Array.from(document.querySelectorAll("button"))) {
        const t = (b.textContent || "").trim();
        if (["我知道了", "关闭", "同意", "接受"].includes(t)) b.click();
      }
    })()`);

    // wait for article content to appear
    const ready = await page
      .waitForFunction(
        `(() => {
          const text = document.body && document.body.innerText ? document.body.innerText : "";
          return text.includes("本文阅读时长") || text.length > 1200 || !!document.querySelector("table");
        })()`,
        { timeout: 25000 },
      )
      .then(() => true)
      .catch(() => false);

    // expand FAQ / collapsed blocks
    await page.evaluate(`(() => {
      for (const d of Array.from(document.querySelectorAll("details"))) {
        d.open = true;
      }
      const clickables = Array.from(document.querySelectorAll('[role="button"], button, summary, [class*="collapse"], [class*="Collapse"], [class*="accordion"]'));
      for (const el of clickables) {
        const t = (el.textContent || "").trim();
        if (t.startsWith("问：") || t.startsWith("Q：") || t.includes("展开")) {
          try { el.click(); } catch (e) {}
        }
      }
    })()`);
    await new Promise((r) => setTimeout(r, ready ? 800 : 1500));

    const extracted = (await page.evaluate(`(() => {
      const titleHint = ${JSON.stringify(article.title)};
      const title = document.querySelector("h1")?.textContent?.trim() || titleHint;
      const candidates = Array.from(document.querySelectorAll('[class*="js-heraAdit-richText-body"], [class*="hc_aditRichtext"], article, main'));
      candidates.sort((a, b) => (b.textContent || "").length - (a.textContent || "").length);
      const main = candidates[0] || document.body;

      const headings = Array.from(main.querySelectorAll("h1,h2,h3,h4,[class*='heading-h']"))
        .map((el) => (el.textContent || "").trim())
        .filter((t) => t && t !== title);

      const blocks = [];
      const noise = new Set(["帮助中心","登录","智能助手","我知道了","去试试","新手入门","使用飞书","更多资源","本文是否对你有帮助"]);
      const push = (t) => {
        const v = String(t || "").replace(/\\u200b/g, "").replace(/\\s+/g, " ").trim();
        if (v.length < 4) return;
        if (blocks[blocks.length - 1] === v) return;
        if (noise.has(v)) return;
        blocks.push(v);
      };

      for (const el of Array.from(main.querySelectorAll("h1,h2,h3,h4,p,li,td,th,summary,[class*='heading'],[role='button']"))) {
        const t = (el.textContent || "").trim();
        if (t.length >= 4 && t.length < 2000) push(t);
      }

      const fullBody = (document.body.textContent || "").replace(/\\u200b/g, "");
      const lines = fullBody.split(/\\n+/).map((l) => l.trim()).filter(Boolean);
      let startIdx = lines.findIndex((l) => l === title || l.includes("本文阅读时长"));
      if (startIdx < 0) startIdx = Math.max(0, lines.findIndex((l) => l.startsWith("问：") || l.startsWith("Q：")));
      if (startIdx < 0) startIdx = 0;
      const endIdx = lines.findIndex((l, idx) => idx > startIdx && (l.includes("本文是否对你有帮助") || l.includes("上一篇") || l.includes("下一篇")));
      const sliceEnd = endIdx > startIdx ? endIdx : startIdx + 400;
      for (const line of lines.slice(startIdx, sliceEnd)) {
        if (line.length < 4) continue;
        if (line.includes("帮助中心智能助手")) continue;
        push(line);
      }

      const full = (main.textContent || "").replace(/\\u200b/g, "");

      for (const row of Array.from(main.querySelectorAll("tr"))) {
        const cells = Array.from(row.querySelectorAll("th,td")).map((c) => (c.textContent || "").replace(/\\u200b/g, "").trim());
        if (cells.filter(Boolean).length >= 2) push(cells.join(" | "));
      }

      const images = Array.from(main.querySelectorAll("img"))
        .map((img) => ({ src: img.currentSrc || img.src, alt: img.alt || "" }))
        .filter((x) => x.src && !x.src.startsWith("data:"))
        .slice(0, 40);

      const seen = new Set();
      const paragraphs = [];
      for (const b of blocks) {
        if (seen.has(b)) continue;
        seen.add(b);
        paragraphs.push(b);
      }

      return {
        title,
        headings: Array.from(new Set(headings)).slice(0, 60),
        paragraphs: paragraphs.slice(0, 250),
        images,
        textLength: fullBody.trim().length,
      };
    })()`)) as {
      title: string;
      headings: string[];
      paragraphs: string[];
      images: Array<{ src: string; alt: string }>;
      textLength: number;
    };

    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true, type: "png" });

    const summary = summarize(article.title, article.trail, extracted.paragraphs, extracted.headings);
    const md = `# ${article.title}

> 来源：[飞书帮助中心](${article.url})  
> 分类：${["多维表格", ...article.trail].join(" / ")}  
> 抓取时间：${new Date().toISOString()}

## 界面截图

![${article.title}](../${shotRel})

${extracted.images.length ? `### 文档内配图\n\n${extracted.images.map((img, idx) => `${idx + 1}. ${img.alt || "配图"}：${img.src}`).join("\n")}\n` : ""}
${summary}

## 元数据

- article_id: \`${article.id}\`
- category_id: \`${article.category_id}\`
- path: \`${article.path}\`
- extracted_text_length: ${extracted.textLength}
`;

    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, md.replace(/\r\n/g, "\n"), "utf8");
    progress[article.id] = { ok: true, file: mdRel, textLength: extracted.textLength };
    okCount += 1;
    console.log(`OK ${index}/${articles.length} ${article.title} text=${extracted.textLength}`);
  } catch (error) {
    progress[article.id] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    console.error(`FAIL ${index}/${articles.length} ${article.title}:`, progress[article.id].error);
  }

  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
  await new Promise((r) => setTimeout(r, 250));
}

await browser.close();
console.log(`finished batch start=${start} limit=${limit} ok=${okCount}`);
