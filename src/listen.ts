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

// 容器被 stop/restart 时把最后一批用量落库，避免最近几秒的计数留在内存里丢掉。
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    store.usage
      .flush()
      .catch((error) => console.error("usage flush on exit failed", error))
      .finally(() => process.exit(0));
  });
}
