import fs from "node:fs";
import { DomainError, type Store } from "./store.js";
import { ZipBuilder } from "./zip.js";

// 空间级导出：把一个空间打包成单个 Zip——
//   manifest.json          空间 / 表 / 文档 / 附录文件清单与统计
//   README.md              包结构说明
//   tables/NN-表名.json     字段、视图、记录（当前值的权威副本）
//   tables/NN-表名.csv      表格形态的快照（展示文本，方便直接打开）
//   documents/文档标题.md    文档正文（Markdown）
//   attachments/…           记录与文档正文引用到的附件原文件
// 记录里对外的图片 / 文件地址也会原样保留在 JSON 中，附件额外打包一份原件。

const TABLE_RECORD_LIMIT = 5000; // 与 store.getTable 的默认上限一致

export type BaseExportResult = {
  filename: string;
  buffer: Buffer<ArrayBuffer>;
};

function safeSegment(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

function claimName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let index = 2;
  let candidate = `${stem} (${index})${ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem} (${index})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function collectUploadIds(text: string, target: Set<string>): void {
  for (const match of text.matchAll(/\/api\/uploads\/([A-Za-z0-9_-]+)/g)) target.add(match[1]);
}

export async function buildBaseExport(store: Store, baseId: string): Promise<BaseExportResult> {
  const base = (await store.listBases()).find((item) => item.id === baseId);
  if (!base) throw new DomainError("找不到多维表格", 404);

  const zip = new ZipBuilder();
  const used = new Set<string>();
  const uploadIds = new Set<string>();

  const tables: Array<Record<string, unknown>> = [];
  let tableIndex = 0;
  for (const table of base.tables) {
    tableIndex += 1;
    const payload = await store.getTable(table.id);
    const stem = `tables/${String(tableIndex).padStart(2, "0")}-${safeSegment(table.name, table.id)}`;
    zip.addFile(
      claimName(used, `${stem}.json`),
      JSON.stringify(
        {
          baseId: base.id,
          table: { id: table.id, name: table.name },
          fields: payload.fields,
          views: payload.views,
          records: payload.records,
        },
        null,
        2,
      ),
    );
    zip.addFile(claimName(used, `${stem}.csv`), await store.exportCsv(table.id));

    for (const record of payload.records) {
      for (const field of payload.fields) {
        if (field.type !== "attachment") continue;
        const value = record.fields[field.name];
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          if (item && typeof item === "object" && !Array.isArray(item) && "url" in item) {
            const url = (item as { url?: unknown }).url;
            if (typeof url === "string") collectUploadIds(url, uploadIds);
          }
        }
      }
    }

    tables.push({
      id: table.id,
      name: table.name,
      fields: payload.fields.length,
      views: payload.views.length,
      records: payload.records.length,
      // 达到 store 的默认上限时提示可能被截断
      truncated: payload.records.length >= TABLE_RECORD_LIMIT,
    });
  }

  const documents: Array<Record<string, unknown>> = [];
  for (const doc of await store.listDocuments(base.id)) {
    if (doc.kind !== "doc") {
      documents.push({ id: doc.id, title: doc.title, kind: doc.kind, file: null });
      continue;
    }
    const detail = await store.getDocument(doc.id);
    const bodyMd = detail.bodyMd ?? "";
    const file = claimName(used, `documents/${safeSegment(doc.title, doc.id)}.md`);
    zip.addFile(file, bodyMd);
    collectUploadIds(bodyMd, uploadIds);
    documents.push({ id: doc.id, title: doc.title, kind: doc.kind, file, updatedAt: detail.updatedAt });
  }

  const attachments: Array<Record<string, unknown>> = [];
  const missingAttachments: string[] = [];
  for (const uploadId of uploadIds) {
    try {
      const upload = await store.getUpload(uploadId);
      const file = claimName(used, `attachments/${uploadId}-${safeSegment(upload.meta.name, "file")}`);
      zip.addFile(file, await fs.promises.readFile(upload.path));
      attachments.push({ id: uploadId, name: upload.meta.name, size: upload.meta.size ?? null, file });
    } catch {
      missingAttachments.push(uploadId);
    }
  }

  const manifest = {
    generator: "DuoWei 知行人生",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    base: {
      id: base.id,
      name: base.name,
      timezone: base.timezone ?? null,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
    },
    tables,
    documents,
    attachments,
    missingAttachments,
  };
  zip.addFile("manifest.json", JSON.stringify(manifest, null, 2));
  zip.addFile("README.md", buildReadme(manifest));

  const stamp = new Date().toISOString().slice(0, 10);
  return { filename: `${safeSegment(base.name, "space")}-${stamp}.zip`, buffer: zip.finish() };
}

function buildReadme(manifest: {
  exportedAt: string;
  base: { id: string; name: string };
  tables: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  missingAttachments: string[];
}): string {
  const lines = [
    `# ${manifest.base.name} · 空间导出包`,
    "",
    `导出时间：${manifest.exportedAt}　空间 ID：\`${manifest.base.id}\``,
    "",
    "目录结构：",
    "",
    "- `manifest.json`：空间、表、文档、附件的清单与统计",
    "- `tables/*.json`：每张表的字段、视图与全部记录（记录当前值的权威副本）",
    "- `tables/*.csv`：表格快照，直接用表格软件打开（展示文本）",
    "- `documents/*.md`：文档正文（Markdown）",
    "- `attachments/`：记录与文档正文引用到的附件原文件",
    "",
    `统计：${manifest.tables.length} 张表，${manifest.documents.filter((doc) => doc.file).length} 篇文档，${manifest.attachments.length} 个附件。`,
  ];
  if (manifest.missingAttachments.length > 0) {
    lines.push("", `注意：有 ${manifest.missingAttachments.length} 个附件在服务器上已缺失，清单见 manifest.json 的 missingAttachments。`);
  }
  if (manifest.tables.some((table) => table.truncated === true)) {
    lines.push("", "注意：有表的记录数达到导出上限（5000 条/表），如需全量请分视图导出。");
  }
  lines.push("", "包内是一份可读快照，用于备份与迁移参考，不保证可逆向完整回灌。");
  return `${lines.join("\n")}\n`;
}
