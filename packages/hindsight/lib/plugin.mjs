import { agentId, agentPolicy, configuration } from "./config.mjs";
import { ApiError, Hindsight } from "./hindsight.mjs";
import { continuesTools, finalAnswer, memoryBlock, responseTools, utf8Prefix } from "./protocol.mjs";
import { conversationIdentity, createConversationStore, hash, hasNewUserTurn, injected, replay, turnKeys, turns, userText } from "./turns.mjs";

const report = (ctx, code, bytes) => {
  try { ctx?.report?.(code, bytes); } catch { /* Diagnostics never affect traffic. */ }
};
const failureCode = error => error instanceof ApiError ? error.code : "invalid";
const RETRYABLE = new Set(["unavailable", "timeout", "rate-limited"]);
const BANK_COOLDOWN_MS = 15000;
const WRITE_WINDOW_MS = 30 * 60 * 1000;
const MAX_PENDING_RECALLS = 16;
const callerAgent = ctx => ctx.agent && ctx.agent !== "magpie" ? ctx.agent : ctx.caller?.agent || ctx.agent;

function stopWaiting(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new ApiError("cancelled"));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new ApiError("cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function operationId(hash) {
  return [hash.slice(0, 8), hash.slice(8, 12), "5" + hash.slice(13, 16),
    "a" + hash.slice(17, 20), hash.slice(20, 32)].join("-");
}

export function createPlugin({ fetcher = fetch, nativePolicy = () => ({}), observe = () => {} } = {}) {
  const conversation = createConversationStore();
  const health = new Map();
  let pendingRecalls = 0;

  function record(ctx, config, action, code, extras = {}) {
    try {
      observe({ agent: agentId(callerAgent(ctx)) || "unknown",
        protocol: ctx.protocol, bank: config?.bank, action, code, ...extras }, config);
    } catch { /* Observability is always best effort. */ }
  }

  function dispatchRecall(query, ctx, config) {
    const identity = hash([config.hindsight_api, config.bank]);
    const now = Date.now();
    const previous = health.get(identity);
    if (previous?.until > now || (previous?.until && previous.probing))
      return Promise.reject(new ApiError("cooldown"));
    if (pendingRecalls >= MAX_PENDING_RECALLS) return Promise.reject(new ApiError("busy"));
    const healthEntry = previous ?? { failures: 0, until: 0 };
    healthEntry.probing = Boolean(healthEntry.until);
    health.delete(identity);
    health.set(identity, healthEntry);
    if (health.size > 32) health.delete(health.keys().next().value);
    pendingRecalls++;
    const start = Date.now();
    return new Hindsight(config, fetcher).recall(query).then(memories => {
      const text = memoryBlock(memories, config.recall_max_tokens, config.injection_max_bytes - 2);
      healthEntry.failures = 0;
      healthEntry.until = 0;
      record(ctx, config, "recall", text ? "hit" : "empty", { ms: Date.now() - start, bytes: Buffer.byteLength(text) });
      return text;
    }, error => {
      const code = failureCode(error);
      if (RETRYABLE.has(code) && (++healthEntry.failures >= 3 || code === "rate-limited")) {
        healthEntry.until = Date.now() + BANK_COOLDOWN_MS;
      }
      record(ctx, config, "recall", code, { ms: Date.now() - start });
      throw error;
    }).finally(() => {
      healthEntry.probing = false;
      pendingRecalls--;
    });
  }

  return {
    async onRequest(body, ctx = {}) {
      if (ctx.origin !== "local" && ctx.origin !== "magpie-key") {
        report(ctx, "skipped");
        return undefined;
      }
      let config;
      try { config = configuration(ctx.options); }
      catch { report(ctx, "invalid"); record(ctx, null, "policy", "invalid"); return undefined; }
      if (ctx.state) delete ctx.state.hindsight;
      const agent = callerAgent(ctx);
      const identity = agentId(agent);
      const policy = agentPolicy(config, agent, nativePolicy(identity));
      const shouldRecall = policy.recall.owner === "gateway";
      const shouldCapture = policy.capture.owner === "gateway";
      record(ctx, config, "request", "seen", { revision: hash(config).slice(0, 12) });
      if (!shouldRecall) record(ctx, config, "policy", policy.recall.reason);
      if (policy.recall.reason === "native-conflict" || policy.capture.reason === "native-conflict")
        record(ctx, config, "policy", "native-conflict");
      if (!shouldRecall && !shouldCapture) { report(ctx, "skipped"); return undefined; }

      const all = turns(body, ctx.protocol);
      const turn = all.at(-1);
      const cache = conversation(ctx, config);
      const previousResponse = ctx.protocol === "responses" && typeof body.previous_response_id === "string"
        ? body.previous_response_id : "";
      ctx.state ??= {};
      if (!turn) {
        const previous = shouldCapture && previousResponse && cache.get("response:" + previousResponse);
        if (previous && continuesTools(body.input, previous.tools))
          ctx.state.hindsight = previous.run;
        report(ctx, "skipped");
        return undefined;
      }

      const keys = turnKeys(all, all.length === 1 ? previousResponse : "");
      const key = keys.at(-1);
      const continuation = !hasNewUserTurn(body, ctx.protocol, turn);
      const rawText = userText(turn.text).trim();
      const query = utf8Prefix((typeof ctx.query === "string" && userText(ctx.query).trim()) || rawText, 8192);
      const stableTurn = Boolean(ctx.session || turn.id || previousResponse);
      const known = stableTurn ? cache.get(key) : undefined;
      const kept = continuation || known?.query === query ? known : undefined;
      if (shouldCapture && rawText) ctx.state.hindsight = {
        config, query: kept?.query ?? (continuation ? utf8Prefix(rawText, 8192) : query),
        turnId: stableTurn ? key : "", agent
      };

      let block = "";
      if (shouldRecall && rawText && !injected(turn) && !ctx.signal?.aborted && (!continuation || kept)) {
        const recall = kept ?? { query, promise: dispatchRecall(query, ctx, config) };
        if (!kept && stableTurn) cache.set(key, recall);
        if (recall.promise && !kept) {
          recall.promise.then(text => {
            recall.text = text;
            delete recall.promise;
            if (stableTurn && cache.get(key) === recall) cache.set(key, recall);
          }, () => {
            if (stableTurn && cache.get(key) === recall) cache.delete(key);
          });
        }
        try {
          block = recall.text ?? await stopWaiting(recall.promise, ctx.signal);
          if (kept) record(ctx, config, "recall", "reused");
          report(ctx, block ? "ready" : "empty", Buffer.byteLength(block));
        } catch (error) {
          const code = failureCode(error);
          if (["cancelled", "cooldown", "busy"].includes(code)) record(ctx, config, "recall", code);
          report(ctx, code);
        }
      } else {
        report(ctx, "skipped");
        if (shouldRecall) record(ctx, config, "recall", continuation ? "continuation" : "skipped");
      }

      if (!shouldRecall || ctx.signal?.aborted) return undefined;
      const bytes = replay(all, keys, stableTurn ? cache : null, block, config.injection_max_bytes);
      if (bytes) record(ctx, config, "injection", "applied", { bytes });
      return bytes || injected(turn) ? body : undefined;
    },

    async onResponse(reply, ctx = {}) {
      const run = ctx.state?.hindsight;
      if (!run) return undefined;
      const { config } = run;
      if (ctx.success !== true) { report(ctx, "skipped"); return undefined; }
      const cache = conversation(ctx, config);
      if (ctx.protocol === "responses" && reply?.status === "completed" && !reply.error) {
        const tools = responseTools(reply).slice(0, 64);
        if (tools.length && typeof reply.id === "string" && reply.id)
          cache.set("response:" + reply.id, {
            run: { ...run, turnId: run.turnId || hash(["response", reply.id]) },
            query: run.query,
            tools: tools.map(({ type, call_id, id }) => ({ type, call_id, id }))
          }, 15 * 60 * 1000);
      }
      const answer = finalAnswer(reply, ctx.protocol);
      if (!answer) { report(ctx, "skipped"); return undefined; }
      const replyId = typeof reply.id === "string" && reply.id || reply.responseId;
      const turnId = run.turnId || replyId;
      if (typeof turnId !== "string" || !turnId) {
        record(ctx, config, "capture", "unidentified");
        report(ctx, "skipped");
        return undefined;
      }
      const scope = conversationIdentity(ctx, config);
      const digest = hash([scope, turnId, replyId, run.query, answer]);
      const documentId = "magpie-" + digest;
      const id = operationId(hash(["retain", documentId]));
      const submissionKey = "retain:" + id;
      if (cache.get(submissionKey)) {
        record(ctx, config, "capture", "duplicate");
        report(ctx, "skipped");
        return undefined;
      }
      cache.set(submissionKey, {}, WRITE_WINDOW_MS);

      try {
        const client = new Hindsight(config, fetcher);
        const result = await client.retain({ query: run.query, answer, documentId, operationId: id,
          agent: run.agent, protocol: ctx.protocol }, ctx.signal);
        if (result?.success !== true) throw new ApiError("invalid");
        const bytes = Buffer.byteLength(run.query) + Buffer.byteLength(answer);
        const operation = result.operation_id ?? result.operation_ids?.[0];
        record(ctx, config, "capture", "submitted", { operation, bytes });
        report(ctx, "submitted", bytes);
      } catch (error) {
        const code = failureCode(error);
        const uncertain = RETRYABLE.has(code) || code === "cancelled";
        record(ctx, config, "capture", uncertain ? "unconfirmed" : code, { operation: uncertain ? id : undefined });
        report(ctx, code);
      }
      return undefined;
    }
  };
}
