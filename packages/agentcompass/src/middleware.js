/**
 * Sync JS Gateway Middleware (`magpie.middleware`)
 *
 * Runs inside Magpie's in-process `moejs` VM (`internal/middleware/run.go`, 250 ms budget)
 * right before `s.serve` resolves the target model and effort (`internal/gateway/middleware.go:42-78`).
 *
 * Capabilities in `src/middleware.js`:
 * 1. Evaluates `evaluateProviderContinuation` first (holding the current Provider/Model on
 *    `within: true` tool loops, warm KV cache, or short follow-up nudges), and only executes
 *    `inferTaskProfile` + `selectBestRoute` when selecting or switching a Provider/Model is needed.
 * 2. Rewrites `body.model` (using either `<model>:<effort>` which `gateway.go:askedAt` natively
 *    splits, or bare `<model>` plus protocol-specific reasoning effort fields) within the
 *    configured `candidateModels` / `availableModels` / `allowedModels` (or `defaultModel`),
 *    rejecting unconfigured virtual model calls with HTTP 400 (`ctx.reject`).
 * 3. Implements `onResponse(body, ctx)` to update token/cache watermarks and mark a Provider/Model
 *    unhealthy (`healthy: false`) within the pooled runtime instance when a request fails (`status >= 400`).
 * 4. Implements `onProvider(body, ctx)` and `onAccount(account, ctx)` to refine per-provider models
 *    and filter accounts, and exports `strategies["agentcompass"]` / `strategies["agentcompass-pure"]`.
 */

import { selectBestRoute } from "./allocator.js";
import { canonicalModel } from "./catalog.js";
import {
  bodyUpTo,
  computeSessionKey,
  defaultContinuityStore,
  evaluateProviderContinuation,
  keepsEffort,
  recentUserTurns,
} from "./continuity.js";
import { extractRequestFacts, inferTaskProfile } from "./profiler-core.js";
import { orderSeatsByQuotaEconomics } from "./quota.js";

const ROUTE_CARRIER_KEY = "__agentcompass_route";

const DEFAULT_VIRTUAL_MODELS = [
  "agentcompass",
  "agentcompass/auto",
  "agentcompass/intent",
  "agentcompass/system-one-0.5",
];

function stripEffortSuffix(rawModel) {
  if (!rawModel || typeof rawModel !== "string") return "";
  const trimmed = rawModel.trim();
  const colonIdx = trimmed.lastIndexOf(":");
  if (colonIdx > 0) {
    const suffix = trimmed.slice(colonIdx + 1).toLowerCase();
    if (["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"].includes(suffix)) {
      return trimmed.slice(0, colonIdx);
    }
  }
  return trimmed;
}

function isVirtualModelName(model, options = {}) {
  if (!model || typeof model !== "string") return false;
  const clean = stripEffortSuffix(model).toLowerCase();
  if (clean === "agentcompass" || clean.startsWith("agentcompass/")) {
    return true;
  }
  const triggerList = options.triggerModels || options.routeModelTriggers;
  if (Array.isArray(triggerList) && triggerList.length > 0) {
    return triggerList.some((m) => String(m).trim().toLowerCase() === clean);
  }
  return DEFAULT_VIRTUAL_MODELS.includes(clean);
}

function extractModelList(source) {
  if (!source) return null;
  if (Array.isArray(source)) {
    const list = source
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          return String(item.id || item.name || item.model || "").trim();
        }
        return "";
      })
      .filter(Boolean);
    return list.length > 0 ? list : null;
  }
  if (typeof source === "object") {
    const keys = Object.keys(source)
      .map((k) => k.trim())
      .filter(Boolean);
    return keys.length > 0 ? keys : null;
  }
  return null;
}

function resolveCandidateModels(body, ctx = {}, options = {}) {
  const explicit =
    extractModelList(options.candidateModels) ||
    extractModelList(options.allowedModels) ||
    extractModelList(options.availableModels) ||
    extractModelList(options.models) ||
    extractModelList(ctx?.models) ||
    extractModelList(ctx?.availableModels) ||
    extractModelList(options.modelMap);

  if (explicit) {
    return { candidateModels: explicit, hasExplicitCandidates: true, canRewriteModel: true };
  }

  if (options.allowUnconstrainedCatalog === true) {
    return { candidateModels: null, hasExplicitCandidates: false, canRewriteModel: true };
  }

  const rawModel = stripEffortSuffix(body?.model || ctx?.model || "");
  if (rawModel && !isVirtualModelName(rawModel, options)) {
    return {
      candidateModels: [rawModel],
      hasExplicitCandidates: false,
      canRewriteModel: true,
    };
  }

  const fallback = String(options.defaultModel || options.fallbackModel || "").trim();
  if (fallback) {
    return {
      candidateModels: [fallback],
      hasExplicitCandidates: false,
      canRewriteModel: true,
    };
  }

  return { candidateModels: null, hasExplicitCandidates: false, canRewriteModel: false };
}

function shouldRoute(model, options = {}) {
  if (!model || typeof model !== "string") return false;
  if (options.routeAllModels === true) return true;
  return isVirtualModelName(model, options);
}

function applyProtocolEffortOnly(body, targetEffort, ctx = {}) {
  const options = ctx?.options || {};
  const protocol = String(ctx?.protocol || "").toLowerCase();
  if (options.injectProtocolEffort !== true || !targetEffort) return body;

  if (protocol === "chat") {
    body.reasoning_effort = targetEffort === "max" ? "xhigh" : targetEffort;
  } else if (protocol === "responses") {
    body.reasoning = {
      ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}),
      effort: targetEffort === "max" ? "xhigh" : targetEffort,
    };
  } else if (protocol === "anthropic") {
    body.output_config = {
      ...(body.output_config && typeof body.output_config === "object"
        ? body.output_config
        : {}),
      effort: targetEffort === "xhigh" ? "max" : targetEffort,
    };
  }
  return body;
}

/**
 * Apply the selected effort to the request body according to the client protocol,
 * or encode `<model>:<effort>` which Magpie's `askedAt` (`internal/gateway/gateway.go:1560`)
 * natively parses and applies to every upstream candidate!
 */
export function applyRoutedModelAndEffort(body, decision, ctx = {}) {
  const options = ctx?.options || {};
  const rawModel = decision.targetModel;
  const targetEffort = decision.targetEffort || "high";

  if (!rawModel) return body;

  const mappedModel =
    (options.modelMap && typeof options.modelMap === "object" && options.modelMap[rawModel]) ||
    rawModel;
  const targetModel =
    typeof options.modelPrefix === "string" &&
    options.modelPrefix.trim() &&
    !mappedModel.includes("/")
      ? `${options.modelPrefix.trim().replace(/\/$/, "")}/${mappedModel}`
      : mappedModel;

  // Magpie natively supports `<model>:<effort>` in `gateway.go:askedAt` (unless disabled by option)
  if (options.useColonEffort !== false && targetEffort && !targetModel.includes(":")) {
    body.model = `${targetModel}:${targetEffort}`;
  } else {
    body.model = targetModel;
  }

  applyProtocolEffortOnly(body, targetEffort, ctx);

  return body;
}

// How many earlier turns a request may be decided again from (`replayedState`): bounds the work
// on a long conversation, and is part of the rule, so every runtime stops at the same turn.
const MAX_REPLAY_DEPTH = 4;

/**
 * The turn a request belongs to, read from the history the client resent (`recentUserTurns`).
 * `stamp` is the turn whose decision this request carries: the current turn, or, within a tool
 * loop or on a short follow-up ("继续"), the turn that follow-up continues. `prior` is the turn
 * whose decision is the session's state before this request: that same turn for a hold (when it
 * is an earlier request than this one), the previous one for a new turn, `null` on the first.
 */
function turnChain(body, facts) {
  const turns = recentUserTurns(body, MAX_REPLAY_DEPTH + 2);
  if (turns.length === 0) return null;
  const anchorAt = (from) => {
    let at = from;
    while (at < turns.length - 1 && turns[at].short) at += 1;
    return at;
  };
  const holds = Boolean(facts.within || facts.isShortFollowup);
  const at = holds ? anchorAt(0) : 0;
  let prior = null;
  if (holds) {
    // a follow-up holds the turn it continues; a tool loop step, the request that began its turn
    prior = at > 0 || facts.within ? turns[at] : null;
  } else if (turns.length > 1) {
    prior = turns[anchorAt(1)];
  }
  return {
    stamp: turns[at].stamp,
    prior,
    accepts: [turns[at].stamp, prior?.stamp].filter(Boolean),
  };
}

/**
 * The model a hold sends the request to, as the candidate list names it: the store keeps models
 * canonical (`claude-opus-5-5`), and the bare name may resolve to another provider in Magpie than
 * the `upstream/claude-opus-5-5` the session was routed to. The name routed last (`target`) when
 * it is still a candidate, else the one candidate of that canonical model, else the model itself.
 */
function heldTarget(model, sessionState, candidateModels, aliases) {
  if (!Array.isArray(candidateModels) || candidateModels.length === 0) return model;
  if (sessionState?.target && candidateModels.includes(sessionState.target)) return sessionState.target;
  const canonical = canonicalModel(model, aliases);
  return candidateModels.find((m) => canonicalModel(m, aliases) === canonical) || model;
}

/**
 * The session's state before this request, decided again from the history: the request that
 * began the `prior` turn, cut out of the body (`bodyUpTo`) and routed as it was then. Magpie
 * hands each request a pooled runtime and gives middleware no storage across requests
 * (`internal/middleware/middleware.go` `mw.pool`), so the runtime serving a request may never
 * have seen the session, or have seen only an earlier turn of it. The history is the one thing
 * every runtime is given, so a decision made again from it is the same on all of them.
 */
function replayedState(body, ctx, env, chain, stale, depth) {
  if (!chain.prior || depth >= MAX_REPLAY_DEPTH) return null;
  const earlier = routeClaimed(
    bodyUpTo(body, chain.prior.index),
    { ...ctx, within: undefined, estimated_input_tokens: undefined },
    env,
    depth + 1
  );
  const d = earlier.decision;
  if (!d || !d.targetModel) return null;
  const tokens = Number(earlier.facts.estimatedInputTokens || 0);
  return {
    sessionKey: earlier.sessionKey,
    model: canonicalModel(d.targetModel, env.options.catalog?.aliases),
    target: d.targetModel,
    effort: d.targetEffort || "high",
    provider: "",
    workKind: d.workKind || "general_implementation",
    difficulty: d.difficulty || "routine",
    tokens,
    requestTokens: tokens,
    compactedTokens: Number(stale?.compactedTokens || 0),
    cached: false,
    healthy: true,
    turn: earlier.facts.turn || 1,
    anchor: chain.prior.stamp,
    replayed: true,
    updatedAt: env.now,
  };
}

/**
 * Route a request for a claimed (virtual) model: hold the session's Provider/Model where
 * `evaluateProviderContinuation` says to, otherwise profile and select. The session's state is
 * this runtime's record when that record was made in the turn this request follows (its
 * `anchor`), and is decided again from the history otherwise (`replayedState`). Returns the
 * decision and what to record; nothing is recorded here, so replaying an earlier turn leaves the
 * store as it was.
 */
function routeClaimed(body, ctx, env, depth = 0) {
  const { options, store, now, candidateModels, hasExplicitCandidates, canRewriteModel } = env;
  const facts = extractRequestFacts(body, ctx);
  const sessionKey = facts.sessionKey || computeSessionKey(body, ctx, facts.firstWords);
  const chain = turnChain(body, facts);
  const affinityMode = options.affinityMode || options.affinity || "cache";
  let sessionState = sessionKey ? store.get(sessionKey, now) : null;
  if (
    affinityMode !== "off" &&
    chain?.prior &&
    (!sessionState || (sessionState.anchor && !chain.accepts.includes(sessionState.anchor)))
  ) {
    sessionState = replayedState(body, ctx, env, chain, sessionState, depth);
  }
  const anchor = chain?.stamp || "";

  const cont = evaluateProviderContinuation(facts, sessionState, {
    now,
    affinityMode,
    availableModels: candidateModels,
    unhealthyModels: options.unhealthyModels,
    quotas: options.quotas,
    policy: options.catalog?.policy,
    store,
    coldAfterMs: options.coldAfterMs,
    cacheTtl: options.cacheTtl,
    models: options.catalog?.models,
    aliases: options.catalog?.aliases,
  });

  if (cont.shouldHold && cont.model) {
    const heldEffort = keepsEffort(
      sessionState,
      cont.effort || sessionState?.effort || "high",
      facts.estimatedInputTokens,
      now,
      {
        ...options,
        isShortFollowup: facts.isShortFollowup,
      }
    );
    const target = heldTarget(cont.model, sessionState, candidateModels, options.catalog?.aliases);
    return {
      facts,
      sessionKey,
      record: {
        model: target,
        effort: heldEffort,
        provider: cont.provider || sessionState?.provider || "",
        workKind: sessionState?.workKind || "general_implementation",
        difficulty: sessionState?.difficulty || "routine",
        why: cont.why,
        held: true,
        anchor,
      },
      decision: {
        ok: true,
        targetModel: target,
        canonicalModel: canonicalModel(cont.model, options.catalog?.aliases),
        targetEffort: heldEffort,
        modelWithEffort: `${target}:${heldEffort}`,
        canRewriteModel,
        hasExplicitCandidates,
        workKind: sessionState?.workKind || "general_implementation",
        difficulty: sessionState?.difficulty || "routine",
        continuation: {
          held: true,
          why: cont.why,
          sessionKey,
          anchor,
          replayed: Boolean(sessionState?.replayed),
          turn: facts.turn,
          within: facts.within,
          previousModel: cont.previousModel || cont.model,
          previousEffort: cont.previousEffort || heldEffort,
        },
      },
    };
  }

  if (!facts.objective) {
    return { facts, sessionKey, record: null, decision: null };
  }

  const profile = inferTaskProfile(facts);
  const unhealthyModels = [
    ...store.getUnhealthyModels(now),
    ...(Array.isArray(options.unhealthyModels) ? options.unhealthyModels : []),
  ];
  if (cont.why === "provider_unhealthy" && cont.previousModel) {
    unhealthyModels.push(cont.previousModel);
  }
  const minContextTokens = cont.why === "outgrown" ? Number(facts.estimatedInputTokens || 0) : 0;

  let decision = selectBestRoute(profile, {
    objective: facts.objective,
    candidateModels,
    catalog: options.catalog,
    unhealthyModels,
    minContextTokens,
    quotas: options.quotas,
    meteredOk: options.meteredOk,
    now,
    continuity: {
      previousModel: cont.previousModel || null,
      previousEffort: cont.previousEffort || null,
      why: cont.why,
      cacheWarm: false,
    },
  });

  if (!decision.ok) {
    // Without the temporary unhealthy/context/quota constraints, and never unrouted: see selectBestRoute.
    decision = selectBestRoute(profile, {
      objective: facts.objective,
      candidateModels,
      catalog: options.catalog,
      now,
      fallbackToBestExcluded: true,
    });
  }

  if (!decision || !decision.targetModel) {
    return { facts, sessionKey, record: null, decision };
  }

  let finalEffort = decision.targetEffort;
  if (
    sessionState &&
    canonicalModel(decision.targetModel) === canonicalModel(sessionState.model) &&
    cont.why !== "cold" &&
    cont.why !== "compacted" &&
    cont.why !== "first" &&
    cont.why !== "worn"
  ) {
    finalEffort = keepsEffort(
      sessionState,
      decision.targetEffort,
      facts.estimatedInputTokens,
      now,
      options
    );
  }
  decision.targetEffort = finalEffort;
  decision.modelWithEffort = `${decision.targetModel}:${finalEffort}`;
  decision.canRewriteModel = canRewriteModel;
  decision.hasExplicitCandidates = hasExplicitCandidates;
  decision.continuation = {
    held: false,
    why: cont.why,
    reasonDetail: cont.reasonDetail || null,
    sessionKey,
    anchor,
    replayed: Boolean(sessionState?.replayed),
    turn: facts.turn,
    within: facts.within,
    previousModel: cont.previousModel || null,
    previousEffort: cont.previousEffort || null,
  };

  return {
    facts,
    sessionKey,
    decision,
    record: {
      model: decision.targetModel,
      effort: finalEffort,
      workKind: decision.workKind,
      difficulty: decision.difficulty,
      why: cont.why,
      held: false,
      anchor,
    },
  };
}

export function onRequest(body, ctx = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const options = ctx.options || {};
  const isClaimedModel = shouldRoute(body.model, options);
  const stateRoute =
    isClaimedModel &&
    ctx?.state?.route &&
    typeof ctx.state.route === "object" &&
    typeof ctx.state.route.targetModel === "string" &&
    ctx.state.route.targetModel.trim()
      ? ctx.state.route
      : null;

  if (!isClaimedModel && !stateRoute) {
    return undefined;
  }

  try {
    if (ROUTE_CARRIER_KEY in body) {
      delete body[ROUTE_CARRIER_KEY];
    }

    const store = options.continuityStore || defaultContinuityStore;
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const { candidateModels, hasExplicitCandidates, canRewriteModel } = resolveCandidateModels(
      body,
      ctx,
      options
    );

    if (!canRewriteModel && !stateRoute && isVirtualModelName(body.model, options)) {
      if (typeof ctx?.reject === "function") {
        return ctx.reject(400, "agentcompass: set candidateModels in the plugin's options");
      }
      return undefined;
    }

    let decision = null;

    if (stateRoute) {
      if (
        !hasExplicitCandidates ||
        !Array.isArray(candidateModels) ||
        candidateModels.includes(stateRoute.targetModel)
      ) {
        decision = stateRoute;
      }

      if (decision && decision.targetModel) {
        const facts = extractRequestFacts(body, ctx);
        const sessionKey =
          decision.continuation?.sessionKey || facts.sessionKey || computeSessionKey(body, ctx, facts.firstWords);
        if (sessionKey) {
          store.recordRequest(
            sessionKey,
            {
              model: decision.targetModel,
              effort: decision.targetEffort || "high",
              workKind: decision.workKind || "general_implementation",
              difficulty: decision.difficulty || "routine",
              why: decision.continuation?.why || "first",
              held: Boolean(decision.continuation?.held),
            },
            facts,
            now
          );
        }
      }
    }

    if (!decision && isClaimedModel) {
      // 2. Zero-latency (< 2 ms) synchronous execution inside `moejs`
      const routed = routeClaimed(body, ctx, {
        options,
        store,
        now,
        candidateModels,
        hasExplicitCandidates,
        canRewriteModel,
      });
      decision = routed.decision;
      if (routed.record && routed.sessionKey && decision?.targetModel) {
        store.recordRequest(routed.sessionKey, routed.record, routed.facts, now);
      }
    }

    if (!decision || !decision.targetModel) {
      return undefined;
    }

    ctx.state = ctx.state || {};
    ctx.state.agentcompass = decision;
    ctx.state.route = decision;

    const allowModelRewrite =
      canRewriteModel ||
      decision.canRewriteModel === true ||
      decision.hasExplicitCandidates === true;

    if (!allowModelRewrite) {
      if (options.injectProtocolEffort === true) {
        applyProtocolEffortOnly(body, decision.targetEffort, ctx);
        return body;
      }
      return undefined;
    }

    applyRoutedModelAndEffort(body, decision, ctx);
    return body;
  } finally {
    if (body && typeof body === "object" && !Array.isArray(body) && ROUTE_CARRIER_KEY in body) {
      delete body[ROUTE_CARRIER_KEY];
    }
  }
}

/**
 * Middleware `onProvider(body, ctx)` hook (`internal/middleware/run.go:Tried`):
 * Magpie passes `ctx.provider = { id, name, account, model }`.
 * Supports optional per-provider model lists via `options.modelsByProvider[provider.id]`
 * or fallback to `ctx.provider.model` if `body.model` is still a virtual model name.
 */
export function onProvider(body, ctx = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const options = ctx?.options || {};
  const prov = ctx?.provider && typeof ctx.provider === "object" ? ctx.provider : null;
  const providerModels =
    extractModelList(options.modelsByProvider?.[prov?.id]) ||
    extractModelList(options.modelsByProvider?.[prov?.name]);

  const prevDecision = ctx?.state?.agentcompass || ctx?.state?.route;
  if (providerModels && providerModels.length > 0 && prevDecision?.profile) {
    const needProviderRoute =
      isVirtualModelName(body.model, options) ||
      prevDecision.canRewriteModel === false ||
      prevDecision.hasExplicitCandidates === false ||
      !providerModels.includes(prevDecision.targetModel) ||
      options.routePerProvider === true;

    if (needProviderRoute) {
      const routed = selectBestRoute(prevDecision.profile, {
        objective: "",
        candidateModels: providerModels,
        catalog: options.catalog,
        quotas: options.quotas,
        meteredOk: options.meteredOk,
      });
      if (routed.ok && routed.targetModel) {
        const updated = {
          ...prevDecision,
          targetModel: routed.targetModel,
          canonicalModel: routed.canonicalModel,
          targetEffort: routed.targetEffort || prevDecision.targetEffort || "high",
          modelWithEffort: `${routed.targetModel}:${routed.targetEffort || prevDecision.targetEffort || "high"}`,
          canRewriteModel: true,
          hasExplicitCandidates: true,
        };
        if (ctx.state && typeof ctx.state === "object") {
          ctx.state.agentcompass = updated;
          ctx.state.route = updated;
        }
        applyRoutedModelAndEffort(body, updated, ctx);
        return body;
      }
    }
  }

  if (
    isVirtualModelName(body.model, options) &&
    typeof prov?.model === "string" &&
    prov.model.trim()
  ) {
    const fallbackDecision = {
      ...(prevDecision || {}),
      targetModel: prov.model.trim(),
      targetEffort: prevDecision?.targetEffort || "high",
    };
    applyRoutedModelAndEffort(body, fallbackDecision, ctx);
    return body;
  }

  return undefined;
}

/**
 * Middleware `onResponse(body, ctx)` hook (`internal/middleware/run.go`):
 * Shares the pooled request runtime with `onRequest`. Updates token/cache watermarks
 * on success and marks `healthy = false` on upstream error (`status >= 400`).
 */
export function onResponse(body, ctx = {}) {
  const options = ctx?.options || {};
  const store = options.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const decision = ctx?.state?.agentcompass || ctx?.state?.route;
  const sessionKey =
    decision?.continuation?.sessionKey ||
    ctx?.state?.sessionKey ||
    computeSessionKey(ctx?.request || {}, ctx) ||
    store.lastActiveSessionKey;

  store.recordResponse(
    sessionKey,
    body,
    {
      ...ctx,
      model: decision?.targetModel || ctx?.model || body?.model,
    },
    now
  );
  return undefined;
}

/**
 * Middleware `onAccount(account, ctx)` hook (`internal/middleware/account.go:58`):
 * Magpie passes `{ref, provider, name, kind, model}` as the first argument AND sets `ctx.account` to it.
 * Also supports `(body, ctx)` where `ctx` or `ctx.account` carries `{ref, provider, name, kind, model}`,
 * as well as legacy `{provider, account, key}` shapes.
 */
export function onAccount(accountOrBody, ctx = {}) {
  const decision = ctx?.state?.agentcompass || ctx?.state?.route;
  const options = ctx?.options || {};
  if (!decision) return undefined;

  const acct =
    ctx?.account && typeof ctx.account === "object"
      ? ctx.account
      : accountOrBody &&
          typeof accountOrBody === "object" &&
          (accountOrBody.ref ||
            accountOrBody.provider ||
            accountOrBody.name ||
            accountOrBody.kind ||
            accountOrBody.account ||
            accountOrBody.key)
        ? accountOrBody
        : ctx;

  if (!acct || typeof acct !== "object") return undefined;

  const allowedByKind = options.accountsByWorkKind?.[decision.workKind];
  if (Array.isArray(allowedByKind) && allowedByKind.length > 0) {
    const identifiers = [
      acct.ref,
      acct.name,
      acct.provider,
      acct.kind,
      acct.provider && acct.name ? `${acct.provider}/${acct.name}` : "",
      acct.account,
      acct.key,
    ]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim());

    if (identifiers.length > 0 && !identifiers.some((id) => allowedByKind.includes(id))) {
      return { skip: true };
    }
  }
  return undefined;
}

/**
 * Pool seat-ordering strategy (`agentcompass/agentcompass` and `agentcompass/agentcompass-pure`).
 * Combines Magpie's `Seat` telemetry (`account`, `known`, `learns`, `used`, `soon`, `pace`, `resting`, `tokens`)
 * with AgentCompass's subscription opportunity-cost and pre-reset surplus sprint economics.
 * Returns seat indexes `[0 .. seats.length - 1]` as required by `internal/middleware/points.go:232`
 * and `magpie-community/plugins/scripts/middleware.mjs:order()`.
 */
export const strategies = {
  agentcompass: orderSeatsByQuotaEconomics,
  "agentcompass-pure": orderSeatsByQuotaEconomics,
};
