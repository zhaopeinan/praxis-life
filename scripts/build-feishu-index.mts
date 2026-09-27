import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("docs/feishu-bitable");
const articles = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/articles.json"), "utf8")) as Array<{
  id: string;
  title: string;
  url: string;
  trail: string[];
}>;
const progress = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog/progress.json"), "utf8")) as Record<
  string,
  { ok: boolean; file?: string }
>;

function slugify(title: string, id: string): string {
  const base = title
    .replace(/[\/\\?%*:|"<>]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${base || "article"}-${id}`;
}

const byTrail = new Map<string, typeof articles>();
for (const article of articles) {
  const key = article.trail.join(" / ") || "未分类";
  const list = byTrail.get(key) ?? [];
  list.push(article);
  byTrail.set(key, list);
}

const ok = articles.filter((a) => progress[a.id]?.ok).length;
const lines: string[] = [];
lines.push(`# 飞书多维表格需求文档库`);
lines.push("");
lines.push(
  `依据 [飞书帮助中心 · 多维表格](https://www.feishu.cn/hc/zh-CN/category/6933474572494716956-%E5%A4%9A%E7%BB%B4%E8%A1%A8%E6%A0%BC) 逐页整理。当前进度：**${ok} / ${articles.length}**。`,
);
lines.push("");
lines.push(`## 使用方式`);
lines.push("");
lines.push(`- 每篇功能单独一份 Markdown：\`articles/*.md\``);
lines.push(`- 对应整页截图：\`assets/screenshots/*.png\``);
lines.push(`- 完整目录树：\`catalog/tree.json\``);
lines.push("");
lines.push(`## 文章索引`);
lines.push("");

for (const [trail, list] of byTrail) {
  lines.push(`### ${trail}`);
  lines.push("");
  for (const article of list) {
    const file = progress[article.id]?.file || `articles/${slugify(article.title, article.id)}.md`;
    const mark = progress[article.id]?.ok ? "✅" : "⏳";
    lines.push(`- ${mark} [${article.title}](${file}) — [原文](${article.url})`);
  }
  lines.push("");
}

fs.writeFileSync(path.join(ROOT, "README.md"), lines.join("\n"), "utf8");
console.log(`index updated: ${ok}/${articles.length}`);
