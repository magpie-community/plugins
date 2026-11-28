import { activity } from "./lib/activity.mjs";
import { nativePolicy } from "./lib/agents.mjs";
import { bankVerifier } from "./lib/banks.mjs";
import { createPlugin } from "./lib/plugin.mjs";

const plugin = createPlugin({ nativePolicy, observe: activity.observe, checkBank: bankVerifier() });

function internal(ctx, phase) {
  console.error("[magpie-hindsight] unexpected " + phase + " hook error");
  try { ctx?.report?.("internal"); } catch { /* Diagnostics never affect traffic. */ }
}

export async function onRequest(body, ctx) {
  try { return await plugin.onRequest(body, ctx); }
  catch { internal(ctx, "request"); return undefined; }
}

export async function onResponse(reply, ctx) {
  try { return await plugin.onResponse(reply, ctx); }
  catch { internal(ctx, "response"); return undefined; }
}
