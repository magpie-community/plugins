import { createHash } from "node:crypto";
import { agentAllowed, configuration } from "./config.mjs";
import { ApiError, Hindsight } from "./hindsight.mjs";
import { alreadyInjected, finalAnswer, injectSystem, latestUserText, memoryBlock } from "./protocol.mjs";

const report = (ctx, code, bytes) => {
  try { ctx?.report?.(code, bytes); } catch { /* Diagnostics never affect traffic. */ }
};
const failureCode = error => error instanceof ApiError ? error.code : "invalid";

export function createPlugin({ fetcher = fetch } = {}) {
  return {
    async onRequest(body, ctx = {}) {
      let config;
      try { config = configuration(ctx.options); }
      catch { report(ctx, "invalid-options"); return undefined; }
      if (ctx.origin !== "local") { report(ctx, "skipped-remote"); return undefined; }
      if (!agentAllowed(config, ctx.agent)) { report(ctx, "skipped-agent"); return undefined; }

      const query = latestUserText(body, ctx.protocol);
      if (!query) { report(ctx, "skipped"); return undefined; }

      // Keep only plain JSON state. Capture uses this same accepted turn even if
      // recall is empty or unavailable; capture itself remains strictly opt-in.
      ctx.state ??= {};
      ctx.state.hindsight = { config, query };
      if (alreadyInjected(body, ctx.protocol)) { report(ctx, "skipped-injected"); return undefined; }

      try {
        const client = new Hindsight(config, fetcher);
        const memories = await client.recall(query, ctx.signal);
        const block = memoryBlock(memories, config.recall_max_tokens);
        if (!block) { report(ctx, "empty"); return undefined; }
        const changed = injectSystem(body, ctx.protocol, block);
        if (!changed) { report(ctx, "skipped"); return undefined; }
        report(ctx, "recalled", Buffer.byteLength(block));
        return changed;
      } catch (error) {
        report(ctx, failureCode(error));
        return undefined; // Hindsight failure must never block the model request.
      }
    },

    async onResponse(reply, ctx = {}) {
      const run = ctx.state?.hindsight;
      if (!run) return undefined;
      // Use the exact configuration accepted for this request. Besides keeping
      // behavior deterministic, this guarantees recall and retain cannot be
      // sent to different banks if options change while inference is in flight.
      const config = run.config;
      if (!config.capture) { report(ctx, "capture-disabled"); return undefined; }
      if (ctx.success !== true) { report(ctx, "capture-skipped"); return undefined; }

      const answer = finalAnswer(reply, ctx.protocol);
      if (!answer) { report(ctx, "capture-skipped"); return undefined; }
      const documentId = `magpie-${createHash("sha256").update(`${ctx.session ?? ""}\0${run.query}\0${answer}`).digest("hex")}`;

      try {
        const client = new Hindsight(config, fetcher);
        const result = await client.retain(run.query, answer, documentId, ctx.agent, ctx.protocol, ctx.signal);
        if (result?.success !== true) throw new ApiError("invalid");
        report(ctx, "captured", Buffer.byteLength(run.query) + Buffer.byteLength(answer));
      } catch (error) {
        report(ctx, `capture-${failureCode(error)}`);
      }
      return undefined;
    }
  };
}
