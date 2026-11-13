/**
 * Optional Async Bun Gateway Helper (`./hooks`)
 *
 * Used for programmatic / custom host integrations that opt into asynchronous external
 * System-One scoring (`allowExternalScorer: true`) and pass routing state via `ctx.state.route`
 * without mutating client request body fields. With no classifier and no caller profile it routes nothing
 * and says so in `ctx.state.agentcompass` and the log.
 */

import {
  blockedRefusal,
  candidateOffers,
  effortGoneWarning,
  heldBundle,
  heldEffortOn,
  heldTarget,
  explicitCandidateModels,
  extractModelList,
  mergePinOptions,
  pinOptionsOf,
  pinsFixEffort,
  sessionProfile,
  selectBestRoute,
} from "./allocator.js";
import { canonicalModel } from "./catalog.js";
import {
  computeSessionKey,
  defaultContinuityStore,
  evaluateProviderContinuation,
  keepsEffort,
} from "./continuity.js";
import { extractRequestFacts, noTextProfile, resolveCallerProfile, unroutedDecision } from "./profiler-core.js";
import {
  areCandidatesAccountBlocked,
  listQuotaAccounts,
  quotaAccountWarnings,
} from "./quota.js";
import { loadLiveQuotas } from "./quota-loader.js";
import { scoreTaskLive, scorerOptionsOf } from "./scorer-live.js";

export { extractModelList };

function emitWarnings(warnings, ctx) {
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  for (const w of warnings) {
    if (typeof ctx?.warn === "function") {
      ctx.warn(w);
    }
  }
}

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

export function resolveCandidateModels(body, ctx = {}, options = {}) {
  const explicit = explicitCandidateModels(options, ctx);

  if (explicit) {
    return { candidateModels: explicit, hasExplicitCandidates: true, canRewriteModel: true };
  }

  if (options.allowUnconstrainedCatalog === true) {
    return { candidateModels: null, hasExplicitCandidates: false, canRewriteModel: true };
  }

  // A `:effort` here is the user fixing the effort: it stays on the candidate.
  const rawModel = String(body?.model || ctx?.model || "").trim();
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

/** Nothing may route this request: the middleware rejects it rather than deciding again. */
function blockRoute(ctx, sessionKey, error, warnings, refusal) {
  ctx.state = ctx.state || {};
  ctx.state.sessionKey = sessionKey;
  ctx.state.routeBlocked = { error, warnings, refusal };
  ctx.report?.("empty");
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
  const facts = extractRequestFacts(body, ctx);

  if (!shouldRouteRequest(facts.model, options)) {
    ctx.report?.("skipped");
    return undefined;
  }

  const store = options.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const sessionKey = facts.sessionKey || computeSessionKey(body, ctx);
  const sessionState = sessionKey ? store.get(sessionKey, now, { keepExpired: true }) : null;
  const { candidateModels, hasExplicitCandidates, canRewriteModel } = resolveCandidateModels(
    body,
    ctx,
    options
  );
  const liveQuotas = loadLiveQuotas(options, now);

  const pins = mergePinOptions(pinOptionsOf(options), body, body.task);

  let cont = evaluateProviderContinuation(facts, sessionState, {
    now,
    pins,
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
    const keptEffort = keepsEffort(
      sessionState,
      cont.effort || sessionState?.effort || "high",
      facts.estimatedInputTokens,
      now,
      options
    );
    const canonical = canonicalModel(cont.model, options.catalog?.aliases);
    const heldModel = heldTarget(cont.model, sessionState, candidateModels, options.catalog);
    // Contract R2: a hold runs what the pool offers now. Nothing at or below the held effort, or a pin that names it: route again.
    const pool = Array.isArray(candidateModels) && candidateModels.length > 0 ? candidateModels : null;
    const heldEffort = pool ? heldEffortOn(pool, heldModel, keptEffort, options.catalog, { pins, profile: sessionProfile(sessionState) }) : keptEffort;
    const effortGone = heldEffort === null || (heldEffort !== keptEffort && pinsFixEffort(pins));
    if (effortGone) {
      cont = {
        shouldHold: false,
        why: "effort_gone",
        previousModel: cont.previousModel || cont.model,
        previousEffort: keptEffort,
        within: Boolean(facts.within),
        turn: facts.turn || 1,
      };
    }
    if (!effortGone) {
      if (sessionKey) {
        store.recordRequest(
          sessionKey,
          {
            model: heldModel,
            effort: heldEffort,
            provider: cont.provider || sessionState?.provider || "",
            workKind: sessionState?.workKind || "general_implementation",
            difficulty: sessionState?.difficulty || "routine",
            why: cont.why,
            held: true,
            pinnedBundle: pins.pinnedBundle,
          },
          facts,
          now
        );
      }

      const heldAccounts = liveQuotas ? listQuotaAccounts(liveQuotas, now, options.catalog?.policy) : undefined;
      const heldWarnings = liveQuotas ? quotaAccountWarnings(liveQuotas, now, options.catalog?.policy) : [];
      const stepWarnings = heldEffort === keptEffort ? [] : [`${heldModel}: effort ${keptEffort} is no longer offered; held at ${heldEffort}`];
      const allHeldWarnings = [...stepWarnings, ...heldWarnings];
      emitWarnings(allHeldWarnings, ctx);

      const carrier = {
        v: 1,
        targetModel: heldModel,
        canonicalModel: canonical,
        targetEffort: heldEffort,
        modelWithEffort: `${heldModel}:${heldEffort}`,
        bundle: pool ? heldBundle(pool, heldModel, heldEffort, options.catalog, pins) : null,
        canRewriteModel,
        hasExplicitCandidates,
        ...(heldAccounts ? { accounts: heldAccounts } : {}),
        workKind: sessionState?.workKind || "general_implementation",
        difficulty: sessionState?.difficulty || "routine",
        axisDemand: sessionState?.profile?.axis_demand || null,
        score: null,
        components: null,
        profile: sessionState?.profile || null,
        pins,
        warnings: allHeldWarnings,
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
  }

  // What this turn's text looks like is no ground for putting back the row the hold just refused (contract R2).
  // A pool or a pin holds on a turn with no text too: an image alone doesn't get past either (contract R2, R3).
  const caller = resolveCallerProfile(facts.callerProfile, facts.hasVisualInput);
  const { profile, meta } =
    cont.why === "effort_gone"
      ? { profile: sessionProfile(sessionState), meta: { kind: "continuity_hold", held: false, why: cont.why, calls: 0 } }
      : caller?.error
        ? { profile: null, meta: { source: "caller", reason: caller.error } }
        : caller
          ? { profile: caller.profile, meta: { source: "caller" } }
          : !facts.objective
            ? hasExplicitCandidates || Object.keys(pins).length > 0
              ? { profile: noTextProfile(facts), meta: { source: "no_text", calls: 0 } }
              : { profile: null, meta: { source: "none", reason: "empty_objective", calls: 0 } }
            : await scoreTaskLive(facts, {
                scorerTimeoutMs: Math.max(500, (options.gatewayTimeoutMs || 8000) - 500),
                ...scorerOptionsOf(options),
                signal: ctx.signal,
              });

  if (!profile) {
    const unrouted = unroutedDecision(meta.reason);
    console.warn(`agentcompass: ${unrouted.notice} (${unrouted.reason})`);
    ctx.state = ctx.state || {};
    ctx.state.sessionKey = sessionKey;
    ctx.state.agentcompass = unrouted;
    ctx.report?.("empty");
    return undefined;
  }

  const unhealthyModels = [
    ...store.getUnhealthyModels(now),
    ...(Array.isArray(options.unhealthyModels) ? options.unhealthyModels : []),
  ];
  if (cont.why === "provider_unhealthy" && cont.failedModel) {
    unhealthyModels.push(cont.failedModel);
  }

  const minContextTokens =
    cont.why === "outgrown" ? Number(facts.estimatedInputTokens || 0) : 0;

  const decision = selectBestRoute(profile, {
    candidateModels,
    catalog: options.catalog,
    unhealthyModels,
    minContextTokens,
    quotas: liveQuotas,
    meteredOk: options.meteredOk,
    userScores: options.userScores,
    now,
    ...pins,
    continuity: {
      previousModel: cont.previousModel || null,
      previousEffort: cont.previousEffort || null,
      why: cont.why,
      cacheWarm: false,
    },
  });
  if (cont.why === "effort_gone") decision.warnings = [effortGoneWarning(cont), ...decision.warnings];

  emitWarnings(decision.warnings, ctx);

  if (!decision.ok || !decision.targetModel) {
    blockRoute(ctx, sessionKey, decision.error || "no_route", decision.warnings, decision.refusal);
    const accountBlocked = Boolean(
      liveQuotas &&
        (areCandidatesAccountBlocked(candidateModels, liveQuotas, options, now) ||
          selectBestRoute(profile, {
            candidateModels,
            catalog: options.catalog,
            unhealthyModels,
            minContextTokens,
            quotas: undefined,
            meteredOk: options.meteredOk,
            userScores: options.userScores,
            now,
            ...pins,
          }).ok)
    );
    if (!accountBlocked) {
      return undefined;
    }
    const failedCarrier = {
      v: 1,
      ok: false,
      blocked: true,
      error: decision.error || "no_route",
      refusal: decision.refusal,
      accountBlocked: true,
      reason: decision.reason || "no_eligible_candidate",
      targetModel: null,
      canonicalModel: null,
      targetEffort: null,
      modelWithEffort: null,
      canRewriteModel,
      hasExplicitCandidates,
      selectedAccount: null,
      quota: null,
      ...(decision.warnings?.length ? { warnings: decision.warnings } : {}),
      ...(decision.accounts ? { accounts: decision.accounts } : {}),
      workKind: decision.workKind,
      difficulty: decision.difficulty,
      axisDemand: decision.axisDemand,
      score: null,
      components: null,
      profile: decision.profile || profile,
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
      topCandidates: decision.topCandidates || [],
    };
    ctx.state = ctx.state || {};
    ctx.state.sessionKey = sessionKey;
    ctx.state.route = failedCarrier;
    ctx.state.agentcompass = failedCarrier;
    ctx.reject?.(503, `agentcompass: ${blockedRefusal(failedCarrier)}`);
    return undefined;
  }

  let finalEffort = decision.targetEffort;
  if (
    sessionState &&
    canonicalModel(decision.targetModel) === canonicalModel(sessionState.model) &&
    cont.why !== "cold" &&
    cont.why !== "compacted" &&
    cont.why !== "first" &&
    cont.why !== "worn" &&
    !pinsFixEffort(pins)
  ) {
    const kept = keepsEffort(
      sessionState,
      decision.targetEffort,
      facts.estimatedInputTokens,
      now,
      options
    );
    if (!candidateModels || candidateOffers(candidateModels, decision.targetModel, kept, options.catalog)) finalEffort = kept;
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
        profile: decision.profile,
        pinnedBundle: pins.pinnedBundle,
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
    ...(decision.warnings?.length ? { warnings: decision.warnings } : {}),
    ...(decision.accounts ? { accounts: decision.accounts } : {}),
    workKind: decision.workKind,
    difficulty: decision.difficulty,
    axisDemand: decision.axisDemand,
    score: decision.score,
    components: decision.components,
    profile: decision.profile,
    bundle: decision.bundle,
    pins,
    minContextTokens,
    warnings: decision.warnings || [],
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
  // An unrouted request was the client's own choice: it must not start a session that later turns hold.
  if (ctx?.state?.agentcompass?.routed === false) return undefined;
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
