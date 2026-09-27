export type FeishuSendResult = { ok: boolean; status: number; message: string };

function isFeishuWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname.endsWith("feishu.cn") || parsed.hostname.endsWith("larksuite.com")) &&
      parsed.pathname.includes("/open-apis/bot/v2/hook/")
    );
  } catch {
    return false;
  }
}

export function normalizeFeishuWebhook(url: string | undefined): string | null {
  const value = url?.trim() ?? "";
  if (!value) return null;
  if (!isFeishuWebhook(value)) return null;
  return value;
}

export async function sendFeishuText(webhookUrl: string, text: string): Promise<FeishuSendResult> {
  const url = normalizeFeishuWebhook(webhookUrl);
  if (!url) return { ok: false, status: 400, message: "飞书机器人地址无效" };
  const body = JSON.stringify({
    msg_type: "text",
    content: { text: text.slice(0, 4000) || "（空消息）" },
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const raw = await response.text();
    let message = raw.slice(0, 200);
    try {
      const parsed = JSON.parse(raw) as { code?: number; msg?: string };
      if (parsed.msg) message = parsed.msg;
      if (parsed.code != null && parsed.code !== 0) {
        return { ok: false, status: response.status, message };
      }
    } catch {
      /* not json */
    }
    if (!response.ok) return { ok: false, status: response.status, message };
    return { ok: true, status: response.status, message };
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
  }
}
