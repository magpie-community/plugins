import { createHash, randomUUID } from "node:crypto";
import { agentAllowed, configuration } from "./config.mjs";
import { ApiError, Hindsight } from "./hindsight.mjs";
import { continuesTools, finalAnswer, memoryBlock, responseTools } from "./protocol.mjs";
import { createConversationStore, injected, replay, turnKey, turns, userText } from "./turns.mjs";

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
      if (ctx.origin !== "local" && ctx.origin !== "magpie-key") { report(ctx, "skipped"); return undefined; }
      if (!agentAllowed(config, ctx.agent)) { report(ctx, "skipped"); return undefined; }

      const all = turns(body, ctx.protocol);
      const turn = all.at(-1);
      const cache = conversation(ctx, config);
      const previousResponse = ctx.protocol === "responses" && typeof body.previous_response_id === "string"
        ? body.previous_response_id : "";
      const replayed = ctx.session && replay(all, cache, previousResponse);
      ctx.state ??= {};
      if (!turn) {
        const previous = config.capture && previousResponse && cache.get(`response:${previousResponse}`);
        if (previous && Date.now() < previous.expires && continuesTools(body.input, previous.tools))
          ctx.state.hindsight = { config, query: previous.query, turnId: previous.turnId };
        report(ctx, "skipped");
        return undefined;
      }

      const rawText = userText(turn.text).trim();
      if (!rawText) { report(ctx, "skipped"); return replayed ? body : undefined; }
      const key = turnKey(turn, previousResponse);
      const kept = ctx.session ? cache.get(key) : undefined;
      const turnWasReplayed = Boolean(kept?.text);
      // The gateway strips client instruction notices from its query.
      const query = kept?.query ?? ((typeof ctx.query === "string" && userText(ctx.query).trim()) || rawText).slice(0, 8192);
      const turnId = ctx.session ? key : randomUUID();
      ctx.state.hindsight = { config, query, turnId };
      if (injected(turn)) {
        report(ctx, "skipped");
        return body;
      }

      const recall = kept ?? { query, promise: new Hindsight(config, fetcher).recall(query, ctx.signal)
        .then(memories => memoryBlock(memories, config.recall_max_tokens)) };
      if (!kept && ctx.session) cache.set(key, recall);
      try {
        const block = recall.text ?? await recall.promise;
        if (recall.text === undefined) {
          recall.text = block;
          delete recall.promise;
        }
        if (block && !turnWasReplayed) turn.append(block);
        report(ctx, block ? "ready" : "empty", Buffer.byteLength(block));
        return block || replayed ? body : undefined;
      } catch (error) {
        if (ctx.session && cache.get(key) === recall) cache.delete(key);
        report(ctx, failureCode(error));
        return replayed ? body : undefined;
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

      if (ctx.protocol === "responses" && reply?.status === "completed" && !reply.error) {
        const tools = responseTools(reply);
        if (tools.length && typeof reply.id === "string" && reply.id)
          conversation(ctx, config).set(`response:${reply.id}`, {
            query: run.query, turnId: run.turnId, tools: tools.map(({ type, call_id, id }) => ({ type, call_id, id })),
            expires: Date.now() + 15 * 60 * 1000
          });
      }
      const answer = finalAnswer(reply, ctx.protocol);
      if (!answer) { report(ctx, "skipped"); return undefined; }
      const documentId = `magpie-${createHash("sha256").update(JSON.stringify([
        ctx.session, ctx.agent, ctx.protocol, run.turnId, run.query, answer
      ])).digest("hex")}`;

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
