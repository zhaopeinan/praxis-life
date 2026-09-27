import type { PluginHookEvent } from "./types.js";

export type PluginPayload = {
  event: PluginHookEvent;
  tableId: string;
  recordId?: string;
  at: number;
  detail?: Record<string, unknown>;
};

type Handler = (payload: PluginPayload) => void | Promise<void>;

const handlers = new Map<string, Handler>();
const log: PluginPayload[] = [];

/** Register an in-process plugin handler (id used as hook target). */
export function registerPluginHandler(id: string, handler: Handler): void {
  handlers.set(id, handler);
}

export function listPluginHandlers(): string[] {
  return [...handlers.keys()];
}

export async function emitPluginEvent(payload: PluginPayload, targets: string[]): Promise<void> {
  log.push(payload);
  if (log.length > 200) log.shift();
  for (const target of targets) {
    const handler = handlers.get(target);
    if (handler) {
      await handler(payload);
      continue;
    }
    if (target.startsWith("http://") || target.startsWith("https://")) {
      try {
        await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        /* best-effort webhook */
      }
    }
  }
}

export function recentPluginEvents(limit = 20): PluginPayload[] {
  return log.slice(-limit);
}

// built-in sample handler for tests / demo
registerPluginHandler("log", (payload) => {
  console.log(`[plugin:log] ${payload.event} table=${payload.tableId} record=${payload.recordId ?? "-"}`);
});
