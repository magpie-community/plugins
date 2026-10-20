export const DISABLED_TOOL = {
  name: "__magpie_x_search_disabled",
  description: "Magpie X Search Bridge: preserve disabled tool choice.",
  parameters: { type: "object", properties: {} },
};

// 路由完成后再注入，避免影响其他供应商的回退请求。
export function onProvider(body, ctx) {
  if (ctx?.provider?.id !== "grok") return;
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  if (body.tools != null && !Array.isArray(body.tools)) return;
  const tools = body.tools || [];
  // 转换会丢弃没有工具定义的 none；占位工具在供应商 fetch 中移除。
  if (ctx.protocol === "chat" && body.tool_choice === "none") {
    return { ...body, tools: [...tools, { type: "function", function: DISABLED_TOOL }] };
  }
  if (ctx.protocol === "anthropic" && body.tool_choice?.type === "none") {
    const { parameters, ...tool } = DISABLED_TOOL;
    return { ...body, tools: [...tools, { ...tool, input_schema: parameters }] };
  }
  if (ctx.protocol === "gemini" && body.toolConfig?.functionCallingConfig?.mode === "NONE") {
    return { ...body, tools: [...tools, { functionDeclarations: [DISABLED_TOOL] }] };
  }
  if (ctx.protocol !== "responses") return;
  if (body.tool_choice != null && body.tool_choice !== "auto") return;
  if (tools.some(tool => tool?.type === "x_search")) return;
  return { ...body, tools: [...tools, { type: "x_search" }] };
}
