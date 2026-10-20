// 路由完成后再注入，避免影响其他供应商的回退请求。
export function onProvider(body, ctx) {
  if (ctx?.protocol !== "responses" || ctx.provider?.id !== "grok") return;
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  if (body.tool_choice != null && body.tool_choice !== "auto") return;
  if (body.tools != null && !Array.isArray(body.tools)) return;
  const tools = body.tools || [];
  if (tools.some(tool => tool?.type === "x_search")) return;
  return { ...body, tools: [...tools, { type: "x_search" }] };
}
