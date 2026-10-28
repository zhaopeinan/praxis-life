import { serve } from "@hono/node-server";
import { accounts, backup, init, store } from "./context.js";
import { BAIZE_PATH_PREFIX, baizeHandles, baizeReady } from "./baize/index.js";
import { createApp } from "./server.js";

await init();
const port = Number(process.env.DUOWEI_PORT ?? 8787);
const hostname = process.env.DUOWEI_HOST ?? "127.0.0.1";
const app = createApp(store, accounts, backup);
// PG 起不来就干脆不监听，别带病上线。
await baizeReady();
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`知行人生 API http://${info.address}:${info.port}`);
});

// 白泽的三条 WebSocket（/assistant/agent、/assistant/api/ws、/assistant/api/live/*）在这里升级分发。
const baize = baizeHandles();
if (baize) {
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname.startsWith(BAIZE_PATH_PREFIX)) {
      baize.upgrade(pathname, request, socket, head);
      return;
    }
    socket.destroy();
  });
}

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
    const baize = baizeHandles();
    store.usage
      .flush()
      .catch((error) => console.error("usage flush on exit failed", error))
      .finally(() => {
        const done = () => process.exit(0);
        if (baize) void baize.close().catch(() => undefined).finally(done);
        else done();
      });
  });
}
