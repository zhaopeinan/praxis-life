import assert from "node:assert/strict";
import { clearFormulaCache, evalFormula, evalFormulaCached, formulaCacheSize } from "./formula.js";

assert.equal(evalFormula("SUM(1,2,3)", {}), 6);
assert.equal(evalFormula("ROUND(3.1415,2)", {}), 3.14);
assert.equal(evalFormula('IF(1>0,"yes","no")', {}), "yes");
assert.equal(evalFormula('IF({完成}, "done", "todo")', { 完成: true }), "done");
assert.equal(evalFormula('ARRAYJOIN({标签}, "-")', { 标签: ["a", "b", "c"] }), "a-b-c");
assert.equal(evalFormula('CONTAIN({标题}, "需求")', { 标题: "核心需求" }), true);
assert.equal(evalFormula('CONTAINS("hello world", "world")', {}), true);
assert.equal(evalFormula('COUNTIF({分数}, ">60")', { 分数: ["50", "70", "90"] }), 2);
assert.equal(evalFormula("LEN({名})", { 名: "多维" }), 2);
assert.equal(evalFormula('VALUE("42")', {}), 42);
assert.equal(evalFormula("INT(3.9)", {}), 3);
assert.equal(evalFormula("INT(-3.9)", {}), -3);
assert.equal(evalFormula("MOD(10,3)", {}), 1);
assert.equal(evalFormula("POWER(2,10)", {}), 1024);
assert.equal(evalFormula("SQRT(9)", {}), 3);
assert.equal(evalFormula("DATE(2026,9,22)", {}), "2026-09-22");
assert.equal(evalFormula('YEAR("2026-09-22")', {}), 2026);
assert.equal(evalFormula('MONTH("2026-09-22")', {}), 9);
assert.equal(evalFormula('DAY("2026-09-22")', {}), 22);
assert.equal(evalFormula('WEEKDAY("2026-09-22")', {}), 3); // Tuesday → 3
assert.equal(evalFormula('NETWORKDAYS("2026-09-21","2026-09-25")', {}), 5);
assert.equal(evalFormula('CONCATENATE({a}, "-", {b})', { a: "x", b: "y" }), "x-y");
assert.equal(evalFormula("{数量}*{单价}", { 数量: 3, 单价: 10 }), 30);
assert.equal(evalFormula("AND({a}, {b})", { a: true, b: true }), true);
assert.equal(evalFormula("OR(false, {b})", { b: true }), true);
assert.equal(evalFormula("NOT(false)", {}), true);
assert.equal(evalFormula('UPPER("ab")', {}), "AB");
assert.equal(evalFormula('LOWER("AB")', {}), "ab");
assert.equal(evalFormula('TRIM("  x  ")', {}), "x");
assert.equal(evalFormula('LEFT("多维表格", 2)', {}), "多维");
assert.equal(evalFormula('RIGHT("多维表格", 2)', {}), "表格");
assert.equal(evalFormula('MID("ABCDEF", 2, 3)', {}), "BCD");
assert.equal(evalFormula('REPLACE("ABCDEF", 2, 3, "XY")', {}), "AXYEF");
assert.equal(evalFormula('SEARCH("cd", "abcdef")', {}), 3);
assert.equal(evalFormula('FIND("CD", "abcdef")', {}), 3);
assert.equal(evalFormula("ABS(-5)", {}), 5);
assert.equal(evalFormula("MIN(3,1,8)", {}), 1);
assert.equal(evalFormula("MAX(3,1,8)", {}), 8);
assert.equal(evalFormula("AVERAGE(2,4,6)", {}), 4);
assert.equal(evalFormula("AVG({分})", { 分: ["10", "20"] }), 15);
assert.match(String(evalFormula("TODAY()", {})), /^\d{4}-\d{2}-\d{2}$/);
assert.match(String(evalFormula("NOW()", {})), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

assert.deepEqual(evalFormula('LIST("a","b","a")', {}), ["a", "b", "a"]);
assert.deepEqual(evalFormula('UNIQUE(LIST("a","b","a","b"))', {}), ["a", "b"]);
assert.deepEqual(evalFormula('FILTER({标签}, CurrentValue="b")', { 标签: ["a", "b", "c", "b"] }), ["b", "b"]);
assert.deepEqual(evalFormula('FILTER({分数}, CurrentValue>="70")', { 分数: ["50", "70", "90"] }), ["70", "90"]);
assert.deepEqual(evalFormula('MAP({标签}, UPPER(CurrentValue))', { 标签: ["ab", "cd"] }), ["AB", "CD"]);
assert.equal(evalFormula("LET(倍, 3, {数量}*{倍})", { 数量: 4 }), 12);
assert.equal(evalFormula('LET(前缀, "ID-", CONCATENATE({前缀}, {编号}))', { 编号: "001" }), "ID-001");
assert.equal(evalFormula('SUMIF({分数}, ">60")', { 分数: ["50", "70", "90"] }), 160);
assert.equal(evalFormula('SUMIF({状态}, "完成", {金额})', { 状态: ["完成", "进行中", "完成"], 金额: ["10", "20", "5"] }), 15);
assert.equal(evalFormula('DATEDIF("2026-01-01","2026-01-11","D")', {}), 10);
assert.equal(evalFormula('DATEDIF("2026-01-15","2026-03-15","M")', {}), 2);
assert.equal(evalFormula("ISBLANK({空})", { 空: null }), true);
assert.equal(evalFormula("ISBLANK({有})", { 有: "x" }), false);
assert.equal(evalFormula("IFERROR(MOD(1,0), -1)", {}), -1);
assert.equal(evalFormula("IFERROR(SQRT(-1), 0)", {}), 0);
assert.equal(evalFormula("IFERROR(SUM(1,2), 0)", {}), 3);
assert.deepEqual(evalFormula('ARRAYJOIN(FILTER({标签}, CurrentValue!="x"), ",")', { 标签: ["a", "x", "b"] }), "a,b");
assert.equal(
  evalFormula('TABLEROWS("需求")', {}, { tables: { 需求: [{ 标题: "a" }, { 标题: "b" }] } }),
  2,
);
assert.equal(
  evalFormula('TABLESUM("迭代", "点数")', {}, { tables: { 迭代: [{ 点数: 3 }, { 点数: 5 }, { 点数: "x" }] } }),
  8,
);
assert.equal(
  evalFormula('TABLECOUNT("需求", "状态", "进行中")', {}, {
    tables: { 需求: [{ 状态: "进行中" }, { 状态: "完成" }, { 状态: "进行中" }] },
  }),
  2,
);

clearFormulaCache();
const cached1 = evalFormulaCached("{a}+{b}", { a: 1, b: 2 }, { recordId: "r1", fieldId: "f1", updatedAt: 100 });
assert.equal(cached1, 3);
assert.equal(formulaCacheSize(), 1);
const cached2 = evalFormulaCached("{a}+{b}", { a: 9, b: 9 }, { recordId: "r1", fieldId: "f1", updatedAt: 100 });
assert.equal(cached2, 3); // same updatedAt+expr → cache hit
const cached3 = evalFormulaCached("{a}+{b}", { a: 4, b: 5 }, { recordId: "r1", fieldId: "f1", updatedAt: 101 });
assert.equal(cached3, 9); // updatedAt changed → recompute
const cached4 = evalFormulaCached("{a}*{b}", { a: 4, b: 5 }, { recordId: "r1", fieldId: "f1", updatedAt: 101 });
assert.equal(cached4, 20); // expr changed → recompute

console.log("formula tests passed");
