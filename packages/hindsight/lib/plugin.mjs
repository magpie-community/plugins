import { createHash } from "node:crypto";
import { agentAllowed, configuration } from "./config.mjs";
import { ApiError, Hindsight } from "./hindsight.mjs";
import { finalAnswer, memoryBlock } from "./protocol.mjs";
import { createConversationStore, injected, replay, target, turnKey, turns } from "./turns.mjs";

const report = (ctx, code, bytes) => {
  try { ctx?.report?.(code, bytes); } catch { /* Diagnostics never affect traffic. */ }
};
const failureCode = error => error instanceof ApiError ? error.code : "invalid";

export function createPlugin({ fetcher = fetch } = {}) {
  const conversation = createConversationStore();
  return {
    async onRequest(body, ctx = {}) {
      let config;
      try { config = configuration(ctx.options); }
      catch { report(ctx, "invalid"); return undefined; }
      if (ctx.origin !== "local") { report(ctx, "skipped"); return undefined; }
      if (!agentAllowed(config, ctx.agent)) { report(ctx, "skipped"); return undefined; }

      const all = turns(body, ctx.protocol);
      if (!all.length) { report(ctx, "skipped"); return undefined; }
      const turn = target(all, ctx.query);
      if (!turn) { report(ctx, "skipped"); return undefined; }
      // Host-side query has client environment and instruction notices stripped
      // (Claude Code's <system-reminder> blocks); fall back to the raw turn text.
      const query = (typeof ctx.query === "string" && ctx.query.trim())
        ? ctx.query.trim().slice(0, 8192)
        : turn.text.trim().slice(0, 8192);
      if (!query) { report(ctx, "skipped"); return undefined; }

      const cache = conversation(ctx, config);
      // Every accepted request carries this turn's state, so capture still
      // works on the LAST request of a tool loop (the one with finish_reason
      // stop), not only on the request that happened to recall.
      ctx.state ??= {};
      ctx.state.hindsight = { config, query };
      const kept = cache.get(turnKey(turn));
      if (kept) {
        replay(all, cache);
        report(ctx, kept.bytes ? "ready" : "empty", kept.bytes);
        return body;
      }
      // A resent turn that already carries our block needs no new recall.
      if (injected(turn)) { replay(all, cache); report(ctx, "skipped"); return body; }

      try {
        const client = new Hindsight(config, fetcher);
        const memories = await client.recall(query, ctx.signal);
        const block = memoryBlock(memories, config.recall_max_tokens) ?? "";
        // Cache the turn even when empty: this turn is never recalled again.
        cache.set(turnKey(turn), { text: block, bytes: Buffer.byteLength(block) });
        replay(all, cache);
        report(ctx, block ? "ready" : "empty", Buffer.byteLength(block));
        return block ? body : undefined;
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
      if (!config.capture) { report(ctx, "skipped"); return undefined; }
      if (ctx.success !== true) { report(ctx, "skipped"); return undefined; }

      const answer = finalAnswer(reply, ctx.protocol);
      if (!answer) { report(ctx, "skipped"); return undefined; }
      const documentId = `magpie-${createHash("sha256").update(`${ctx.session ?? ""}\0${run.query}\0${answer}`).digest("hex")}`;

      try {
        const client = new Hindsight(config, fetcher);
        const result = await client.retain(run.query, answer, documentId, ctx.agent, ctx.protocol, ctx.signal);
        if (result?.success !== true) throw new ApiError("invalid");
        report(ctx, "ready", Buffer.byteLength(run.query) + Buffer.byteLength(answer));
      } catch (error) {
        report(ctx, failureCode(error));
      }
      return undefined;
    }
  };
}
