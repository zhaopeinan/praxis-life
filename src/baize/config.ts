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
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
  readonly gatewayModels: { readonly plan: string; readonly fast: string };
  /** 白泽 Web 构建产物目录；不存在时 /assistant 只出 API，不伺服页面。 */
  readonly webDir: string | null;
};

const DEFAULT_UPSTREAM_BASE_URL = "https://api.openai.com/v1";

export function baizeConfig(): BaizeConfig | null {
  if (process.env.BAIZE_ENABLED !== "1") return null;
  const dbUrl = required("BAIZE_DATABASE_URL");
  const toolSecretKey = required("BAIZE_TOOL_SECRET_KEY");
  const credentialsKey = required("BAIZE_CREDENTIALS_KEY");
  const upstreamApiKey = process.env.BAIZE_UPSTREAM_API_KEY ?? "";
  for (const ch of upstreamApiKey) {
    if (ch.charCodeAt(0) > 127) throw new Error("BAIZE_UPSTREAM_API_KEY 必须是 ASCII");
  }
  return {
    dbUrl,
    toolSecretKey,
    credentialsKey,
    upstreamBaseUrl: process.env.BAIZE_UPSTREAM_BASE_URL ?? DEFAULT_UPSTREAM_BASE_URL,
    upstreamApiKey,
    gatewayModels: parseGatewayModels(process.env.BAIZE_GATEWAY_MODELS),
    webDir: process.env.BAIZE_WEB_DIR ?? defaultWebDir(),
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未设置：白泽子系统（BAIZE_ENABLED=1）起不来`);
  return value;
}

/** "plan=x,fast=y"，缺哪档用哪档的默认名。 */
function parseGatewayModels(raw: string | undefined): { readonly plan: string; readonly fast: string } {
  const plan = raw?.match(/(?:^|,)plan=([^,]+)/)?.[1]?.trim();
  const fast = raw?.match(/(?:^|,)fast=([^,]+)/)?.[1]?.trim();
  return { plan: plan || "baize-default", fast: fast || plan || "baize-default" };
}

function defaultWebDir(): string | null {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/web/dist");
  return existsSync(dir) ? dir : null;
}
