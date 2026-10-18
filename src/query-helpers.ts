import type { DisplayValue } from "./types.js";

export function isEmptyValue(value: DisplayValue | undefined): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function localYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(y, (m ?? 1) - 1, (d ?? 1) + days);
  return localYmd(next);
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 相对日期 token 求值：today、today+N、today-N、week_start、week_end、month_start、month_end、
 * now、now+Nh、now-Nh。普通文本返回 null，由调用方决定是否回退原文。
 * 一周按周一起算；date 字段取前十位即可，时间相关判断可用 now±Nh 的「YYYY-MM-DD HH:MM」。
 *
 * 自动化动作取值、自动化条件比较值、视图过滤器与颜色规则共用这一处实现。
 */
export function resolveDateToken(text: string, now = new Date()): string | null {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  if (key === "today") return localYmd(now);
  if (key === "now") return formatTs(now.getTime());
  const day = key.match(/^today([+-])(\d{1,4})$/);
  if (day) return addDaysYmd(localYmd(now), Number(day[2]) * (day[1] === "+" ? 1 : -1));
  const hour = key.match(/^now([+-])(\d{1,4})h$/);
  if (hour) return formatTs(now.getTime() + Number(hour[2]) * (hour[1] === "+" ? 1 : -1) * 3_600_000);
  if (key === "week_start" || key === "week_end") {
    const weekday = now.getDay();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (weekday === 0 ? -6 : 1 - weekday));
    const target = key === "week_end" ? new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6) : monday;
    return localYmd(target);
  }
  if (key === "month_start" || key === "month_end") {
    return localYmd(
      key === "month_start" ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), now.getMonth() + 1, 0),
    );
  }
  return null;
}

export function displayText(value: DisplayValue | undefined): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "string" ? item : item && typeof item === "object" && "name" in item ? String(item.name) : String(item),
      )
      .join(", ");
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object" && "lat" in value && "lng" in value) {
    const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : "";
    return label || `${value.lat}, ${value.lng}`;
  }
  return String(value);
}
