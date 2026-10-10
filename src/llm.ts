/**
 * OpenAI 兼容的 Chat Completions 适配层。
 * 只依赖 fetch，方便接 OpenAI / DeepSeek / 通义 / 自建网关等兼容端点。
 */

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** assistant 消息里模型请求调用的工具 */
  tool_calls?: LlmToolCall[];
  /** role=tool 时对应的调用 id */
  tool_call_id?: string;
};

export type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LlmToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmChatResult = {
  content: string;
  toolCalls: LlmToolCall[];
};

export type LlmChatInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  timeoutMs?: number;
};

/** 把常见写法（…/v1、…/v1/、…/v1/chat/completions）统一成 chat/completions 地址 */
export function resolveChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("模型地址为空");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function pickMessage(raw: unknown): { content: string; toolCalls: LlmToolCall[] } {
  const message = (raw ?? {}) as Record<string, unknown>;
  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((part) => {
              if (typeof part === "string") return part;
              const piece = part as { text?: unknown };
              return typeof piece.text === "string" ? piece.text : "";
            })
            .join("")
        : "";
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: LlmToolCall[] = [];
  for (const item of rawCalls) {
    const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = call.function?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    toolCalls.push({
      id: typeof call.id === "string" && call.id.length > 0 ? call.id : name,
      type: "function",
      function: {
        name,
        arguments:
          typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {}),
      },
    });
  }
  return { content: content.trim(), toolCalls };
}

/** 从响应里抽出第一段可读的错误信息，便于回显在运行日志里 */
function extractError(status: number, text: string): string {
  const body = text.trim();
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.error?.message === "string"
            ? parsed.error.message
            : typeof parsed.message === "string"
              ? parsed.message
              : "";
      if (message) return `模型接口返回 ${status}：${message.slice(0, 400)}`;
    } catch {
      /* 非 JSON，走下面的兜底 */
    }
    return `模型接口返回 ${status}：${body.slice(0, 400)}`;
  }
  return `模型接口返回 ${status}`;
}

export async function chatCompletion(input: LlmChatInput): Promise<LlmChatResult> {
  const url = resolveChatUrl(input.baseUrl);
  if (!input.apiKey.trim()) throw new Error("未配置模型密钥");
  if (!input.model.trim()) throw new Error("未配置模型名称");
  const timeoutMs = input.timeoutMs ?? 120_000;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: input.model.trim(),
        temperature: input.temperature ?? 0.2,
        messages: input.messages.map((message) => {
          if (message.role === "tool") {
            return { role: "tool", content: message.content ?? "", tool_call_id: message.tool_call_id };
          }
          if (message.role === "assistant" && message.tool_calls?.length) {
            return { role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls };
          }
          return { role: message.role, content: message.content ?? "" };
        }),
        ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto" } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(reason)) throw new Error(`模型请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`连接模型接口失败：${reason.slice(0, 300)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(extractError(response.status, text));
  }
  const data = (await response.json().catch(() => null)) as { choices?: Array<{ message?: unknown }> } | null;
  const choice = data?.choices?.[0]?.message;
  if (!choice) throw new Error("模型接口没有返回内容");
  return pickMessage(choice);
}
