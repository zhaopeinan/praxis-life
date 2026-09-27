import { serve } from "@hono/node-server";
import { accounts, init, store } from "./context.js";
import { createApp } from "./server.js";

await init();
const port = Number(process.env.DUOWEI_PORT ?? 8787);
const hostname = process.env.DUOWEI_HOST ?? "127.0.0.1";
serve({ fetch: createApp(store, accounts).fetch, port, hostname }, (info) => {
  console.log(`多维 API http://${info.address}:${info.port}`);
});

const scheduleMs = Number(process.env.DUOWEI_SCHEDULE_MS ?? 60_000);
if (scheduleMs > 0) {
  setInterval(() => {
    store.runDueSchedules().catch((error) => console.error("schedule tick failed", error));
  }, scheduleMs).unref?.();
}
