import { serve } from "@hono/node-server";
import { accounts, backup, init, store } from "./context.js";
import { createApp } from "./server.js";

await init();
const port = Number(process.env.DUOWEI_PORT ?? 8787);
const hostname = process.env.DUOWEI_HOST ?? "127.0.0.1";
serve({ fetch: createApp(store, accounts, backup).fetch, port, hostname }, (info) => {
  console.log(`知行人生 API http://${info.address}:${info.port}`);
});

const scheduleMs = Number(process.env.DUOWEI_SCHEDULE_MS ?? 60_000);
if (scheduleMs > 0) {
  setInterval(() => {
    store.runDueSchedules().catch((error) => console.error("schedule tick failed", error));
    store.processWorkflowTimeouts().catch((error) => console.error("workflow timeout tick failed", error));
    backup.tick().catch((error) => console.error("backup tick failed", error));
  }, scheduleMs).unref?.();
}
