import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 as zlibCrc32, inflateRawSync } from "node:zlib";
import { Accounts } from "./accounts.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";
import { crc32, ZipBuilder } from "./zip.js";

// 这个测试刻意不复用 ZipBuilder 的写入逻辑：自己从中央目录读回来，
// 用 zlib 的独立实现校验 CRC 与解压结果，避免"写错读错互相抵消"。

type ZipEntry = { name: string; method: number; data: Uint8Array; compressed: number };

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "找不到 ZIP 结束记录（EOCD）");
  const total = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  let offset = buf.readUInt32LE(eocd + 16);
  assert.equal(offset + centralSize + 22, buf.length, "中央目录偏移与文件长度不符");

  const entries: ZipEntry[] = [];
  for (let index = 0; index < total; index += 1) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, "中央目录签名不对");
    assert.equal(buf.readUInt16LE(offset + 8) & 0x0800, 0x0800, "条目名没有标 UTF-8 标志位");
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressed = buf.readUInt32LE(offset + 20);
    const rawSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `${name} 的本地文件头签名不对`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const payload = buf.subarray(start, start + compressed);
    const data = method === 8 ? new Uint8Array(inflateRawSync(payload)) : new Uint8Array(payload);
    assert.equal(data.length, rawSize, `${name} 解压后长度与头里声明不符`);
    assert.equal(zlibCrc32(data), crc, `${name} 的 CRC 过不了 zlib 独立校验`);
    assert.equal(crc32(data), crc, `${name} 的 CRC 与本项目实现不一致`);
    entries.push({ name, method, data, compressed });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readJson<T>(entries: ZipEntry[], name: string): T {
  const entry = entries.find((item) => item.name === name);
  assert.ok(entry, `导出包里缺少 ${name}`);
  return JSON.parse(Buffer.from(entry.data).toString("utf8")) as T;
}

/* ——— 第一部分：ZipBuilder 自身的边界 ——— */
{
  const zip = new ZipBuilder(new Date("2026-10-10T10:00:00"));
  zip.addFile("中文 名称.md", "# 标题\n正文\n");
  zip.addFile("bin/设备.bin", new Uint8Array([0, 1, 2, 255, 254, 0, 0, 7]));
  zip.addFile("empty.txt", "");
  assert.throws(() => zip.addFile("中文 名称.md", "x"), /重名/, "同名条目应直接报错");
  assert.throws(() => zip.addFile("../escape.txt", "x"), /非法/, "路径穿越名应被拒绝");
  assert.throws(() => zip.addFile("/abs.txt", "x"), /非法/, "绝对路径名应被拒绝");

  const entries = readZipEntries(zip.finish());
  assert.deepEqual(
    entries.map((item) => item.name).sort(),
    ["bin/设备.bin", "empty.txt", "中文 名称.md"].sort(),
  );
  assert.equal(Buffer.from(entries.find((item) => item.name === "中文 名称.md")!.data).toString("utf8"), "# 标题\n正文\n");
  assert.deepEqual([...entries.find((item) => item.name === "bin/设备.bin")!.data], [0, 1, 2, 255, 254, 0, 0, 7]);
  assert.equal(entries.find((item) => item.name === "empty.txt")!.data.length, 0);
  // 重复内容应被压小；随机小文件走存储（method 0）也不必强求，这里只确认两种方式都能读回。
  assert.ok(entries.every((item) => item.method === 0 || item.method === 8));
}

/* ——— 第二部分：整空间导出端到端 ——— */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duowei-export-"));
process.env.DUOWEI_DEV_CODES = "1";
delete process.env.SMTP_HOST;

const store = new Store(path.join(dir, "duowei.db"));
await store.init();
const accounts = new Accounts(store.database, store, dir, { devCodes: true, pepper: "test-pepper" });
const app = createApp(store, accounts);

async function json(pathname: string, init?: RequestInit & { cookie?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (init?.cookie) headers.set("cookie", init.cookie);
  const response = await app.request(pathname, { method: init?.method, body: init?.body, headers });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return { status: response.status, data: data as any, cookie };
}

const registered = await json("/api/auth/bootstrap", {
  method: "POST",
  body: JSON.stringify({ name: "Ada", email: "ada@export.test", password: "password123" }),
});
assert.equal(registered.status, 201);
const ada = registered.cookie!;

const base = await json("/api/bases", { method: "POST", cookie: ada, body: JSON.stringify({ name: "导出验证空间" }) });
assert.equal(base.status, 201);
const baseId = base.data.id as string;

const table = await json(`/api/bases/${baseId}/tables`, {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({
    name: "任务",
    fields: [
      { name: "标题", type: "text" },
      { name: "附件", type: "attachment" },
    ],
  }),
});
assert.equal(table.status, 201);
const tableId = table.data.id as string;

const upload = await json("/api/uploads", {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({
    filename: "实验记录.txt",
    contentBase64: Buffer.from("附件正文：epoch 42 loss 0.031\n").toString("base64"),
    mime: "text/plain",
    baseId,
  }),
});
assert.equal(upload.status, 201);

const withAttachment = await json(`/api/tables/${tableId}/records`, {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({
    fields: {
      标题: "带附件的任务",
      附件: [{ name: "实验记录.txt", url: upload.data.url, mime: "text/plain", size: upload.data.size }],
    },
  }),
});
assert.equal(withAttachment.status, 201);

// 顺手造一条指向已丢失附件的记录，检查 manifest 里的缺失清单。
const missing = await json(`/api/tables/${tableId}/records`, {
  method: "POST",
  cookie: ada,
  body: JSON.stringify({
    fields: { 标题: "附件丢了", 附件: [{ name: "gone.bin", url: "/api/uploads/up_missing0000" }] },
  }),
});
assert.equal(missing.status, 201);

// 两篇同名文档：验证导出时的重名后缀（claimName）。
for (const bodyMd of ["# 复盘\n\n第一篇，引用 /api/uploads/" + upload.data.id + "\n", "# 复盘\n\n第二篇\n"]) {
  const doc = await json(`/api/bases/${baseId}/documents`, {
    method: "POST",
    cookie: ada,
    body: JSON.stringify({ title: "复盘", bodyMd }),
  });
  assert.equal(doc.status, 201);
}

const unauthorized = await app.request(`/api/bases/${baseId}/export.zip`);
assert.equal(unauthorized.status, 401);

const response = await app.request(`/api/bases/${baseId}/export.zip`, { headers: { cookie: ada } });
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type") ?? "", /application\/zip/);
const disposition = response.headers.get("content-disposition") ?? "";
assert.match(disposition, /filename\*=UTF-8''/);
assert.ok(decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)![1]).startsWith("导出验证空间-"));

const entries = readZipEntries(new Uint8Array(await response.arrayBuffer()));
const names = entries.map((item) => item.name);
assert.ok(names.includes("manifest.json"), `缺少 manifest.json：${names.join(", ")}`);
assert.ok(names.includes("README.md"));
const tableJson = names.find((name) => /^tables\/01-任务\.json$/.test(name));
assert.ok(tableJson, `表 JSON 命名不符：${names.join(", ")}`);
assert.ok(names.includes("tables/01-任务.csv"));
assert.ok(names.some((name) => /^attachments\/up_.*实验记录\.txt$/.test(name)), names.join(", "));
assert.deepEqual(
  names.filter((name) => name.startsWith("documents/")).sort(),
  ["documents/复盘 (2).md", "documents/复盘.md"].sort(),
  "同名文档应加序号而不是互相覆盖",
);

type Manifest = {
  formatVersion: number;
  base: { id: string; name: string };
  tables: Array<{ id: string; name: string; records: number; truncated: boolean }>;
  documents: Array<{ title: string; file: string | null }>;
  attachments: Array<{ id: string; name: string; file: string }>;
  missingAttachments: string[];
};
const manifest = readJson<Manifest>(entries, "manifest.json");
assert.equal(manifest.formatVersion, 1);
assert.equal(manifest.base.name, "导出验证空间");
assert.deepEqual(manifest.tables.map((item) => item.name), ["任务"]);
assert.equal(manifest.tables[0].records, 2);
assert.equal(manifest.tables[0].truncated, false);
assert.deepEqual(manifest.missingAttachments, ["up_missing0000"]);
assert.deepEqual(manifest.attachments.map((item) => item.name), ["实验记录.txt"]);
assert.equal(manifest.documents.filter((doc) => doc.file).length, 2);

const tablePayload = readJson<{ fields: unknown[]; records: Array<{ fields: Record<string, unknown> }> }>(
  entries,
  tableJson!,
);
assert.ok(tablePayload.fields.length >= 2);
assert.deepEqual(
  tablePayload.records.map((record) => record.fields["标题"]).sort(),
  ["带附件的任务", "附件丢了"],
);

const csv = Buffer.from(entries.find((item) => item.name === "tables/01-任务.csv")!.data).toString("utf8");
assert.match(csv, /标题/);
assert.match(csv, /带附件的任务/);

const attachmentEntry = entries.find((item) => item.name.startsWith("attachments/"))!;
assert.equal(Buffer.from(attachmentEntry.data).toString("utf8"), "附件正文：epoch 42 loss 0.031\n");

const readme = Buffer.from(entries.find((item) => item.name === "README.md")!.data).toString("utf8");
assert.match(readme, /导出验证空间/);
assert.match(readme, /1 个附件在服务器上已缺失/);

const noAccess = await json("/api/bases/b_not_exists/export.zip", { cookie: ada });
assert.ok(noAccess.status === 404 || noAccess.status === 403, `越权/不存在的空间应被拒绝，实际 ${noAccess.status}`);

console.log("duowei export tests passed");
