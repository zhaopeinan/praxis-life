/**
 * 合并后的开发启动：知行人生后端（8787，含白泽子系统）+ 知行人生 Vite（5174，/assistant 代理到 8787）。
 * 读 .env 的 KEY=value（不展开变量），shell 里已有的变量优先。白泽 Web 要单独调试用 5173 起
 * `pnpm --filter @baize/web dev`（proxy 已认 BAIZE_BASE）。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const envFromFile = {};
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      envFromFile[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
const env = { ...envFromFile, ...process.env };

const procs = [
  ["server", "node_modules/.bin/tsx", ["watch", "src/listen.ts"]],
  ["web", "node_modules/.bin/vite", []],
];

for (const [name, cmd, args] of procs) {
  const child = spawn(cmd, args, { env, stdio: "inherit", shell: false });
  child.on("exit", (code) => {
    console.log(`[${name}] exited ${code}`);
    process.exitCode = code ?? 1;
    for (const other of procs) other[3]?.kill("SIGTERM");
  });
  procs.find((p) => p[0] === name)[3] = child;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const [, , , child] of procs) child?.kill(signal);
  });
}
