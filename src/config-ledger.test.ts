import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalConfigPath,
  compareConfigLedger,
  experimentIdFromFile,
  ledgerRowsFromPayload,
  normalizeExperimentId,
  parseConfigText,
  scanConfigDirectory,
  scanConfigFiles,
  toSeedNumber,
  type ConfigLedgerRow,
} from "./config-ledger.js";
import { Store } from "./store.js";
import type { Field, PublicRecord } from "./types.js";

/* ------------------------------ 编号与路径口径 ------------------------------ */

assert.equal(normalizeExperimentId("exp-017"), "exp-17"); // 自动编号不补零，文件名常补零
assert.equal(normalizeExperimentId(" EXP-7 "), "exp-7");
assert.equal(normalizeExperimentId("exp-17"), normalizeExperimentId("exp-017"));
assert.equal(canonicalConfigPath("./configs\\exp-017.yaml"), "configs/exp-17.yaml");
assert.equal(experimentIdFromFile("configs/abl/exp-003.yaml"), "exp-003");
assert.equal(experimentIdFromFile("configs\\exp-3.yml"), "exp-3");
assert.equal(toSeedNumber(42), 42);
assert.equal(toSeedNumber(" 20260922 "), 20260922);
assert.equal(toSeedNumber(""), null);
assert.equal(toSeedNumber("随机"), null);
assert.equal(toSeedNumber([1, 2]), null);
assert.equal(toSeedNumber(null), null);

/* --------------------------------- 单份解析 -------------------------------- */

const good = parseConfigText(
  "configs/exp-017.yaml",
  [
    "experiment_id: exp-017",
    "hypothesis: H-01",
    "model:",
    "  backbone: llama3-8b",
    "training:",
    "  lr: 2.0e-5",
    "  seed: 42",
  ].join("\n"),
);
assert.ok("entry" in good);
assert.equal(good.entry.experimentId, "exp-017");
assert.equal(good.entry.seed, 42);
assert.equal(good.entry.seedKey, "training.seed");
assert.deepEqual(good.entry.warnings, []);

// 第二个种子来源要报出来：种子必须收敛到一个字段
const twoSeeds = parseConfigText(
  "configs/exp-018.yaml",
  ["seed: 42", "data:", "  numpy_seed: 7", "  split_seed: 7"].join("\n"),
);
assert.ok("entry" in twoSeeds);
assert.ok(twoSeeds.entry.seed === 42); // 精确名为 seed 的那个仍用于对账
assert.ok(twoSeeds.entry.warnings.some((line) => line.includes("发现多个种子字段")));

// 种子字段名不合口径（不是 seed）：提示但不静默
const renamedSeed = parseConfigText("configs/exp-019.yaml", ["random_seed: 42"].join("\n"));
assert.ok("entry" in renamedSeed);
assert.equal(renamedSeed.entry.seed, 42);
assert.ok(renamedSeed.entry.warnings.some((line) => line.includes("种子字段名")));

// 没写 seed：这一份配置根本复现不了
const noSeed = parseConfigText("configs/exp-020.yaml", ["experiment_id: exp-020", "model:", "  backbone: qwen"].join("\n"));
assert.ok("entry" in noSeed);
assert.equal(noSeed.entry.seed, null);
assert.ok(noSeed.entry.warnings.some((line) => line.includes("没有 seed")));

// seed 不是数字
const badSeed = parseConfigText("configs/exp-021.yaml", ["seed: [1, 2, 3]"].join("\n"));
assert.ok("entry" in badSeed);
assert.equal(badSeed.entry.seed, null);
assert.ok(badSeed.entry.warnings.some((line) => line.includes("seed 不是数字")));

// 文件名即实验编号：不一致要提示，并统一按文件名取值
const mismatch = parseConfigText("configs/exp-022.yaml", ["experiment_id: exp-99", "seed: 1"].join("\n"));
assert.ok("entry" in mismatch);
assert.equal(mismatch.entry.experimentId, "exp-022");
assert.ok(mismatch.entry.warnings.some((line) => line.includes("与文件名")));

// 解析失败不抛错，交给 unparsed
const broken = parseConfigText("configs/exp-023.yaml", "training: [unclosed");
assert.ok("error" in broken && broken.error.includes("YAML 解析失败"));
const notMapping = parseConfigText("configs/exp-024.yaml", "- just\n- a list");
assert.ok("error" in notMapping);

/* --------------------------------- 目录扫描 -------------------------------- */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "duowei-config-ledger-"));
try {
  fs.mkdirSync(path.join(workDir, "configs", "abl"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "configs", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "experiments"), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, "configs", "exp-1.yaml"),
    ["experiment_id: exp-1", "training:", "  seed: 1"].join("\n"),
  );
  fs.writeFileSync(path.join(workDir, "configs", "abl", "exp-2.yml"), ["seed: 2"].join("\n"));
  fs.writeFileSync(path.join(workDir, "configs", "notes.md"), "# 不是配置");
  fs.writeFileSync(path.join(workDir, "configs", "broken.yaml"), "seed: [unclosed");
  fs.writeFileSync(path.join(workDir, "configs", "node_modules", "exp-9.yaml"), "seed: 9");
  fs.writeFileSync(path.join(workDir, "experiments", "exp-3.yaml"), ["seed: 3"].join("\n"));

  const scan = scanConfigDirectory(workDir, { ledgerPaths: ["experiments/exp-3.yaml", "experiments/exp-404.yaml"] });
  assert.equal(scan.files.length, 3); // 嵌套目录算，node_modules 与 .md 不算
  assert.deepEqual(
    scan.files.map((item) => item.file),
    ["configs/abl/exp-2.yml", "configs/exp-1.yaml", "experiments/exp-3.yaml"],
  );
  assert.equal(scan.unparsed.length, 1);
  assert.equal(scan.unparsed[0].file, "configs/broken.yaml");
  assert.ok(scan.notes.some((line) => line.includes("台账路径不在配置目录内")));

  const missingDir = scanConfigDirectory(workDir, { configDir: "benchmarks" });
  assert.equal(missingDir.files.length, 0);
  assert.ok(missingDir.notes.some((line) => line.includes("配置目录不存在")));

  // 台账路径跑到仓库外面去了：不读，只说明一句
  const escaped = scanConfigDirectory(workDir, { ledgerPaths: ["../outside.yaml", "/tmp/outside.yaml"] });
  assert.ok(escaped.notes.filter((line) => line.includes("超出仓库范围")).length === 2);

  assert.throws(() => scanConfigDirectory(path.join(workDir, "configs", "exp-1.yaml")));

  /* --------------------------------- 对账 --------------------------------- */

  const rows: ConfigLedgerRow[] = [
    { recordId: "r1", experimentId: "exp-1", path: "configs/exp-001.yaml", seed: 1, label: "检索增强对照" },
    { recordId: "r2", experimentId: "exp-2", path: "configs/abl/exp-2.yml", seed: 5, label: "消融：去检索" },
    { recordId: "r3", experimentId: "exp-3", path: "experiments/exp-3.yaml", seed: null, label: "预研" },
    { recordId: "r4", experimentId: "exp-4", path: "configs/exp-4.yaml", seed: 42, label: "幽灵" },
  ];
  const diff = compareConfigLedger(scan, rows);

  // 三张清单：仓库里有台账没有 / 台账有仓库没有 / seed 不一致
  assert.deepEqual(diff.missingInLedger, []);
  assert.deepEqual(
    diff.ghostInLedger.map((item) => item.experimentId),
    ["exp-4"],
  );
  assert.deepEqual(
    diff.seedMismatch.map((item) => `${item.experimentId}:${item.fileSeed}≠${item.ledgerSeed}`),
    ["exp-2:2≠5"],
  );
  // 台账路径写成 configs/exp-001.yaml，实际是 configs/exp-1.yaml：编号归一化后不算漏登记，但要报路径
  assert.deepEqual(diff.pathMismatch, []);
  assert.deepEqual(
    diff.seedIncomplete.map((item) => `${item.experimentId}:${item.note}`),
    ["exp-3:YAML seed=3；台账未填 seed"],
  );
  assert.equal(diff.unparsed.length, 1);
  assert.deepEqual(
    diff.warnings.map((item) => item.file),
    ["configs/abl/exp-2.yml", "experiments/exp-3.yaml"], // 这两份配置没写 experiment_id
  );

  // 换成本地仓库场景：路径写法不一致要报出来
  const pathDiff = compareConfigLedger(scan, [
    { recordId: "r1", experimentId: "exp-1", path: "configs/legacy/exp-1.yaml", seed: 1, label: "" },
  ]);
  assert.deepEqual(pathDiff.pathMismatch, [
    { experimentId: "exp-1", ledgerPath: "configs/legacy/exp-1.yaml", file: "configs/exp-1.yaml" },
  ]);

  // 编号写法不一致（exp-1 vs exp_1）时，两张清单都报，同时给一句提示
  const loose = compareConfigLedger(scanConfigFiles([{ path: "configs/exp_1.yaml", content: "seed: 1" }]), [
    { recordId: "r5", experimentId: "exp-1", path: "configs/exp_1.yaml", seed: 1, label: "" },
  ]);
  assert.equal(loose.missingInLedger.length, 1);
  assert.equal(loose.ghostInLedger.length, 1);
  assert.ok(loose.notes.some((line) => line.includes("疑似同一实验")));

  // 全空即通过
  const clean = compareConfigLedger(
    scanConfigFiles([{ path: "configs/exp-1.yaml", content: "experiment_id: exp-1\nseed: 1" }]),
    [{ recordId: "r6", experimentId: "exp-1", path: "configs/exp-1.yaml", seed: 1, label: "" }],
  );
  assert.ok(clean.summary.some((line) => line.includes("仓库与台账一致")));

  // 同一编号两份配置：不静默取一份
  const duplicated = compareConfigLedger(
    scanConfigFiles([
      { path: "configs/exp-1.yaml", content: "seed: 1" },
      { path: "configs/copy/exp-1.yaml", content: "seed: 1" },
    ]),
    [],
  );
  assert.equal(duplicated.missingInLedger.length, 1);
  assert.ok(duplicated.warnings.some((item) => item.message.includes("重复")));
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

/* ------------------------------- 台账行提取 ------------------------------- */

function field(id: string, name: string, type: Field["type"]): Field {
  return { id, tableId: "t1", name, type, position: 0 } as Field;
}

function record(id: string, values: Record<string, unknown>): PublicRecord {
  return { id, createdAt: 0, updatedAt: 0, fields: values as PublicRecord["fields"] };
}

const payload = {
  fields: [
    field("f1", "实验编号", "auto_number"),
    field("f2", "配置文件路径", "text"),
    field("f3", "seed", "number"),
    field("f4", "一句话目的", "text"),
  ],
  // 记录字段按字段名索引（store.toPublic 的口径）
  records: [
    record("r1", { 实验编号: "exp-17", 配置文件路径: "configs/exp-17.yaml", seed: 42, 一句话目的: "检索增强 vs 截断" }),
    record("r2", { 实验编号: "exp-18", 配置文件路径: "", seed: null, 一句话目的: "" }),
    record("r3", { 实验编号: "", 配置文件路径: "configs/exp-19.yaml", seed: 1, 一句话目的: "" }),
  ],
};
const extracted = ledgerRowsFromPayload(payload);
assert.deepEqual(extracted.rows, [
  { recordId: "r1", experimentId: "exp-17", path: "configs/exp-17.yaml", seed: 42, label: "检索增强 vs 截断" },
  { recordId: "r2", experimentId: "exp-18", path: null, seed: null, label: "r2" },
]);
assert.ok(extracted.notes.some((line) => line.includes("为空，已跳过")));
assert.throws(() => ledgerRowsFromPayload({ fields: [field("f2", "配置文件路径", "text")], records: [] }), /实验编号/);

const noSeedColumn = ledgerRowsFromPayload(
  { fields: [field("f1", "实验编号", "auto_number"), field("f2", "配置文件路径", "text")], records: [] },
  {},
);
assert.equal(noSeedColumn.rows.length, 0);
assert.ok(noSeedColumn.notes.some((line) => line.includes("没有「seed」字段")));

/* ------------------------------ 与真实库联调 ------------------------------ */

// 上面的 payload 是手写的；这一段用真实 store 建一张「配置台账」，确认自动编号与数字字段的取值口径没变
const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), "duowei-config-ledger-live-"));
try {
  const store = new Store(path.join(liveDir, "duowei.db"));
  await store.init();
  const base = await store.createBase("科研方法");
  const table = await store.createTable(base.id, {
    name: "配置台账",
    fields: [
      { name: "实验编号", type: "auto_number", prefix: "exp-" },
      { name: "配置文件路径", type: "text" },
      { name: "seed", type: "number" },
      { name: "一句话目的", type: "text" },
    ],
  });
  await store.createRecord(table.id, { 配置文件路径: "configs/exp-1.yaml", seed: 42, 一句话目的: "对照 A" });
  await store.createRecord(table.id, { 配置文件路径: "configs/exp-2.yaml", seed: 7, 一句话目的: "对照 B" });
  await store.createRecord(table.id, { 配置文件路径: "configs/exp-4.yaml", seed: 4, 一句话目的: "幽灵" });

  const repo = path.join(liveDir, "repo");
  fs.mkdirSync(path.join(repo, "configs"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "configs", "exp-1.yaml"),
    ["experiment_id: exp-1", "hypothesis: H-01", "training:", "  seed: 42"].join("\n"),
  );
  fs.writeFileSync(path.join(repo, "configs", "exp-2.yaml"), ["seed: 99"].join("\n"));
  fs.writeFileSync(path.join(repo, "configs", "exp-5.yaml"), ["experiment_id: exp-5", "seed: 5"].join("\n"));

  const live = ledgerRowsFromPayload(await store.getTable(table.id));
  assert.deepEqual(live.rows, [
    { recordId: live.rows[0].recordId, experimentId: "exp-1", path: "configs/exp-1.yaml", seed: 42, label: "对照 A" },
    { recordId: live.rows[1].recordId, experimentId: "exp-2", path: "configs/exp-2.yaml", seed: 7, label: "对照 B" },
    { recordId: live.rows[2].recordId, experimentId: "exp-3", path: "configs/exp-4.yaml", seed: 4, label: "幽灵" },
  ]);
  const liveDiff = compareConfigLedger(
    scanConfigDirectory(repo, { ledgerPaths: live.rows.map((row) => row.path) }),
    live.rows,
  );
  assert.deepEqual(
    liveDiff.missingInLedger.map((item) => item.experimentId),
    ["exp-5"],
  );
  assert.deepEqual(
    liveDiff.ghostInLedger.map((item) => item.experimentId),
    ["exp-3"],
  );
  assert.deepEqual(
    liveDiff.seedMismatch.map((item) => `${item.experimentId}:${item.fileSeed}≠${item.ledgerSeed}`),
    ["exp-2:99≠7"],
  );
} finally {
  fs.rmSync(liveDir, { recursive: true, force: true });
}

console.log("config-ledger tests passed");
