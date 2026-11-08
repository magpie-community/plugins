import { createPlugin } from "./lib/plugin.mjs";

const plugin = createPlugin();
const reportInternal = ctx => {
  try { ctx?.report?.("internal"); } catch { /* Diagnostics never affect traffic. */ }
};

export async function onRequest(body, ctx) {
  try { return await plugin.onRequest(body, ctx); }
  catch (error) {
    // The host otherwise reports only a generic failure. Keep diagnostics to the
    // error class/message; request bodies, memories and credentials are excluded.
    console.error(`[magpie-hindsight] onRequest ${error?.name || "Error"}: ${error?.message || "unknown"}`);
    reportInternal(ctx);
    return undefined;
  }
}

export async function onResponse(reply, ctx) {
  try { return await plugin.onResponse(reply, ctx); }
  catch (error) {
    console.error(`[magpie-hindsight] onResponse ${error?.name || "Error"}: ${error?.message || "unknown"}`);
    reportInternal(ctx);
    return undefined;
  }
}
