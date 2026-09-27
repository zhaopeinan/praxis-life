import type { DisplayValue, Filter, PublicRecord, RecordQuery, Sort } from "./types.js";
import { displayText, isEmptyValue } from "./query-helpers.js";
export { displayText, isEmptyValue } from "./query-helpers.js";
export { evalFormula, evalFormulaCached, clearFormulaCache, formulaCacheSize } from "./formula.js";

function asNumber(value: DisplayValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function matchesFilter(value: DisplayValue | undefined, filter: Filter): boolean {
  if (filter.op === "is_empty") return isEmptyValue(value);
  if (filter.op === "is_not_empty") return !isEmptyValue(value);

  const expected = (filter.value ?? "").trim();
  const expectedLower = expected.toLowerCase();
  const text = displayText(value).toLowerCase();
  const num = asNumber(value);
  const expectedNum = expected !== "" && Number.isFinite(Number(expected)) ? Number(expected) : null;

  if (filter.op === "eq") {
    if (Array.isArray(value)) {
      return (
        value.some((item) => displayText(typeof item === "string" ? item : [item]).toLowerCase() === expectedLower) ||
        text === expectedLower
      );
    }
    return text === expectedLower;
  }
  if (filter.op === "neq") {
    if (Array.isArray(value)) {
      return (
        !value.some((item) => displayText(typeof item === "string" ? item : [item]).toLowerCase() === expectedLower) &&
        text !== expectedLower
      );
    }
    return text !== expectedLower;
  }
  if (filter.op === "contains") {
    if (Array.isArray(value)) {
      return value.some((item) => displayText(typeof item === "string" ? item : [item]).toLowerCase().includes(expectedLower));
    }
    return text.includes(expectedLower);
  }
  if (filter.op === "not_contains") {
    if (Array.isArray(value)) {
      return !value.some((item) => displayText(typeof item === "string" ? item : [item]).toLowerCase().includes(expectedLower));
    }
    return !text.includes(expectedLower);
  }
  if (expectedNum != null && num != null) {
    if (filter.op === "gt") return num > expectedNum;
    if (filter.op === "gte") return num >= expectedNum;
    if (filter.op === "lt") return num < expectedNum;
    if (filter.op === "lte") return num <= expectedNum;
  }
  if (filter.op === "gt") return text > expectedLower;
  if (filter.op === "gte") return text >= expectedLower;
  if (filter.op === "lt") return text < expectedLower;
  if (filter.op === "lte") return text <= expectedLower;
  return false;
}

function compareValues(a: DisplayValue | undefined, b: DisplayValue | undefined): number {
  const aEmpty = isEmptyValue(a);
  const bEmpty = isEmptyValue(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return displayText(a).localeCompare(displayText(b), "zh-Hans");
}

export function applyQuery(
  records: PublicRecord[],
  fields: { id: string; name: string }[],
  query: Pick<RecordQuery, "filters" | "conjunction" | "sorts" | "limit"> = {},
): PublicRecord[] {
  const nameOf = new Map(fields.map((field) => [field.id, field.name]));
  const filters = query.filters ?? [];
  const conjunction = query.conjunction ?? "and";

  let next = records.filter((record) => {
    if (filters.length === 0) return true;
    const checks = filters.map((filter) => {
      const fieldName = nameOf.get(filter.fieldId);
      const value = fieldName ? record.fields[fieldName] : null;
      return matchesFilter(value, filter);
    });
    return conjunction === "or" ? checks.some(Boolean) : checks.every(Boolean);
  });

  const sorts = query.sorts ?? [];
  if (sorts.length > 0) {
    next = [...next].sort((a, b) => compareRecords(a, b, sorts, nameOf));
  }

  if (query.limit != null) return next.slice(0, query.limit);
  return next;
}

function compareRecords(
  a: PublicRecord,
  b: PublicRecord,
  sorts: Sort[],
  nameOf: Map<string, string>,
): number {
  for (const sort of sorts) {
    const fieldName = nameOf.get(sort.fieldId);
    const result = compareValues(
      fieldName ? a.fields[fieldName] : null,
      fieldName ? b.fields[fieldName] : null,
    );
    if (result !== 0) return sort.direction === "desc" ? -result : result;
  }
  return a.createdAt - b.createdAt;
}
