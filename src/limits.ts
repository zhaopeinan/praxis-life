import type { FieldType } from "./types.js";

/** DuoWei soft/hard caps aligned with Feishu help-center「常见上限」. */
export const LIMITS = {
  tablesPerBase: 300,
  fieldsPerTable: 300,
  formulaAndLookupPerTable: 100,
  viewsPerTable: 200,
  groupsPerView: 3,
  filtersPerView: 50,
  optionsPerSelect: 10_000,
  attachmentsPerCell: 100,
  personPerCell: 100,
  groupPerCell: 10,
  linkPerCell: 500,
  urlPerCell: 500,
  phoneMaxLen: 64,
  textMaxLen: 100_000,
  /** Max rows converted in-place when changing field type. */
  fieldTypeChangeMaxRows: 20_000,
  /** Above this row count, field changes are serialized (Feishu-like). */
  fieldChangeConstraintMinRows: 100_000,
} as const;

export type LimitsSnapshot = typeof LIMITS & {
  description: string;
  cellCaps: Array<{ type: string; cap: string }>;
};

export function getLimitsSnapshot(): LimitsSnapshot {
  return {
    ...LIMITS,
    description: "知行人生自托管上限（表格类产品常见上限）",
    cellCaps: [
      { type: "text / long_text", cap: `字数 ≤ ${LIMITS.textMaxLen}` },
      { type: "person", cap: `个数 ≤ ${LIMITS.personPerCell}` },
      { type: "phone", cap: `数字长度 ≤ ${LIMITS.phoneMaxLen}` },
      { type: "url", cap: `个数 ≤ ${LIMITS.urlPerCell}` },
      { type: "attachment", cap: `个数 ≤ ${LIMITS.attachmentsPerCell}` },
      { type: "link / duplex_link", cap: `个数 ≤ ${LIMITS.linkPerCell}` },
      { type: "group", cap: `个数 ≤ ${LIMITS.groupPerCell}` },
    ],
  };
}

/** Types that cannot change after creation. */
export const IMMUTABLE_FIELD_TYPES = new Set<FieldType>([
  "created_time",
  "updated_time",
  "created_by",
  "auto_number",
  "formula",
  "lookup",
  "button",
]);

const COMPATIBLE: Record<string, FieldType[]> = {
  text: ["long_text", "url", "email", "phone", "barcode", "single_select", "multi_select", "number"],
  long_text: ["text", "url"],
  number: ["text", "currency", "rating", "progress", "single_select"],
  currency: ["number", "text", "rating"],
  rating: ["number", "text", "currency"],
  progress: ["number", "text"],
  single_select: ["multi_select", "text"],
  multi_select: ["single_select", "text"],
  checkbox: ["text", "number"],
  date: ["text"],
  email: ["text"],
  phone: ["text"],
  url: ["text"],
  person: ["text", "multi_select", "group"],
  group: ["text", "multi_select", "person"],
  barcode: ["text"],
  geolocation: ["text"],
  signature: ["text"],
  attachment: ["text"],
  link: ["text", "duplex_link"],
  duplex_link: ["text", "link"],
};

export function canChangeFieldType(from: FieldType, to: FieldType): boolean {
  if (from === to) return true;
  if (IMMUTABLE_FIELD_TYPES.has(from) || IMMUTABLE_FIELD_TYPES.has(to)) return false;
  return (COMPATIBLE[from] ?? []).includes(to);
}

export function listChangeTargets(from: FieldType): FieldType[] {
  if (IMMUTABLE_FIELD_TYPES.has(from)) return [];
  return COMPATIBLE[from] ?? [];
}
