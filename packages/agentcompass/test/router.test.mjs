import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { burnScale, effortValue, namedRoute, rankCandidates, selectBestRoute } from "../src/allocator.js";
import { CANONICAL_ROUTES, DEFAULT_SCORING_POLICY, EFFORT_CURVES, canonicalModel } from "../src/catalog.js";
import {
  CACHE_COLD_MS,
  CHATGPT_CODEX_COLD_MS,
  SessionContinuityStore,
  WORKER_WORN_TOKENS,
  analyzeTurnState,
  coldAfterMs,
  computeSessionKey,
  evaluateProviderContinuation,
  firstWords,
  isShortFollowupMessage,
  keepsEffort,
  sha256Hex,
  userSaidFromText,
} from "../src/continuity.js";
import {
  ROUTE_CARRIER_KEY,
  onRequest as hookOnRequest,
  onResponse as hookOnResponse,
} from "../src/hooks.js";
import {
  AGENTCOMPASS_ICON_DATA_URI,
  AgentCompassRouterPlugin,
  DECISION_MODEL_ID,
  PROVIDER_ID,
  clearQuotasCache,
  evaluateLevelsProbe,
  evaluateModelQuota,
  handleSystemOneRequest,
  loadLiveQuotas,
  normalizeQuotaSnapshot,
  orderSeatsByQuotaEconomics,
} from "../src/index.js";
import {
  onAccount as mwOnAccount,
  onProvider as mwOnProvider,
  onRequest as mwOnRequest,
  onResponse as mwOnResponse,
  strategies,
} from "../src/middleware.js";
import { capProfileText, extractRequestFacts, inferKindFromObjective, inferTaskProfile, profileTask } from "../src/profiler-core.js";
import { SCORER_SYSTEM_PROMPT, clearProfileCache, parseJevScorerAnswer, scoreTaskLive } from "../src/scorer-live.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("1.1 Routine bounded bulk work selects lightweight model (gemini-3.8-flash-high) and penalizes expensive overqualification", () => {
    const profile = inferTaskProfile({
      objective: "Perform a mechanical batch rename of `foo_bar` to `fooBar` across the JSON fixtures using a uniform rule.",
    });
    assert.equal(profile.work_kind, "bounded_bulk_work");
    assert.equal(profile.reasoning_depth, 1);

    const decision = selectBestRoute(profile);
    assert.equal(decision.ok, true);
    assert.equal(decision.difficulty, "routine");
    assert.equal(decision.canonicalModel, "gemini-3.8-flash-high");
    assert.equal(decision.targetEffort, "high");

    // Verify that expensive frontier models like gpt-6-astra or claude-fable-5-1 received overqualification penalty
    const ranked = rankCandidates(profile);
    const astraHigh = ranked.ranking.find((c) => c.canonicalModel === "gpt-6-astra" && c.effort === "high");
    assert.ok(astraHigh, "gpt-6-astra:high should be in eligible ranking");
    assert.ok(astraHigh.components.overqualification > 0, "gpt-6-astra:high should pay overqualification penalty on routine work");
  });

test("1.2 Convergent single-module production coding selects gpt-6.1-sol via module_precision DNA", () => {
    const profile = inferTaskProfile({
      objective: "Implement a standalone self-contained LRU cache algorithm module in TypeScript with unit tests.",
    });
    assert.equal(profile.work_kind, "self_contained_code");
    const decision = selectBestRoute(profile);
    assert.equal(decision.canonicalModel, "gpt-6.1-sol");
    assert.equal(decision.targetEffort, "high");
  });

test("1.3 Coupled cross-module deadlock & invariant audit selects claude-opus-5-5 via global_rigor + anti_hallucination", () => {
    const profile = inferTaskProfile({
      objective:
        "Conduct a read-only security audit and cross-module deadlock / race condition root-cause review across the gateway subsystem.",
    });
    assert.equal(profile.work_kind, "debug_review");
    assert.equal(profile.code_complexity, 0, "read-only review must force code_complexity=0");
    assert.equal(profile.reasoning_depth, 3);

    const decision = selectBestRoute(profile);
    assert.equal(decision.difficulty, "coupled");
    assert.equal(decision.canonicalModel, "claude-opus-5-5");
    assert.ok(["high", "xhigh", "max"].includes(decision.targetEffort));
  });

test("1.4 Open-ended divergent architecture ideation selects gemini-4-argon-high via divergence DNA (0.96)", () => {
    const profile = inferTaskProfile({
      objective:
        "Brainstorm and formulate a novel creative gameplay scheme and first-principles roadmap for an AI agent simulation game.",
      work_kind: "direction_reasoning",
    });
    assert.equal(profile.divergence, 3);
    assert.equal(profile.reasoning_depth, 3);

    const decision = selectBestRoute(profile);
    assert.equal(decision.workKind, "direction_reasoning");
    assert.equal(decision.canonicalModel, "gemini-4-argon-high");
  });

test("1.5 Frontier mathematical proof (reasoning_depth=4, floor=4.2) selects claude-opus-5-5", () => {
    const profile = inferTaskProfile({
      objective: "Provide a formal mathematical proof or refute the optimal-stopping theorem bound for this Markov chain.",
    });
    assert.equal(profile.reasoning_depth, 4);
    const decision = selectBestRoute(profile);
    assert.equal(decision.difficulty, "frontier");
    assert.equal(decision.canonicalModel, "claude-opus-5-5");
  });

test("1.6 GUI computer-use task routes to gpt-6-astra (#1 GUI grounding) and excludes text-only models", () => {
    const profile = inferTaskProfile({
      objective: "Operate the desktop app GUI: click the Settings button, take a screenshot, and toggle the proxy switch.",
    });
    assert.equal(profile.work_kind, "computer_use");
    assert.equal(profile.needs_gui, true);
    assert.equal(profile.needs_visual, true);

    const ranked = rankCandidates(profile);
    const grok = ranked.allCandidates.find((c) => c.canonicalModel === "grok-4.7");
    assert.ok(grok.excluded.includes("task needs visual input"), "text-only grok-4.7 must be excluded on visual/GUI work");
    assert.equal(ranked.selected.canonicalModel, "gpt-6-astra");

    const visualReview = inferTaskProfile({
      objective: "Compare screenshots of the login dialog and inspect the screenshot for layout misalignment.",
    });
    assert.equal(visualReview.work_kind, "visual_analysis");
    assert.equal(visualReview.needs_visual, true);
    assert.equal(visualReview.needs_gui, false);
});

test("2. Gateway Middleware (`magpie.middleware` [`moejs` 250ms]) and optional `hooks.js` state routing rewrite model & effort without polluting `body`", async () => {
  const originalBody = {
    model: "agentcompass/auto",
    stream: true,
    messages: [
      {
        role: "user",
        content: "Review the diff and diagnose the cross-module race condition in internal/gateway/decide.go (read-only review).",
      },
    ],
    tools: [{ type: "function", function: { name: "read_file" } }],
  };

  let reportedOutcome = null;
  let reportedBytes = 0;
  const hookCtx = {
    protocol: "chat",
    agent: "claude-code",
    options: {
      gatewayTimeoutMs: 8000,
      scorerType: "heuristic",
      candidateModels: ["claude-opus-5-5", "gpt-6.1-sol", "gemini-3.8-flash-high"],
    },
    state: {},
    report(code, bytes) {
      reportedOutcome = code;
      reportedBytes = bytes;
    },
  };

  // Stage 1: Run Async Bun Hook (`src/hooks.js`)
  const bodyClone = structuredClone(originalBody);
  const afterHook = await hookOnRequest(bodyClone, hookCtx);
  assert.equal(afterHook, undefined, "hookOnRequest must not mutate or replace body by default");
  assert.equal(ROUTE_CARRIER_KEY in bodyClone, false, "hookOnRequest must never inject __agentcompass_route by default");
  assert.equal(reportedOutcome, "ready");
  assert.ok(reportedBytes > 0);
  assert.ok(hookCtx.state.route, "route decision must be stored in ctx.state.route");
  assert.equal(hookCtx.state.route.targetModel, "claude-opus-5-5");

  // Stage 2: Run Sync `moejs` Middleware (`src/middleware.js`)
  const mwCtx = {
    protocol: "chat",
    agent: "claude-code",
    options: {
      injectProtocolEffort: true,
      candidateModels: ["claude-opus-5-5", "gpt-6.1-sol", "gemini-3.8-flash-high"],
    },
    state: {},
  };
  const afterMw = mwOnRequest(bodyClone, mwCtx);
  assert.ok(afterMw, "mwOnRequest should return mutated body");
  assert.equal(ROUTE_CARRIER_KEY in afterMw, false, "carrier must never be present on body");
  assert.match(afterMw.model, /^claude-opus-5-5:(high|xhigh|max)$/);
  assert.ok(["high", "xhigh"].includes(afterMw.reasoning_effort));

  // Verify `onAccount` works with Magpie's real `{ref, provider, name, kind, model}` account shape
  const skipRes = mwOnAccount(
    {
      ref: "a1b2c3d4e5f60718",
      provider: "openai",
      name: "OpenAI Plus",
      kind: "codex",
      model: "gpt-6.1-sol",
    },
    {
      state: mwCtx.state,
      options: { accountsByWorkKind: { debug_review: ["anthropic"] } },
    },
  );
  assert.deepEqual(skipRes, { skip: true });
});

test("3.1 Live OpenAI-compatible scorer parses 10-field JSON profile and caches it when explicitly opted in", async () => {
  clearProfileCache();
    let fetchCalls = 0;
    const mockFetch = async (_url, init) => {
      fetchCalls++;
      assert.equal("User-Agent" in (init.headers || {}), false, "Must not send fake Magpie-Router/1.0 User-Agent");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  work_kind: "frontend_implementation",
                  reasoning_depth: 2,
                  code_complexity: 2,
                  context_scale: 1,
                  divergence: 2,
                  hallucination_risk: 2,
                  error_cost: 2,
                  needs_visual: true,
                  needs_gui: false,
                  local_only: true,
                  interaction_style: "engineering",
                  expected_hours: 1.0,
                  hours_confidence: "high",
                  urgency: "unknown",
                  multi_task: false,
                  task_count: "1",
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const task = { objective: "Build the interactive React analytics dashboard component from the Figma spec." };
    const first = await scoreTaskLive(task, {
      allowExternalScorer: true,
      scorerType: "openai_compatible",
      scorerBaseUrl: "http://127.0.0.1:4096",
      scorerModel: "gemini-3.8-flash-high",
      fetch: mockFetch,
    });
    assert.equal(first.meta.source, "system_one_live");
    assert.equal(first.profile.work_kind, "frontend_implementation");
    assert.equal(fetchCalls, 1);

    // Second call with identical task hits LRU cache in 0ms without calling fetch
    const second = await scoreTaskLive(task, {
      allowExternalScorer: true,
      scorerType: "openai_compatible",
      scorerBaseUrl: "http://127.0.0.1:4096",
      scorerModel: "gemini-3.8-flash-high",
      fetch: mockFetch,
    });
    assert.equal(second.meta.cached, true);
    assert.equal(fetchCalls, 1);
  });

test("3.2 Timeout or HTTP failure gracefully falls back to deterministic twin without failing closed", async () => {
    clearProfileCache();
    const failingFetch = async () => {
      throw new Error("Simulated timeout");
    };
    const res = await scoreTaskLive(
      { objective: "Fix the memory leak in the WebSocket connection pool." },
      {
        allowExternalScorer: true,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:4096",
        fetch: failingFetch,
      },
    );
    assert.equal(res.meta.source, "heuristic_fallback");
    assert.equal(res.profile.work_kind, "debug_review");
});

test("4. Native Magpie `/v1/systemone` Decision Handler (`handleSystemOneRequest`)", async () => {
  // 4a. Test `jevLevelled` probe (`decide.go:310`)
  const levelProbe = await handleSystemOneRequest({
    model: DECISION_MODEL_ID,
    state: { kinds: ["简单日常", "常规开发", "复杂跨模块架构"] },
    questions: {
      levels: { type: "noul" },
      work0: { type: "score" },
      work1: { type: "score" },
      work2: { type: "score" },
    },
  });
  assert.ok(levelProbe.answers.levels.noul >= 0.5, "difficulty scale intents must be recognized as levels");
  assert.ok(levelProbe.answers.work0.score < levelProbe.answers.work2.score);

  // 4b. Test `jevBody` turn classification (`decide.go:167`)
  const turnDecision = await handleSystemOneRequest({
    model: DECISION_MODEL_ID,
    state: {
      turn: "Please conduct a read-only security audit and race condition review across the authentication middleware.",
    },
    questions: {
      intent: {
        type: "choice",
        criteria: {
          frontend_implementation: "Frontend UI work",
          debug_review: "Bug diagnosis and code review",
          bounded_bulk_work: "Simple batch edits",
          none: "None of the above",
        },
      },
      effort: {
        type: "score",
        criteria: ["low", "medium", "high", "xhigh"],
      },
    },
  });
  assert.equal(turnDecision.answers.intent.choice, "debug_review");
  assert.ok(turnDecision.answers.intent.confidence >= 0.6, "confidence must clear Magpie's jevSure (0.6)");
  assert.ok(turnDecision.answers.effort.score >= 2.0, "coupled review must select high/xhigh effort (>= 2.0)");

  // 4c. Default plugin export does NOT inject a fake auth/provider entry unless explicitly opted in
  assert.equal(PROVIDER_ID, "agentcompass");
  const defaultPlugin = await AgentCompassRouterPlugin({}, {});
  const emptyCfg = {};
  await defaultPlugin.config(emptyCfg);
  assert.equal(emptyCfg.provider, undefined, "Default gateway plugin must not register a fake provider");
  assert.equal(defaultPlugin.auth, undefined, "Default gateway plugin must not register a fake auth hook");

  // Opt-in decision provider mode
  const optInPlugin = await AgentCompassRouterPlugin({}, { enableDecisionProvider: true });
  const cfg = {};
  await optInPlugin.config(cfg);
  assert.equal(cfg.provider[PROVIDER_ID].name, "AgentCompass");
  assert.equal(cfg.provider[PROVIDER_ID].decide, true);
  assert.equal(cfg.provider[PROVIDER_ID].models[DECISION_MODEL_ID].decides, true);

  const { fetch: decisionFetch, baseURL } = await optInPlugin.auth.loader(async () => ({}), {});
  const httpRes = await decisionFetch(`${baseURL}/systemone`, {
    method: "POST",
    body: JSON.stringify({
      model: DECISION_MODEL_ID,
      state: { turn: "Batch rename all `old_id` fields to `new_id` across fixtures." },
      questions: {
        intent: {
          type: "choice",
          criteria: {
            bounded_bulk_work: "Bulk edits",
            debug_review: "Debugging",
            none: "None",
          },
        },
        effort: { type: "score", criteria: ["low", "medium", "high", "xhigh"] },
      },
    }),
  });
  assert.equal(httpRes.status, 200);
  const json = await httpRes.json();
  assert.equal(json.answers.intent.choice, "bounded_bulk_work");
});

/**
 * What Magpie's plugin host (0.1.2804 through 0.1.2891, `internal/plugin/host.js`) needs before a
 * decision provider exists, emulated: the server function is called with plugins.json's options
 * (`fn(input, p.options)`); a provider is listed, signed in and served only when a hook's
 * `auth.provider` names it (`auths()` / `providers()`); `decide` and the model's `decides` come from
 * the config entry (`info()`); `magpie plugin login` takes a keyless `api` method's `authorize()`;
 * System One is posted to the loader's `baseURL` + `/systemone` through the loader's `fetch` (`load()`).
 * A `config` entry with no auth hook passed the old test and was never listed (issue #1).
 */
async function magpieHostView(serverFn, options) {
  const hooks = (await serverFn({}, options)) ?? {};
  const config = {};
  if (typeof hooks.config === "function") await hooks.config(config);
  const auth = hooks.auth?.provider ? hooks.auth : null;
  if (!auth) return { providers: [] };
  const cfg = config.provider?.[auth.provider] ?? {};
  const keyless = (auth.methods ?? []).filter(
    (m) => m.type === "api" && m.keyless === true && typeof m.authorize === "function"
  );
  const signedIn = keyless.length ? await keyless[0].authorize() : null;
  const loaded = signedIn?.type === "success" && auth.loader ? await auth.loader(async () => signedIn, cfg) : {};
  return {
    providers: [
      {
        id: auth.provider,
        name: cfg.name ?? auth.provider,
        decide: cfg.decide === true,
        decisionModels: Object.entries(cfg.models ?? {}).filter(([, m]) => m.decides === true).map(([id]) => id),
        keyless: keyless.length > 0,
        signedIn: signedIn?.type === "success",
        baseURL: typeof loaded.baseURL === "string" ? loaded.baseURL : "",
        fetch: typeof loaded.fetch === "function" ? loaded.fetch : null,
      },
    ],
  };
}

test("4d. Decision provider registers the way Magpie's host lists, signs in and serves it (issue #1)", async () => {
  const pluginEntry = (await import("../src/index.js")).default;
  assert.equal(pluginEntry.id, "agentcompass");

  for (const options of [{}, { enableDecisionProvider: false }, { enableDecisionProvider: "true" }]) {
    assert.deepEqual((await magpieHostView(pluginEntry.server, options)).providers, [], JSON.stringify(options));
  }

  const { providers } = await magpieHostView(pluginEntry.server, {
    enableDecisionProvider: true,
    injectProtocolEffort: true,
    routeAllModels: true,
  });
  assert.equal(providers.length, 1, "magpie plugin list must show the agentcompass provider");
  const [p] = providers;
  assert.equal(p.id, PROVIDER_ID);
  assert.equal(p.name, "AgentCompass");
  assert.equal(p.decide, true);
  assert.deepEqual(p.decisionModels, [DECISION_MODEL_ID], "agentcompass/agentcompass-systemone is a Classifier option");
  assert.ok(p.keyless && p.signedIn, "magpie plugin login agentcompass signs in without a key");
  assert.match(p.baseURL, /^https?:\/\//);
  assert.equal(typeof p.fetch, "function");

  const answered = await p.fetch(`${p.baseURL}/systemone`, {
    method: "POST",
    body: JSON.stringify({
      model: DECISION_MODEL_ID,
      state: { task: "Find the root cause of a deadlock across three services" },
      questions: { work_kind: { type: "choice" }, reasoning_depth: { type: "score" } },
    }),
  });
  assert.equal(answered.status, 200);
  const body = await answered.json();
  assert.equal(body.model, DECISION_MODEL_ID);
  assert.equal(typeof body.answers.work_kind.choice, "string");
  assert.equal(typeof body.answers.reasoning_depth.score, "number");

  // Only System One is served: a chat request sent to the provider is refused, never answered as a model.
  const chat = await p.fetch(`${p.baseURL}/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(chat.status, 404);
  const viaRequest = await p.fetch(new Request(`${p.baseURL}/systemone`, { method: "POST", body: "{}" }));
  assert.equal(viaRequest.status, 200);
});

test("5. Pool strategy `agentcompass` / `agentcompass-pure` orders non-resting lowest-used seat indexes first", () => {
  const seats = [
    { key: "seat-resting", used: 10, resting: true },
    { key: "seat-busy", used: 80, resting: false },
    { key: "seat-fresh", used: 20, resting: false },
  ];
  const order1 = strategies.agentcompass("anthropic", seats, {});
  const order2 = strategies["agentcompass-pure"]("anthropic", seats, {});
  assert.deepEqual(order1, [2, 1, 0]);
  assert.deepEqual(order2, [2, 1, 0]);
  assert.deepEqual(order1.map((i) => seats[i].key), ["seat-fresh", "seat-busy", "seat-resting"]);
});

test("6. Magpie Plugin Market & Registry Contract (`package.json`, `icon`, `options`, `registry.json`)", async () => {
  assert.equal(profileTask, inferTaskProfile);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(["agentcompass", "@magpie-community/gateway-agentcompass"].includes(pkg.name));
  assert.equal(pkg.magpie.name, "AgentCompass");
  assert.equal(pkg.magpie.hooks, undefined, "magpie.hooks must not be declared alongside magpie.middleware");
  assert.equal(pkg.magpie.middleware, "./src/middleware.js");
  assert.ok(pkg.magpie.icon.startsWith("data:image/svg+xml;base64,"));
  assert.equal(pkg.magpie.icon, AGENTCOMPASS_ICON_DATA_URI);

  const decodedSvg = Buffer.from(pkg.magpie.icon.split(",")[1], "base64").toString("utf8");
  assert.ok(decodedSvg.includes("<svg"), "Decoded icon must be valid SVG for Magpie StoreIcon()");

  for (const kw of ["magpie", "magpie-middleware", "magpie-routing", "routing", "load-balancing", "llm-gateway", "agentcompass"]) {
    assert.ok(pkg.keywords.includes(kw), `package.json keywords must include "${kw}"`);
  }
  assert.equal(pkg.keywords.includes("provider"), false, "Middleware plugin must not claim 'provider' keyword");
  assert.equal(pkg.keywords.includes("auth"), false, "Middleware plugin must not claim 'auth' keyword");
  assert.equal(
    pkg.keywords.includes("pi-package"),
    false,
    "Plugins must not include 'pi-package' in keywords"
  );

  const standaloneListingPath = path.join(REPO_ROOT, "docs", "magpie-community-registry-entry.json");
  const monorepoRegistryPath = path.resolve(REPO_ROOT, "..", "..", "registry.json");
  if (fs.existsSync(standaloneListingPath)) {
    const listing = JSON.parse(fs.readFileSync(standaloneListingPath, "utf8"));
    assert.ok(["agentcompass", "@magpie-community/gateway-agentcompass"].includes(listing.package));
    assert.equal(listing.name, "AgentCompass");
    assert.equal(listing.kind, "middleware");
    assert.equal("providers" in listing, false);
    assert.ok(listing.summary?.en && listing.summary?.zh);
  }
  if (fs.existsSync(monorepoRegistryPath)) {
    const reg = JSON.parse(fs.readFileSync(monorepoRegistryPath, "utf8"));
    const entry = reg.plugins.find((p) => p.package === pkg.name);
    assert.ok(entry, `registry.json must include an entry for ${pkg.name}`);
    assert.equal(entry.name, "AgentCompass");
    assert.equal(entry.kind, "middleware");
    assert.equal(entry.community, true);
    assert.ok(entry.summary?.en && entry.summary?.zh);
  }
});

test("7.1 Scenario 1 (`why: first` & subagent isolation): New session runs intent routing and isolates `x-claude-code-agent-id` subagents", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;
    let scorerCalls = 0;

    // Verify pure-JS SHA-256 against NIST test vector ("abc")
    assert.equal(
      sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );

    const req1 = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content:
            "Audit our distributed Raft consensus state machine across 4 modules to find the split-brain deadlock root cause.",
        },
      ],
    };

    const ctx1 = {
      protocol: "chat",
      headers: { "x-session-id": "sess-main-1" },
      state: {},
      options: {
        continuityStore: store,
        now: t0,
        allowExternalScorer: true,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        useCache: false,
        fetch: async () => {
          scorerCalls += 1;
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      work_kind: "debug_review",
                      reasoning_depth: 3,
                      code_complexity: 3,
                      context_scale: 3,
                      divergence: 1,
                      hallucination_risk: 3,
                      error_cost: 3,
                      needs_visual: false,
                      needs_gui: false,
                      local_only: true,
                      interaction_style: "engineering",
                      expected_hours: 2.0,
                      hours_confidence: "high",
                      urgency: "normal",
                      multi_task: false,
                      task_count: "1",
                    }),
                  },
                },
              ],
            }),
            { status: 200 }
          );
        },
      },
    };
    await hookOnRequest(req1, ctx1);

    assert.equal(scorerCalls, 1, "First turn of a new session must invoke intent scorer once");
    const carrier1 = ctx1.state.route;
    assert.equal(carrier1.continuation.held, false);
    assert.equal(carrier1.continuation.why, "first");
    assert.equal(carrier1.canonicalModel, "claude-opus-5-5");

    // Simulate subagent sharing the same `x-session-id` but with `x-claude-code-agent-id`
    const subagentReq = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content: "Batch rename `old_var` to `new_var` across JSON fixtures.",
        },
      ],
    };
    const mainKey = computeSessionKey(req1, { headers: { "x-session-id": "sess-main-1" } });
    const subKey = computeSessionKey(subagentReq, {
      headers: {
        "x-session-id": "sess-main-1",
        "x-claude-code-agent-id": "subagent-haiku-worker",
      },
    });
    assert.notEqual(mainKey, subKey, "Subagent must have an isolated session key");

    await hookOnRequest(subagentReq, {
      protocol: "chat",
      headers: {
        "x-session-id": "sess-main-1",
        "x-claude-code-agent-id": "subagent-haiku-worker",
      },
      options: { continuityStore: store, now: t0 + 1000, prefer_local_heuristic: true },
    });

    // Main session must still hold `claude-opus-5-5`, unaffected by subagent
    assert.equal(store.get(mainKey, t0 + 1000).model, "claude-opus-5-5");
  });

test("7.2 Scenario 2 (`why: turn` mid-turn lock): Tool results & agent-injected `<system-reminder>` lock Provider/Model with 0 scorer calls", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;
    let scorerCalls = 0;
    const countingFetch = async () => {
      scorerCalls += 1;
      throw new Error("Scorer should NOT be called during mid-turn hold!");
    };

    // Turn 1: User starts a complex task on `claude-opus-5-5:high`
    const firstTurn = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content:
            "Refactor the distributed transaction coordinator across 4 microservices to fix the two-phase commit deadlock.",
        },
      ],
    };
    const ctx1 = {
      protocol: "chat",
      headers: { "x-session-id": "sess-turn-lock" },
      state: {},
      options: {
        continuityStore: store,
        now: t0,
        prefer_local_heuristic: true,
        allowUnconstrainedCatalog: true,
      },
    };
    await hookOnRequest(firstTurn, ctx1);
    const routed1 = mwOnRequest(structuredClone(firstTurn), {
      protocol: "chat",
      headers: { "x-session-id": "sess-turn-lock" },
      state: ctx1.state,
      options: { continuityStore: store, now: t0, allowUnconstrainedCatalog: true },
    });
    assert.equal(routed1.model, "claude-opus-5-5:xhigh");

    // Step 2a: Assistant calls a tool, and the next request ends with `role: "tool"`
    const toolResultReq = {
      model: "agentcompass/auto",
      messages: [
        ...firstTurn.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "package coordinator // simple 10-line file",
        },
      ],
    };

    const ctx2a = {
      protocol: "chat",
      headers: { "x-session-id": "sess-turn-lock" },
      state: {},
      options: {
        continuityStore: store,
        now: t0 + 10 * 60 * 1000, // Even after 10 minutes (> 5m cache TTL), mid-turn `within: true` MUST still hold!
        allowExternalScorer: true,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        fetch: countingFetch,
      },
    };
    await hookOnRequest(toolResultReq, ctx2a);
    assert.equal(scorerCalls, 0, "Mid-turn tool result must make 0 scorer calls");
    assert.equal(ctx2a.state.route.continuation.held, true);
    assert.equal(ctx2a.state.route.continuation.why, "turn");
    assert.equal(ctx2a.state.route.continuation.within, true);
    assert.equal(ctx2a.state.route.modelWithEffort, "claude-opus-5-5:xhigh");

    // Step 2b: Agent injects a `role: "user"` message containing only `<system-reminder>` and `TodoWrite` noise
    const agentNoiseReq = {
      model: "agentcompass/auto",
      messages: [
        ...toolResultReq.messages,
        {
          role: "user",
          content:
            "<system-reminder>Remember to run tests before finishing.</system-reminder>\n\nThe TodoWrite tool hasn't been used recently.",
        },
      ],
    };
    assert.equal(userSaidFromText(agentNoiseReq.messages[3].content), "");
    const turnState2b = analyzeTurnState(agentNoiseReq);
    assert.equal(turnState2b.within, true, "Agent-injected reminder must keep within === true");
    assert.equal(turnState2b.turn, 1, "Agent-injected reminder must not increment user turn count");

    const ctx2b = {
      protocol: "chat",
      headers: { "x-session-id": "sess-turn-lock" },
      state: {},
      options: {
        continuityStore: store,
        now: t0 + 12 * 60 * 1000,
        allowExternalScorer: true,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        fetch: countingFetch,
      },
    };
    await hookOnRequest(agentNoiseReq, ctx2b);
    assert.equal(scorerCalls, 0);
    assert.equal(ctx2b.state.route.continuation.held, true);
    assert.equal(ctx2b.state.route.continuation.why, "turn");
  });

test("7.3 Scenario 3 (`why: cache` & `why: followup` + `keepsEffort`): Warm KV cache and short follow-up nudges hold model and ratchet effort", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;
    let scorerCalls = 0;

    // Turn 1: Complex task routes to `claude-opus-5-5:high`
    const turn1 = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content:
            "Audit the cross-module state synchronization protocol across gateway, worker, and store for race conditions.",
        },
      ],
    };
    const ctx1 = {
      protocol: "anthropic",
      headers: { "x-session-id": "sess-warm-cache" },
      state: {},
      options: { continuityStore: store, now: t0, prefer_local_heuristic: true },
    };
    await hookOnRequest(turn1, ctx1);
    assert.equal(ctx1.state.route.modelWithEffort, "claude-opus-5-5:xhigh");

    // Simulate response returning 4,200 tokens (>= 1024 CACHE_WORTH_TOKENS) and cache creation
    await hookOnResponse(
      {
        id: "msg_1",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 1800,
          cache_creation_input_tokens: 2100,
          output_tokens: 300,
        },
      },
      ctx1
    );

    // Turn 2 (2 minutes later, within 5m Anthropic cache TTL): User asks a trivial routine question
    // Because the 4,200-token KV cache is warm, it MUST hold `claude-opus-5-5:xhigh` (`why: "cache"`) without calling scorer!
    const turn2 = {
      model: "agentcompass/auto",
      messages: [
        ...turn1.messages,
        { role: "assistant", content: "Here is the protocol audit and synchronization state machine." },
        { role: "user", content: "Also rename the variable `sync_flag` to `isSynced` in that file." },
      ],
    };
    const ctx2 = {
      protocol: "anthropic",
      headers: { "x-session-id": "sess-warm-cache" },
      state: {},
      options: {
        continuityStore: store,
        now: t0 + 2 * 60 * 1000,
        allowExternalScorer: true,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        fetch: async () => {
          scorerCalls += 1;
          throw new Error("Should not call scorer while KV cache is warm!");
        },
      },
    };
    await hookOnRequest(turn2, ctx2);
    assert.equal(scorerCalls, 0);
    assert.equal(ctx2.state.route.continuation.held, true);
    assert.equal(ctx2.state.route.continuation.why, "cache");
    assert.equal(ctx2.state.route.modelWithEffort, "claude-opus-5-5:xhigh");

    // Turn 3 (short follow-up "继续" / "ok go ahead" even when token count < 1024):
    assert.equal(isShortFollowupMessage("继续"), true);
    assert.equal(isShortFollowupMessage("好的，按这个改"), true);
    assert.equal(isShortFollowupMessage("ok, go ahead"), true);
    assert.equal(isShortFollowupMessage("lgtm"), true);

    // Verify `/v1/systemone` (`handleSystemOneRequest`) short follow-up inherits `previous_message_kind` & ratchets effort with 0 scorer calls
    const sysOneFollowup = await handleSystemOneRequest(
      {
        model: DECISION_MODEL_ID,
        state: {
          message: "继续",
          previous_message_kind: "debug_review",
          previous_message_reasoning: "high",
          previous_user_message: "Audit the distributed lock manager.",
          previous_assistant_reply: "I found two lock ordering inversions. Shall I continue?",
        },
        questions: {
          intent: {
            type: "choice",
            criteria: {
              debug_review: "Debugging and review",
              bounded_bulk_work: "Routine bulk edits",
              none: "None",
            },
          },
          effort: {
            type: "score",
            criteria: ["low", "medium", "high", "xhigh"],
          },
        },
      },
      {
        allowExternalScorer: true,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        fetch: async () => {
          scorerCalls += 1;
          throw new Error("Short follow-up in /v1/systemone must not call external scorer!");
        },
      }
    );
    assert.equal(scorerCalls, 0);
    assert.equal(sysOneFollowup.answers.intent.choice, "debug_review");
    assert.ok(sysOneFollowup.answers.intent.confidence >= 0.9);
    assert.equal(sysOneFollowup.answers.effort.score, 2.0, "Effort must stay ratcheted at high (2.0)");
    assert.equal(sysOneFollowup.agentcompass.continuation.held, true);
    assert.equal(sysOneFollowup.agentcompass.continuation.why, "followup");

    // Verify `keepsEffort` directly: warm session on `xhigh` never drops to `low`
    const sessionSnap = store.get(ctx2.state.route.continuation.sessionKey, t0 + 2 * 60 * 1000);
    assert.equal(keepsEffort(sessionSnap, "low", 4200, t0 + 2 * 60 * 1000), "xhigh");
    // Verify ChatGPT/Codex & DeepSeek 1h cache TTL vs default 5m TTL
    assert.equal(coldAfterMs("claude-opus-5-5"), CACHE_COLD_MS);
    assert.equal(coldAfterMs("gpt-6.1-sol"), CHATGPT_CODEX_COLD_MS);
    assert.equal(coldAfterMs("deepseek-v4.1-flash-free"), CHATGPT_CODEX_COLD_MS);
  });

test("7.4 Scenario 4 (`why: capability_outgrown` / `outgrown` / `worn`): Modality, tier escalation, 95% context window, and 2M wear trigger re-routing", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;

    // 4a. Visual modality outgrowth: session starts on text-only `grok-4.7`, next turn sends an image
    const sessKeyVis = "sess-vis-outgrow";
    store.set(
      sessKeyVis,
      {
        model: "grok-4.7",
        effort: "medium",
        tokens: 4000,
        cached: true,
        healthy: true,
        turn: 1,
      },
      t0
    );
    const visReq = {
      model: "agentcompass/auto",
      session_id: sessKeyVis,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this UI screenshot and diagnose the overlapping flex layout bug." },
            { type: "image_url", image_url: { url: "https://example.com/bug.png" } },
          ],
        },
      ],
    };
    const ctxVis = {
      protocol: "chat",
      session_id: sessKeyVis,
      state: {},
      options: { continuityStore: store, now: t0 + 30_000, prefer_local_heuristic: true },
    };
    await hookOnRequest(visReq, ctxVis);
    assert.equal(ctxVis.state.route.continuation.held, false);
    assert.equal(ctxVis.state.route.continuation.why, "capability_outgrown");
    assert.equal(ctxVis.state.route.continuation.reasonDetail, "visual_modality_required");
    assert.notEqual(ctxVis.state.route.canonicalModel, "grok-4.7");

    // 4b. Tier escalation outgrowth: session starts on lightweight `claude-haiku-5-5` (tier 3.2),
    // next turn asks for a complex cross-module architecture & deadlock refactoring
    const sessKeyTier = "sess-tier-outgrow";
    store.set(
      sessKeyTier,
      {
        model: "claude-haiku-5-5",
        effort: "low",
        tokens: 3000,
        cached: true,
        healthy: true,
        turn: 1,
      },
      t0
    );
    const tierReq = {
      model: "agentcompass/auto",
      messages: [
        { role: "user", content: "Rename `foo` to `bar`." },
        { role: "assistant", content: "Done." },
        {
          role: "user",
          content:
            "Now perform a cross-module architecture refactoring and root cause deadlock audit across our consensus engine.",
        },
      ],
    };
    const tierKey = computeSessionKey(tierReq, { headers: { "x-session-id": sessKeyTier } });
    store.set(tierKey, store.get(sessKeyTier, t0), t0);
    const ctxTier = {
      protocol: "chat",
      headers: { "x-session-id": sessKeyTier },
      state: {},
      options: { continuityStore: store, now: t0 + 20_000, prefer_local_heuristic: true },
    };
    await hookOnRequest(tierReq, ctxTier);
    assert.equal(ctxTier.state.route.continuation.held, false);
    assert.equal(ctxTier.state.route.continuation.why, "capability_outgrown");
    assert.equal(ctxTier.state.route.canonicalModel, "claude-opus-5-5");

    // 4c. Context window 95% outgrowth (`claude-opus-5-5` has 200k limit; 95% = 190k; pass 195k tokens)
    const outgrownReq = {
      model: "agentcompass/auto",
      estimated_input_tokens: 195_000,
      messages: [
        {
          role: "user",
          content: "Analyze the entire multi-module repository dump and architecture trade-offs.",
        },
      ],
    };
    const outgrownKey = computeSessionKey(outgrownReq, { headers: { "x-session-id": "sess-ctx-outgrow" } });
    store.set(
      outgrownKey,
      {
        model: "claude-opus-5-5",
        effort: "high",
        tokens: 195_000,
        cached: true,
        healthy: true,
        turn: 2,
      },
      t0
    );
    const ctxOutgrown = {
      protocol: "chat",
      headers: { "x-session-id": "sess-ctx-outgrow" },
      state: {},
      options: { continuityStore: store, now: t0 + 10_000, prefer_local_heuristic: true },
    };
    await hookOnRequest(outgrownReq, ctxOutgrown);
    assert.equal(ctxOutgrown.state.route.continuation.held, false);
    assert.equal(ctxOutgrown.state.route.continuation.why, "outgrown");
    // Must switch to a model whose 95% context window >= 195k (e.g. `gemini-4-argon-high` 1M or `gpt-6-astra` 400k)
    assert.ok(
      ["gemini-4-argon-high", "gpt-6-astra", "gpt-6.1-terra", "gpt-6.1-sol"].includes(
        ctxOutgrown.state.route.canonicalModel
      ),
      `Expected >205k context model, got ${ctxOutgrown.state.route.canonicalModel}`
    );

    // 4d. 2M cumulative token wear (`compactedTokens + tokens >= 2,000,000`)
    const wornCheck = evaluateProviderContinuation(
      { within: false, turn: 15, estimatedInputTokens: 150_000 },
      {
        model: "claude-opus-5-5",
        effort: "high",
        tokens: 150_000,
        compactedTokens: WORKER_WORN_TOKENS - 100_000,
        cached: true,
        healthy: true,
        updatedAt: t0,
      },
      { now: t0 + 5_000 }
    );
    assert.equal(wornCheck.shouldHold, false);
    assert.equal(wornCheck.why, "worn");
  });

test("7.5 Scenario 5 (`why: cold` & `why: compacted`): Expired KV cache or `/compact` re-evaluates and cleanly downshifts on routine work", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;

    const routineFollowupReq = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content: "Audit the distributed consensus engine across modules.",
        },
        {
          role: "assistant",
          content: "Audit complete.",
        },
        {
          role: "user",
          content: "Perform a mechanical batch rename of `old_key` to `newKey` across the JSON fixtures.",
        },
      ],
    };
    const sessKey = computeSessionKey(routineFollowupReq, { headers: { "x-session-id": "sess-cold-downshift" } });
    store.set(
      sessKey,
      {
        model: "claude-opus-5-5",
        effort: "high",
        tokens: 8000,
        cached: true,
        healthy: true,
        turn: 1,
      },
      t0
    );

    // 5a. Advance clock by 6 minutes (> 5m Anthropic cacheCold): cache is now COLD
    const ctxCold = {
      protocol: "anthropic",
      headers: { "x-session-id": "sess-cold-downshift" },
      state: {},
      options: {
        continuityStore: store,
        now: t0 + 6 * 60 * 1000,
        prefer_local_heuristic: true,
      },
    };
    await hookOnRequest(routineFollowupReq, ctxCold);
    assert.equal(ctxCold.state.route.continuation.held, false);
    assert.equal(ctxCold.state.route.continuation.why, "cold");
    // Must downshift from `claude-opus-5-5` to lightweight `gemini-3.8-flash-high`!
    assert.equal(ctxCold.state.route.canonicalModel, "gemini-3.8-flash-high");

    // 5b. Reset to warm `claude-opus-5-5` with 20,000 tokens, then send a compacted context (2,000 tokens < 50% of 20,000)
    store.set(
      sessKey,
      {
        model: "claude-opus-5-5",
        effort: "high",
        tokens: 20_000,
        cached: true,
        healthy: true,
        turn: 2,
      },
      t0 + 10 * 60 * 1000
    );
    const compactedReq = {
      ...routineFollowupReq,
      estimated_input_tokens: 2_000,
    };
    const ctxCompacted = {
      protocol: "anthropic",
      headers: { "x-session-id": "sess-cold-downshift" },
      state: {},
      options: {
        continuityStore: store,
        now: t0 + 11 * 60 * 1000, // Only 1 minute later, but tokens dropped from 20k -> 2k!
        prefer_local_heuristic: true,
      },
    };
    await hookOnRequest(compactedReq, ctxCompacted);
    assert.equal(ctxCompacted.state.route.continuation.held, false);
    assert.equal(ctxCompacted.state.route.continuation.why, "compacted");
    assert.equal(ctxCompacted.state.route.canonicalModel, "gemini-3.8-flash-high");
    // Verify `compactedTokens` accumulated the pre-compaction 20,000 tokens
    assert.equal(store.get(sessKey, t0 + 11 * 60 * 1000).compactedTokens, 20_000);
  });

test("7.6 Scenario 6 (`why: provider_unhealthy`): Upstream 429/502 error in `onResponse` or `onUsage` marks model unhealthy and fails over", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;

    const req = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content: "Audit the cross-module concurrency lock graph and race condition invariants.",
        },
      ],
    };
    const ctx = {
      protocol: "chat",
      headers: { "x-session-id": "sess-failover" },
      state: {},
      options: { continuityStore: store, now: t0, prefer_local_heuristic: true },
    };

    await hookOnRequest(req, ctx);
    assert.equal(ctx.state.route.canonicalModel, "claude-opus-5-5");

    // Simulate upstream 429 rate-limit failure reported to `hookOnResponse` (or `mwOnUsage`)
    await hookOnResponse(
      { error: { message: "Rate limit exceeded", status: 429 } },
      { ...ctx, status: 429 }
    );
    assert.equal(store.isModelHealthy("claude-opus-5-5", t0 + 1000), false);

    // Retry the exact same request (or even a mid-turn tool loop): because `claude-opus-5-5` is unhealthy,
    // it MUST break the lock (`why: "provider_unhealthy"`) and switch to a healthy fallback model!
    const ctx2 = {
      ...ctx,
      state: {},
      options: { ...ctx.options, now: t0 + 2000 },
    };
    await hookOnRequest(req, ctx2);
    assert.equal(ctx2.state.route.continuation.held, false);
    assert.equal(ctx2.state.route.continuation.why, "provider_unhealthy");
    assert.notEqual(
      ctx2.state.route.canonicalModel,
      "claude-opus-5-5",
      "Unhealthy model must be excluded on failover"
    );

    // Also verify `mwOnResponse` marking a model unhealthy on `{ status: 503 }` in the shared pooled request VM
    const fallbackModel = ctx2.state.route.canonicalModel;
    mwOnResponse(
      {
        error: { message: "Service unavailable", status: 503 },
      },
      {
        protocol: "chat",
        status: 503,
        model: fallbackModel,
        state: {
          agentcompass: {
            sessionKey: ctx2.state.route.continuation.sessionKey,
            targetModel: fallbackModel,
            targetEffort: ctx2.state.route.targetEffort,
          },
        },
        options: { continuityStore: store, now: t0 + 3000 },
      }
    );
    assert.equal(store.isModelHealthy(fallbackModel, t0 + 3500), false);
  });

test("8.1 Exhausted subscription window (< 5% safety margin or < 10% short-window floor) excludes provider and routes to healthy subscription", () => {
    const t0 = 1_700_000_000_000;
    const implProfile = {
      work_kind: "general_implementation",
      reasoning_depth: 2,
      code_complexity: 2,
      context_scale: 1,
      divergence: 1,
      hallucination_risk: 2,
      error_cost: 2,
      needs_visual: false,
      needs_gui: false,
      local_only: true,
      interaction_style: "engineering",
      expected_hours: 0.5,
    };

    // Without quota constraints, `gpt-6.1-sol` (`gpt-5.3-codex`) wins `general_implementation`
    const baseline = selectBestRoute(implProfile, {
      candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"],
      now: t0,
    });
    assert.equal(baseline.targetModel, "gpt-5.3-codex");

    // When `codex` has only 3% remaining on its 7d window (< 5% safety_margin_pct), it is excluded
    // and `claude-sonnet-4-6` (with 80% remaining) wins automatically!
    const withExhaustedCodex = selectBestRoute(implProfile, {
      candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"],
      now: t0,
      quotas: {
        "codex/work@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              { name: "7d", used: 97, remaining: 3, resetsAt: new Date(t0 + 48 * 3600 * 1000).toISOString() },
            ],
          },
        },
        "claude/pro@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              { name: "7d", used: 20, remaining: 80, resetsAt: new Date(t0 + 72 * 3600 * 1000).toISOString() },
            ],
          },
        },
      },
    });
    assert.equal(withExhaustedCodex.targetModel, "claude-sonnet-4-6");
    assert.equal(withExhaustedCodex.selectedAccount, "claude/pro@example.com");
  });

test("8.2 High opportunity cost / scarcity on over-burned subscription shifts routing to well-funded subscription before hitting 0%", () => {
    const t0 = 1_700_000_000_000;
    const implProfile = {
      work_kind: "general_implementation",
      reasoning_depth: 2,
      code_complexity: 2,
      context_scale: 2,
      divergence: 1,
      hallucination_risk: 2,
      error_cost: 2,
      needs_visual: false,
      needs_gui: false,
      local_only: true,
      interaction_style: "engineering",
      expected_hours: 1.5,
    };

    // Codex has 14% left with 130h (5.4 days) remaining in its 168h week (burning 2.3%/h, high shortage probability & scarcity).
    // Claude has 92% left with 48h remaining in its week.
    const decision = selectBestRoute(implProfile, {
      candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"],
      now: t0,
      quotas: {
        "codex/scarce@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 86,
                remaining: 14,
                resetsAt: new Date(t0 + 130 * 3600 * 1000).toISOString(),
                pct_per_hour_24h: 2.2,
              },
            ],
          },
        },
        "claude/plentiful@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 8,
                remaining: 92,
                resetsAt: new Date(t0 + 48 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
      },
    });
    assert.equal(
      decision.targetModel,
      "claude-sonnet-4-6",
      "High opportunity cost + scarcity on Codex should shift routing to plentiful Claude subscription"
    );
    assert.ok(decision.components.reset_bonus >= 0);
  });

test("8.3 Pre-reset surplus sprint (`reset_bonus` & `sprint_sunk`): harvests expiring subscription quota and unlocks higher effort", () => {
    const t0 = 1_700_000_000_000;
    const hardProfile = {
      work_kind: "general_implementation",
      reasoning_depth: 2,
      code_complexity: 2,
      context_scale: 2,
      divergence: 1,
      hallucination_risk: 2,
      error_cost: 2,
      needs_visual: false,
      needs_gui: false,
      local_only: true,
      interaction_style: "engineering",
      expected_hours: 1.0,
    };

    // Normally on `general_implementation` (depth 2), `claude-opus-4-6` pays an overqualification penalty
    // and `gpt-5.3-codex:high` wins.
    // Now give `claude` 65% remaining quota resetting in just 3 hours (`resetHours = 3 <= 36h horizon`)!
    const sprintDecision = selectBestRoute(hardProfile, {
      candidateModels: ["gpt-5.3-codex", "claude-opus-4-6"],
      now: t0,
      quotas: {
        "codex/normal@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 45,
                remaining: 55,
                resetsAt: new Date(t0 + 100 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
        "claude/expiring-soon@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 35,
                remaining: 65,
                resetsAt: new Date(t0 + 3 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
      },
    });

    assert.equal(
      sprintDecision.targetModel,
      "claude-opus-4-6",
      "Expiring Claude subscription with 65% surplus resetting in 3h must win via reset_bonus"
    );
    assert.ok(
      sprintDecision.components.reset_bonus > 0.8,
      `Expected reset_bonus > 0.8, got ${sprintDecision.components.reset_bonus}`
    );
    assert.ok(
      ["xhigh", "max"].includes(sprintDecision.targetEffort),
      `Pre-reset surplus sprint on non-routine work should waive effort penalty and unlock xhigh/max effort (got ${sprintDecision.targetEffort})`
    );
  });

test("8.4 Sticky session failover on quota exhaustion (`why: quota_exhausted`) & explicit `magpieConfigDir` quota loading", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;

    // Create a temporary Magpie config directory with `quotas.json` and `providers.json`
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-quotas-test-"));
    const quotasFile = path.join(tmpDir, "quotas.json");
    fs.writeFileSync(path.join(tmpDir, "providers.json"), "{}", "utf8");
    fs.writeFileSync(
      quotasFile,
      JSON.stringify({
        "codex/acct1": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 98,
                remaining: 2,
                resetsAt: new Date(t0 + 48 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
        "claude/acct1": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 15,
                remaining: 85,
                resetsAt: new Date(t0 + 72 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
      }),
      "utf8"
    );
    clearQuotasCache();

    try {
      const loaded = loadLiveQuotas({ magpieConfigDir: tmpDir }, t0);
      assert.ok(loaded && loaded["codex/acct1"]);

      const req = {
        model: "agentcompass/auto",
        messages: [
          {
            role: "user",
            content: "Implement the next pagination helper method in the user service.",
          },
        ],
      };
      const sessKey = computeSessionKey(req, { headers: { "x-session-id": "sess-quota-spent" } });
      // Session was previously holding `gpt-5.3-codex` with warm KV cache
      store.set(
        sessKey,
        {
          model: "gpt-5.3-codex",
          effort: "high",
          provider: "codex",
          tokens: 12_000,
          cached: true,
          healthy: true,
          turn: 2,
        },
        t0
      );

      const ctxQuota = {
        protocol: "chat",
        headers: { "x-session-id": "sess-quota-spent" },
        state: {},
        options: {
          continuityStore: store,
          magpieConfigDir: tmpDir,
          candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"],
          now: t0 + 15_000,
          prefer_local_heuristic: true,
        },
      };
      await hookOnRequest(req, ctxQuota);

      assert.equal(ctxQuota.state.route.continuation.held, false);
      assert.equal(ctxQuota.state.route.continuation.why, "quota_exhausted");
      assert.equal(ctxQuota.state.route.targetModel, "claude-sonnet-4-6");
      assert.equal(ctxQuota.state.route.selectedAccount, "claude/acct1");
    } finally {
      clearQuotasCache();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

test("8.5 `strategies.agentcompass` pool seat ordering: `learns` -> pre-reset sprint -> healthy subscription -> API key -> low reserve -> resting/spent", () => {
    const t0 = 1_700_000_000_000;
    const seats = [
      // Index 0: Resting seat
      { key: "claude/resting", account: true, known: true, learns: false, used: 20, soon: [t0 + 48 * 3600_000], pace: 1.6, resting: true, tokens: 0 },
      // Index 1: Low-reserve seat (94% used >= 90% keepPercent)
      { key: "claude/low-reserve", account: true, known: true, learns: false, used: 94, soon: [t0 + 24 * 3600_000], pace: 0.25, resting: false, tokens: 100 },
      // Index 2: Unshared pay-as-you-go API key (`account: false`, `soon: []`)
      { key: "claude/api-key", account: false, known: false, learns: false, used: 0, soon: [], pace: 0, resting: false, tokens: 0 },
      // Index 3: Normal healthy subscription (50% used, 100h left)
      { key: "claude/normal-sub", account: true, known: true, learns: false, used: 50, soon: [t0 + 100 * 3600_000], pace: 0.5, resting: false, tokens: 500 },
      // Index 4: Pre-reset surplus sprint subscription (30% used = 70% left, renewing in 3 hours!)
      { key: "claude/sprint-sub", account: true, known: true, learns: false, used: 30, soon: [t0 + 3 * 3600_000], pace: 23.3, resting: false, tokens: 1000 },
      // Index 5: Unknown subscription that `learns` on its first response
      { key: "claude/learns-sub", account: true, known: false, learns: true, used: 0, soon: [], pace: 0, resting: false, tokens: 0 },
    ];

    const order = strategies.agentcompass("claude", seats, { now: t0 });
    assert.deepEqual(
      order,
      [5, 4, 3, 2, 1, 0],
      `Expected [learns(5), sprint(4), normalSub(3), apiKey(2), lowReserve(1), resting(0)], got [${order.join(", ")}]`
    );
  });

test("8.6 Strict AgentCompass Main-Repo Parity (`allocator.py` + `reference-accounts.json` invariants)", () => {
    // Verify calibrated subjective blend weights (0.49 / 0.34 / 0.17) and default_hours (0.4 / 1.0 / 2.0 / 3.5)
    assert.deepEqual(DEFAULT_SCORING_POLICY.profile.subjective, {
      weight: 0.49,
      vector_weight: 0.34,
      route_weight: 0.17,
    });
    assert.deepEqual(DEFAULT_SCORING_POLICY.default_hours, {
      routine: 0.4,
      hard: 1.0,
      coupled: 2.0,
      frontier: 3.5,
    });

    // Verify multi-task detection (`MULTI_TASK_MARK_RE`) and structured-only profile (no free-text `reason`)
    const multiProfile = inferTaskProfile({
      objective: "Task 1: Refactor the auth middleware.\nTask 2: Build the billing CSV exporter.",
    });
    assert.equal(multiProfile.multi_task, true);
    assert.equal(multiProfile.task_count, "2");
    assert.equal("reason" in multiProfile, false, "Structured task profile must omit free-text reason");
    assert.equal(SCORER_SYSTEM_PROMPT.includes("- reason:"), false, "SCORER_SYSTEM_PROMPT must not request free-text reason");

    // Verify `parseJevScorerAnswer` produces structured-only profile without `reason`
    const jevParsed = parseJevScorerAnswer({
      model: "jev-latest",
      answers: {
        work_kind: { choice: "debug_review" },
        interaction_style: { choice: "exploration" },
        reasoning_depth: { score: 2 },
        code_complexity: { score: 0 },
        context_scale: { score: 1 },
        divergence: { score: 1 },
        hallucination_risk: { score: 2 },
        error_cost: { score: 1 },
        needs_visual: { noul: 0.1 },
        needs_gui: { noul: 0.1 },
        local_only: { noul: 0.9 },
      },
    });
    assert.equal("reason" in jevParsed, false);
    assert.equal(jevParsed.work_kind, "debug_review");
    assert.equal(jevParsed.local_only, true);

    // Verify `namedRoute` trusts classifier's `work_kind` directly without secondary `code_complexity === 0` override (89f66ab)
    assert.equal(
      namedRoute({ work_kind: "general_implementation", code_complexity: 0 }),
      "general_implementation"
    );

    // Verify `free_usage` (+0.18 `unlimited_bonus`) on unlimited subscription accounts
    const unlimitedDec = selectBestRoute(
      {
        work_kind: "bounded_bulk_work",
        reasoning_depth: 1,
        code_complexity: 1,
        context_scale: 2,
        divergence: 1,
        hallucination_risk: 1,
        error_cost: 1,
        needs_visual: false,
        needs_gui: false,
        local_only: true,
        interaction_style: "engineering",
        expected_hours: 0.4,
      },
      {
        candidateModels: ["gpt-6.1-sol", "gemini-3.8-flash-high"],
        quotas: {
          "codex/unlimited@example.com": {
            kind: "subscription",
            unlimited: true,
          },
          "gemini/limited@example.com": {
            kind: "subscription",
            quota: {
              windows: [{ name: "7d", used: 40, remaining: 60, resetHours: 100 }],
            },
          },
        },
      }
    );
    assert.equal(unlimitedDec.targetModel, "gpt-6.1-sol");
    assert.equal(unlimitedDec.components.free_usage, 0.18);

    // Verify v0.3.7 + 54bb51e calibration parity:
    assert.deepEqual(DEFAULT_SCORING_POLICY.ability_floor, {
      routine: 2.3,
      hard: 3.1,
      coupled: 3.6,
      frontier: 4.2,
    });
    assert.deepEqual(DEFAULT_SCORING_POLICY.ability_score_origin, {
      routine: 3.0,
      hard: 3.3,
      coupled: 3.6,
      frontier: 4.2,
    });
    assert.deepEqual(DEFAULT_SCORING_POLICY.critical_headroom_by_difficulty, {
      frontier: 0.1,
    });

    // D (54bb51e): computer_use action phrases, CODE_FILE_RE, and translation-of narrowing
    for (const prompt of [
      "Fix the keyboard shortcuts in editor.py.",
      "Fix mouse event handler in app.ts",
      "Fix translation.py.",
      "Debug translation pipeline",
      "修复翻译模块的 bug",
    ]) {
      assert.equal(inferKindFromObjective(prompt), "debug_review", `Expected debug_review for: ${prompt}`);
    }
    assert.equal(inferKindFromObjective("用鼠标点击设置里的保存"), "computer_use");

    // A3 (54bb51e): origin = max(floor, ability_score_origin[d]) so raising floor above origin does not hand out free ability score
    const raisedFloorRanked = rankCandidates(
      {
        work_kind: "debug_review",
        reasoning_depth: 2,
        code_complexity: 2,
        context_scale: 1,
        divergence: 1,
        hallucination_risk: 2,
        error_cost: 3, // critical -> uses origin-based gradient
        needs_visual: false,
        needs_gui: false,
        local_only: true,
        interaction_style: "engineering",
      },
      {
        candidateModels: ["claude-opus-5-5", "gpt-6.1-sol"],
        catalog: {
          policy: {
            ...DEFAULT_SCORING_POLICY,
            ability_floor: { ...DEFAULT_SCORING_POLICY.ability_floor, hard: 3.6 },
            critical_headroom: 0.0,
          },
        },
      }
    );
    const solHigh = raisedFloorRanked.ranking.find((c) => c.canonicalModel === "gpt-6.1-sol" && c.effort === "high");
    assert.ok(solHigh, "gpt-6.1-sol:high (ability 3.6) clears floor=3.6 when critical_headroom=0");
    assert.equal(solHigh.components.ability, 0, "Model right at raised floor (3.6 > origin 3.3) must not get free ability score");

    // gpt-6-luna's effort curve is AgentCompass v0.3.7-v0.3.9 `effort_curves["gpt-6-luna"]`
    assert.deepEqual(EFFORT_CURVES["gpt-6-luna"], {
      ability: { low: -0.54, medium: -0.15, high: 0, xhigh: 0.1, max: 0.35 },
      burn: { low: 0.1, medium: 0.4, high: 0.7, xhigh: 1.0, max: 1.5 },
    });
  });

const GATE_PROFILE = {
  code_complexity: 2,
  context_scale: 1,
  divergence: 1,
  hallucination_risk: 2,
  needs_visual: false,
  needs_gui: false,
  local_only: true,
  interaction_style: "engineering",
};

test("8.7 Critical frontier gate is 4.3 (frontier floor 4.2 + `critical_headroom_by_difficulty.frontier` 0.1): Astra Max is admitted, Astra High is not", () => {
  const ranked = rankCandidates(
    { ...GATE_PROFILE, work_kind: "general_implementation", reasoning_depth: 4, code_complexity: 3, error_cost: 3 },
    { candidateModels: [{ model: "gpt-6-astra", efforts: ["high", "max"] }] },
  );
  assert.equal(ranked.task.difficulty, "frontier");
  assert.equal(ranked.task.critical, true);
  const byEffort = Object.fromEntries(ranked.allCandidates.map((c) => [c.effort, c]));
  assert.equal(byEffort.max.eligible, true, `Astra Max (4.3) clears the 4.3 gate: ${byEffort.max.excluded.join("; ")}`);
  assert.equal(byEffort.high.eligible, false, "Astra High (4.2) is below the 4.3 gate");
  assert.match(byEffort.high.excluded.join("; "), /ability 4\.20 below the frontier floor 4\.30/);
});

test("8.8 tool_execution/hard uses its route floor 2.7, not the policy's hard floor 3.1", () => {
  // gpt-6-luna:medium is 3.2 - 0.15 = 3.05: above the route's 2.7, below the policy's 3.1
  const rank = (workKind) =>
    rankCandidates(
      { ...GATE_PROFILE, work_kind: workKind, reasoning_depth: 2, error_cost: 2 },
      { candidateModels: [{ model: "gpt-6-luna", efforts: ["medium"] }] },
    );
  const tool = rank("tool_execution");
  assert.equal(tool.task.kind, "tool_execution");
  assert.equal(tool.task.difficulty, "hard");
  const toolLuna = tool.allCandidates[0];
  assert.equal(toolLuna.eligible, true, `luna:medium (3.05) clears the 2.7 route floor: ${toolLuna.excluded.join("; ")}`);

  const impl = rank("general_implementation");
  assert.equal(impl.task.kind, "general_implementation");
  assert.equal(impl.task.difficulty, "hard");
  assert.match(impl.allCandidates[0].excluded.join("; "), /ability 3\.05 below the hard floor 3\.10/);
});

test("8.9 `ability_score_origin` above the floor decides the pick (hard: origin 3.3, floor 3.1)", () => {
  // Critical hard task (error_cost 3): abilityScore = (credited - origin - (gate - floor)) / span, gate 3.4, span 0.6.
  const ranked = rankCandidates(
    { ...GATE_PROFILE, work_kind: "general_implementation", reasoning_depth: 2, error_cost: 3 },
    { candidateModels: [{ model: "claude-sonnet-5-5", efforts: ["xhigh"] }, { model: "gpt-6-astra", efforts: ["medium"] }] },
  );
  assert.equal(ranked.task.difficulty, "hard");
  assert.equal(ranked.task.minimum_sufficient, false);
  const sonnet = ranked.allCandidates.find((c) => c.canonicalModel === "claude-sonnet-5-5");
  assert.equal(sonnet.components.ability_value, 4.3);
  // Measured against origin 3.3; with origin = floor 3.1 the score is 0.333 higher and Sonnet xhigh overtakes Astra medium
  assert.equal(`${ranked.selected.canonicalModel}:${ranked.selected.effort}`, "gpt-6-astra:medium");
});

test("8.10 Work-kind and GUI-fact guards from AgentCompass 54bb51e (v0.3.8)", () => {
  // CODE_FILE_RE guard: an action phrase about a code file is not computer use
  assert.equal(inferKindFromObjective("Click the Save button handler in settings.tsx is broken"), "general_implementation");
  // Bare "keyboard" / "mouse" are not computer-use phrases
  assert.equal(inferKindFromObjective("Add keyboard shortcuts to the settings dialog"), "general_implementation");
  assert.equal(inferKindFromObjective("Add mouse wheel zoom to the chart"), "general_implementation");
  // "translation of", not "translation"
  assert.equal(inferKindFromObjective("Add a translation layer between the API and the DB"), "general_implementation");
  assert.equal(inferKindFromObjective("Write a translation of the README into Japanese"), "text_in_text_out");
  // A named code file skips text_in_text_out even with no debug word
  assert.equal(inferKindFromObjective("Translate the error strings in i18n.ts"), "general_implementation");
  assert.equal(inferKindFromObjective("Translate the release notes into Japanese"), "text_in_text_out");
  // Phrases v0.3.8 does not have are not computer use on their own
  for (const prompt of ["Take a screenshot of the report", "Capture a screenshot for the docs", "截取屏幕上的报表", "截屏操作说明"]) {
    assert.notEqual(inferKindFromObjective(prompt), "computer_use", prompt);
  }

  // hasComputerUse: COMPUTER_USE_PHRASES with the code-file guard, not the older GUI_WORDS
  const facts = (text) => extractRequestFacts({ messages: [{ role: "user", content: text }] }, { protocol: "chat" });
  assert.equal(facts("Click the Save button in the desktop app and confirm the dialog closes").hasComputerUse, true);
  assert.equal(facts("Click the Save button handler in settings.tsx is broken").hasComputerUse, false);
  for (const text of ["Add keyboard shortcuts to the desktop app", "Open the gui and check the desktop app", "修改桌面版的键盘快捷键"]) {
    assert.equal(facts(text).hasComputerUse, false, text);
  }
});

test("8.11 Continuity: only a computer-use turn outgrows a model without GUI (`capability_outgrown` / `gui_capability_required`)", async () => {
  const t0 = 1_700_000_000_000;
  const nextTurn = async (text) => {
    const store = new SessionContinuityStore();
    store.set("sess-gui", { model: "grok-4.7", effort: "medium", tokens: 4000, cached: true, healthy: true, turn: 1 }, t0);
    const ctx = {
      protocol: "chat",
      session_id: "sess-gui",
      state: {},
      options: { continuityStore: store, now: t0 + 30_000, prefer_local_heuristic: true },
    };
    await hookOnRequest({ model: "agentcompass/auto", session_id: "sess-gui", messages: [{ role: "user", content: text }] }, ctx);
    return ctx.state.route;
  };
  const gui = await nextTurn("Click the Save button in the desktop app and confirm the dialog closes");
  assert.equal(gui.continuation.held, false);
  assert.equal(gui.continuation.why, "capability_outgrown");
  assert.equal(gui.continuation.reasonDetail, "gui_capability_required");
  assert.notEqual(gui.canonicalModel, "grok-4.7");
  // Before 0.1.2 the broader GUI words (" gui", "desktop app", "keyboard", "桌面", "键盘") also moved the session; now they hold it
  for (const text of [
    "Add keyboard shortcuts to the desktop app",
    "Open the gui and check the desktop app",
    "修改桌面版的键盘快捷键",
    "Click the Save button handler in settings.tsx is broken",
  ]) {
    const held = await nextTurn(text);
    assert.notEqual(held.continuation.why, "capability_outgrown", text);
    assert.equal(held.canonicalModel, "grok-4.7", text);
  }
});

// AgentCompass v0.3.8 skills/agent-compass/references/accounts.json: `effort_curves` for the 13 models the plugin carries
const V038_EFFORT_CURVES = {
  "deepseek-v4.1-flash-free": { ability: { high: 0, max: 0.2 }, burn: { high: 0.7, max: 0.91 } },
  "claude-opus-5-5": {
    ability: { low: -0.84, medium: -0.2, high: 0, xhigh: 0.25, max: 0.35 },
    burn: { low: 0.2, medium: 0.5, high: 0.7, xhigh: 1.22, max: 2.03 },
  },
  "claude-sonnet-5-5": {
    ability: { low: -0.79, medium: -0.54, high: 0, xhigh: 0.4, max: 0.64 },
    burn: { low: 0.22, medium: 0.33, high: 0.7, xhigh: 1.75, max: 4.28 },
  },
  "gpt-6-astra": {
    ability: { low: -0.59, medium: -0.15, high: 0, xhigh: 0, max: 0.1 },
    burn: { low: 0.31, medium: 0.59, high: 0.7, xhigh: 0.79, max: 1.35 },
  },
  "gpt-6.1-sol": {
    ability: { low: -0.74, medium: -0.2, high: 0, xhigh: 0.1, max: 0.25 },
    burn: { low: 0.19, medium: 0.43, high: 0.7, xhigh: 0.9, max: 1.51 },
  },
  "grok-4.7": { ability: { low: -0.2, high: 0, xhigh: 0 }, burn: { low: 0.33, high: 0.7, xhigh: 0.88 } },
  "gemini-3.8-flash-high": { ability: { low: -0.4, medium: -0.05, high: 0 }, burn: { medium: 0.56, high: 0.7 } },
  "gemini-4-argon-high": { ability: { low: -0.3, medium: -0.1, high: 0 }, burn: { low: 0.63, medium: 0.7, high: 0.7 } },
  "claude-haiku-5-5": {
    ability: { low: -0.54, medium: -0.25, high: 0, xhigh: 0.25, max: 0.3 },
    burn: { low: 0.17, medium: 0.39, high: 0.7, xhigh: 1.09, max: 1.79 },
  },
  "gpt-6.1-terra": {
    ability: { low: -0.64, medium: -0.2, high: 0, xhigh: 0.15, max: 0.45 },
    burn: { low: 0.19, medium: 0.46, high: 0.7, xhigh: 1.08, max: 2.58 },
  },
  "gpt-6-luna": {
    ability: { low: -0.54, medium: -0.15, high: 0, xhigh: 0.1, max: 0.35 },
    burn: { low: 0.1, medium: 0.4, high: 0.7, xhigh: 1.0, max: 1.5 },
  },
  "claude-fable-5-1": {
    ability: { low: -0.4, medium: -0.2, high: 0, xhigh: 0.15, max: 0.15 },
    burn: { low: 0.41, medium: 0.52, high: 0.7, xhigh: 1.01, max: 1.21 },
  },
  "gemini-4-carbon": { ability: { low: -0.3, medium: -0.1, high: 0 }, burn: { low: 0.65, medium: 0.59, high: 0.7 } },
};

test("8.12 All 13 effort curves and `effort_ability` / `effort_burn` equal AgentCompass v0.3.8", () => {
  assert.deepEqual(Object.keys(EFFORT_CURVES).sort(), Object.keys(V038_EFFORT_CURVES).sort());
  for (const [model, curve] of Object.entries(V038_EFFORT_CURVES)) {
    assert.deepEqual(EFFORT_CURVES[model].ability, curve.ability, `${model} ability`);
    assert.deepEqual(EFFORT_CURVES[model].burn, curve.burn, `${model} burn`);
  }
  // scoring.effort_ability / scoring.effort_burn: upstream's low..max; none/off/minimal are the plugin's own rows (0.1.3)
  const { none, off, minimal, ...upstreamAbility } = DEFAULT_SCORING_POLICY.effort_ability;
  assert.deepEqual(upstreamAbility, { low: -0.54, medium: -0.2, high: 0, xhigh: 0.15, max: 0.3 });
  assert.deepEqual({ none, off, minimal }, { none: -1.1, off: -1.1, minimal: -1.0 });
  assert.deepEqual(DEFAULT_SCORING_POLICY.effort_burn, { low: 0.2, medium: 0.4, high: 0.7, xhigh: 1.0, max: 1.3 });
});

test("9.1 PR #670 Review Guard: Default triggers ONLY claim `agentcompass` / `agentcompass/*` and never hijack `auto` or `group/intent`", async () => {
  for (const nonOwnedModel of ["auto", "intent", "group/intent", "default", "claude-sonnet-4-6"]) {
    const req = {
      model: nonOwnedModel,
      messages: [{ role: "user", content: "Explain how HTTP/3 QUIC connection migration works." }],
    };
    const hookCtx = { protocol: "chat", state: {}, options: {} };
    const hookRes = await hookOnRequest(req, hookCtx);
    assert.equal(hookRes, undefined, `hookOnRequest must skip non-owned model "${nonOwnedModel}" by default`);
    assert.equal(hookCtx.state.route, undefined);

    const mwCtx = { protocol: "chat", state: {}, options: {} };
    const mwRes = mwOnRequest(req, mwCtx);
    assert.equal(mwRes, undefined, `mwOnRequest must skip non-owned model "${nonOwnedModel}" by default`);
    assert.equal(req.model, nonOwnedModel, `req.model "${nonOwnedModel}" must remain untouched`);
  }
});

test("9.2 PR #670 Review Guard: `availableModels` / `candidateModels` / `ctx.models` & safe fallback when candidate list is omitted", async () => {
  // 1. When `availableModels: ["claude-haiku-5-5", "claude-sonnet-5-5"]` is passed, `agentcompass/auto` ONLY selects from those two models
  const reqLimited = {
    model: "agentcompass/auto",
    messages: [
      {
        role: "user",
        content:
          "Conduct a deep cross-module deadlock and race condition root-cause audit across the distributed transaction engine.",
      },
    ],
  };
  const mwCtxLimited = {
    protocol: "chat",
    state: {},
    options: {
      availableModels: ["claude-haiku-5-5", "claude-sonnet-5-5"],
      injectProtocolEffort: true,
    },
  };
  const routedLimited = mwOnRequest(structuredClone(reqLimited), mwCtxLimited);
  assert.ok(routedLimited, "mwOnRequest must route within availableModels");
  assert.match(
    routedLimited.model,
    /^claude-sonnet-5-5:(high|xhigh|max)$/,
    `Must pick claude-sonnet-5-5 from availableModels, got ${routedLimited.model}`
  );

  // 2. When NO candidate list is configured and `routeAllModels: true` is used on a concrete model (`claude-sonnet-4-6`),
  // it MUST keep `claude-sonnet-4-6` and only inject effort — never rewriting to an unverified catalog model like `claude-opus-5-5`!
  const reqConcrete = {
    model: "claude-sonnet-4-6",
    messages: [
      {
        role: "user",
        content: "Audit the cross-module state machine for deadlocks and prove liveness invariants.",
      },
    ],
  };
  const routedConcrete = mwOnRequest(structuredClone(reqConcrete), {
    protocol: "chat",
    state: {},
    options: { routeAllModels: true, injectProtocolEffort: true },
  });
  assert.ok(routedConcrete);
  assert.match(
    routedConcrete.model,
    /^claude-sonnet-4-6:(high|xhigh|max)$/,
    `Concrete model must not be rewritten to an unverified catalog model (got ${routedConcrete.model})`
  );

  // 3. When `model: "agentcompass/auto"` is sent WITHOUT `candidateModels` or `defaultModel`, `onRequest` calls
  // `ctx.reject(400, "agentcompass: set candidateModels in the plugin's options")` instead of guessing from a fixed list.
  const reqVirtual = {
    model: "agentcompass/auto",
    messages: [
      {
        role: "user",
        content: "Implement a standalone LRU cache module in TypeScript with unit tests.",
      },
    ],
  };
  let rejectedStatus = null;
  let rejectedMessage = null;
  const unconfiguredRes = mwOnRequest(structuredClone(reqVirtual), {
    protocol: "chat",
    state: {},
    options: { injectProtocolEffort: true },
    reject(status, message) {
      rejectedStatus = status;
      rejectedMessage = message;
      return undefined;
    },
  });
  assert.equal(unconfiguredRes, undefined);
  assert.equal(rejectedStatus, 400);
  assert.equal(rejectedMessage, "agentcompass: set candidateModels in the plugin's options");

  // With `defaultModel` configured, `onRequest` rewrites the virtual model to `defaultModel:<effort>` and `onProvider`
  // refines within `options.modelsByProvider` using Magpie's real `{id, name, account, model}` `ctx.provider` shape!
  const sharedState = {};
  const afterReq = mwOnRequest(reqVirtual, {
    protocol: "chat",
    state: sharedState,
    options: { defaultModel: "claude-sonnet-4-6", injectProtocolEffort: true },
  });
  assert.ok(afterReq, "Virtual model must be rewritten in onRequest when defaultModel is set");
  assert.match(afterReq.model, /^claude-sonnet-4-6:(medium|high|xhigh)$/);
  assert.ok(sharedState.agentcompass?.profile, "Task profile must be saved in ctx.state for onProvider/onAccount");

  const afterProv = mwOnProvider(afterReq, {
    protocol: "chat",
    state: sharedState,
    provider: {
      id: "anthropic",
      name: "Anthropic",
      account: "work",
      model: afterReq.model,
    },
    options: {
      injectProtocolEffort: true,
      modelsByProvider: {
        anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6"],
      },
    },
  });
  assert.ok(afterProv);
  assert.match(afterProv.model, /^claude-sonnet-4-6:(medium|high|xhigh)$/);
});

test("9.3 PR #670 Review Guard: `hooks.onRequest` never injects `__agentcompass_route` and `mwOnRequest` strips it on claimed models", async () => {
  // 1. `hooks.onRequest` leaves zero `__agentcompass_route` property on `body` even if `useRouteCarrier: true` is passed
  const req = {
    model: "agentcompass/auto",
    messages: [{ role: "user", content: "Fix the bug in the parser." }],
  };
  const hookCtx = {
    protocol: "chat",
    state: {},
    options: { candidateModels: ["claude-sonnet-5-5"], useRouteCarrier: true },
  };
  const hookOut = await hookOnRequest(req, hookCtx);
  assert.equal(hookOut, undefined);
  assert.equal(ROUTE_CARRIER_KEY in req, false);

  // 2. On a claimed request (`model: "agentcompass"`), `mwOnRequest` strips `__agentcompass_route` from the returned body
  const claimedWithCarrier = {
    model: "agentcompass",
    messages: [{ role: "user", content: "Fix the bug in the parser." }],
    [ROUTE_CARRIER_KEY]: { targetModel: "claude-opus-5-5" },
  };
  const routed = mwOnRequest(claimedWithCarrier, {
    protocol: "chat",
    state: {},
    options: { candidateModels: ["claude-sonnet-4-6"] },
  });
  assert.ok(routed);
  assert.equal(ROUTE_CARRIER_KEY in routed, false);
});

test("9.4 PR #670 Review Guard: `onAccount` natively matches Magpie's `{ref, provider, name, kind, model}` context", () => {
  const state = {
    agentcompass: {
      workKind: "debug_review",
      targetModel: "claude-sonnet-5-5",
      targetEffort: "high",
    },
  };

  // Match by `ref`
  assert.equal(
    mwOnAccount(
      { ref: "deadbeefcafe1234", provider: "anthropic", name: "Team Seat", kind: "claude", model: "claude-sonnet-5-5" },
      { state, options: { accountsByWorkKind: { debug_review: ["deadbeefcafe1234"] } } }
    ),
    undefined
  );

  // Match by `provider/name`
  assert.equal(
    mwOnAccount(
      { ref: "deadbeefcafe1234", provider: "anthropic", name: "work", kind: "claude", model: "claude-sonnet-5-5" },
      { state, options: { accountsByWorkKind: { debug_review: ["anthropic/work"] } } }
    ),
    undefined
  );

  // Skip when neither `ref`, `name`, `provider`, `kind`, nor `${provider}/${name}` matches
  assert.deepEqual(
    mwOnAccount(
      { ref: "deadbeefcafe1234", provider: "openai", name: "personal", kind: "codex", model: "gpt-5.3-codex" },
      { state, options: { accountsByWorkKind: { debug_review: ["anthropic/work", "claude"] } } }
    ),
    { skip: true }
  );
});

test("9.5 PR #670 Review Guard: Zero implicit external scorer calls and zero parent-directory `quotas.json` walking", async () => {
  clearProfileCache();
  clearQuotasCache();

  // 1. `loadLiveQuotas({})` returns `null` without walking parent directories or reading disk
  assert.equal(loadLiveQuotas({}), null);

  // 2. `scoreTaskLive` with `scorerType: "openai_compatible"` or `"jev"` and `scorerBaseUrl` set,
  // but WITHOUT `allowExternalScorer: true` (and without injected test `fetch`), makes 0 network calls!
  const origFetch = globalThis.fetch;
  let globalFetchCalled = false;
  globalThis.fetch = async () => {
    globalFetchCalled = true;
    throw new Error("globalThis.fetch must not be called without allowExternalScorer: true");
  };
  try {
    const res1 = await scoreTaskLive(
      { objective: "Design a distributed consensus protocol." },
      {
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:4096",
        useCache: false,
      }
    );
    assert.equal(globalFetchCalled, false);
    assert.equal(res1.meta.source, "heuristic_twin");

    const res2 = await scoreTaskLive(
      { objective: "Design a distributed consensus protocol." },
      {
        scorerType: "jev",
        jevBaseUrl: "https://api.typesafe.ai",
        useCache: false,
      }
    );
    assert.equal(globalFetchCalled, false);
    assert.equal(res2.meta.source, "heuristic_twin");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("9.6 PR #670 Round 2 & 3 Guard: Client body injection (`__agentcompass_route`, `useRouteCarrier`, `available_models`, `candidate_models`) is rejected", async () => {
  // 1. Unclaimed model (`"claude-sonnet-4-6"`) is untouched and returns `undefined`, even if `__agentcompass_route` and `useRouteCarrier: true` are passed
  const nonClaimedBody = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hello" }],
    [ROUTE_CARRIER_KEY]: { targetModel: "evil", modelWithEffort: "evil:max" },
  };
  const nonClaimedRes = mwOnRequest(nonClaimedBody, {
    protocol: "chat",
    state: {},
    options: { useRouteCarrier: true },
  });
  assert.equal(nonClaimedRes, undefined);
  assert.equal(nonClaimedBody.model, "claude-sonnet-4-6");

  // 2a. Claimed model (`"agentcompass"`) WITH `candidateModels` where client `__agentcompass_route` names a model
  // INSIDE `candidateModels` (`"claude-opus-4-6"`) AND passes `{ useRouteCarrier: true }` + a malformed `profile.work_kind`:
  // MUST ignore the client carrier completely, never pass client `profile` to `selectBestRoute`, and route the rename to `"claude-haiku-4-5:low"`!
  const claimedInCandidatesBody = {
    model: "agentcompass",
    messages: [{ role: "user", content: "rename the variable foo to bar in utils.go" }],
    [ROUTE_CARRIER_KEY]: {
      targetModel: "claude-opus-4-6",
      targetEffort: "max",
      modelWithEffort: "claude-opus-4-6:max",
      profile: { work_kind: "invalid_evil_work_kind" },
    },
  };
  const claimedInCandidatesRes = mwOnRequest(claimedInCandidatesBody, {
    protocol: "chat",
    state: {},
    options: {
      useRouteCarrier: true,
      candidateModels: ["claude-opus-4-6", "claude-haiku-4-5", "gpt-5.5"],
    },
  });
  assert.ok(claimedInCandidatesRes);
  assert.equal(ROUTE_CARRIER_KEY in claimedInCandidatesRes, false);
  assert.equal(claimedInCandidatesRes.model, "claude-haiku-4-5:low");

  // 2b. Claimed model (`"agentcompass"`) where client `__agentcompass_route` names a model OUTSIDE `candidateModels`
  // and supplies a hostile `profile.work_kind`: MUST NOT pass `profile` to `selectBestRoute` or throw!
  const claimedOutsideCandidatesBody = {
    model: "agentcompass",
    messages: [{ role: "user", content: "rename the variable foo to bar in utils.go" }],
    [ROUTE_CARRIER_KEY]: {
      targetModel: "evil",
      targetEffort: "max",
      modelWithEffort: "evil:max",
      profile: { work_kind: "unknown_hostile_work_kind" },
    },
  };
  const claimedOutsideCandidatesRes = mwOnRequest(claimedOutsideCandidatesBody, {
    protocol: "chat",
    state: {},
    options: {
      useRouteCarrier: true,
      candidateModels: ["claude-opus-4-6", "claude-haiku-4-5", "gpt-5.5"],
    },
  });
  assert.ok(claimedOutsideCandidatesRes);
  assert.equal(claimedOutsideCandidatesRes.model, "claude-haiku-4-5:low");

  // 2c. Claimed model (`"agentcompass"`) with NO `candidateModels` (`allowUnconstrainedCatalog: true`) and `{ useRouteCarrier: true }`:
  // client `__agentcompass_route` (`targetModel: "evil"`) MUST be ignored and never steer routing to `"evil:max"`!
  const claimedNoCandidatesBody = {
    model: "agentcompass",
    messages: [{ role: "user", content: "rename the variable foo to bar in utils.go" }],
    [ROUTE_CARRIER_KEY]: { targetModel: "evil", targetEffort: "max", modelWithEffort: "evil:max" },
  };
  const claimedNoCandidatesRes = mwOnRequest(claimedNoCandidatesBody, {
    protocol: "chat",
    state: {},
    options: { useRouteCarrier: true, allowUnconstrainedCatalog: true },
  });
  assert.ok(claimedNoCandidatesRes);
  assert.equal(ROUTE_CARRIER_KEY in claimedNoCandidatesRes, false);
  assert.equal(claimedNoCandidatesRes.model, "gemini-3.8-flash-high:high");

  // 3. Client-supplied `body.available_models` and `body.candidate_models` MUST NOT influence candidate model selection
  const bodySpoofCandidates = {
    model: "claude-sonnet-4-6",
    available_models: ["evil-model-1", "evil-model-2"],
    candidate_models: ["evil-model-1", "evil-model-2"],
    messages: [{ role: "user", content: "rename the variable foo to bar in utils.go" }],
  };
  const spoofHookCtx = { protocol: "chat", state: {}, options: { routeAllModels: true } };
  await hookOnRequest(bodySpoofCandidates, spoofHookCtx);
  assert.equal(spoofHookCtx.state.route.targetModel, "claude-sonnet-4-6");

  const spoofMwRes = mwOnRequest(structuredClone(bodySpoofCandidates), {
    protocol: "chat",
    state: {},
    options: { routeAllModels: true },
  });
  assert.ok(spoofMwRes);
  assert.match(spoofMwRes.model, /^claude-sonnet-4-6:/);
});

test("9.7 PR #670 Round 2 Guard: Mainstream real model IDs & trivial single-variable rename routing across all candidate orders", () => {
  // 1. Built-in catalog (`allowUnconstrainedCatalog: true`) routes "rename the variable foo to bar in utils.go" to `gemini-3.8-flash-high:high`
  const builtInBody = {
    model: "agentcompass",
    messages: [{ role: "user", content: "rename the variable foo to bar in utils.go" }],
  };
  const builtInRes = mwOnRequest(builtInBody, {
    protocol: "chat",
    state: {},
    options: { allowUnconstrainedCatalog: true },
  });
  assert.ok(builtInRes);
  assert.equal(builtInRes.model, "gemini-3.8-flash-high:high");

  // 2. Across all 6 permutations of `["claude-opus-4-6", "claude-haiku-4-5", "gpt-5.5"]`:
  //    - Trivial single-variable rename routes to `"claude-haiku-4-5:low"`
  //    - Complex multi-module concurrency/deadlock architecture audit routes to `"claude-opus-4-6:high"` or `"claude-opus-4-6:xhigh"`
  const permutations = [
    ["claude-opus-4-6", "claude-haiku-4-5", "gpt-5.5"],
    ["claude-opus-4-6", "gpt-5.5", "claude-haiku-4-5"],
    ["claude-haiku-4-5", "claude-opus-4-6", "gpt-5.5"],
    ["claude-haiku-4-5", "gpt-5.5", "claude-opus-4-6"],
    ["gpt-5.5", "claude-opus-4-6", "claude-haiku-4-5"],
    ["gpt-5.5", "claude-haiku-4-5", "claude-opus-4-6"],
  ];

  for (const candidateModels of permutations) {
    const renameReq = {
      model: "agentcompass",
      messages: [{ role: "user", content: "rename the variable foo to bar in utils.go" }],
    };
    const renameOut = mwOnRequest(renameReq, {
      protocol: "chat",
      state: {},
      options: { candidateModels, continuityStore: new SessionContinuityStore() },
    });
    assert.equal(
      renameOut.model,
      "claude-haiku-4-5:low",
      `Expected claude-haiku-4-5:low for permutation [${candidateModels.join(", ")}], got ${renameOut.model}`
    );

    const auditReq = {
      model: "agentcompass",
      messages: [
        {
          role: "user",
          content:
            "Conduct a deep cross-module root-cause audit of the intermittent deadlock and lock-ordering race condition across internal/gateway/affinity.go and internal/gateway/decide.go.",
        },
      ],
    };
    const auditOut = mwOnRequest(auditReq, {
      protocol: "chat",
      state: {},
      options: { candidateModels, continuityStore: new SessionContinuityStore() },
    });
    assert.match(
      auditOut.model,
      /^claude-opus-4-6:(high|xhigh|max)$/,
      `Expected claude-opus-4-6:(high|xhigh|max) for permutation [${candidateModels.join(", ")}], got ${auditOut.model}`
    );
  }

  // A multi-prefix id resolves by its last segment; an unknown one keeps only its first prefix stripped
  assert.equal(canonicalModel("openrouter/openai/gpt-5-mini"), "gpt-6-luna");
  assert.equal(canonicalModel("OpenRouter/OpenAI/GPT-5-Mini"), "gpt-6-luna");
  // Alias keys with capitals (`MiniMax-M3`) need the exact-case last-segment lookup
  assert.equal(canonicalModel("openrouter/minimax/MiniMax-M3"), "minimax-m3");
  assert.equal(canonicalModel("openrouter/qwen/foo"), "qwen/foo");
  assert.equal(canonicalModel("qwen/foo"), "foo");
});

test("9.8 PR #670 Round 2 Guard: `options.fetch` alone never enables external scorer unless `allowExternalScorer === true`", async () => {
  clearProfileCache();
  let fetchCalled = false;
  const customFetch = async () => {
    fetchCalled = true;
    throw new Error("options.fetch must not be called when allowExternalScorer is not true");
  };

  const scoreRes = await scoreTaskLive(
    { objective: "Refactor the authentication service." },
    {
      scorerType: "openai_compatible",
      scorerBaseUrl: "http://127.0.0.1:4096",
      fetch: customFetch,
      useCache: false,
    }
  );
  assert.equal(fetchCalled, false);
  assert.equal(scoreRes.meta.source, "heuristic_twin");

  const hookReq = {
    model: "agentcompass",
    messages: [{ role: "user", content: "Refactor the authentication service." }],
  };
  await hookOnRequest(hookReq, {
    protocol: "chat",
    state: {},
    options: {
      scorerType: "openai_compatible",
      scorerBaseUrl: "http://127.0.0.1:4096",
      fetch: customFetch,
      candidateModels: ["claude-sonnet-4-6"],
    },
  });
  assert.equal(fetchCalled, false);
});

test("9.9 PR #670 Round 2 & 3 Guard: Single-pass bounded work (`scannedChars`, `extractedTurns`, `capProfileText`) as body grows", () => {
  const messages = [];
  const hugeLogChunk = "x".repeat(50_000) + "\n<system-reminder>hook context reminder</system-reminder>\n";
  for (let i = 0; i < 25; i++) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text:
            i === 0
              ? `<system-reminder>Session initialized</system-reminder>\nImplement the distributed rate limiter middleware.\n${hugeLogChunk}`
              : `Tool output batch ${i}:\n${"z".repeat(4000)}`,
        },
      ],
    });
    messages.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Completed step ${i}. Reading next file section:\n` + "y".repeat(4000),
        },
      ],
    });
  }
  messages.push({
    role: "user",
    content:
      "Now audit the cross-module lock ordering invariants and fix the race condition in internal/gateway/affinity.go.\n" +
      hugeLogChunk +
      "\nEnsure deadlock freedom across all goroutines.",
  });

  const rawSize = JSON.stringify(messages).length;
  assert.ok(rawSize >= 250_000, `Expected synthetic Claude Code payload >= 250KB, got ${rawSize} bytes`);

  const req = {
    model: "agentcompass",
    system: "You are Claude Code, Anthropic's official CLI for Claude.\n" + "s".repeat(12_000),
    messages,
  };

  // 1. Verify work-boundedness invariants directly (raising MAX_PROFILE_CHARS, MAX_NOISE_STRIP_CHARS, or MAX_USER_TURN_CHARS turns these red)
  const facts = extractRequestFacts(req, { protocol: "messages" });
  assert.ok(
    facts.extractedTurns <= 4,
    `Expected at most 4 full-text user turns extracted across ${messages.length} messages, got ${facts.extractedTurns}`
  );
  assert.ok(
    facts.scannedChars <= 36_000,
    `Expected total scannedChars bounded by <= 36,000 on ${(rawSize / 1024).toFixed(1)}KB body, got ${facts.scannedChars}`
  );
  assert.ok(
    facts.objective.length <= 4_001,
    `Expected extracted objective capped at <= 4,001 chars (MAX_USER_TURN_CHARS), got ${facts.objective.length}`
  );
  const cappedProfileInput = capProfileText("audit concurrency ".repeat(4_000));
  assert.ok(
    cappedProfileInput.length <= 4_001,
    `Expected capProfileText output bounded at <= 4,001 chars (MAX_PROFILE_CHARS), got ${cappedProfileInput.length}`
  );

  // 2. Generous smoke ceiling (200ms) for end-to-end `mwOnRequest`
  const tStart = performance.now();
  const out = mwOnRequest(req, {
    protocol: "messages",
    headers: { "x-session-id": "perf-bench-run" },
    state: {},
    options: { candidateModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"] },
  });
  const elapsedMs = performance.now() - tStart;

  assert.ok(out);
  assert.match(out.model, /^claude-opus-4-6:(high|xhigh|max)$/);
  assert.ok(
    elapsedMs < 200,
    `Expected single-pass mwOnRequest smoke check on ${(rawSize / 1024).toFixed(1)}KB body to finish in < 200ms, took ${elapsedMs.toFixed(2)}ms`
  );
});





test("9.10 Effort fallback (plugin-side, not in AgentCompass): `:minimal` and `:ultra` parse as efforts, `ultra` reads as the model's Max and `minimal` sits below its Low", () => {
  const profile = {
    work_kind: "general_implementation",
    reasoning_depth: 1,
    code_complexity: 1,
    context_scale: 2,
    divergence: 1,
    hallucination_risk: 2,
    error_cost: 1,
    needs_visual: false,
    needs_gui: false,
    local_only: true,
    interaction_style: "engineering",
  };
  const rank = (candidateModels, options = {}) => rankCandidates(profile, { candidateModels, ...options });
  const policy = DEFAULT_SCORING_POLICY;

  // Parsing: each suffix is one candidate at that effort, not the model's whole effort list
  assert.deepEqual(
    rank(["gpt-6-astra:minimal", "gpt-6-astra:ultra"]).allCandidates.map((c) => c.id).sort(),
    ["gpt-6-astra:minimal", "gpt-6-astra:ultra"],
  );

  // Scoring on a model's own curve: ultra is its Max; minimal is its Low less the policy's Low->minimal step
  // (at least 0.2), and burns at most 0.75 of its Low
  const astra = Object.fromEntries(
    rank(["gpt-6-astra:low", "gpt-6-astra:max", "gpt-6-astra:minimal", "gpt-6-astra:ultra"]).allCandidates.map((c) => [
      c.effort,
      c.components.ability_value,
    ]),
  );
  assert.equal(astra.ultra, astra.max);
  const step = Math.min(policy.effort_ability.minimal - policy.effort_ability.low, -0.2);
  assert.ok(Math.abs(astra.minimal - (astra.low + step)) < 0.001, `minimal ${astra.minimal}, low ${astra.low}`);
  const curve = { burn: { low: 0.3, high: 0.7, max: 1.4 } };
  assert.equal(burnScale(policy, curve, "ultra"), burnScale(policy, curve, "max"));
  assert.ok(effortValue(policy, curve, "burn", "minimal", 0.7) <= 0.3 * 0.75);

  // A model whose curve has no Low row takes the policy table's minimal step, not High's 0
  const deepseek = Object.fromEntries(
    rank(["deepseek-v4.1-flash-free:minimal", "deepseek-v4.1-flash-free:high"]).allCandidates.map((c) => [
      c.effort,
      c.components.ability_value,
    ]),
  );
  assert.ok(Math.abs(deepseek.minimal - (deepseek.high + policy.effort_ability.minimal)) < 0.001);

  // Continuity: on a warm cache, minimal after low is a downgrade and keeps only a quarter of the continuity bonus
  const held = rank(["gpt-6-astra:low", "gpt-6-astra:minimal"], {
    previousModel: "gpt-6-astra",
    previousEffort: "low",
    cacheWarm: true,
  });
  const cont = Object.fromEntries(held.allCandidates.map((c) => [c.effort, c.components.continuity]));
  assert.equal(cont.low, 0.25);
  assert.equal(cont.minimal, 0.0625);
});

test("9.11 Effort fallback branches the default policy can't reach: policy Max for `ultra`, the 0.2 step floor, the 0.75 burn clamp, none/off", () => {
  const profile = {
    work_kind: "general_implementation",
    reasoning_depth: 1,
    code_complexity: 1,
    context_scale: 2,
    divergence: 1,
    hallucination_risk: 2,
    error_cost: 1,
    needs_visual: false,
    needs_gui: false,
    local_only: true,
    interaction_style: "engineering",
  };
  const policy = DEFAULT_SCORING_POLICY;
  const round = (value) => Math.round(value * 1e4) / 1e4;
  const abilities = (candidateModels) =>
    Object.fromEntries(rankCandidates(profile, { candidateModels }).allCandidates.map((c) => [c.effort, c.components.ability_value]));

  // ultra on a model with no curve of its own reads as the policy's Max
  assert.equal(EFFORT_CURVES["glm-5.3"], undefined);
  const glm = abilities(["glm-5.3:high", "glm-5.3:max", "glm-5.3:ultra"]);
  assert.equal(glm.ultra, glm.max);
  assert.ok(Math.abs(glm.ultra - (glm.high + policy.effort_ability.max)) < 0.001, `ultra ${glm.ultra}, high ${glm.high}`);
  assert.equal(effortValue(policy, undefined, "ability", "ultra", 0), policy.effort_ability.max);
  assert.equal(effortValue(policy, undefined, "burn", "ultra", 0.7), policy.effort_burn.max);

  // Step floor: a policy whose Low->minimal step is smaller than 0.2 still puts minimal 0.2 below the model's Low
  const shallow = { ...policy, effort_ability: { ...policy.effort_ability, low: -0.54, minimal: -0.6 } };
  assert.equal(round(effortValue(shallow, { ability: { low: -0.5, high: 0 } }, "ability", "minimal", 0)), -0.7);
  // ...and a deeper step is used as given
  const deep = { ...policy, effort_ability: { ...policy.effort_ability, low: -0.54, minimal: -1.0 } };
  assert.equal(round(effortValue(deep, { ability: { low: -0.5, high: 0 } }, "ability", "minimal", 0)), -0.96);

  // Burn clamp: a policy with effort_burn.minimal close to Low still burns at most 0.75 of the model's Low
  const curve = { burn: { low: 0.4, high: 0.7 } };
  const nearLow = { ...policy, effort_burn: { ...policy.effort_burn, low: 0.2, minimal: 0.19 } };
  assert.equal(effortValue(nearLow, curve, "burn", "minimal", 0.7), 0.3);
  const cheap = { ...policy, effort_burn: { ...policy.effort_burn, low: 0.2, minimal: 0.1 } };
  assert.equal(effortValue(cheap, curve, "burn", "minimal", 0.7), 0.2);

  // none/off: parsed as efforts and scored from their own policy rows (below minimal), on and off a model's curve
  const astra = abilities(["gpt-6-astra:none", "gpt-6-astra:off", "gpt-6-astra:minimal", "gpt-6-astra:low"]);
  assert.deepEqual(Object.keys(astra).sort(), ["low", "minimal", "none", "off"]);
  const lowToNone = Math.min(policy.effort_ability.none - policy.effort_ability.low, -0.2);
  assert.ok(Math.abs(astra.none - (astra.low + lowToNone)) < 0.001, `none ${astra.none}, low ${astra.low}`);
  assert.equal(astra.off, astra.none);
  assert.ok(astra.none < astra.minimal, `none ${astra.none} below minimal ${astra.minimal}`);
  const glmNone = abilities(["glm-5.3:none", "glm-5.3:off", "glm-5.3:high"]);
  assert.ok(Math.abs(glmNone.none - (glmNone.high + policy.effort_ability.none)) < 0.001);
  assert.ok(Math.abs(glmNone.off - (glmNone.high + policy.effort_ability.off)) < 0.001);
});

test("9.12 Quota opportunity cost reads the allocator's burn scale: `:ultra` costs what `:max` costs, `:minimal`/`none`/`off` cost less than `:low`", () => {
  const t0 = Date.parse("2026-11-05T00:00:00Z");
  const subscription = (key) => ({
    [key]: {
      kind: "subscription",
      quota: { windows: [{ name: "7d", used: 60, remaining: 40, resetsAt: new Date(t0 + 120 * 3600 * 1000).toISOString() }] },
    },
  });
  // glm-5.3 has no effort curve, so its efforts come from the policy table alone.
  for (const [model, quotas] of [
    ["claude-opus-5-5", subscription("claude/sub")],
    ["gpt-6-astra", subscription("codex/sub")],
    ["glm-5.3", subscription("glm-5.3/sub")],
  ]) {
    const cost = (effort) =>
      evaluateModelQuota(`${model}:${effort}`, effort, { hours: 1.5, difficulty: "hard" }, quotas, {}, t0).opportunity_cost;
    assert.ok(cost("max") > cost("high") && cost("high") > cost("low"), `${model} max/high/low ${cost("max")}/${cost("high")}/${cost("low")}`);
    assert.equal(cost("ultra"), cost("max"), `${model} ultra ${cost("ultra")} vs max ${cost("max")}`);
    for (const effort of ["minimal", "none", "off"]) {
      assert.ok(cost(effort) < cost("low"), `${model} ${effort} ${cost(effort)} vs low ${cost("low")}`);
    }
  }
});

test("9.13 The gateway always routes: when every candidate is below the task's floor it sends the most capable one; the allocator itself still declines", async () => {
  const prompt = "Refactor the payment retry loop in billing/retry.go and add tests for the backoff";
  const body = () => ({ model: "agentcompass", messages: [{ role: "user", content: prompt }] });
  const routed = (candidateModels) => {
    const out = mwOnRequest(body(), { protocol: "chat", agent: "claude-code", options: { candidateModels }, state: {} });
    return out ? out.model : null;
  };
  // AgentCompass may leave a task unrouted; it has nothing below the floor to offer.
  assert.equal(selectBestRoute(inferTaskProfile({ objective: prompt }), { objective: prompt, candidateModels: ["gpt-6-astra:minimal"] }).ok, false);
  // Magpie must still send the request somewhere: forwarding `agentcompass` upstream only fails.
  assert.equal(routed(["gpt-6-astra:minimal"]), "gpt-6-astra:minimal");
  assert.equal(routed(["gemini-3.8-flash-high"]), "gemini-3.8-flash-high:high");
  assert.equal(routed(["gpt-6-astra:none", "gpt-6-astra:minimal"]), "gpt-6-astra:minimal");
  // A candidate that clears the floor still wins.
  assert.equal(routed(["gpt-6-astra:minimal", "gpt-6-astra:high"]), "gpt-6-astra:high");

  const ctx = { protocol: "chat", agent: "claude-code", options: { scorerType: "heuristic", candidateModels: ["gpt-6-astra:minimal"] }, state: {}, report() {} };
  await hookOnRequest(body(), ctx);
  assert.equal(ctx.state.route?.targetModel, "gpt-6-astra");
  assert.equal(ctx.state.route?.targetEffort, "minimal");
  assert.ok(ctx.state.route?.fallback, "the decision says it fell back");

  // A model that can't see the request's image is the last resort, however capable it is.
  const visualPrompt = "Refactor the payment retry loop in billing/retry.go to match this screenshot and add tests for the backoff";
  const visualBody = () => ({
    model: "agentcompass",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: visualPrompt },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    }],
  });
  const routedVisual = (candidateModels) => {
    const out = mwOnRequest(visualBody(), { protocol: "chat", agent: "claude-code", options: { candidateModels }, state: {} });
    return out ? out.model : null;
  };
  assert.equal(routedVisual(["claude-fable-5-1:high", "gemini-3.8-flash-high:low"]), "gemini-3.8-flash-high:low");
  assert.equal(routedVisual(["grok-4.7:high", "gemini-3.8-flash-high:minimal"]), "gemini-3.8-flash-high:minimal");
  // Outside the floor-only tier, seeing the image still beats raw ability.
  const visualProfile = { ...inferTaskProfile({ objective: visualPrompt }), needs_visual: true };
  const kind = visualProfile.work_kind;
  const seeing = selectBestRoute(visualProfile, {
    objective: visualPrompt,
    candidateModels: ["claude-fable-5-1:high", "gemini-3.8-flash-high:low", "grok-4.7:low"],
    catalog: { routes: { ...CANONICAL_ROUTES, [kind]: { ...CANONICAL_ROUTES[kind], restrict_models: true, preferred: ["grok-4.7"] } } },
    fallbackToBestExcluded: true,
  });
  assert.equal(seeing.modelWithEffort, "gemini-3.8-flash-high:low");
  assert.equal(seeing.fallback.excluded.length, 2, "not in the allowed list and below the floor");
  // Only missing the floor beats a capable candidate excluded for another reason.
  const floorOnly = selectBestRoute(visualProfile, {
    objective: visualPrompt,
    candidateModels: ["gpt-6-astra:high", "gemini-3.8-flash-high:low"],
    catalog: { routes: { ...CANONICAL_ROUTES, [kind]: { ...CANONICAL_ROUTES[kind], restrict_models: true, preferred: ["gemini-3.8-flash-high"] } } },
    fallbackToBestExcluded: true,
  });
  assert.equal(floorOnly.modelWithEffort, "gemini-3.8-flash-high:low");
  // With no model that can see it, the request still goes somewhere, to the most capable one.
  assert.equal(routedVisual(["claude-fable-5-1:high", "grok-4.7:high"]), "claude-fable-5-1:high");

  const visualCtx = { protocol: "chat", agent: "claude-code", options: { scorerType: "heuristic", candidateModels: ["claude-fable-5-1:high", "gemini-3.8-flash-high:low"] }, state: {}, report() {} };
  await hookOnRequest(visualBody(), visualCtx);
  assert.equal(visualCtx.state.route?.targetModel, "gemini-3.8-flash-high");
});
