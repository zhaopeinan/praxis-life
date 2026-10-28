/**
 * 把白泽 Bot 控制面嵌进知行人生的同一个 Hono 应用：
 * - 一切白泽路由挂在 /assistant 前缀下（HTTP 由子应用承接，WS 由 listen.ts 升级分发）；
 * - 账号统一：知行人生的 duowei_session 是唯一会话，首次访问按需 provisioning 出白泽用户行；
 * - BAIZE_ENABLED 不设时这里什么都不做，知行人生单独跑不受影响。
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { parse as parseCookie } from "hono/utils/cookie";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Accounts } from "../accounts.js";
import type { Store } from "../store.js";
import { COOKIE, readSecret } from "../server.js";
import { baizeConfig } from "./config.js";

export const BAIZE_PATH_PREFIX = "/assistant";
export const MODEL_GATEWAY_SETTING_KEY = "model_gateway";

type ProvisionExternalUser = (
  db: import("@baize/control-plane").Db,
  input: { readonly id: string; readonly name: string; readonly email: string },
) => Promise<import("@baize/shared").User>;

export type Handles = {
  readonly db: import("@baize/control-plane").Db;
  readonly webDir: string | null;
  readonly upgrade: (pathname: string, request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  readonly close: () => Promise<void>;
};

let booting: Promise<Handles | null> | null = null;
let handles: Handles | null = null;
let provision: ProvisionExternalUser | null = null;

export function mountBaize(app: Hono, accounts: Accounts, store: Store): void {
  const config = baizeConfig();
  if (config === null) return;

  const boot = bootBaize(app, accounts, store);

  // 知行人生会话 → 白泽用户。白泽子应用自己的认证中间件在 external 模式下只验这个 user 存在。
  // health 和例行 webhook 是白泽的公开面，不拦（子应用内部也各认一份白名单）。
  const publicHook = new RegExp(`^${BAIZE_PATH_PREFIX}/api/hooks/[^/]+$`);
  app.use(`${BAIZE_PATH_PREFIX}/api/*`, async (c, next) => {
    if (c.req.path === `${BAIZE_PATH_PREFIX}/api/health` || publicHook.test(c.req.path)) return next();
    const current = await boot;
    const provisionExternalUser = provision;
    if (current === null || provisionExternalUser === null) return c.json({ error: "白泽子系统没起来" }, 503);
    const duo = await accounts.userFromSecret(readSecret(c));
    if (duo === null || duo.kind === "agent") return c.json({ error: "请先登录" }, 401);
    if (duo.disabled) return c.json({ error: "账号已停用" }, 403);
    const user = await provisionExternalUser(current.db, { id: duo.id, name: duo.name, email: duo.email });
    c.set("user" as never, user);
    await next();
  });

  // 白泽 Web 构建产物。文件不存在的路径落到 notFound，由它回 index.html 做 SPA 兜底。
  if (config.webDir) {
    app.use(
      `${BAIZE_PATH_PREFIX}/*`,
      serveStatic({ root: config.webDir, rewriteRequestPath: (p) => (p === BAIZE_PATH_PREFIX ? "/index.html" : p) }),
    );
  }
}

function bootBaize(app: Hono, accounts: Accounts, store: Store): Promise<Handles | null> {
  booting ??= (async (): Promise<Handles | null> => {
    const config = baizeConfig();
    if (config === null) return null;
    const controlPlane = await import("@baize/control-plane");
    provision = controlPlane.provisionExternalUser;
    const { db, sql } = controlPlane.connect(config.dbUrl, { max: 10 });
    try {
      await controlPlane.runMigrations(sql);
      const runtime = await controlPlane.buildRuntime({
        db,
        config: {
          ...controlPlane.DEFAULT_RUNTIME_CONFIG,
          upstreamBaseUrl: "",
          upstreamApiKey: "",
        },
        toolSecretKey: config.toolSecretKey,
        credentialsKey: config.credentialsKey,
        auth: "external",
        pathPrefix: BAIZE_PATH_PREFIX,
        externalUserFromRequest: (request) => duoUserFromRequest(accounts, request),
        upstreamProvider: modelGatewayProvider(store),
      });
      // 运行时建成才挂路由：静态伺服在 createApp 里更早注册，文件不存在的路径会落到这边来。
      app.route(BAIZE_PATH_PREFIX, runtime.app);
      handles = {
        db,
        webDir: config.webDir,
        upgrade: runtime.upgrade,
        close: async () => {
          await runtime.close();
          await sql.end();
        },
      };
      return handles;
    } catch (error) {
      console.error("白泽子系统启动失败", error);
      await sql.end().catch(() => undefined);
      return null;
    }
  })();
  return booting;
}

/** listen.ts 在 serve() 之前 await：PG 起不来就不监听，别带病上线。 */
export async function baizeReady(): Promise<void> {
  if (booting === null) return;
  const current = await booting;
  if (current === null) throw new Error("白泽子系统启动失败，见日志");
}

/** listen.ts 在 baizeReady() 之后调用，boot 必然已落定。 */
export function baizeHandles(): Handles | null {
  return handles;
}

async function duoUserFromRequest(
  accounts: Accounts,
  request: IncomingMessage,
): Promise<{ id: string; name: string; email: string } | null> {
  const token = parseCookie(request.headers.cookie ?? "")[COOKIE] ?? null;
  if (token === null) return null;
  const duo = await accounts.userFromSecret(token);
  if (duo === null || duo.kind === "agent" || duo.disabled) return null;
  return { id: duo.id, name: duo.name, email: duo.email };
}

let routeCache: { at: number; route: import("@baize/control-plane").UpstreamRoute | null } | null = null;

/**
 * 模型网关配置实时读知行人生的 app_settings（管理员在前端改），2 秒缓存抗并发，
 * 保存后最迟 2 秒生效；没配或配得不全返回 null，网关回一句人话 502。
 */
function modelGatewayProvider(store: Store): () => Promise<import("@baize/control-plane").UpstreamRoute | null> {
  return async () => {
    if (routeCache !== null && Date.now() - routeCache.at < 2_000) return routeCache.route;
    const raw = await store.getAppSetting(MODEL_GATEWAY_SETTING_KEY);
    let route: import("@baize/control-plane").UpstreamRoute | null = null;
    if (raw !== null) {
      try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        const baseUrl = typeof v["upstreamBaseUrl"] === "string" ? v["upstreamBaseUrl"].replace(/\/+$/, "") : "";
        const apiKey = typeof v["apiKey"] === "string" ? v["apiKey"] : "";
        const plan = typeof v["planModel"] === "string" ? v["planModel"] : "";
        const fast = typeof v["fastModel"] === "string" ? v["fastModel"] : "";
        if (baseUrl !== "" && apiKey !== "" && plan !== "" && fast !== "") {
          route = { baseUrl, apiKey, models: { plan, fast } };
        }
      } catch {
        route = null;
      }
    }
    routeCache = { at: Date.now(), route };
    return route;
  };
}
