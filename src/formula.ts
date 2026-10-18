import type { DisplayValue } from "./types.js";
import { displayText, isEmptyValue } from "./query-helpers.js";

export { displayText, isEmptyValue } from "./query-helpers.js";

function asNumber(value: DisplayValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function toArray(value: DisplayValue | undefined): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : item.name));
  }
  return [String(value)];
}

function parseArgs(inner: string): string[] {
  const args: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth += 1;
      cur += ch;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth -= 1;
      cur += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

const FN_RE =
  /\b(ARRAYJOIN|CONCATENATE|CONCAT|CONTAIN|CONTAINS|COUNTIF|COUNT|SUMIF|SUM|IFERROR|IFS|IF|ISBLANK|ROUND|LEN|VALUE|INT|MOD|POWER|SQRT|TEXT|DATE|DATEDIF|YEAR|MONTH|DAY|TODAY|NOW|WEEKDAY|NETWORKDAYS|AND|OR|NOT|UPPER|LOWER|TRIM|LEFT|RIGHT|MID|REPLACE|SEARCH|FIND|ABS|MIN|MAX|AVERAGE|AVG|FILTER|MAP|LET|UNIQUE|LIST|BLANK|TABLESUM|TABLECOUNT|TABLEROWS)\s*\(/gi;

function findInnermostCall(expr: string): { start: number; end: number; name: string; inner: string } | null {
  const re = new RegExp(FN_RE.source, "gi");
  let match: RegExpExecArray | null;
  const deferred = new Set(["FILTER", "MAP", "LET", "IFERROR"]);
  const calls: Array<{ start: number; end: number; name: string; inner: string }> = [];
  while ((match = re.exec(expr))) {
    const name = match[1];
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let quote: '"' | "'" | null = null;
    for (let i = open; i < expr.length; i++) {
      const ch = expr[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push({
            start: match.index,
            end: i,
            name: name.toUpperCase(),
            inner: expr.slice(open + 1, i),
          });
          break;
        }
      }
    }
  }
  if (!calls.length) return null;
  const deferredCalls = calls.filter((call) => deferred.has(call.name));
  const pool = deferredCalls.length ? deferredCalls : calls;
  return pool.reduce((best, call) => (!best || call.start > best.start ? call : best));
}

function serialize(value: DisplayValue): string {
  if (value == null) return "null";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return JSON.stringify(toArray(value));
  return JSON.stringify(String(value));
}

function parseDate(raw: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(`${raw.slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function matchCriteria(item: string, criteria: string): boolean {
  const m = criteria.match(/^(>=|<=|!=|<>|>|<|=)?\s*(.*)$/);
  if (!m) return item === criteria;
  const op = m[1] || "=";
  const expected = m[2];
  const left = Number(item);
  const right = Number(expected);
  if (Number.isFinite(left) && Number.isFinite(right) && expected !== "") {
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
    if (op === "<") return left < right;
    if (op === "<=") return left <= right;
    if (op === "!=" || op === "<>") return left !== right;
    return left === right;
  }
  if (op === "!=" || op === "<>") return item !== expected;
  return item === expected;
}

function truthy(value: DisplayValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return !isEmptyValue(value) && String(value).toLowerCase() !== "false" && String(value) !== "0";
}

function collectNumbers(vals: DisplayValue[]): number[] {
  const out: number[] = [];
  for (const v of vals) {
    if (Array.isArray(v)) {
      for (const item of toArray(v)) {
        const n = asNumber(item);
        if (n != null) out.push(n);
      }
    } else {
      const n = asNumber(v);
      if (n != null) out.push(n);
    }
  }
  return out;
}

export type FormulaContext = {
  /** tableName -> list of field maps */
  tables?: Record<string, Array<Record<string, DisplayValue>>>;
};

/** Evaluate formula expressions with common Feishu-like functions. */
export function evalFormula(
  expression: string,
  fields: Record<string, DisplayValue>,
  ctx?: FormulaContext,
): DisplayValue {
  try {
    return evalExpr(expression, fields, ctx);
  } catch {
    return null;
  }
}

type FormulaCacheEntry = { updatedAt: number; expr: string; value: DisplayValue };
const formulaCache = new Map<string, FormulaCacheEntry>();

/** Cache by recordId+fieldId; invalidate when record.updatedAt or expression changes. */
export function evalFormulaCached(
  expression: string,
  fields: Record<string, DisplayValue>,
  key: { recordId: string; fieldId: string; updatedAt: number },
  ctx?: FormulaContext,
): DisplayValue {
  const cacheKey = `${key.recordId}:${key.fieldId}`;
  const hit = formulaCache.get(cacheKey);
  if (hit && hit.updatedAt === key.updatedAt && hit.expr === expression) return hit.value;
  const value = evalFormula(expression, fields, ctx);
  formulaCache.set(cacheKey, { updatedAt: key.updatedAt, expr: expression, value });
  return value;
}

export function clearFormulaCache(): void {
  formulaCache.clear();
}

export function formulaCacheSize(): number {
  return formulaCache.size;
}

function evalExpr(expression: string, fields: Record<string, DisplayValue>, ctx?: FormulaContext): DisplayValue {
  let expr = expression.trim();
  if (!expr) return null;
  if (/^\{[^}]+\}$/.test(expr)) return fields[expr.slice(1, -1).trim()] ?? null;
  if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  if (/^(true|false)$/i.test(expr)) return expr.toLowerCase() === "true";
  if (/^null$/i.test(expr)) return null;
  if (expr.startsWith("[") && expr.endsWith("]")) {
    try {
      const parsed = JSON.parse(expr) as unknown;
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      /* fall through */
    }
  }

  if (Object.prototype.hasOwnProperty.call(fields, "CurrentValue")) {
    expr = injectCurrentValue(expr, fields.CurrentValue ?? null);
  }

  for (let guard = 0; guard < 40; guard++) {
    const call = findInnermostCall(expr);
    if (!call) break;
    const result = callFn(call.name, parseArgs(call.inner), fields, ctx);
    expr = expr.slice(0, call.start) + serialize(result) + expr.slice(call.end + 1);
  }

  expr = expr.replace(/\{([^}]+)\}/g, (_, name: string) => serialize(fields[name.trim()] ?? null));

  const trimmed = expr.trim();

  // 结构化表达式：算术（+ - * /）与比较（= == != <> < <= > >=），支持括号、数字、字符串与布尔。
  // 让「本年度值 − 上年度值」「摘要修订轮次 < 当前工序序号」「TABLECOUNT(…) != 3」这类
  // 同行/跨表表达式可以求值；解析失败则按原文回退（普通文本原样返回）。
  // 必须放在「整串带引号」的启发式之前，否则 `"a" < "b"` 会被误判成一个字符串。
  const parsed = evaluateExpression(trimmed);
  if (parsed !== NOT_AN_EXPRESSION) return parsed;

  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;

  if (!/^[\d\s+\-*/().]+$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.replace(/^"|"$/g, "");
    }
  }
  const result = Function(`"use strict"; return (${trimmed});`)();
  if (typeof result === "number" && Number.isFinite(result)) return result;
  if (typeof result === "boolean") return result;
  return result == null ? null : String(result);
}

const NOT_AN_EXPRESSION = Symbol("not-an-expression") as unknown as DisplayValue;
type ExprToken = { kind: "number"; value: number } | { kind: "string"; value: string } | { kind: "op"; value: string };

function tokenizeExpression(text: string): ExprToken[] | null {
  const tokens: ExprToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== ch) {
        value += text[j];
        j += 1;
      }
      if (j >= text.length) return null;
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    const num = text.slice(i).match(/^-?\d+(\.\d+)?/);
    if (num && /[\d.]/.test(ch)) {
      tokens.push({ kind: "number", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const op = text.slice(i).match(/^(<=|>=|<>|!=|==|=|<|>|\+|-|\*|\/|\(|\))/);
    if (!op) return null;
    tokens.push({ kind: "op", value: op[0] });
    i += op[0].length;
  }
  return tokens;
}

/** 求值算术 / 比较表达式；不是合法表达式时返回 NOT_AN_EXPRESSION，由调用方回退。 */
function evaluateExpression(text: string): DisplayValue | typeof NOT_AN_EXPRESSION {
  if (!/[<>=!+\-*/()]/.test(text)) return NOT_AN_EXPRESSION;
  // 裸日期 / 时间戳原样保留，别把 `2026-10-18` 拆成减法算出 1998。
  if (/^\d{4}-\d{2}-\d{2}(\s\d{2}:\d{2}(:\d{2})?)?$/.test(text)) return NOT_AN_EXPRESSION;
  const tokens = tokenizeExpression(text);
  if (!tokens || !tokens.length) return NOT_AN_EXPRESSION;
  let pos = 0;
  const peek = (): ExprToken | null => tokens[pos] ?? null;
  const isOp = (token: ExprToken | null, value: string): boolean => token?.kind === "op" && token.value === value;

  const compareOperand = (v: DisplayValue): number | string => {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v == null) return "";
    const asNum = asNumber(String(v));
    if (asNum != null && String(asNum) === String(v).trim()) return asNum;
    return String(v);
  };
  const compare = (op: string, left: DisplayValue, right: DisplayValue): boolean => {
    const a = compareOperand(left);
    const b = compareOperand(right);
    if (op === "=" || op === "==") return typeof a === typeof b ? a === b : String(a) === String(b);
    if (op === "!=" || op === "<>") return typeof a === typeof b ? a !== b : String(a) !== String(b);
    if (typeof a === "number" && typeof b === "number") {
      if (op === "<") return a < b;
      if (op === "<=") return a <= b;
      if (op === ">") return a > b;
      return a >= b;
    }
    const sa = String(a);
    const sb = String(b);
    if (op === "<") return sa < sb;
    if (op === "<=") return sa <= sb;
    if (op === ">") return sa > sb;
    return sa >= sb;
  };

  // expr := cmp; cmp := sum ((< <= > >= = == != <>)) sum; sum := term ((+|-) term)*; term := factor ((*|/) factor)*
  function parseCmp(): DisplayValue {
    const left = parseSum();
    const token = peek();
    if (token?.kind === "op" && ["<", "<=", ">", ">=", "=", "==", "!=", "<>"].includes(token.value)) {
      pos += 1;
      const right = parseSum();
      return compare(token.value, left, right);
    }
    return left;
  }
  function parseSum(): DisplayValue {
    let value = parseTerm();
    while (true) {
      const token = peek();
      if (!isOp(token, "+") && !isOp(token, "-")) return value;
      pos += 1;
      const right = parseTerm();
      const a = asNumber(typeof value === "string" || typeof value === "number" ? value : null) ?? 0;
      const b = asNumber(typeof right === "string" || typeof right === "number" ? right : null) ?? 0;
      value = isOp(token, "+") ? a + b : a - b;
    }
  }
  function parseTerm(): DisplayValue {
    let value = parseFactor();
    while (true) {
      const token = peek();
      if (!isOp(token, "*") && !isOp(token, "/")) return value;
      pos += 1;
      const right = parseFactor();
      const a = asNumber(typeof value === "string" || typeof value === "number" ? value : null) ?? 0;
      const b = asNumber(typeof right === "string" || typeof right === "number" ? right : null) ?? 0;
      value = isOp(token, "*") ? a * b : b === 0 ? null : a / b;
    }
  }
  function parseFactor(): DisplayValue {
    const token = peek();
    if (!token) throw new Error("unexpected end");
    if (token.kind === "number") {
      pos += 1;
      return token.value;
    }
    if (token.kind === "string") {
      pos += 1;
      return token.value;
    }
    if (token.kind === "op") {
      if (token.value === "(") {
        pos += 1;
        const value = parseCmp();
        if (!isOp(peek(), ")")) throw new Error("missing )");
        pos += 1;
        return value;
      }
      if (token.value === "-") {
        pos += 1;
        const inner = parseFactor();
        const n = asNumber(typeof inner === "string" || typeof inner === "number" ? inner : null) ?? 0;
        return -n;
      }
      if (token.value === "+") {
        pos += 1;
        return parseFactor();
      }
    }
    throw new Error("unexpected token");
  }

  try {
    const value = parseCmp();
    if (pos !== tokens.length) return NOT_AN_EXPRESSION;
    if (value == null) return null;
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  } catch {
    return NOT_AN_EXPRESSION;
  }
}

function injectCurrentValue(expr: string, value: DisplayValue): string {
  const replacement = (): string => {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") {
      const n = asNumber(value);
      if (n != null && String(n) === value.trim()) return String(n);
    }
    return serialize(value);
  };
  return expr.replace(/\{CurrentValue\}/gi, replacement).replace(/\bCurrentValue\b/g, replacement);
}

function callFn(name: string, args: string[], fields: Record<string, DisplayValue>, ctx?: FormulaContext): DisplayValue {
  // Deferred-arg functions need the raw expression strings (CurrentValue / LET bindings).
  if (name === "FILTER" || name === "MAP" || name === "LET" || name === "IFERROR") {
    return callDeferredFn(name, args, fields);
  }

  if (name === "TABLEROWS" || name === "TABLESUM" || name === "TABLECOUNT") {
    const tableName = displayText(evalExpr(args[0] ?? '""', fields, ctx));
    const rows = ctx?.tables?.[tableName] ?? [];
    if (name === "TABLEROWS") return rows.length;
    const fieldName = displayText(evalExpr(args[1] ?? '""', fields, ctx));
    if (name === "TABLESUM") {
      let sum = 0;
      for (const row of rows) {
        const n = asNumber(row[fieldName]);
        if (n != null) sum += n;
      }
      return sum;
    }
    const criteria = args[2] != null ? displayText(evalExpr(args[2], fields, ctx)) : "";
    if (!criteria) return rows.filter((row) => !isEmptyValue(row[fieldName])).length;
    return rows.filter((row) => matchCriteria(displayText(row[fieldName]), criteria)).length;
  }

  const vals = args.map((arg) => evalExpr(arg, fields, ctx));
  switch (name) {
    case "ARRAYJOIN": {
      const arr = toArray(vals[0]);
      const sep = vals[1] == null ? "," : displayText(vals[1]);
      return arr.join(sep);
    }
    case "CONCATENATE":
    case "CONCAT":
      return vals.map((v) => displayText(v)).join("");
    case "CONTAIN":
    case "CONTAINS": {
      const needle = displayText(vals[1]).toLowerCase();
      if (Array.isArray(vals[0])) return toArray(vals[0]).some((item) => item.toLowerCase().includes(needle));
      return displayText(vals[0]).toLowerCase().includes(needle);
    }
    case "COUNT":
      return toArray(vals[0]).length;
    case "COUNTIF": {
      const source = toArray(vals[0]);
      const criteria = displayText(vals[1]);
      return source.filter((item) => matchCriteria(item, criteria)).length;
    }
    case "SUMIF": {
      const range = toArray(vals[0]);
      const criteria = displayText(vals[1]);
      const sumRange = vals[2] != null ? toArray(vals[2]) : range;
      let sum = 0;
      for (let i = 0; i < range.length; i++) {
        if (!matchCriteria(range[i], criteria)) continue;
        sum += Number(sumRange[i] ?? 0) || 0;
      }
      return sum;
    }
    case "SUM":
      return vals.reduce<number>((sum, v) => {
        if (Array.isArray(v)) return sum + toArray(v).reduce((s, x) => s + (Number(x) || 0), 0);
        return sum + (asNumber(v) ?? 0);
      }, 0);
    case "IF":
      return truthy(vals[0]) ? (vals[1] ?? null) : (vals[2] ?? null);
    case "IFS": {
      for (let i = 0; i + 1 < vals.length; i += 2) {
        if (truthy(vals[i])) return vals[i + 1] ?? null;
      }
      return null;
    }
    case "ISBLANK":
      return isEmptyValue(vals[0]);
    case "BLANK":
      return null;
    case "LIST":
      return vals.map((v) => displayText(v));
    case "UNIQUE": {
      const source = args.length ? toArray(vals[0]) : [];
      return [...new Set(source)];
    }
    case "ROUND": {
      const n = asNumber(vals[0]) ?? 0;
      const d = asNumber(vals[1]) ?? 0;
      return Number(n.toFixed(d));
    }
    case "LEN":
      return displayText(vals[0]).length;
    case "VALUE":
      return asNumber(vals[0]) ?? 0;
    case "INT":
      return Math.trunc(asNumber(vals[0]) ?? 0);
    case "MOD": {
      const a = asNumber(vals[0]) ?? 0;
      const b = asNumber(vals[1]) ?? 1;
      if (b === 0) return null;
      return ((a % b) + b) % b;
    }
    case "POWER": {
      const base = asNumber(vals[0]) ?? 0;
      const exp = asNumber(vals[1]) ?? 1;
      return base ** exp;
    }
    case "SQRT": {
      const n = asNumber(vals[0]) ?? 0;
      return n < 0 ? null : Math.sqrt(n);
    }
    case "TEXT":
      return displayText(vals[0]);
    case "DATE": {
      const y = asNumber(vals[0]) ?? 1970;
      const m = asNumber(vals[1]) ?? 1;
      const d = asNumber(vals[2]) ?? 1;
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${y}-${pad(m)}-${pad(d)}`;
    }
    case "DATEDIF": {
      const start = parseDate(displayText(vals[0]));
      const end = parseDate(displayText(vals[1]));
      const unit = displayText(vals[2] ?? "D").toUpperCase();
      if (!start || !end) return 0;
      if (unit === "Y" || unit === "YEAR") return end.getFullYear() - start.getFullYear();
      if (unit === "M" || unit === "MONTH") {
        return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
      }
      return Math.trunc((end.getTime() - start.getTime()) / 86_400_000);
    }
    case "YEAR":
    case "MONTH":
    case "DAY": {
      const dt = parseDate(displayText(vals[0])) ?? new Date();
      if (name === "YEAR") return dt.getFullYear();
      if (name === "MONTH") return dt.getMonth() + 1;
      return dt.getDate();
    }
    case "TODAY": {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }
    case "NOW": {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    case "WEEKDAY": {
      const dt = parseDate(displayText(vals[0])) ?? new Date();
      // 1=Sunday … 7=Saturday (Excel-like default)
      return dt.getDay() + 1;
    }
    case "NETWORKDAYS": {
      const start = parseDate(displayText(vals[0]));
      const end = parseDate(displayText(vals[1]));
      if (!start || !end) return 0;
      let a = start.getTime() <= end.getTime() ? start : end;
      let b = start.getTime() <= end.getTime() ? end : start;
      let count = 0;
      const cur = new Date(a);
      while (cur.getTime() <= b.getTime()) {
        const day = cur.getDay();
        if (day !== 0 && day !== 6) count += 1;
        cur.setDate(cur.getDate() + 1);
      }
      return start.getTime() <= end.getTime() ? count : -count;
    }
    case "AND":
      return vals.every((v) => truthy(v));
    case "OR":
      return vals.some((v) => truthy(v));
    case "NOT":
      return !truthy(vals[0]);
    case "UPPER":
      return displayText(vals[0]).toUpperCase();
    case "LOWER":
      return displayText(vals[0]).toLowerCase();
    case "TRIM":
      return displayText(vals[0]).trim();
    case "LEFT": {
      const s = displayText(vals[0]);
      const n = Math.max(0, Math.floor(asNumber(vals[1]) ?? 1));
      return s.slice(0, n);
    }
    case "RIGHT": {
      const s = displayText(vals[0]);
      const n = Math.max(0, Math.floor(asNumber(vals[1]) ?? 1));
      return n === 0 ? "" : s.slice(-n);
    }
    case "MID": {
      const s = displayText(vals[0]);
      const start = Math.max(1, Math.floor(asNumber(vals[1]) ?? 1));
      const len = Math.max(0, Math.floor(asNumber(vals[2]) ?? s.length));
      return s.slice(start - 1, start - 1 + len);
    }
    case "REPLACE": {
      const s = displayText(vals[0]);
      const start = Math.max(1, Math.floor(asNumber(vals[1]) ?? 1));
      const len = Math.max(0, Math.floor(asNumber(vals[2]) ?? 0));
      const repl = displayText(vals[3]);
      return s.slice(0, start - 1) + repl + s.slice(start - 1 + len);
    }
    case "SEARCH":
    case "FIND": {
      const needle = displayText(vals[0]);
      const hay = displayText(vals[1]);
      const start = Math.max(1, Math.floor(asNumber(vals[2]) ?? 1));
      const idx = hay.toLowerCase().indexOf(needle.toLowerCase(), start - 1);
      return idx < 0 ? 0 : idx + 1;
    }
    case "ABS":
      return Math.abs(asNumber(vals[0]) ?? 0);
    case "MIN": {
      const nums = collectNumbers(vals);
      return nums.length ? Math.min(...nums) : 0;
    }
    case "MAX": {
      const nums = collectNumbers(vals);
      return nums.length ? Math.max(...nums) : 0;
    }
    case "AVERAGE":
    case "AVG": {
      const nums = collectNumbers(vals);
      if (!nums.length) return 0;
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    default:
      return null;
  }
}

function callDeferredFn(name: string, args: string[], fields: Record<string, DisplayValue>): DisplayValue {
  switch (name) {
    case "FILTER": {
      if (args.length < 2) return [];
      const list = toArray(evalExpr(args[0], fields));
      const pred = args[1].trim();
      const comparison = matchCurrentValuePredicate(pred, fields);
      if (comparison) {
        return list.filter((item) => matchCriteria(item, comparison));
      }
      return list.filter((item) => truthy(evalExpr(pred, { ...fields, CurrentValue: item })));
    }
    case "MAP": {
      if (args.length < 2) return [];
      const list = toArray(evalExpr(args[0], fields));
      const mapper = args[1];
      return list.map((item) => displayText(evalExpr(mapper, { ...fields, CurrentValue: item })));
    }
    case "LET": {
      if (args.length < 3) return null;
      const bindName = args[0].trim().replace(/^["']|["']$/g, "").replace(/^\{|\}$/g, "");
      if (!bindName) return null;
      const bindValue = evalExpr(args[1], fields);
      return evalExpr(args[2], { ...fields, [bindName]: bindValue });
    }
    case "IFERROR": {
      if (!args.length) return null;
      try {
        const value = evalExpr(args[0], fields);
        if (value == null || isEmptyValue(value) || (typeof value === "number" && !Number.isFinite(value))) {
          return args[1] != null ? evalExpr(args[1], fields) : null;
        }
        return value;
      } catch {
        return args[1] != null ? evalExpr(args[1], fields) : null;
      }
    }
    default:
      return null;
  }
}

/** Parse `CurrentValue="x"` / `CurrentValue>=70` into a matchCriteria string. */
function matchCurrentValuePredicate(pred: string, fields: Record<string, DisplayValue>): string | null {
  const m = pred.match(/^\{?CurrentValue\}?\s*(>=|<=|!=|<>|>|<|=)\s*(.+)$/i);
  if (!m) return null;
  const op = m[1];
  let expected = m[2].trim();
  if ((expected.startsWith('"') && expected.endsWith('"')) || (expected.startsWith("'") && expected.endsWith("'"))) {
    expected = expected.slice(1, -1);
  } else if (!/^-?\d+(\.\d+)?$/.test(expected)) {
    expected = displayText(evalExpr(expected, fields));
  }
  if (op === "=") return expected;
  return `${op}${expected}`;
}
