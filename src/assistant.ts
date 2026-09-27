import { MCP_TOOL_CATALOG } from "./mcp-catalog.js";
import { getLimitsSnapshot } from "./limits.js";
import type { Store } from "./store.js";
import { FIELD_TYPE_LABELS, type Field, type PublicRecord } from "./types.js";

export type AssistantReply = {
  answer: string;
  suggestions: string[];
};

function displayFirst(record: PublicRecord): string {
  const values = Object.values(record.fields);
  const first = values.find((item) => item != null && item !== "");
  return first == null ? record.id : String(first);
}

function groupCounts(records: PublicRecord[], fieldName: string): Array<{ key: string; count: number }> {
  const map = new Map<string, number>();
  for (const record of records) {
    const raw = record.fields[fieldName];
    const keys = Array.isArray(raw)
      ? raw.map(String)
      : raw == null || raw === ""
        ? ["(空)"]
        : [String(raw)];
    for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function sumField(records: PublicRecord[], fieldName: string): number {
  let total = 0;
  for (const record of records) {
    const raw = record.fields[fieldName];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function findField(fields: Field[], hint: string): Field | undefined {
  const lower = hint.toLowerCase();
  return (
    fields.find((field) => field.name === hint) ??
    fields.find((field) => field.name.toLowerCase().includes(lower)) ??
    fields.find((field) => FIELD_TYPE_LABELS[field.type].includes(hint))
  );
}

export async function runAssistantQuery(
  store: Store,
  tableId: string,
  question: string,
): Promise<AssistantReply> {
  const table = await store.getTable(tableId);
  const q = question.trim();
  const lower = q.toLowerCase();
  const suggestions = [
    "有多少条记录？",
    "有哪些字段？",
    "按状态统计",
    "上限是多少？",
    "按钮类型说明",
    "MCP 工具",
  ];

  if (!q) {
    return { answer: "请输入问题，例如「有多少条」或「按状态统计」。", suggestions };
  }

  if (/mcp|工具|令牌|token/i.test(q)) {
    const tools = MCP_TOOL_CATALOG.map((item) => `· ${item.name} — ${item.description}`).join("\n");
    return {
      answer: `本地 MCP：设置 DUOWEI_TOKEN 后执行 npx tsx src/mcp.ts\n\n可用工具：\n${tools}`,
      suggestions,
    };
  }

  if (/上限|限制|quota|limit/i.test(q)) {
    const snap = getLimitsSnapshot();
    const lines = [
      snap.description,
      `· 每 base 数据表 ≤ ${snap.tablesPerBase}`,
      `· 每表字段 ≤ ${snap.fieldsPerTable}（公式+查找引用合计 ≤ ${snap.formulaAndLookupPerTable}）`,
      `· 每表视图 ≤ ${snap.viewsPerTable}`,
      `· 视图筛选 ≤ ${snap.filtersPerView}，分组 ≤ ${snap.groupsPerView}`,
      `· 字段类型变更就地转换 ≤ ${snap.fieldTypeChangeMaxRows} 行`,
      ...snap.cellCaps.map((item) => `· ${item.type}：${item.cap}`),
    ];
    return { answer: lines.join("\n"), suggestions };
  }

  if (/按钮/.test(q)) {
    return {
      answer: [
        "按钮分两类：",
        "1. 关联数据：数据表「按钮」字段，点击时作用在当前行（可改字段 / 评论 / 打开链接，并可触发自动化）。",
        "2. 未关联数据：仪表盘按钮组件、定时类自动化消息里的按钮，不绑定具体记录。",
        "DuoWei 数据表按钮支持动作：add_comment / set_field / open_url。",
      ].join("\n"),
      suggestions,
    };
  }

  if (/多少|几条|count|条数|记录数/.test(lower)) {
    return {
      answer: `「${table.name}」共 ${table.records.length} 条记录、${table.fields.length} 个字段、${table.views.length} 个视图。`,
      suggestions,
    };
  }

  if (/字段|列名|有哪些列/.test(q)) {
    const list = table.fields
      .map((field) => `${field.name}（${FIELD_TYPE_LABELS[field.type]}）`)
      .join("、");
    return { answer: `字段：${list || "（无）"}`, suggestions };
  }

  if (/视图/.test(q)) {
    const list = table.views.map((view) => `${view.name}（${view.type}）`).join("、");
    return { answer: `视图：${list || "（无）"}`, suggestions };
  }

  const groupMatch = q.match(/按\s*[「"]?(.+?)[」"]?\s*(统计|分组|分布)/);
  if (groupMatch || /统计|分布|分组/.test(q)) {
    const hint = groupMatch?.[1]?.trim() || "";
    const field =
      (hint ? findField(table.fields, hint) : undefined) ??
      table.fields.find((item) => item.type === "single_select" || item.type === "multi_select") ??
      table.fields[0];
    if (!field) return { answer: "没有可用于统计的字段。", suggestions };
    const rows = groupCounts(table.records, field.name).slice(0, 12);
    const body = rows.map((row) => `· ${row.key}：${row.count}`).join("\n");
    return { answer: `按「${field.name}」统计（前 ${rows.length} 项）：\n${body || "（无数据）"}`, suggestions };
  }

  const sumMatch = q.match(/(求和|合计|总和|sum)\s*[「"]?(.+?)[」"]?\s*$/i) || q.match(/[「"](.+?)[」"]\s*(求和|合计|总和)/);
  if (sumMatch || /求和|合计|总和|sum/.test(lower)) {
    const hint = (sumMatch?.[2] || sumMatch?.[1] || "").trim();
    const field =
      (hint ? findField(table.fields, hint) : undefined) ??
      table.fields.find((item) => ["number", "currency", "rating", "progress"].includes(item.type));
    if (!field) return { answer: "没有数值字段可求和。", suggestions };
    const total = sumField(table.records, field.name);
    return { answer: `「${field.name}」合计：${total}`, suggestions };
  }

  if (/变更|改类型|转换字段/.test(q)) {
    return {
      answer: [
        "字段类型变更：在字段菜单选择「更改类型」。",
        `· 就地转换最多 ${getLimitsSnapshot().fieldTypeChangeMaxRows} 行；`,
        `· 超过 ${getLimitsSnapshot().fieldChangeConstraintMinRows} 行时，同一表同时只能变更一个字段；`,
        "· 公式 / 查找引用 / 按钮 / 自动编号 / 系统字段不可改类型。",
      ].join("\n"),
      suggestions,
    };
  }

  const hit = table.records.filter((record) =>
    Object.values(record.fields).some((value) => String(value ?? "").toLowerCase().includes(lower)),
  );
  if (hit.length) {
    return {
      answer: `关键词「${q}」命中 ${hit.length} 条：` + hit.slice(0, 8).map(displayFirst).join("；"),
      suggestions,
    };
  }

  return {
    answer: `未直接匹配。可问：条数、字段、按某字段统计、某字段求和、上限、按钮类型、MCP 工具。当前表「${table.name}」有 ${table.records.length} 条。`,
    suggestions,
  };
}
