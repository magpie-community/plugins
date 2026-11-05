/**
 * Native Magpie System-One Decision Provider Plugin (`decide: true` / `decides: true`)
 *
 * How Magpie integrates this provider (`internal/gateway/decide.go` & `internal/plugin/host.js:1787,1821`):
 * 1. Registers provider `"agentcompass"` with `decide: true` and model
 *    `"agentcompass-systemone"` with `decides: true`.
 * 2. In Magpie's UI (Routing -> Group -> Classifier), the user can select
 *    `agentcompass/agentcompass-systemone` as the Routing Group's Classifier.
 * 3. Magpie gives Classifier calls `Settings.ClassifyTimeout`: **8,000 ms default, configurable
 *    up to 60,000 ms (60 seconds)** (`internal/gateway/classify.go:classifyTimeout()`).
 * 4. Handles all three `/v1/systemone` request shapes sent by Magpie:
 *    - Shape A (`jevLevelled` probe in `decide.go:310`): `state.kinds` + `questions.levels` + `questions.work0..N`
 *    - Shape B (`jevBody` turn classification in `decide.go:167`): `state.turn` / `state.message` +
 *      `state.previous_message_kind` / `state.previous_message_reasoning` + `questions.intent` / `questions.level` + `questions.effort`
 *    - Shape C (Direct AgentCompass 10-field `/v1/systemone` query): `state.task` + `questions.work_kind` / `reasoning_depth` / etc.
 */

import { rankCandidates, selectBestRoute } from "./allocator.js";
import { CANONICAL_ROUTES, canonicalModel } from "./catalog.js";
import {
  SessionContinuityStore,
  analyzeTurnState,
  coldAfterMs,
  computeSessionKey,
  defaultContinuityStore,
  evaluateProviderContinuation,
  firstWords,
  isCompactionText,
  isShortFollowupMessage,
  keepsEffort,
  ratchetEffort,
  sha256Hex,
  stripAgentNoise,
  userSaidFromText,
} from "./continuity.js";
import {
  computeWindowCost,
  demandForecast,
  evaluateModelQuota,
  isModelQuotaExhausted,
  normalizeQuotaSnapshot,
  orderSeatsByQuotaEconomics,
} from "./quota.js";
import { clearQuotasCache, loadLiveQuotas, resolveMagpieQuotasFile } from "./quota-loader.js";
import { scoreTaskLive } from "./scorer-live.js";

export const PROVIDER_ID = "agentcompass";
export const DECISION_MODEL_ID = "agentcompass-systemone";
export const AGENTCOMPASS_ICON_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMjgiIHN0cm9rZT0iIzNCODJGNiIgc3Ryb2tlLXdpZHRoPSI0IiBmaWxsPSIjMEYxNzJBIi8+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMjIiIHN0cm9rZT0iIzYwQTVGQSIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1kYXNoYXJyYXk9IjMgMyIvPjxwb2x5Z29uIHBvaW50cz0iMzIsMTIgMzgsMzIgMzIsMjggMjYsMzIiIGZpbGw9IiNFRjQ0NDQiLz48cG9seWdvbiBwb2ludHM9IjMyLDUyIDM4LDMyIDMyLDM2IDI2LDMyIiBmaWxsPSIjRTJFOEYwIi8+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMy41IiBmaWxsPSIjRjhGQUZDIi8+PC9zdmc+";

const DIFFICULTY_SCALE_WORDS = {
  routine: 0,
  simple: 0,
  easy: 0,
  trivial: 0,
  low: 0,
  简单: 0,
  日常: 0,
  轻量: 0,
  hard: 1,
  standard: 1,
  medium: 1,
  normal: 1,
  中等: 1,
  常规: 1,
  标准: 1,
  coupled: 2,
  complex: 2,
  deep: 2,
  architectural: 2,
  复杂: 2,
  跨模块: 2,
  架构: 2,
  frontier: 3,
  extreme: 3,
  critical: 3,
  max: 3,
  前沿: 3,
  高难: 3,
  极限: 3,
};

const EFFORT_TO_JEV_SCORE = {
  low: 0.0,
  medium: 1.0,
  high: 2.0,
  xhigh: 3.0,
  max: 3.0,
  ultra: 3.0,
};

/**
 * Check if a Routing Group's `intents` array represents difficulty/scale levels
 * (`jevLevelled` in `internal/gateway/decide.go:310`).
 */
export function evaluateLevelsProbe(kinds = []) {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return { isLevels: false, scores: [] };
  }
  let matched = 0;
  const scores = kinds.map((raw) => {
    const clean = String(raw || "").trim().toLowerCase();
    for (const [word, score] of Object.entries(DIFFICULTY_SCALE_WORDS)) {
      if (clean === word || clean.includes(word)) {
        matched++;
        return score;
      }
    }
    return 1.0;
  });
  return {
    isLevels: matched === kinds.length && new Set(scores).size >= 2,
    scores,
  };
}

function buildChoiceDistribution(choices, bestChoice, winnerProb = 0.88) {
  const probabilities = {};
  const restChoices = choices.filter((c) => c !== bestChoice);
  const remainder = restChoices.length > 0 ? (1.0 - winnerProb) / restChoices.length : 0.0;
  for (const c of choices) {
    probabilities[c] =
      c === bestChoice
        ? restChoices.length > 0
          ? winnerProb
          : 1.0
        : Math.round(remainder * 10000) / 10000;
  }
  return {
    choice: bestChoice,
    confidence: probabilities[bestChoice],
    probabilities,
  };
}

/**
 * Match a profiled AgentCompass task (`workKind`, `difficulty`, `targetModel`, `profile`)
 * against the user's Routing Group `intent` or `level` choices in Magpie (`decide.go:readJev`).
 */
export function matchMagpieIntentChoice(criteriaObj, routeDecision, preferredChoice = "") {
  const choices = Object.keys(criteriaObj || {});
  if (choices.length === 0) {
    return {
      choice: "none of these",
      confidence: 1.0,
      probabilities: { "none of these": 1.0 },
    };
  }

  if (preferredChoice && choices.includes(preferredChoice)) {
    return buildChoiceDistribution(choices, preferredChoice, 0.94);
  }

  const noneKey = choices.find((c) => c === "none of these" || c === "none") || "none of these";
  const nonNone = choices.filter((c) => c !== "none" && c !== "none of these");
  const wk = String(routeDecision.workKind || "").toLowerCase();
  const diff = String(routeDecision.difficulty || "hard").toLowerCase();
  const targetCanon = canonicalModel(routeDecision.targetModel || "").toLowerCase();
  const style = String(routeDecision.profile?.interaction_style || "").toLowerCase();

  let bestChoice = null;
  let bestWeight = -1;
  const rawWeights = {};

  for (const candidate of nonNone) {
    const lower = candidate.trim().toLowerCase();
    const desc = String(criteriaObj[candidate] || "").toLowerCase();
    let w = 0.05;

    // 1. Exact or substring match with AgentCompass's 16 canonical `work_kind` routes
    if (lower === wk || lower.replace(/[-\s]/g, "_") === wk) {
      w = 10.0;
    } else if (
      desc.includes(wk.replace(/_/g, " ")) ||
      (wk && lower.includes(wk.split("_")[0]))
    ) {
      w = Math.max(w, 6.0);
    }

    // 2. Match by difficulty level (`routine`, `hard`, `coupled`, `frontier`, Chinese equivalents)
    if (
      lower === diff ||
      (DIFFICULTY_SCALE_WORDS[lower] !== undefined &&
        DIFFICULTY_SCALE_WORDS[lower] === DIFFICULTY_SCALE_WORDS[diff])
    ) {
      w = Math.max(w, 8.5);
    }

    // 3. Match by model family or DNA keywords in the rule's intent label
    if (targetCanon && (lower.includes(targetCanon) || targetCanon.includes(lower))) {
      w = Math.max(w, 8.0);
    }
    if (
      (wk === "frontend_implementation" && /frontend|ui|react|css|前端|界面/.test(lower)) ||
      (wk === "debug_review" && /debug|bug|fix|review|audit|排查|修复|审查|审计/.test(lower)) ||
      ((wk === "direction_reasoning" || wk === "complex_build_plan") &&
        /direction|reason|brainstorm|creative|plan|architect|design|scheme|方案|架构|规划|创意|脑暴|推理/.test(
          lower
        )) ||
      ((wk === "bounded_bulk_work" || wk === "tool_execution") &&
        /fast|quick|routine|bulk|simple|简单|日常|批量|轻量/.test(lower)) ||
      (wk === "visual_analysis" && /vis|image|screenshot|看图|视觉|截图/.test(lower)) ||
      (wk === "computer_use" && /gui|desktop|browser|computer|桌面|点击/.test(lower)) ||
      (style === "exploration" && /explor|research|search|分析|调研|探索/.test(lower)) ||
      ((wk === "self_contained_code" || wk === "general_implementation") &&
        /code|coding|implement|dev|代码|开发|实现/.test(lower))
    ) {
      w = Math.max(w, 7.5);
    }

    rawWeights[candidate] = w;
    if (w > bestWeight) {
      bestWeight = w;
      bestChoice = candidate;
    }
  }

  if (!bestChoice || (bestWeight < 1.0 && choices.includes(noneKey))) {
    bestChoice = choices.includes(noneKey) ? noneKey : nonNone[0];
  }

  return buildChoiceDistribution(choices, bestChoice, 0.88);
}

function buildEffortAnswer(effort, confidence = 0.9) {
  const effScore = EFFORT_TO_JEV_SCORE[effort] ?? 2.0;
  const idx = String(Math.max(0, Math.min(3, Math.round(effScore))));
  const rem = Math.round(((1.0 - confidence) / 3) * 10000) / 10000;
  const probs = { "0": rem, "1": rem, "2": rem, "3": rem };
  probs[idx] = confidence;
  return {
    score: effScore,
    confidence,
    probabilities: probs,
  };
}

/**
 * Handle a POST `/v1/systemone` request from Magpie (`internal/gateway/decide.go`).
 */
export async function handleSystemOneRequest(bodyObj, pluginOptions = {}) {
  const model = bodyObj?.model || DECISION_MODEL_ID;
  const state = bodyObj?.state || {};
  const questions = bodyObj?.questions || {};

  // Case 1: Magpie `jevLevelled` probe (`state.kinds` + `questions.levels`)
  if ("levels" in questions && Array.isArray(state.kinds)) {
    const { isLevels, scores } = evaluateLevelsProbe(state.kinds);
    const answers = {
      levels: { noul: isLevels ? 0.9 : 0.05 },
    };
    scores.forEach((s, idx) => {
      if (`work${idx}` in questions) {
        answers[`work${idx}`] = { score: s };
      }
    });
    return {
      model,
      answers,
      usage: { input_tokens: 32, output_tokens: 16 },
    };
  }

  // Case 2: Magpie Routing Group per-turn decision (`state.message` / `state.turn` + `questions.intent` / `level` / `effort`)
  const turnText =
    typeof state.message === "string"
      ? state.message
      : typeof state.turn === "string"
        ? state.turn
        : typeof state.task?.objective === "string"
          ? state.task.objective
          : JSON.stringify(state);

  const prevUser =
    typeof state.previous_user_message === "string"
      ? state.previous_user_message
      : typeof state.previous_user === "string"
        ? state.previous_user
        : "";
  const prevKind =
    typeof state.previous_message_kind === "string" ? state.previous_message_kind.trim() : "";
  const prevReasoning =
    typeof state.previous_message_reasoning === "string"
      ? state.previous_message_reasoning.trim().toLowerCase()
      : "";

  // Continuation fast-path for short follow-up nudges ("继续", "ok go ahead", "lgtm", etc.)
  // when Magpie's `decide.go` passes `previous_message_kind` / `previous_message_reasoning`.
  if (
    (prevKind || prevReasoning) &&
    isShortFollowupMessage(turnText) &&
    !isCompactionText(turnText)
  ) {
    const heldEffort = ratchetEffort(prevReasoning || "high", "medium", [
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    const answers = {};
    const syntheticDecision = {
      workKind: prevKind || "general_implementation",
      difficulty: DIFFICULTY_SCALE_WORDS[prevKind.toLowerCase()] !== undefined ? prevKind : "hard",
      targetModel: "",
      targetEffort: heldEffort,
    };

    if (questions.intent?.criteria) {
      answers.intent = matchMagpieIntentChoice(
        questions.intent.criteria,
        syntheticDecision,
        prevKind
      );
    }
    if (questions.level?.criteria) {
      answers.level = matchMagpieIntentChoice(
        questions.level.criteria,
        syntheticDecision,
        prevKind
      );
    }
    if (questions.effort) {
      answers.effort = buildEffortAnswer(heldEffort, 0.94);
    }
    if (questions.work_kind && !answers.work_kind) {
      answers.work_kind = {
        choice: prevKind || "general_implementation",
        confidence: 0.94,
      };
    }

    return {
      model,
      answers,
      agentcompass: {
        targetModel: null,
        targetEffort: heldEffort,
        workKind: prevKind || "general_implementation",
        difficulty: syntheticDecision.difficulty,
        continuation: {
          held: true,
          why: "followup",
          previousKind: prevKind || null,
          previousEffort: prevReasoning || null,
        },
        scorer: {
          kind: "continuity_hold",
          held: true,
          why: "followup",
          calls: 0,
        },
      },
      usage: {
        input_tokens: Math.max(8, Math.ceil(turnText.length / 4)),
        output_tokens: 16,
      },
    };
  }

  const taskFacts = {
    objective: turnText,
    previousUser: prevUser,
    hasVisualInput: Boolean(state.has_visual_input),
  };

  const scorerCfg =
    pluginOptions.scorer && typeof pluginOptions.scorer === "object" ? pluginOptions.scorer : {};
  const allowExternalScorer =
    pluginOptions.allowExternalScorer === true ||
    scorerCfg.allowExternalScorer === true;

  const { profile, meta } = await scoreTaskLive(taskFacts, {
    allowExternalScorer,
    scorerType: pluginOptions.scorerType || scorerCfg.kind || scorerCfg.type || "heuristic",
    scorerModel: pluginOptions.scorerModel || scorerCfg.model,
    scorerBaseUrl: pluginOptions.scorerBaseUrl || scorerCfg.baseUrl,
    scorerApiKey: pluginOptions.scorerApiKey || scorerCfg.apiKey,
    jevBaseUrl: pluginOptions.jevBaseUrl || scorerCfg.jevBaseUrl,
    jevApiKey: pluginOptions.jevApiKey || scorerCfg.jevApiKey,
    scorerTimeoutMs: pluginOptions.scorerTimeoutMs || scorerCfg.timeoutMs || 15000,
    fetch: pluginOptions.fetch,
  });

  const liveQuotas = state.quotas || loadLiveQuotas(pluginOptions);
  let decision = selectBestRoute(profile, {
    objective: turnText,
    candidateModels: pluginOptions.candidateModels || pluginOptions.allowedModels,
    catalog: pluginOptions.catalog,
    quotas: liveQuotas,
    meteredOk: pluginOptions.meteredOk,
  });
  if (!decision.ok && liveQuotas) {
    decision = selectBestRoute(profile, {
      objective: turnText,
      candidateModels: pluginOptions.candidateModels || pluginOptions.allowedModels,
      catalog: pluginOptions.catalog,
    });
  }

  const answers = {};
  let matchedChoice = "";

  if (questions.intent?.criteria) {
    answers.intent = matchMagpieIntentChoice(questions.intent.criteria, decision);
    matchedChoice = answers.intent.choice;
  }
  if (questions.level?.criteria) {
    answers.level = matchMagpieIntentChoice(questions.level.criteria, decision);
    if (!matchedChoice) matchedChoice = answers.level.choice;
  }

  // Monotonic effort ratchet (`keepsEffort`) when continuing on the same kind/intent
  let effectiveEffort = decision.targetEffort;
  if (
    prevReasoning &&
    !isCompactionText(turnText) &&
    ((prevKind && matchedChoice && prevKind === matchedChoice) ||
      (prevKind && prevKind === decision.workKind))
  ) {
    effectiveEffort = ratchetEffort(prevReasoning, effectiveEffort, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  }

  if (questions.effort) {
    answers.effort = buildEffortAnswer(effectiveEffort, 0.9);
  }

  // Case 3: Direct 10-field System-One questions (when called as a general Jev endpoint)
  if (questions.work_kind && !answers.work_kind) {
    answers.work_kind = { choice: decision.workKind, confidence: 0.9 };
  }
  if (questions.interaction_style && !answers.interaction_style) {
    answers.interaction_style = { choice: profile.interaction_style, confidence: 0.9 };
  }
  for (const dim of [
    "reasoning_depth",
    "code_complexity",
    "context_scale",
    "divergence",
    "hallucination_risk",
    "error_cost",
  ]) {
    if (questions[dim] && !answers[dim]) {
      const low = dim === "code_complexity" ? 0 : 1;
      answers[dim] = { score: Math.max(0, (profile[dim] ?? low) - low) };
    }
  }
  for (const flag of ["needs_visual", "needs_gui", "local_only"]) {
    if (questions[flag] && !answers[flag]) {
      answers[flag] = { noul: profile[flag] ? 0.95 : 0.05 };
    }
  }

  return {
    model,
    answers,
    agentcompass: {
      targetModel: decision.targetModel,
      targetEffort: effectiveEffort,
      selectedAccount: decision.selectedAccount || null,
      quota: decision.quota || null,
      workKind: decision.workKind,
      difficulty: decision.difficulty,
      requiredAbility: decision.requiredAbility,
      continuation: {
        held: false,
        why: prevKind ? "reclassified" : "first",
        previousKind: prevKind || null,
        previousEffort: prevReasoning || null,
      },
      profile,
      scorer: meta,
    },
    usage: {
      input_tokens: Math.max(16, Math.ceil(turnText.length / 4)),
      output_tokens: 48,
    },
  };
}

/**
 * Default Magpie Gateway / Middleware Plugin export (`src/index.js`).
 * By default it registers no `auth` hook and no `cfg.provider` entry, so Magpie treats the package
 * purely as a gateway hook + middleware plugin. With `enableDecisionProvider: true` it adds the
 * `agentcompass` decision provider: the `config` entry (`decide`, the `decides` model) and the keyless
 * `auth` hook whose loader serves `/systemone`; Magpie needs both.
 */
export async function AgentCompassRouterPlugin(input, pluginOptions = {}) {
  if (pluginOptions.enableDecisionProvider !== true) {
    return {
      async config() {},
    };
  }

  return {
    async config(cfg) {
      cfg.provider = cfg.provider || {};
      cfg.provider[PROVIDER_ID] = {
        name: "AgentCompass",
        icon: AGENTCOMPASS_ICON_DATA_URI,
        api: DECISION_BASE_URL,
        decide: true,
        models: {
          [DECISION_MODEL_ID]: {
            name: "AgentCompass System-One Profiler (10D + Model DNA)",
            decides: true,
            reasoning: true,
            tool_call: false,
            limit: { context: 200000, output: 4096 },
            cost: { input: 0, output: 0 },
          },
        },
      };
    },
    // Magpie lists, signs in and serves only providers a plugin's auth hook names (host.js `auths()`,
    // `providers()`; Go `plugin.Provider` is "a provider a plugin signs in to"). It posts System One's
    // questions to the provider's base `/systemone` through the fetch the auth loader returns. A
    // `config` entry alone is never listed: no Classifier option, no `magpie plugin login agentcompass`,
    // and `/v1/systemone` answers 404 (issue #1).
    auth: {
      provider: PROVIDER_ID,
      icon: AGENTCOMPASS_ICON_DATA_URI,
      single: true,
      methods: [
        {
          type: "api",
          // keyless: nothing to type and no account of the user's (Magpie's publicPlugin)
          keyless: true,
          label: "Enable AgentCompass decision provider",
          async authorize() {
            return { type: "success", key: DECISION_ACCOUNT_KEY };
          },
        },
      ],
      async loader() {
        return {
          baseURL: DECISION_BASE_URL,
          apiKey: DECISION_ACCOUNT_KEY,
          fetch: (reqInput, init) => systemOneFetch(reqInput, init, pluginOptions),
        };
      },
    },
  };
}

/** Local base the decision provider is served under; nothing is sent over the network. */
export const DECISION_BASE_URL = "https://agentcompass.local/v1";
const DECISION_ACCOUNT_KEY = "agentcompass-local";

function requestPath(reqInput) {
  const raw = typeof reqInput === "string" ? reqInput : reqInput?.url ?? String(reqInput ?? "");
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

/** The decision provider's fetch: answers `/systemone`, and nothing else. */
export async function systemOneFetch(reqInput, init, pluginOptions = {}) {
  const json = (status, value) =>
    new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  if (!requestPath(reqInput).replace(/\/+$/, "").endsWith("/systemone")) {
    return json(404, {
      error: { type: "not_found_error", message: `${PROVIDER_ID} answers only /systemone (System One decisions)` },
    });
  }
  const rawBody = init?.body
    ? typeof init.body === "string"
      ? init.body
      : new TextDecoder().decode(init.body)
    : reqInput instanceof Request
      ? await reqInput.text()
      : "{}";
  let parsed = {};
  try {
    parsed = JSON.parse(rawBody);
  } catch {}
  return json(200, await handleSystemOneRequest(parsed, pluginOptions));
}

export default {
  id: "agentcompass",
  server: AgentCompassRouterPlugin,
};
export {
  CANONICAL_ROUTES,
  SessionContinuityStore,
  analyzeTurnState,
  clearQuotasCache,
  coldAfterMs,
  computeSessionKey,
  computeWindowCost,
  defaultContinuityStore,
  demandForecast,
  evaluateModelQuota,
  evaluateProviderContinuation,
  firstWords,
  isCompactionText,
  isModelQuotaExhausted,
  isShortFollowupMessage,
  keepsEffort,
  loadLiveQuotas,
  normalizeQuotaSnapshot,
  orderSeatsByQuotaEconomics,
  rankCandidates,
  ratchetEffort,
  resolveMagpieQuotasFile,
  selectBestRoute,
  sha256Hex,
  stripAgentNoise,
  userSaidFromText,
};
