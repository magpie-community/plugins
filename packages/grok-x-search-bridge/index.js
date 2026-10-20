import { GrokAuthPlugin } from "@magpie-community/opencode-grok-auth";
import { DISABLED_TOOL, onProvider } from "./grok-x-search-bridge.middleware.js";

function prepare(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  if (body.tools != null && !Array.isArray(body.tools)) return;
  if (body.tool_choice === "none") {
    const tools = (body.tools || []).filter(
      tool => !(tool?.type === "function" && tool.name === DISABLED_TOOL.name &&
        tool.description === DISABLED_TOOL.description),
    );
    const next = { ...body, tools };
    // Grok 不接受空工具列表与 none 同时出现；没有工具时也不允许注入搜索。
    if (!tools.length) delete next.tool_choice;
    return next;
  }
  return onProvider(body, { protocol: "responses", provider: { id: "grok" } });
}

function wrapFetch(options) {
  return function (input, init) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!url.pathname.endsWith("/responses") || typeof init?.body !== "string") {
      return options.fetch.call(options, input, init);
    }
    let body;
    try { body = JSON.parse(init.body); } catch {
      return options.fetch.call(options, input, init);
    }
    const next = prepare(body);
    return options.fetch.call(options, input,
      next === undefined ? init : { ...init, body: JSON.stringify(next) });
  };
}

export async function GrokXSearchBridge(ctx) {
  const hooks = await GrokAuthPlugin(ctx);
  const loader = hooks.auth.loader;
  hooks.auth.loader = async function (...args) {
    const options = await loader.apply(this, args);
    return typeof options.fetch === "function"
      ? { ...options, fetch: wrapFetch(options) }
      : options;
  };
  return hooks;
}

export const _internal = { prepare, wrapFetch };
