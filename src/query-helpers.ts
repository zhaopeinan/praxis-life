import type { DisplayValue } from "./types.js";

export function isEmptyValue(value: DisplayValue | undefined): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
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
