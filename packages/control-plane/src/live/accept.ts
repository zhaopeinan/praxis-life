import { LiveId, LiveViewerClose, type User } from "@zhixingbot/shared";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import type { LiveRelay } from "./relay.js";

export const LIVE_PATH = /^\/api\/live\/([^/]+)$/;

/**
 * cookie 认人（独立模式认 baize_session，嵌入模式由调用方注入宿主解析器），跟 /api/ws 同一个身份。
 * 另外查 Origin：带了 Origin 而它的 host 不等于 Host 头就 403。会话 cookie 是 Lax，但这条 socket
 * 能往用户已登录的网站里打字，跨站劫持的后果比推送大，所以多这一道。没有 Origin 的（非浏览器客户端，
 * 测试）放行，它们本来就得自己带 cookie。
 * 路径里的号不合法和会话不存在一样回 notFound，网页只需要认一种「没有这个画面」。
 */
export function acceptLiveViewer(
  deps: {
    readonly viewers: WebSocketServer;
    readonly relay: Pick<LiveRelay, "attachViewer">;
    /** 嵌入模式下带挂载前缀（^/assistant/api/live/...），独立模式用导出的 LIVE_PATH。 */
    readonly livePath: RegExp;
    readonly resolveUser: (request: IncomingMessage) => Promise<User | null>;
  },
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  if (!sameOrigin(request)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  void deps.resolveUser(request)
    .then((user) => {
      if (user === null) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      deps.viewers.handleUpgrade(request, socket, head, (ws) => {
        // ws 遇到超过 maxPayload 之类的协议错误先 emit error 再自己关，没人监听的 error 会变成未捕获异常。
        ws.on("error", () => ws.close());
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const liveId = LiveId.safeParse(deps.livePath.exec(path)?.[1]);
        if (liveId.success) deps.relay.attachViewer(user.id, liveId.data, ws);
        else ws.close(LiveViewerClose.notFound, "没有这个画面");
      });
    })
    .catch(() => socket.destroy());
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}
