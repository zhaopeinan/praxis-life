/**
 * 配置台账对账（第 12 讲 P1）
 *
 * 仓库里的 YAML 配置是可执行副本，`配置台账` 表是索引与审计口径——系统不托管配置目录，
 * 所以扫描发生在本地进程（stdio MCP），本模块只负责把两者对成三张清单：
 * 漏登记（仓库里有、台账没有）、幽灵配置（台账有、仓库里没有）、seed 漂移（两边都有但值不一致）。
 *
 * 口径（与 `ResearchModule/design_docs/第12讲_可复现实验框架.md` 一致）：
 * - 一个实验一个配置文件，**文件名即实验编号**；编号比对时 `exp-1` 与 `exp-01` 视为同一编号（自动编号不补零）；
 * - 种子只允许一个来源，台账用单值数字字段 `seed` 登记，配置里出现第二个种子字段即告警；
 * - 台账的 `配置文件路径` 是仓库相对路径，扫描以它为坐标。
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { displayText } from "./query-helpers.js";
import type { Field, PublicRecord } from "./types.js";

export const CONFIG_LEDGER_DEFAULTS = {
  /** 仓库里的配置目录；多个目录用逗号分隔 */
  configDir: "configs",
  /** 台账里的字段名（可在调用时覆盖） */
  idField: "实验编号",
  pathField: "配置文件路径",
  seedField: "seed",
  labelField: "一句话目的",
};

/** 只扫 YAML：配置先于实验存在，格式定死 */
const CONFIG_EXTENSIONS = new Set([".yaml", ".yml"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
  ".next",
  ".cache",
]);
const MAX_SCAN_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SEED_DEPTH = 8;
/** 配置里认这几个键当实验编号（去掉下划线后小写比对） */
const EXPERIMENT_ID_KEYS = new Set(["experimentid", "expid", "实验编号"]);

export type ConfigFileEntry = {
  /** 仓库相对路径，如 `configs/exp-017.yaml` */
  file: string;
  /** 实验编号：取自文件名（文件名即编号） */
  experimentId: string;
  /** 配置里登记的 seed；没写或不是数字时为 null */
  seed: number | null;
  /** seed 在配置里的位置，如 `training.seed` */
  seedKey: string | null;
  warnings: string[];
};

export type ConfigLedgerRow = {
  recordId: string;
  experimentId: string;
  /** 台账「配置文件路径」，仓库相对路径 */
  path: string | null;
  seed: number | null;
  /** 便于人读：台账「一句话目的」，缺省回落记录 id */
  label: string;
};

export type ConfigScan = {
  /** 仓库根目录绝对路径；调用方直接传文件内容时为 null */
  root: string | null;
  /** 扫描范围描述，如 `configs` */
  configDir: string;
  files: ConfigFileEntry[];
  unparsed: Array<{ file: string; error: string }>;
  notes: string[];
  truncated: boolean;
};

export type ConfigLedgerDiff = {
  root: string | null;
  configDir: string;
  scannedFiles: number;
  /** 仓库里有、台账没有 */
  missingInLedger: Array<{ experimentId: string; file: string; seed: number | null }>;
  /** 台账有、仓库里没有 */
  ghostInLedger: Array<{ experimentId: string; recordId: string; path: string | null; label: string }>;
  /** 两边都有但 seed 不一致（静默漂移） */
  seedMismatch: Array<{
    experimentId: string;
    file: string;
    fileSeed: number;
    ledgerSeed: number;
    recordId: string;
  }>;
  /** 一边有 seed、另一边空着（对不出漂移，但同样查不下去） */
  seedIncomplete: Array<{
    experimentId: string;
    file: string;
    fileSeed: number | null;
    ledgerSeed: number | null;
    note: string;
  }>;
  /** 台账路径与仓库实际路径不一致 */
  pathMismatch: Array<{ experimentId: string; ledgerPath: string; file: string }>;
  unparsed: Array<{ file: string; error: string }>;
  warnings: Array<{ file: string; message: string }>;
  notes: string[];
  summary: string[];
};

/* ------------------------------ 编号与路径口径 ------------------------------ */

/**
 * 实验编号归一化：小写、去空白、数字段去掉前导零。
 * 自动编号字段产出 `exp-1`，文件名却常写成 `exp-001.yaml`，两者必须能对上，否则三张清单全是误报。
 */
export function normalizeExperimentId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\d+/g, (digits) => String(Number(digits)));
}

/** 更松的一层：连分隔符也不要，用来提示「疑似同一实验，只是编号写法不一致」 */
function looseExperimentId(raw: string): string {
  return normalizeExperimentId(raw).replace(/[^0-9a-z\u4e00-\u9fa5]/g, "");
}

/** 路径口径：统一分隔符、去掉 `./`、数字段去掉前导零 */
export function canonicalConfigPath(raw: string): string {
  const text = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return text.replace(/\d+/g, (digits) => String(Number(digits)));
}

/** 文件名即实验编号：`configs/exp-017.yaml` → `exp-017` */
export function experimentIdFromFile(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return base.replace(/\.(ya?ml)$/i, "");
}

/** 数字 / 数字字符串 → number；其余（空值、数组、对象、非数字文本）→ null */
export function toSeedNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

/* --------------------------------- 配置解析 -------------------------------- */

type ParsedConfig = { entry: ConfigFileEntry } | { error: string };

function readExperimentId(document: Record<string, unknown>, warnings: string[]): string | null {
  for (const [key, value] of Object.entries(document)) {
    const normalized = key.trim().toLowerCase().replace(/[_-]/g, "");
    if (!EXPERIMENT_ID_KEYS.has(normalized)) continue;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
      warnings.push(`experiment_id 是空值`);
      return null;
    }
    warnings.push(`experiment_id 不是文本：${preview(value)}`);
    return null;
  }
  return null;
}

type SeedHit = { key: string; value: number | null; raw: string };

/** 递归找所有名字里带 seed 的键：设计口径是「种子收敛到一个字段」，多一个就是问题 */
function collectSeedHits(node: unknown, prefix: string, depth: number, hits: SeedHit[]): void {
  if (depth > MAX_SEED_DEPTH || node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectSeedHits(item, `${prefix}[${index}]`, depth + 1, hits));
    return;
  }
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (key.trim().toLowerCase().includes("seed")) {
      hits.push({ key: childPath, value: toSeedNumber(child), raw: preview(child) });
    }
    collectSeedHits(child, childPath, depth + 1, hits);
  }
}

function readSeed(document: Record<string, unknown>, warnings: string[]): { value: number | null; key: string | null } {
  const hits: SeedHit[] = [];
  collectSeedHits(document, "", 0, hits);
  if (hits.length === 0) {
    warnings.push("配置里没有 seed：四层随机源（数值库 / 框架 / 数据顺序 / 硬件算子）要收敛到一个字段");
    return { value: null, key: null };
  }
  const exact = hits.filter((hit) => (hit.key.split(".").pop() ?? "").trim().toLowerCase() === "seed");
  if (hits.length > 1) {
    warnings.push(`发现多个种子字段：${hits.map((hit) => `${hit.key}=${hit.raw}`).join("、")}；种子只能有一个来源`);
  } else if (exact.length === 0) {
    warnings.push(`种子字段名是 ${hits[0].key}，台账按单值字段 seed 登记`);
  }
  const chosen = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  if (!chosen) return { value: null, key: null };
  if (chosen.value == null) {
    warnings.push(`seed 不是数字：${chosen.raw}`);
    return { value: null, key: chosen.key };
  }
  return { value: chosen.value, key: chosen.key };
}

/** 解析一份配置文本；解析失败不抛错，交给调用方列进 `unparsed` */
export function parseConfigText(file: string, content: string): ParsedConfig {
  const warnings: string[] = [];
  const experimentId = experimentIdFromFile(file);
  let document: unknown;
  try {
    document = parseYaml(content);
  } catch (error) {
    return { error: `YAML 解析失败：${errorMessage(error)}` };
  }
  if (document == null || typeof document !== "object" || Array.isArray(document)) {
    return { error: "不是一份 YAML 映射（顶层应为 model / data / training / eval 四节）" };
  }
  const map = document as Record<string, unknown>;
  const declared = readExperimentId(map, warnings);
  if (!declared) {
    warnings.push(`配置里没有 experiment_id（按文件名取实验编号：${experimentId}）`);
  } else if (normalizeExperimentId(declared) !== normalizeExperimentId(experimentId)) {
    warnings.push(`experiment_id（${declared}）与文件名（${path.basename(file)}）不一致：文件名即实验编号`);
  }
  const seed = readSeed(map, warnings);
  return { entry: { file, experimentId, seed: seed.value, seedKey: seed.key, warnings } };
}

/* --------------------------------- 目录扫描 -------------------------------- */

export type ScanOptions = {
  /** 配置目录（相对仓库根），多个用逗号分隔；缺省 configs */
  configDir?: string;
  /** 台账里登记的配置文件路径：不在配置目录内的也一并读取，免得全是幽灵配置 */
  ledgerPaths?: Array<string | null>;
};

function splitDirs(raw: string | undefined): string[] {
  const text = (raw ?? CONFIG_LEDGER_DEFAULTS.configDir).trim();
  const dirs = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return dirs.length ? dirs : [CONFIG_LEDGER_DEFAULTS.configDir];
}

function relativeTo(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function readEntry(
  absolute: string,
  file: string,
  unparsed: Array<{ file: string; error: string }>,
): ConfigFileEntry | null {
  let content: string;
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_FILE_BYTES) {
      unparsed.push({ file, error: `文件过大（${stat.size} 字节），已跳过` });
      return null;
    }
    content = fs.readFileSync(absolute, "utf8");
  } catch (error) {
    unparsed.push({ file, error: errorMessage(error) });
    return null;
  }
  const parsed = parseConfigText(file, content);
  if ("error" in parsed) {
    unparsed.push({ file, error: parsed.error });
    return null;
  }
  return parsed.entry;
}

/** 扫描本地仓库的配置目录（只读，不跟随符号链接） */
export function scanConfigDirectory(root: string, options: ScanOptions = {}): ConfigScan {
  const absoluteRoot = path.resolve(root);
  const stat = fs.statSync(absoluteRoot);
  if (!stat.isDirectory()) throw new Error(`不是仓库目录：${absoluteRoot}`);
  const dirs = splitDirs(options.configDir);
  const notes: string[] = [];
  const files: ConfigFileEntry[] = [];
  const unparsed: Array<{ file: string; error: string }> = [];
  let truncated = false;

  const targets: string[] = [];
  const seen = new Set<string>();
  const push = (absolute: string) => {
    if (seen.has(absolute)) return;
    if (targets.length >= MAX_SCAN_FILES) {
      truncated = true;
      return;
    }
    seen.add(absolute);
    targets.push(absolute);
  };

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      notes.push(`目录读取失败：${relativeTo(absoluteRoot, dir)}（${errorMessage(error)}）`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue; // 符号链接一律跳过
      if (!CONFIG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      push(full);
    }
  };

  for (const dir of dirs) {
    const scanRoot = path.resolve(absoluteRoot, dir);
    if (!fs.existsSync(scanRoot)) {
      notes.push(`配置目录不存在：${dir}`);
      continue;
    }
    walk(scanRoot);
  }

  // 台账登记的路径若落在配置目录之外，单独读一遍：否则会被误报成幽灵配置
  const outside: string[] = [];
  for (const raw of options.ledgerPaths ?? []) {
    if (!raw || !raw.trim()) continue;
    const absolute = path.resolve(absoluteRoot, raw.trim());
    if (seen.has(absolute)) continue;
    if (!CONFIG_EXTENSIONS.has(path.extname(absolute).toLowerCase())) continue;
    const escape = path.relative(absoluteRoot, absolute);
    if (escape.startsWith("..") || path.isAbsolute(escape)) {
      notes.push(`台账路径超出仓库范围，已跳过：${raw}`);
      continue;
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    if (targets.length >= MAX_SCAN_FILES) {
      truncated = true;
      continue;
    }
    seen.add(absolute);
    targets.push(absolute);
    outside.push(relativeTo(absoluteRoot, absolute));
  }
  if (outside.length) notes.push(`台账路径不在配置目录内，已单独读取：${outside.join("、")}`);

  targets.sort();
  for (const absolute of targets) {
    const entry = readEntry(absolute, relativeTo(absoluteRoot, absolute), unparsed);
    if (entry) files.push(entry);
  }

  return { root: absoluteRoot, configDir: dirs.join(","), files, unparsed, notes, truncated };
}

/** 仓库不在本机时的退路：调用方自己读文件，把路径与正文传进来 */
export function scanConfigFiles(
  inputs: Array<{ path: string; content: string }>,
  options: { root?: string | null; configDir?: string } = {},
): ConfigScan {
  const files: ConfigFileEntry[] = [];
  const unparsed: Array<{ file: string; error: string }> = [];
  for (const input of inputs.slice(0, MAX_SCAN_FILES)) {
    const file = input.path.trim().replace(/^\.\//, "");
    const parsed = parseConfigText(file, input.content);
    if ("error" in parsed) unparsed.push({ file, error: parsed.error });
    else files.push(parsed.entry);
  }
  const truncated = inputs.length > MAX_SCAN_FILES;
  return {
    root: options.root ?? null,
    configDir: options.configDir?.trim() || "(调用方传入的文件清单)",
    files,
    unparsed,
    notes: [],
    truncated,
  };
}

/* ------------------------------- 台账行提取 ------------------------------- */

export type LedgerFieldNames = {
  idField?: string;
  pathField?: string;
  seedField?: string;
  labelField?: string;
};

/** 从 `get_table` 的结果里取出对账需要的三列：实验编号 / 配置文件路径 / seed（记录字段按字段名索引） */
export function ledgerRowsFromPayload(
  payload: { fields: Field[]; records: PublicRecord[] },
  names: LedgerFieldNames = {},
): { rows: ConfigLedgerRow[]; notes: string[] } {
  const idField = names.idField?.trim() || CONFIG_LEDGER_DEFAULTS.idField;
  const pathField = names.pathField?.trim() || CONFIG_LEDGER_DEFAULTS.pathField;
  const seedField = names.seedField?.trim() || CONFIG_LEDGER_DEFAULTS.seedField;
  const labelField = names.labelField?.trim() || CONFIG_LEDGER_DEFAULTS.labelField;
  const find = (name: string) => payload.fields.find((field) => field.name === name) ?? null;

  const id = find(idField);
  if (!id) throw new Error(`配置台账表里找不到「${idField}」字段：对账需要实验编号`);
  const pathColumn = find(pathField);
  const seedColumn = find(seedField);
  const labelColumn = find(labelField);

  const notes: string[] = [];
  if (!pathColumn) notes.push(`表里没有「${pathField}」字段：只按实验编号对账，不校验路径`);
  if (!seedColumn) notes.push(`表里没有「${seedField}」字段：seed 一律按缺失处理`);

  const rows: ConfigLedgerRow[] = [];
  for (const record of payload.records) {
    const experimentId = displayText(record.fields[id.name]).trim();
    if (!experimentId) {
      notes.push(`台账记录 ${record.id} 的「${idField}」为空，已跳过`);
      continue;
    }
    const pathText = pathColumn ? displayText(record.fields[pathColumn.name]).trim() : "";
    const seedValue = seedColumn ? toSeedNumber(record.fields[seedColumn.name]) : null;
    const label = labelColumn ? displayText(record.fields[labelColumn.name]).trim() : "";
    rows.push({
      recordId: record.id,
      experimentId,
      path: pathText || null,
      seed: seedValue,
      label: label || record.id,
    });
  }
  return { rows, notes };
}

/* --------------------------------- 对账 -------------------------------- */

function byExperimentId(a: { experimentId: string }, b: { experimentId: string }): number {
  return normalizeExperimentId(a.experimentId).localeCompare(normalizeExperimentId(b.experimentId));
}

export function compareConfigLedger(
  scan: ConfigScan,
  rows: ConfigLedgerRow[],
  options: { notes?: string[] } = {},
): ConfigLedgerDiff {
  const notes = [...scan.notes, ...(options.notes ?? [])];
  const warnings: Array<{ file: string; message: string }> = scan.files.flatMap((entry) =>
    entry.warnings.map((message) => ({ file: entry.file, message })),
  );
  if (scan.truncated) notes.push(`扫描超过 ${MAX_SCAN_FILES} 个文件，已截断：请缩小配置目录范围`);

  const fileIndex = new Map<string, ConfigFileEntry>();
  for (const entry of scan.files) {
    const key = normalizeExperimentId(entry.experimentId);
    const existing = fileIndex.get(key);
    if (existing) {
      warnings.push({ file: entry.file, message: `实验编号与 ${existing.file} 重复，只按前者对账` });
      continue;
    }
    fileIndex.set(key, entry);
  }

  const ledgerIndex = new Map<string, ConfigLedgerRow>();
  for (const row of rows) {
    const key = normalizeExperimentId(row.experimentId);
    if (!key) continue;
    const existing = ledgerIndex.get(key);
    if (existing) {
      notes.push(`台账里「${row.experimentId}」有两条记录（${existing.recordId}、${row.recordId}），只按前者对账`);
      continue;
    }
    ledgerIndex.set(key, row);
  }

  const missingInLedger: ConfigLedgerDiff["missingInLedger"] = [];
  for (const [key, entry] of fileIndex) {
    if (ledgerIndex.has(key)) continue;
    missingInLedger.push({ experimentId: entry.experimentId, file: entry.file, seed: entry.seed });
  }

  const ghostInLedger: ConfigLedgerDiff["ghostInLedger"] = [];
  for (const [key, row] of ledgerIndex) {
    if (fileIndex.has(key)) continue;
    ghostInLedger.push({ experimentId: row.experimentId, recordId: row.recordId, path: row.path, label: row.label });
  }

  const seedMismatch: ConfigLedgerDiff["seedMismatch"] = [];
  const seedIncomplete: ConfigLedgerDiff["seedIncomplete"] = [];
  const pathMismatch: ConfigLedgerDiff["pathMismatch"] = [];
  for (const [key, entry] of fileIndex) {
    const row = ledgerIndex.get(key);
    if (!row) continue;
    if (entry.seed == null || row.seed == null) {
      const sides = [
        entry.seed == null ? "YAML 未写 seed" : `YAML seed=${entry.seed}`,
        row.seed == null ? "台账未填 seed" : `台账 seed=${row.seed}`,
      ];
      seedIncomplete.push({
        experimentId: entry.experimentId,
        file: entry.file,
        fileSeed: entry.seed,
        ledgerSeed: row.seed,
        note: sides.join("；"),
      });
    } else if (entry.seed !== row.seed) {
      seedMismatch.push({
        experimentId: entry.experimentId,
        file: entry.file,
        fileSeed: entry.seed,
        ledgerSeed: row.seed,
        recordId: row.recordId,
      });
    }
    if (row.path && canonicalConfigPath(row.path) !== canonicalConfigPath(entry.file)) {
      pathMismatch.push({ experimentId: entry.experimentId, ledgerPath: row.path, file: entry.file });
    }
  }

  // 一张清单的「漏登记」常是另一张的「幽灵配置」——编号写法不一致时点一句，免得白查
  for (const missing of missingInLedger) {
    for (const ghost of ghostInLedger) {
      if (looseExperimentId(missing.experimentId) === looseExperimentId(ghost.experimentId)) {
        notes.push(
          `疑似同一实验：仓库 ${missing.file} 与台账 ${ghost.experimentId}（${ghost.recordId}）只是编号写法不一致`,
        );
      }
    }
  }

  missingInLedger.sort(byExperimentId);
  ghostInLedger.sort(byExperimentId);
  seedMismatch.sort(byExperimentId);
  seedIncomplete.sort(byExperimentId);
  pathMismatch.sort(byExperimentId);
  warnings.sort((a, b) => a.file.localeCompare(b.file));

  const clean =
    missingInLedger.length === 0 && ghostInLedger.length === 0 && seedMismatch.length === 0 && seedIncomplete.length === 0;
  const summary = [
    `扫描范围 ${scan.configDir}：${scan.files.length} 个配置文件${scan.unparsed.length ? `，${scan.unparsed.length} 个未能解析` : ""}`,
    `台账 ${rows.length} 行`,
    `漏登记 ${missingInLedger.length}｜幽灵配置 ${ghostInLedger.length}｜seed 漂移 ${seedMismatch.length}｜seed 缺失 ${seedIncomplete.length}｜路径不一致 ${pathMismatch.length}`,
    clean ? "仓库与台账一致" : "有差异：以台账为准修正仓库，或反之——但必须显式改一处，不允许长期并存两个版本",
  ];
  if (warnings.length) summary.push(`配置自身告警 ${warnings.length} 条（种子多来源、字段名不合口径等）`);

  return {
    root: scan.root,
    configDir: scan.configDir,
    scannedFiles: scan.files.length,
    missingInLedger,
    ghostInLedger,
    seedMismatch,
    seedIncomplete,
    pathMismatch,
    unparsed: scan.unparsed,
    warnings,
    notes,
    summary,
  };
}
