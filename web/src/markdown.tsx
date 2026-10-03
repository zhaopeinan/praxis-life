import DOMPurify, { type Config } from "dompurify";
import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import markedKatex from "marked-katex-extension";
import { useEffect, useRef, useState } from "react";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const parser = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, language) {
      // 未识别的语言原样保留（仅转义），避免代码块里的标签被当成 HTML。
      if (!language || !hljs.getLanguage(language)) return escapeHtml(code);
      try {
        return hljs.highlight(code, { language }).value;
      } catch {
        return escapeHtml(code);
      }
    },
  }),
  markedKatex({ throwOnError: false, nonStandard: false }),
);

parser.setOptions({ gfm: true, breaks: true });

const SANITIZE: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ADD_ATTR: ["target", "rel"],
  FORBID_TAGS: ["style", "form", "iframe", "object", "embed"],
  FORBID_ATTR: ["srcset"],
};

/** Markdown → 安全的 HTML 字符串。同步返回，便于直接渲染。 */
export function renderMarkdown(source: string): string {
  if (!source.trim()) return "";
  let raw: string;
  try {
    raw = parser.parse(source, { async: false }) as string;
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  }
  return DOMPurify.sanitize(raw, SANITIZE) as unknown as string;
}

/** KaTeX 之外的公式形式（如 $$...$$ 单独成段）已在扩展里处理；这里只做空行兜底。 */
export function countWords(source: string): number {
  return source.trim().length;
}

let mermaidSeq = 0;

/**
 * 把 ```mermaid 代码块替换成渲染后的 SVG。
 * mermaid 体积较大，只有真的出现图表时才动态加载。
 */
async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("code.language-mermaid"));
  if (!blocks.length) return;
  let mermaid: typeof import("mermaid").default;
  try {
    mermaid = (await import("mermaid")).default;
  } catch {
    return;
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: "inherit",
    themeVariables: {
      primaryColor: "#f0fdfa",
      primaryBorderColor: "#0f766e",
      primaryTextColor: "#18181b",
      lineColor: "#71717a",
      fontSize: "13px",
    },
  });
  for (const code of blocks) {
    const host = code.closest("pre") ?? code;
    const source = code.textContent ?? "";
    const id = `dw-mermaid-${(mermaidSeq += 1)}`;
    try {
      const { svg } = await mermaid.render(id, source);
      const wrap = document.createElement("div");
      wrap.className = "md-mermaid";
      wrap.innerHTML = svg;
      host.replaceWith(wrap);
    } catch (error) {
      const wrap = document.createElement("div");
      wrap.className = "md-mermaid-error";
      wrap.textContent = `Mermaid 渲染失败：${error instanceof Error ? error.message : String(error)}`;
      host.replaceWith(wrap);
    }
  }
}

/** 外链一律新窗口打开，并补上 noopener。 */
function decorateLinks(root: HTMLElement): void {
  for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    }
  }
}

export function MarkdownView({ source, className }: { source: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState(() => renderMarkdown(source));

  useEffect(() => {
    setHtml(renderMarkdown(source));
  }, [source]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    decorateLinks(root);
    void renderMermaidBlocks(root);
  }, [html]);

  if (!source.trim()) {
    return <div className={className ? `md-preview empty ${className}` : "md-preview empty"}>还没有内容。切到「编辑」开始写吧。</div>;
  }

  return (
    <div
      ref={ref}
      className={className ? `md-preview ${className}` : "md-preview"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
