/**
 * 白泽 Web 挂在哪个前缀下。独立运行是 ""（根路径），嵌进知行人生构建时注入 VITE_BAIZE_BASE=/assistant。
 * 所有 API、WebSocket、跳转都走这个常量，不再写根相对的 "/api"。
 */
export const BASE: string = (import.meta.env.VITE_BAIZE_BASE as string | undefined) ?? "";
