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
 *    - Shape C (Direct AgentCompass task-profile `/v1/systemone` query): `state.task` + `questions.work_kind` / `reasoning_depth` / etc.
 */

import {
  explicitCandidateModels,
  blockedRefusal,
  candidateOffers,
  effortUnchecked,
  logRouteWarnings,
  mergePinOptions,
  pinOptionsOf,
  pinsFixEffort,
  refusalSummary,
  rankCandidates,
  selectBestRoute,
} from "./allocator.js";
import { ROUTES, canonicalModel } from "./catalog.js";
import {
  SessionContinuityStore,
  analyzeTurnState,
  coldAfterMs,
  computeSessionKey,
  defaultContinuityStore,
  evaluateProviderContinuation,
  firstWords,
  keepsEffort,
  ratchetEffort,
  sha256Hex,
  stripAgentNoise,
  userSaidFromText,
} from "./continuity.js";
import { FIVE_AXES } from "./axis-scores.js";
import { extractRequestFacts } from "./profiler-core.js";
import {
  isModelQuotaExhausted,
  formatQuotaAccountList,
  listQuotaAccounts,
  normalizeQuotaSnapshot,
  orderSeatsByQuotaEconomics,
  quotaAccountWarnings,
} from "./quota.js";
import { resolveCallerProfile, unroutedDecision } from "./profiler-core.js";
import { clearQuotasCache, getQuotasLoadStatus, loadLiveQuotas, resolveMagpieQuotasFile } from "./quota-loader.js";
import { askClassifier, scoreTaskLive, scorerOptionsOf } from "./scorer-live.js";

export const PROVIDER_ID = "agentcompass";
export const DECISION_MODEL_ID = "agentcompass-systemone";
export const AGENTCOMPASS_ICON_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMjgiIHN0cm9rZT0iIzNCODJGNiIgc3Ryb2tlLXdpZHRoPSI0IiBmaWxsPSIjMEYxNzJBIi8+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMjIiIHN0cm9rZT0iIzYwQTVGQSIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1kYXNoYXJyYXk9IjMgMyIvPjxwb2x5Z29uIHBvaW50cz0iMzIsMTIgMzgsMzIgMzIsMjggMjYsMzIiIGZpbGw9IiNFRjQ0NDQiLz48cG9seWdvbiBwb2ludHM9IjMyLDUyIDM4LDMyIDMyLDM2IDI2LDMyIiBmaWxsPSIjRTJFOEYwIi8+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMy41IiBmaWxsPSIjRjhGQUZDIi8+PC9zdmc+";

const EFFORT_TO_JEV_SCORE = {
  low: 0.0,
  medium: 1.0,
  high: 2.0,
  xhigh: 3.0,
  max: 3.0,
  ultra: 3.0,
};

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

const NONE_OF_THESE = "none of these";
const isNoneChoice = (choice) => choice === NONE_OF_THESE || choice === "none";

function noneAnswer(criteriaObj) {
  const choices = Object.keys(criteriaObj || {});
  const none = choices.find(isNoneChoice);
  return none
    ? buildChoiceDistribution(choices, none, 0.88)
    : { choice: NONE_OF_THESE, confidence: 1.0, probabilities: { [NONE_OF_THESE]: 1.0 } };
}

/**
 * The operator's Routing Group `intent` or `level` choice that names this route exactly: its `work_kind`,
 * `difficulty` or model. Any other label is the operator's own words, which only the classifier reads
 * (`askClassifier`); `null` then.
 */
export function matchMagpieIntentChoice(criteriaObj, routeDecision) {
  const choices = Object.keys(criteriaObj || {}).filter((c) => !isNoneChoice(c));
  const wk = String(routeDecision.workKind || "").toLowerCase();
  const diff = String(routeDecision.difficulty || "").toLowerCase();
  const targetCanon = canonicalModel(routeDecision.targetModel || "").toLowerCase();
  const named = (target) =>
    target ? choices.find((c) => c.trim().toLowerCase().replace(/[-\s]/g, "_") === target) : undefined;
  const choice = named(wk) || named(diff) || choices.find((c) => targetCanon && c.trim().toLowerCase() === targetCanon);
  return choice ? buildChoiceDistribution(Object.keys(criteriaObj), choice, 0.88) : null;
}

/**
 * The classifier's answer to a `choice` question, as a distribution over the operator's labels, or `null`.
 */
function classifierChoice(answers, name, criteriaObj) {
  const choice = answers?.[name]?.choice;
  const choices = Object.keys(criteriaObj || {});
  return typeof choice === "string" && choices.includes(choice) ? buildChoiceDistribution(choices, choice, 0.88) : null;
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
 * Handle a POST `/v1/systemone` request from Magpie (`internal/gateway/decide.go`). Magpie reads `model`, `answers` and `usage`.
 * This is a public gateway route, so `agentcompass` holds the conclusion only: accounts, quotas, the pool and health go to the
 * local log, and to the caller only under the operator's `decisionProviderDetails: true`.
 */
export async function handleSystemOneRequest(bodyObj, pluginOptions = {}) {
  const model = bodyObj?.model || DECISION_MODEL_ID;
  const state = bodyObj?.state || {};
  const questions = bodyObj?.questions || {};

  const scorerOptions = { scorerTimeoutMs: 15000, ...scorerOptionsOf(pluginOptions) };

  // Case 1: Magpie `jevLevelled` probe (`state.kinds` + `questions.levels`): whether the operator's labels are a
  // difficulty scale is for the classifier to say. Without one they are plain kinds.
  if ("levels" in questions && Array.isArray(state.kinds)) {
    const said = await askClassifier(state, questions, scorerOptions);
    const levels = Number(said?.levels?.noul);
    const answers = {
      levels: { noul: Number.isFinite(levels) ? levels : 0.05 },
    };
    state.kinds.forEach((_, idx) => {
      const score = Number(said?.[`work${idx}`]?.score);
      if (`work${idx}` in questions && Number.isFinite(score)) {
        answers[`work${idx}`] = { score };
      }
    });
    return {
      model,
      answers,
      ...(said ? {} : { agentcompass: unroutedDecision("no_classifier_answer") }),
      usage: { input_tokens: 32, output_tokens: 16 },
    };
  }

  // Case 2: Magpie Routing Group per-turn decision (`state.message` / `state.turn` + `questions.intent` / `level` / `effort`)
  const now = Number.isFinite(pluginOptions.now) ? Number(pluginOptions.now) : Date.now();
  const liveQuotas = state.quotas || loadLiveQuotas(pluginOptions, now);
  const hasStateTurn =
    typeof state.message === "string" ||
    typeof state.turn === "string" ||
    typeof state.task?.objective === "string";
  const chatFacts =
    !hasStateTurn &&
    bodyObj &&
    (Array.isArray(bodyObj.messages) || Array.isArray(bodyObj.input) || typeof bodyObj.prompt === "string")
      ? extractRequestFacts(bodyObj, { options: pluginOptions })
      : null;

  const turnText =
    typeof state.message === "string"
      ? state.message
      : typeof state.turn === "string"
        ? state.turn
        : typeof state.task?.objective === "string"
          ? state.task.objective
          : chatFacts?.turnText || chatFacts?.objective || JSON.stringify(state);

  const prevUser =
    typeof state.previous_user_message === "string"
      ? state.previous_user_message
      : typeof state.previous_user === "string"
        ? state.previous_user
        : chatFacts?.previousUser || "";
  const prevKind =
    typeof state.previous_message_kind === "string" ? state.previous_message_kind.trim() : "";
  const prevReasoning =
    typeof state.previous_message_reasoning === "string"
      ? state.previous_message_reasoning.trim().toLowerCase()
      : "";

  const rawTaskObj = state.task && typeof state.task === "object" ? state.task : {};
  const store = pluginOptions.continuityStore || defaultContinuityStore;
  const candidateModels = pluginOptions.candidateModels || pluginOptions.allowedModels;
  const chatSessionKey = chatFacts ? chatFacts.sessionKey || computeSessionKey(bodyObj, { options: pluginOptions }) : "";
  const chatSessionState = chatSessionKey ? store.get(chatSessionKey, now) : null;
  const chatCont =
    chatFacts && chatSessionKey
      ? evaluateProviderContinuation(chatFacts, chatSessionState, {
          now,
          affinityMode: pluginOptions.affinityMode || pluginOptions.affinity || "cache",
          availableModels: candidateModels,
          unhealthyModels: pluginOptions.unhealthyModels,
          quotas: liveQuotas,
          policy: pluginOptions.catalog?.policy,
          store,
          coldAfterMs: pluginOptions.coldAfterMs,
          cacheTtl: pluginOptions.cacheTtl,
          models: pluginOptions.catalog?.models,
          aliases: pluginOptions.catalog?.aliases,
        })
      : null;

  const pins = mergePinOptions(pinOptionsOf(pluginOptions), state, rawTaskObj);
  const withDetails = pluginOptions.decisionProviderDetails === true;
  const blockedAnswer = (blocked, decision) => {
    logRouteWarnings(blocked.warnings);
    const { code, message } = refusalSummary(blocked);
    return {
      model,
      answers: {},
      agentcompass: withDetails
        ? {
            ok: false,
            targetModel: null,
            blocked: true,
            error: blocked.error,
            refusal: blockedRefusal(blocked),
            warnings: blocked.warnings,
            ...(decision?.accounts ? { accounts: decision.accounts } : {}),
            continuation: {
              held: false,
              why: chatCont?.why || (prevKind ? "reclassified" : "first"),
              previousKind: prevKind || null,
              previousEffort: prevReasoning || null,
            },
          }
        : { targetModel: null, blocked: true, error: code, message },
      usage: { input_tokens: Math.max(16, Math.ceil(turnText.length / 4)), output_tokens: 16 },
    };
  };

  if (chatCont && chatCont.shouldHold && chatCont.model) {
    const heldEffort = keepsEffort(
      chatSessionState,
      chatCont.effort || chatSessionState?.effort || "high",
      chatFacts.estimatedInputTokens,
      now,
      pluginOptions
    );
    const heldModel = chatCont.model;
    store.recordRequest(
      chatSessionKey,
      {
        model: heldModel,
        effort: heldEffort,
        provider: chatCont.provider || chatSessionState?.provider || "",
        workKind: chatSessionState?.workKind || "general_implementation",
        difficulty: chatSessionState?.difficulty || "routine",
        why: chatCont.why,
        held: true,
      },
      chatFacts,
      now
    );
    const heldAccounts = liveQuotas ? listQuotaAccounts(liveQuotas, now, pluginOptions.catalog?.policy) : undefined;
    const heldWarnings = liveQuotas ? quotaAccountWarnings(liveQuotas, now, pluginOptions.catalog?.policy) : [];
    const answers = {};
    const syntheticDecision = {
      workKind: chatSessionState?.workKind || "general_implementation",
      difficulty: chatSessionState?.difficulty || "routine",
      targetModel: heldModel,
      targetEffort: heldEffort,
    };
    if (questions.intent?.criteria) {
      answers.intent = matchMagpieIntentChoice(questions.intent.criteria, syntheticDecision);
    }
    if (questions.level?.criteria) {
      answers.level = matchMagpieIntentChoice(questions.level.criteria, syntheticDecision);
    }
    if (questions.effort) {
      answers.effort = buildEffortAnswer(heldEffort, 0.94);
    }
    return {
      model,
      answers,
      agentcompass: withDetails
        ? {
            ok: true,
            targetModel: heldModel,
            targetEffort: heldEffort,
            ...(heldWarnings.length ? { warnings: heldWarnings } : {}),
            ...(heldAccounts ? { accounts: heldAccounts } : {}),
            workKind: syntheticDecision.workKind,
            difficulty: syntheticDecision.difficulty,
            continuation: {
              held: true,
              why: chatCont.why,
              sessionKey: chatSessionKey,
              previousModel: chatCont.previousModel || heldModel,
              previousEffort: chatCont.previousEffort || heldEffort,
            },
            scorer: {
              kind: "continuity_hold",
              held: true,
              why: chatCont.why,
              calls: 0,
            },
          }
        : { targetModel: heldModel, targetEffort: heldEffort },
      usage: {
        input_tokens: Math.max(8, Math.ceil(turnText.length / 4)),
        output_tokens: 16,
      },
    };
  }

  const taskFacts = {
    objective: turnText,
    previousUser: prevUser,
    hasVisualInput: Boolean(state.has_visual_input || chatFacts?.hasVisualInput),
  };

  const caller = resolveCallerProfile(
    rawTaskObj.profile && typeof rawTaskObj.profile === "object"
      ? rawTaskObj.profile
      : state.profile ?? chatFacts?.callerProfile,
    taskFacts.hasVisualInput,
  );
  const { profile, meta } = caller?.error
    ? { profile: null, meta: { source: "caller", reason: caller.error } }
    : caller
      ? { profile: caller.profile, meta: { source: "caller" } }
      : await scoreTaskLive(taskFacts, scorerOptions);

  if (!profile) {
    const unrouted = unroutedDecision(meta.reason);
    console.warn(`agentcompass: ${unrouted.notice} (${unrouted.reason})`);
    const answers = {};
    if (questions.intent?.criteria) answers.intent = noneAnswer(questions.intent.criteria);
    if (questions.level?.criteria) answers.level = noneAnswer(questions.level.criteria);
    return {
      model,
      answers,
      agentcompass: { ...unrouted, scorer: meta },
      usage: {
        input_tokens: Math.max(16, Math.ceil(turnText.length / 4)),
        output_tokens: 16,
      },
    };
  }

  const decision = selectBestRoute(profile, {
    candidateModels: explicitCandidateModels(pluginOptions) || undefined,
    catalog: pluginOptions.catalog,
    quotas: liveQuotas,
    unhealthyModels: [
      ...(pluginOptions.continuityStore?.getUnhealthyModels?.(Date.now()) || []),
      ...(Array.isArray(pluginOptions.unhealthyModels) ? pluginOptions.unhealthyModels : []),
    ],
    meteredOk: pluginOptions.meteredOk,
    userScores: pluginOptions.userScores,
    now,
    ...pins,
  });
  if (decision.blocked) {
    return blockedAnswer({ error: decision.error || "no_route", warnings: decision.warnings, refusal: decision.refusal }, decision);
  }
  logRouteWarnings(decision.warnings);

  if (chatSessionKey && decision.ok && decision.targetModel) {
    store.recordRequest(
      chatSessionKey,
      {
        model: decision.targetModel,
        effort: decision.targetEffort || "high",
        workKind: decision.workKind,
        difficulty: decision.difficulty,
        why: chatCont?.why || "first",
        held: false,
      },
      chatFacts,
      now
    );
  }

  const answers = {};
  let matchedChoice = "";

  const labelQuestions = {};
  for (const name of ["intent", "level"]) {
    const criteria = questions[name]?.criteria;
    if (!criteria) continue;
    const exact = matchMagpieIntentChoice(criteria, decision);
    if (exact) answers[name] = exact;
    else labelQuestions[name] = questions[name];
  }
  if (Object.keys(labelQuestions).length > 0) {
    const said = await askClassifier({ message: turnText, previous_user: prevUser || undefined }, labelQuestions, scorerOptions);
    for (const [name, question] of Object.entries(labelQuestions)) {
      answers[name] = classifierChoice(said, name, question.criteria) || noneAnswer(question.criteria);
    }
  }
  matchedChoice = answers.intent?.choice || answers.level?.choice || "";

  // Monotonic effort ratchet (`keepsEffort`) when continuing on the same kind/intent
  let effectiveEffort = decision.targetEffort;
  if (
    !pinsFixEffort(pins) &&
    prevReasoning &&
    ((prevKind && matchedChoice && prevKind === matchedChoice) ||
      (prevKind && prevKind === decision.workKind))
  ) {
    const ratcheted = ratchetEffort(prevReasoning, effectiveEffort, ["low", "medium", "high", "xhigh", "max"]);
    const pool = explicitCandidateModels(pluginOptions);
    if (!pool || candidateOffers(pool, decision.targetModel, ratcheted, pluginOptions.catalog)) effectiveEffort = ratcheted;
  }

  if (questions.effort) {
    answers.effort = buildEffortAnswer(effectiveEffort, 0.9);
  }

  // Case 3: Direct task-profile System-One questions (when called as a general Jev endpoint)
  if (questions.work_kind && !answers.work_kind) {
    answers.work_kind = { choice: decision.workKind, confidence: 0.9 };
  }
  if (questions.interaction_style && !answers.interaction_style) {
    answers.interaction_style = { choice: profile.interaction_style, confidence: 0.9 };
  }
  for (const dim of ["reasoning_depth", "code_complexity"]) {
    if (questions[dim] && !answers[dim]) {
      const low = dim === "code_complexity" ? 0 : 1;
      answers[dim] = { score: Math.max(0, (profile[dim] ?? low) - low) };
    }
  }
  for (const axis of FIVE_AXES) {
    const name = `demand_${axis}`;
    if (questions[name] && !answers[name]) answers[name] = { score: (profile.axis_demand || {})[axis] ?? 0 };
  }
  for (const flag of ["needs_visual", "needs_gui", "local_only", "wants_fast", "read_only_review", "multi_task"]) {
    if (questions[flag] && !answers[flag]) {
      answers[flag] = { noul: profile[flag] ? 0.95 : 0.05 };
    }
  }
  if (questions.access && !answers.access) answers.access = { choice: profile.access, confidence: 0.9 };
  if (questions.task_count && !answers.task_count) answers.task_count = { choice: profile.task_count, confidence: 0.9 };

  return {
    model,
    answers,
    agentcompass: withDetails
      ? {
          ok: Boolean(decision.ok && decision.targetModel),
          targetModel: decision.targetModel,
          targetEffort: effectiveEffort,
          selectedAccount: decision.selectedAccount || null,
          quota: decision.quota || null,
          workKind: decision.workKind,
          difficulty: decision.difficulty,
          axisDemand: decision.axisDemand,
          warnings: decision.warnings,
          ...(decision.accounts ? { accounts: decision.accounts } : {}),
          continuation: {
            held: false,
            why: chatCont?.why || (prevKind ? "reclassified" : "first"),
            previousKind: prevKind || null,
            previousEffort: prevReasoning || null,
            ...(chatCont?.previousModel ? { previousModel: chatCont.previousModel } : {}),
          },
          profile,
          scorer: meta,
        }
      : { targetModel: decision.targetModel, targetEffort: effectiveEffort },
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
            name: "AgentCompass System-One Profiler (4 categories + quota economy)",
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
  ROUTES,
  SessionContinuityStore,
  analyzeTurnState,
  clearQuotasCache,
  coldAfterMs,
  computeSessionKey,
  defaultContinuityStore,
  evaluateProviderContinuation,
  firstWords,
  formatQuotaAccountList,
  getQuotasLoadStatus,
  isModelQuotaExhausted,
  keepsEffort,
  listQuotaAccounts,
  loadLiveQuotas,
  normalizeQuotaSnapshot,
  orderSeatsByQuotaEconomics,
  quotaAccountWarnings,
  rankCandidates,
  ratchetEffort,
  resolveMagpieQuotasFile,
  selectBestRoute,
  sha256Hex,
  stripAgentNoise,
  userSaidFromText,
};
