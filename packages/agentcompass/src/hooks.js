/**
 * Optional Async Bun Gateway Helper (`./hooks`)
 *
 * Used for programmatic / custom host integrations that opt into asynchronous external
 * System-One scoring (`allowExternalScorer: true`) and pass routing state via `ctx.state.route`
 * without mutating client request body fields.
 */

import { selectBestRoute } from "./allocator.js";
import { canonicalModel } from "./catalog.js";
import {
  computeSessionKey,
  defaultContinuityStore,
  evaluateProviderContinuation,
  keepsEffort,
} from "./continuity.js";
import { extractRequestFacts } from "./profiler-core.js";
import { loadLiveQuotas } from "./quota-loader.js";
import { scoreTaskLive } from "./scorer-live.js";

export const ROUTE_CARRIER_KEY = "__agentcompass_route";

export const DEFAULT_VIRTUAL_MODELS = [
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

export function isVirtualModelName(model, options = {}) {
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

export function extractModelList(source) {
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

export function resolveCandidateModels(body, ctx = {}, options = {}) {
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

  return { candidateModels: null, hasExplicitCandidates: false, canRewriteModel: true };
}

/**
 * Determine whether this request should be routed by AgentCompass.
 * By default, only claims the `agentcompass` / `agentcompass/*` namespace.
 */
export function shouldRouteRequest(model, options = {}) {
  if (!model || typeof model !== "string") return false;
  if (options.routeAllModels === true) return true;
  return isVirtualModelName(model, options);
}

export async function onRequest(body, ctx = {}) {
  if (body && typeof body === "object" && !Array.isArray(body) && ROUTE_CARRIER_KEY in body) {
    delete body[ROUTE_CARRIER_KEY];
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    ctx.report?.("skipped");
    return undefined;
  }

  const options = ctx.options || {};
  const scorerCfg = options.scorer && typeof options.scorer === "object" ? options.scorer : {};
  const facts = extractRequestFacts(body, ctx);

  if (!shouldRouteRequest(facts.model, options)) {
    ctx.report?.("skipped");
    return undefined;
  }

  const store = options.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const sessionKey = facts.sessionKey || computeSessionKey(body, ctx);
  const sessionState = sessionKey ? store.get(sessionKey, now) : null;
  const { candidateModels, hasExplicitCandidates, canRewriteModel } = resolveCandidateModels(
    body,
    ctx,
    options
  );
  const liveQuotas = loadLiveQuotas(options, now);

  const cont = evaluateProviderContinuation(facts, sessionState, {
    now,
    affinityMode: options.affinityMode || options.affinity || "cache",
    availableModels: candidateModels,
    unhealthyModels: options.unhealthyModels,
    quotas: liveQuotas,
    policy: options.catalog?.policy,
    store,
    coldAfterMs: options.coldAfterMs,
    cacheTtl: options.cacheTtl,
    models: options.catalog?.models,
    aliases: options.catalog?.aliases,
  });

  // Fast path: Hold active session Provider/Model without calling the intent classifier
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
    const canonical = canonicalModel(cont.model, options.catalog?.aliases);
    if (sessionKey) {
      store.recordRequest(
        sessionKey,
        {
          model: cont.model,
          effort: heldEffort,
          provider: cont.provider || sessionState?.provider || "",
          workKind: sessionState?.workKind || "general_implementation",
          difficulty: sessionState?.difficulty || "routine",
          why: cont.why,
          held: true,
        },
        facts,
        now
      );
    }

    const carrier = {
      v: 1,
      targetModel: cont.model,
      canonicalModel: canonical,
      targetEffort: heldEffort,
      modelWithEffort: `${cont.model}:${heldEffort}`,
      canRewriteModel,
      hasExplicitCandidates,
      workKind: sessionState?.workKind || "general_implementation",
      difficulty: sessionState?.difficulty || "routine",
      requiredAbility: null,
      score: null,
      components: null,
      profile: null,
      scorer: {
        kind: "continuity_hold",
        held: true,
        why: cont.why,
        calls: 0,
      },
      continuation: {
        held: true,
        why: cont.why,
        sessionKey,
        turn: facts.turn,
        within: facts.within,
        previousModel: cont.previousModel || cont.model,
        previousEffort: cont.previousEffort || heldEffort,
      },
      topCandidates: [],
    };

    const payloadBytes = JSON.stringify(carrier).length;
    ctx.state = ctx.state || {};
    ctx.state.sessionKey = sessionKey;
    ctx.state.route = carrier;
    ctx.state.agentcompass = carrier;
    ctx.report?.("ready", payloadBytes);
    return undefined;
  }

  if (!facts.objective) {
    ctx.report?.("empty");
    return undefined;
  }

  const preferHeuristic =
    options.prefer_local_heuristic === true || scorerCfg.prefer_local_heuristic === true;
  const allowExternalScorer =
    options.allowExternalScorer === true ||
    scorerCfg.allowExternalScorer === true;

  const { profile, meta } = await scoreTaskLive(facts, {
    allowExternalScorer,
    scorerType: preferHeuristic
      ? "heuristic"
      : options.scorerType || scorerCfg.kind || scorerCfg.type || "heuristic",
    scorerModel: options.scorerModel || scorerCfg.model,
    scorerBaseUrl: options.scorerBaseUrl || scorerCfg.baseUrl,
    scorerApiKey: options.scorerApiKey || scorerCfg.apiKey,
    jevBaseUrl: options.jevBaseUrl || scorerCfg.jevBaseUrl,
    jevApiKey: options.jevApiKey || scorerCfg.jevApiKey,
    scorerTimeoutMs:
      options.scorerTimeoutMs ||
      scorerCfg.timeoutMs ||
      Math.max(500, (options.gatewayTimeoutMs || 8000) - 500),
    useCache: options.useCache !== false && scorerCfg.useCache !== false,
    signal: ctx.signal,
    fetch: options.fetch,
  });

  const unhealthyModels = [
    ...store.getUnhealthyModels(now),
    ...(Array.isArray(options.unhealthyModels) ? options.unhealthyModels : []),
  ];
  if (cont.why === "provider_unhealthy" && cont.previousModel) {
    unhealthyModels.push(cont.previousModel);
  }

  const minContextTokens =
    cont.why === "outgrown" ? Number(facts.estimatedInputTokens || 0) : 0;

  let decision = selectBestRoute(profile, {
    objective: facts.objective,
    candidateModels,
    catalog: options.catalog,
    unhealthyModels,
    minContextTokens,
    quotas: liveQuotas,
    meteredOk: options.meteredOk,
    now,
    continuity: {
      previousModel: cont.previousModel || null,
      previousEffort: cont.previousEffort || null,
      why: cont.why,
      cacheWarm: false,
    },
  });

  // Without the temporary unhealthy/context/quota constraints, and never unrouted: see selectBestRoute.
  if (!decision.ok) {
    decision = selectBestRoute(profile, {
      objective: facts.objective,
      candidateModels,
      catalog: options.catalog,
      now,
      fallbackToBestExcluded: true,
    });
  }

  if (!decision.ok || !decision.targetModel) {
    ctx.report?.("empty");
    return undefined;
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

  if (sessionKey) {
    store.recordRequest(
      sessionKey,
      {
        model: decision.targetModel,
        effort: finalEffort,
        workKind: decision.workKind,
        difficulty: decision.difficulty,
        why: cont.why,
        held: false,
      },
      facts,
      now
    );
  }

  const carrier = {
    v: 1,
    targetModel: decision.targetModel,
    canonicalModel: decision.canonicalModel,
    targetEffort: finalEffort,
    modelWithEffort: `${decision.targetModel}:${finalEffort}`,
    canRewriteModel,
    hasExplicitCandidates,
    selectedAccount: decision.selectedAccount || null,
    quota: decision.quota || null,
    fallback: decision.fallback || null,
    workKind: decision.workKind,
    difficulty: decision.difficulty,
    requiredAbility: decision.requiredAbility,
    score: decision.score,
    components: decision.components,
    profile: decision.profile,
    scorer: meta,
    continuation: {
      held: false,
      why: cont.why,
      reasonDetail: cont.reasonDetail || null,
      sessionKey,
      turn: facts.turn,
      within: facts.within,
      previousModel: cont.previousModel || null,
      previousEffort: cont.previousEffort || null,
    },
    topCandidates: decision.topCandidates,
  };

  const payloadBytes = JSON.stringify(carrier).length;
  ctx.state = ctx.state || {};
  ctx.state.sessionKey = sessionKey;
  ctx.state.route = carrier;
  ctx.state.agentcompass = carrier;
  ctx.report?.("ready", payloadBytes);
  return undefined;
}

export async function onResponse(reply, ctx = {}) {
  const options = ctx?.options || {};
  const store = options.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const sessionKey =
    ctx?.state?.sessionKey ||
    ctx?.state?.route?.continuation?.sessionKey ||
    computeSessionKey(ctx?.request || {}, ctx);

  store.recordResponse(
    sessionKey,
    reply,
    {
      ...ctx,
      model: ctx?.state?.route?.targetModel || ctx?.model || reply?.model,
    },
    now
  );
  return undefined;
}
