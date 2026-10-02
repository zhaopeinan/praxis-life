import type { Field } from "../../src/types.js";

/**
 * 常见「状态类」字段名。一键转看板时优先挑这些名字的字段分组，
 * 因为用户说「带状态的表格转看板」时，想要的多半就是它。
 */
const STATUS_HINTS = [
  "状态",
  "阶段",
  "进度",
  "优先级",
  "status",
  "stage",
  "state",
  "phase",
  "priority",
  "progress",
];

/** 表里没有单选字段时，转看板会新建这个字段兜底 */
export const DEFAULT_STATUS_FIELD = "状态";
export const DEFAULT_STATUS_OPTIONS = ["待办", "进行中", "已完成", "已搁置"];

/**
 * 从字段里挑一个最适合当看板分组的单选字段。
 * 排序依据：名字像不像状态字段 → 选项数量是否适中（2-8 个，分列既不挤也不至于只剩一列）。
 * 没有任何单选字段时返回 null，调用方需要自己决定是否新建字段。
 */
export function pickStatusField(fields: Field[]): Field | null {
  const selects = fields.filter((field) => field.type === "single_select");
  if (selects.length === 0) return null;
  const scored = selects.map((field) => {
    const lower = field.name.toLowerCase();
    const hintIndex = STATUS_HINTS.findIndex((hint) => lower.includes(hint.toLowerCase()));
    const optionCount = field.config.options?.length ?? 0;
    return {
      field,
      hintRank: hintIndex === -1 ? STATUS_HINTS.length : hintIndex,
      shapePenalty: optionCount >= 2 && optionCount <= 8 ? 0 : 1,
    };
  });
  scored.sort((a, b) => a.hintRank - b.hintRank || a.shapePenalty - b.shapePenalty);
  return scored[0].field;
}
