function icsEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replaceAll("\n", "\\n");
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return parts.join("\r\n");
}

function toIcsDate(value: string): string | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3]}`;
}

function toIcsStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export type IcsEvent = {
  uid: string;
  title: string;
  date: string;
  description?: string;
  updatedAt?: number;
};

export function buildIcsCalendar(input: { name: string; events: IcsEvent[] }): string {
  const now = toIcsStamp(Date.now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DuoWei//Calendar//ZH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    foldLine(`X-WR-CALNAME:${icsEscape(input.name || "知行人生日历")}`),
  ];
  for (const event of input.events) {
    const day = toIcsDate(event.date);
    if (!day) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(foldLine(`UID:${icsEscape(event.uid)}`));
    lines.push(`DTSTAMP:${event.updatedAt ? toIcsStamp(event.updatedAt) : now}`);
    lines.push(`DTSTART;VALUE=DATE:${day}`);
    lines.push(foldLine(`SUMMARY:${icsEscape(event.title || "未命名")}`));
    if (event.description) lines.push(foldLine(`DESCRIPTION:${icsEscape(event.description)}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
