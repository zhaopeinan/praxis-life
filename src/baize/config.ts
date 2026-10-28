/**
 * 白泽 Bot 子系统的环境配置。知行人生本身只用 DUOWEI_* 变量，这里全部 BAIZE_ 前缀，避免撞名。
 * 不设 BAIZE_ENABLED=1 时整个挂载不发生（测试、纯知行人生部署都不受影响）。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type BaizeConfig = {
  readonly dbUrl: string;
  readonly toolSecretKey: string;
  readonly credentialsKey: string;
  /** 白泽 Web 构建产物目录；不存在时 /assistant 只出 API，不伺服页面。 */
  readonly webDir: string | null;
};

export function baizeConfig(): BaizeConfig | null {
  if (process.env.BAIZE_ENABLED !== "1") return null;
  return {
    dbUrl: required("BAIZE_DATABASE_URL"),
    toolSecretKey: required("BAIZE_TOOL_SECRET_KEY"),
    credentialsKey: required("BAIZE_CREDENTIALS_KEY"),
    webDir: process.env.BAIZE_WEB_DIR ?? defaultWebDir(),
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未设置：白泽子系统（BAIZE_ENABLED=1）起不来`);
  return value;
}

function defaultWebDir(): string | null {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/web/dist");
  return existsSync(dir) ? dir : null;
}
