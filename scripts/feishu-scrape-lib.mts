import fs from "node:fs";
import path from "node:path";
import type { Page } from "puppeteer-core";

export type Article = {
  id: string;
  title: string;
  url: string;
  trail: string[];
  category_id: string;
  path: string;
};

export type Extracted = {
  title: string;
  headings: string[];
  paragraphs: string[];
  images: Array<{ src: string; alt: string }>;
  textLength: number;
};

export const ROOT = path.resolve("docs/feishu-bitable");

export function slugify(title: string, id: string): string {
  const base = title
    .replace(/[\/\\?%*:|"<>]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${base || "article"}-${id}`;
}

export function summarize(title: string, trail: string[], paragraphs: string[], headings: string[]): string {
  const body = paragraphs.join("\n");
  const lines: string[] = [];
  lines.push(`## 功能定位`, "", `本页对应飞书帮助中心「${["多维表格", ...trail].join(" / ")}」下的「${title}」。以下需求描述依据官方说明文档提炼，用于指导 DuoWei 对标实现。`, "");
  lines.push(`## 功能目标`, "", paragraphs[0] || `提供与「${title}」相关的多维表格能力，行为应对齐飞书帮助文档描述。`, "");
  if (headings.length) {
    lines.push(`## 文档结构（官方章节）`, "");
    for (const h of headings.slice(0, 50)) lines.push(`- ${h}`);
    lines.push("");
  }
  lines.push(`## 详细功能说明`, "");
  if (paragraphs.length) {
    for (const p of paragraphs) {
      if (p.trim().length < 4) continue;
      lines.push(p.trim(), "");
    }
  } else {
    lines.push(`（正文提取为空，请结合截图与源链接复核。）`, "");
  }
  lines.push(
    `## 实现要点（对标 DuoWei）`,
    "",
    `1. **入口与信息架构**：在产品中明确该能力所属模块（${trail.join(" / ") || "多维表格"}），并保证用户可从对应导航触达。`,
    `2. **核心交互**：按上文「详细功能说明」还原主要操作路径；截图中出现的按钮、字段、面板命名尽量与飞书语义一致或可映射。`,
    `3. **数据与权限**：若文档涉及可见范围、可编辑范围、分享或高级权限，实现时需落到角色/成员模型，并保证 API/MCP 与 UI 权限一致。`,
    `4. **边界与上限**：若文档提到数量上限、格式限制、导入导出约束，需在实现与错误提示中体现。`,
    `5. **验收**：以本页截图场景为用例，完成「能打开 / 能配置 / 能保存 / 能被 Agent 读写（如适用）」四项检查。`,
    "",
    `## 原始摘录摘要`,
    "",
    `> ${body.slice(0, 800).replace(/\n+/g, " ")}${body.length > 800 ? "…" : ""}`,
    "",
  );
  return lines.join("\n");
}

export function pathsFor(article: Article) {
  const slug = slugify(article.title, article.id);
  return {
    slug,
    mdRel: `articles/${slug}.md`,
    shotRel: `assets/screenshots/${slug}.png`,
    mdPath: path.join(ROOT, `articles/${slug}.md`),
    shotPath: path.join(ROOT, `assets/screenshots/${slug}.png`),
  };
}

export function isDone(
  article: Article,
  progress: Record<string, { ok?: boolean; textLength?: number }>,
  force: boolean,
): boolean {
  if (force) return false;
  const prev = progress[article.id];
  const { mdPath, shotPath } = pathsFor(article);
  const hasFiles = fs.existsSync(mdPath) && fs.existsSync(shotPath);
  // Some formula/FAQ pages are image/video heavy and extract little text; screenshot+md is enough.
  return Boolean(prev?.ok && hasFiles);
}

export async function scrapeArticle(page: Page, article: Article): Promise<Extracted> {
  await page.goto(article.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("h1", { timeout: 15000 }).catch(() => null);

  await page.evaluate(`(() => {
    for (const b of Array.from(document.querySelectorAll("button"))) {
      const t = (b.textContent || "").trim();
      if (["我知道了", "关闭", "同意", "接受"].includes(t)) b.click();
    }
  })()`);

  await page
    .waitForFunction(
      `(() => {
        const text = document.body?.innerText || "";
        return text.includes("本文阅读时长") || text.length > 1200 || !!document.querySelector("table") || !!document.querySelector("h1");
      })()`,
      { timeout: 12000 },
    )
    .catch(() => null);

  await page.evaluate(`(() => {
    for (const d of document.querySelectorAll("details")) d.open = true;
  })()`);
  await new Promise((r) => setTimeout(r, 350));

  return (await page.evaluate(`(() => {
    const titleHint = ${JSON.stringify(article.title)};
    const title = document.querySelector("h1")?.textContent?.trim() || titleHint;
    const richBlocks = Array.from(document.querySelectorAll('[class*="js-heraAdit-richText-body"]'))
      .filter((el) => {
        const t = (el.textContent || "").trim();
        return t.length > 20 && !t.includes("本文是否对你有帮助");
      })
      .sort((a, b) => (b.textContent || "").length - (a.textContent || "").length);
    const main = richBlocks[0] || document.querySelector("article") || document.querySelector("main") || document.body;

    const headings = Array.from(main.querySelectorAll("h1,h2,h3,h4,[class*='heading-h']"))
      .map((el) => (el.textContent || "").trim())
      .filter((t) => t && t !== title);

    const blocks = [];
    const noise = new Set(["帮助中心","登录","智能助手","我知道了","去试试","新手入门","使用飞书","更多资源","本文是否对你有帮助"]);
    const push = (t) => {
      const v = String(t || "").replace(/\\u200b/g, "").replace(/\\s+/g, " ").trim();
      if (v.length < 4 || noise.has(v)) return;
      if (blocks[blocks.length - 1] === v) return;
      blocks.push(v);
    };

    for (const el of main.querySelectorAll("h1,h2,h3,h4,p,li,td,th,summary,[class*='heading']")) {
      const t = (el.textContent || "").trim();
      if (t.length >= 4 && t.length < 2000) push(t);
    }
    for (const d of document.querySelectorAll("details")) {
      const q = d.querySelector("summary")?.textContent?.trim();
      const a = (d.textContent || "").replace(q || "", "").trim();
      if (q) push(q);
      if (a && a.length < 1500) push(a);
    }
    for (const row of main.querySelectorAll("tr")) {
      const cells = Array.from(row.querySelectorAll("th,td")).map((c) => (c.textContent || "").replace(/\\u200b/g, "").trim());
      if (cells.filter(Boolean).length >= 2) push(cells.join(" | "));
    }

    const seen = new Set();
    const paragraphs = [];
    for (const b of blocks) {
      if (seen.has(b)) continue;
      seen.add(b);
      paragraphs.push(b);
    }

    const images = Array.from(main.querySelectorAll("img"))
      .map((img) => ({ src: img.currentSrc || img.src, alt: img.alt || "" }))
      .filter((x) => x.src && !x.src.startsWith("data:"))
      .slice(0, 40);

    const textLength = paragraphs.join("\\n").length;
    return {
      title,
      headings: Array.from(new Set(headings)).slice(0, 60),
      paragraphs: paragraphs.slice(0, 250),
      images,
      textLength,
    };
  })()`)) as Extracted;
}

export function writeArticle(article: Article, extracted: Extracted): { mdRel: string; shotRel: string } {
  const { mdRel, shotRel, mdPath } = pathsFor(article);
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
  return { mdRel, shotRel };
}
