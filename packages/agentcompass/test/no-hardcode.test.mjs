/**
 * The highest rule: "这个工具强依赖分类模型的智力 不要做任何硬编码的分类操作". A route comes from the classifier's structured
 * answer or the caller's, never from the words of a task; without an answer a request is not routed.
 *   - The corpus tests send every text of test/task_text_corpus.mjs with the same answer and require the same route.
 *   - The scan below reads `src/` for anything that looks into a task's text, so that a new rule fails until it is written down.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { selectBestRoute } from "../src/allocator.js";
import { SessionContinuityStore, evaluateProviderContinuation } from "../src/continuity.js";
import { onRequest as hookOnRequest, onResponse as hookOnResponse } from "../src/hooks.js";
import { handleSystemOneRequest } from "../src/index.js";
import { onProvider, onRequest as mwOnRequest, onResponse as mwOnResponse } from "../src/middleware.js";
import { UNROUTED_NOTICE, extractRequestFacts } from "../src/profiler-core.js";
import { clearProfileCache } from "../src/scorer-live.js";
import { profile } from "./profile.mjs";
import { BASE_TASK, KEYWORD_CORPUS } from "./task_text_corpus.mjs";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const NOW = 1790000000000;
const POOL = ["claude-opus-5-5", "gpt-6-astra", "gpt-6.1-sol", "claude-sonnet-5-5", "gemini-3.8-flash-high", "gemini-4-argon-high", "grok-4.7"];

const PROFILES = {
  routine: profile({ work_kind: "bounded_bulk_work", reasoning_depth: 1, code_complexity: 1, expected_hours: 0.4, axis_demand: { divergence: 0, coding: 1 } }),
  coupled: profile({
    work_kind: "debug_review",
    reasoning_depth: 3,
    code_complexity: 0,
    access: "read-only",
    read_only_review: true,
    local_only: true,
    expected_hours: 2,
    hours_confidence: "high",
    axis_demand: { divergence: 2, coding: 3 },
  }),
};

const quiet = (t) => t.mock.method(console, "warn", () => {});
const requestOf = (text, extra = {}) => ({ model: "agentcompass/auto", messages: [{ role: "user", content: text }], ...extra });

function classifierThatSays(profile, seen = []) {
  return {
    allowExternalScorer: true,
    scorerType: "openai_compatible",
    scorerBaseUrl: "http://127.0.0.1:9999/v1",
    useCache: false,
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(profile) } }] }), { status: 200 });
    },
  };
}
const brokenClassifier = {
  allowExternalScorer: true,
  scorerType: "openai_compatible",
  scorerBaseUrl: "http://127.0.0.1:9999/v1",
  useCache: false,
  fetch: async () => new Response("no", { status: 500 }),
};

const routeOf = (route) => ({
  targetModel: route?.targetModel,
  targetEffort: route?.targetEffort,
  workKind: route?.workKind,
  difficulty: route?.difficulty,
  axisDemand: route?.axisDemand,
  score: route?.score,
  profile: route?.profile,
  why: route?.continuation?.why,
  held: route?.continuation?.held,
});

// ---------------------------------------------------------------------------------------------------------------------
// Rule 7: the same answer routes every wording alike
// ---------------------------------------------------------------------------------------------------------------------

for (const [name, profile] of Object.entries(PROFILES)) {
  test(`same answer, any wording: hooks route alike (${name})`, async () => {
    const run = async (text) => {
      const ctx = { state: {}, options: { ...classifierThatSays(profile), candidateModels: POOL, now: NOW, continuityStore: new SessionContinuityStore() } };
      await hookOnRequest(requestOf(text), ctx);
      return routeOf(ctx.state.route);
    };
    const base = await run(BASE_TASK);
    assert.ok(base.targetModel);
    for (const text of KEYWORD_CORPUS) assert.deepEqual(await run(text), base, text.slice(0, 80));
  });

  test(`same answer, any wording: middleware routes alike (${name})`, () => {
    const run = (text) => {
      const body = requestOf(text, { profile });
      mwOnRequest(body, { state: {}, options: { candidateModels: POOL, now: NOW, continuityStore: new SessionContinuityStore() } });
      assert.equal("profile" in body, false, "the profile stops at the gateway");
      return body.model;
    };
    const base = run(BASE_TASK);
    assert.match(base, /:/);
    for (const text of KEYWORD_CORPUS) assert.equal(run(text), base, text.slice(0, 80));
  });

  test(`same answer, any wording: the decision provider answers alike (${name})`, async () => {
    const questions = {
      intent: { type: "choice", criteria: { debug_review: "Debugging", bounded_bulk_work: "Bulk", "none of these": "None" } },
      effort: { type: "score", criteria: ["low", "medium", "high", "xhigh"] },
      work_kind: { type: "choice" },
      reasoning_depth: { type: "score" },
    };
    const run = async (text) => {
      const res = await handleSystemOneRequest({ state: { message: text }, questions }, { ...classifierThatSays(profile), candidateModels: POOL });
      return { answers: res.answers, target: res.agentcompass.targetModel, effort: res.agentcompass.targetEffort };
    };
    const base = await run(BASE_TASK);
    assert.equal(base.answers.intent.choice, profile.work_kind);
    for (const text of KEYWORD_CORPUS) assert.deepEqual(await run(text), base, text.slice(0, 80));
  });
}

test("any wording: a warm session is held or moved for the same reason, on later turns too", () => {
  const sessions = [
    { model: "claude-haiku-5-5", effort: "low", tokens: 5000, cached: true, updatedAt: NOW - 1000 },
    { model: "claude-opus-5-5", effort: "high", tokens: 100, requestTokens: 100, updatedAt: NOW - 1000 },
    { model: "grok-4.7", effort: "medium", tokens: 5000, cached: true, updatedAt: NOW - 1000 },
    { model: "gpt-6-luna", effort: "high", tokens: 300, updatedAt: NOW - 10 * 60 * 1000 },
  ];
  const decide = (text, session, affinityMode) => {
    const body = {
      model: "agentcompass/auto",
      estimated_input_tokens: 100,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "done" },
        { role: "user", content: text },
      ],
    };
    return evaluateProviderContinuation(extractRequestFacts(body, {}), session, { now: NOW, affinityMode });
  };
  for (const affinityMode of ["cache", "turn", "session", "strict"]) {
    for (const session of sessions) {
      const base = decide(BASE_TASK, session, affinityMode);
      for (const text of KEYWORD_CORPUS) assert.deepEqual(decide(text, session, affinityMode), base, text.slice(0, 80));
    }
  }
});

test("any wording: nothing structured in a request's facts changes with its text", () => {
  const WORDS_AND_THEIR_IDENTITY = ["objective", "turnText", "lastUserText", "firstWords", "sessionKey", "scannedChars"];
  const facts = (text) => {
    const out = { ...extractRequestFacts(requestOf(text, { estimated_input_tokens: 100 }), {}) };
    for (const key of WORDS_AND_THEIR_IDENTITY) delete out[key];
    return out;
  };
  const base = facts(BASE_TASK);
  assert.equal(base.hasVisualInput, false);
  assert.equal(base.hasComputerUse, false);
  for (const text of KEYWORD_CORPUS) assert.deepEqual(facts(text), base, text.slice(0, 80));
});

// ---------------------------------------------------------------------------------------------------------------------
// Rule 4: image input is a content part
// ---------------------------------------------------------------------------------------------------------------------

test("visual input comes from the request's content parts, never from words", () => {
  const worded = (text) => extractRequestFacts(requestOf(text), {}).hasVisualInput;
  for (const text of ["写一个上传图片 image 的接口", "Look at this screenshot", "把 figma 设计稿的 mockup 做 visual diff"]) {
    assert.equal(worded(text), false, text);
  }
  const parts = [
    { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    { type: "input_image", image_url: "https://example.com/a.png" },
    { type: "image", source: { media_type: "image/png", data: "AAAA" } },
    { inline_data: { mime_type: "image/png", data: "AAAA" } },
  ];
  for (const part of parts) {
    const body = { model: "x", messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, part] }] };
    assert.equal(extractRequestFacts(body, {}).hasVisualInput, true, JSON.stringify(part));
  }

  // A word doesn't exclude a blind model; an image part does, whatever the profile said
  const blind = ["grok-4.7"];
  const text = requestOf("Look at this screenshot", { profile: PROFILES.routine });
  mwOnRequest(text, { state: {}, options: { candidateModels: blind, now: NOW, continuityStore: new SessionContinuityStore() } });
  assert.match(text.model, /^grok-4\.7:/);
  const image = {
    model: "agentcompass/auto",
    profile: PROFILES.routine,
    messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, parts[0]] }],
  };
  const ctx = { state: {}, options: { candidateModels: POOL, now: NOW, continuityStore: new SessionContinuityStore() } };
  mwOnRequest(image, ctx);
  assert.equal(ctx.state.route.profile.needs_visual, true);
  assert.doesNotMatch(image.model, /^grok-4\.7/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Rule 3: no answer, no route
// ---------------------------------------------------------------------------------------------------------------------

test("no classifier and no profile: the middleware forwards the client's model and says why", (t) => {
  const warn = quiet(t);
  for (const text of [BASE_TASK, ...KEYWORD_CORPUS.slice(0, 40)]) {
    const store = new SessionContinuityStore();
    const body = requestOf(text);
    const ctx = { state: {}, options: { candidateModels: POOL, now: NOW, continuityStore: store } };
    assert.equal(mwOnRequest(body, ctx), undefined);
    assert.equal(body.model, "agentcompass/auto");
    assert.equal(ctx.state.route, undefined);
    assert.equal(ctx.state.agentcompass.routed, false);
    assert.equal(ctx.state.agentcompass.notice, UNROUTED_NOTICE);

    const reply = mwOnResponse({ id: "r1", model: "upstream-served", usage: { input_tokens: 5000 } }, ctx);
    assert.deepEqual(reply.agentcompass, { routed: false, notice: UNROUTED_NOTICE, reason: "no_task_profile" });
    assert.equal(store.sessions.size, 0, "an unrouted reply starts no session that later turns would hold");
  }
  assert.ok(warn.mock.calls.every((c) => c.arguments[0].includes(UNROUTED_NOTICE)));
  assert.ok(warn.mock.calls.length > 0);
});

test("no classifier: a concrete model on routeAllModels stays as the client asked, with no effort added", (t) => {
  quiet(t);
  const body = { model: "claude-sonnet-5-5", messages: [{ role: "user", content: BASE_TASK }] };
  const ctx = { protocol: "chat", state: {}, options: { routeAllModels: true, injectProtocolEffort: true, now: NOW, continuityStore: new SessionContinuityStore() } };
  assert.equal(mwOnRequest(body, ctx), undefined);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal("reasoning_effort" in body, false);
});

test("no classifier: a virtual name goes on as it is, or as the model the operator named for this", (t) => {
  quiet(t);
  const named = requestOf(BASE_TASK);
  const ctx = { state: {}, options: { candidateModels: POOL, defaultModel: "claude-sonnet-5-5", now: NOW, continuityStore: new SessionContinuityStore() } };
  assert.equal(mwOnRequest(named, ctx), named);
  assert.equal(named.model, "claude-sonnet-5-5");

  // The provider Magpie chose names its own model; no effort of ours comes with it
  const body = requestOf(BASE_TASK);
  const provided = { state: {}, options: { candidateModels: POOL, now: NOW, continuityStore: new SessionContinuityStore() } };
  mwOnRequest(body, provided);
  assert.equal(body.model, "agentcompass/auto");
  onProvider(body, { ...provided, provider: { id: "p", model: "claude-sonnet-5-5" } });
  assert.equal(body.model, "claude-sonnet-5-5");
});

test("the router's fields never reach the upstream when a request is not routed", (t) => {
  quiet(t);
  const body = requestOf(BASE_TASK, { needs: { gui: true }, profile: { work_kind: "other_or_mixed" } });
  const ctx = { state: {}, options: { candidateModels: POOL, now: NOW, continuityStore: new SessionContinuityStore() } };
  assert.equal(mwOnRequest(body, ctx), body);
  assert.equal("profile" in body, false);
  assert.equal("needs" in body, false);
});

test("a caller's invalid profile is not routed, not an error", (t) => {
  quiet(t);
  const body = requestOf(BASE_TASK, { profile: { work_kind: "nope", reasoning_depth: 2 } });
  const ctx = { state: {}, options: { candidateModels: POOL, now: NOW, continuityStore: new SessionContinuityStore() } };
  mwOnRequest(body, ctx);
  assert.equal(body.model, "agentcompass/auto");
  assert.match(ctx.state.agentcompass.reason, /^invalid_caller_profile/);
  assert.equal("profile" in body, false);
});

test("hooks: no classifier or a broken one leaves the request unrouted, and says why", async (t) => {
  const warn = quiet(t);
  clearProfileCache();
  for (const [options, reason] of [
    [{}, "no_classifier_configured"],
    [{ scorerType: "heuristic", scorerBaseUrl: "http://127.0.0.1:9999", allowExternalScorer: true }, "no_classifier_configured"],
    [{ prefer_local_heuristic: true }, "no_classifier_configured"],
    [brokenClassifier, "OpenAI-compatible scorer HTTP 500"],
  ]) {
    const store = new SessionContinuityStore();
    const body = requestOf(BASE_TASK);
    const reports = [];
    const ctx = { state: {}, report: (code) => reports.push(code), options: { ...options, candidateModels: POOL, now: NOW, continuityStore: store } };
    assert.equal(await hookOnRequest(body, ctx), undefined);
    assert.equal(body.model, "agentcompass/auto");
    assert.equal(ctx.state.route, undefined);
    assert.equal(ctx.state.agentcompass.routed, false);
    assert.equal(ctx.state.agentcompass.notice, UNROUTED_NOTICE);
    assert.equal(ctx.state.agentcompass.reason, reason);
    assert.deepEqual(reports, ["empty"]);
    await hookOnResponse({ model: "x", usage: { input_tokens: 5000 } }, ctx);
    assert.equal(store.sessions.size, 0);
  }
  assert.equal(warn.mock.calls.length, 4);
});

test("the decision provider: no classifier or a broken one answers none of these, with no effort, and says why", async (t) => {
  quiet(t);
  const questions = {
    intent: { type: "choice", criteria: { debug_review: "Debugging", "none of these": "None" } },
    level: { type: "choice", criteria: { routine: "Routine", none: "None" } },
    effort: { type: "score", criteria: ["low", "medium", "high", "xhigh"] },
    work_kind: { type: "choice" },
  };
  for (const [options, reason] of [
    [{}, "no_classifier_configured"],
    [brokenClassifier, "OpenAI-compatible scorer HTTP 500"],
  ]) {
    const res = await handleSystemOneRequest({ state: { message: "Fix the bug in foo.js" }, questions }, options);
    assert.equal(res.answers.intent.choice, "none of these");
    assert.ok(res.answers.intent.confidence >= 0.6, "clears Magpie's jevSure");
    assert.equal(res.answers.level.choice, "none");
    assert.equal(res.answers.effort, undefined);
    assert.equal(res.answers.work_kind, undefined);
    assert.equal(res.agentcompass.routed, false);
    assert.equal(res.agentcompass.notice, UNROUTED_NOTICE);
    assert.equal(res.agentcompass.reason, reason);
  }
});

test("the decision provider: the operator's own labels are the classifier's to read, and a label that names the route needs no call", async () => {
  const seen = [];
  const classifier = classifierThatSays(PROFILES.coupled, seen);
  const exact = await handleSystemOneRequest(
    { state: { message: "x" }, questions: { intent: { type: "choice", criteria: { "debug-review": "a", other: "b", "none of these": "c" } } } },
    { ...classifier, candidateModels: POOL },
  );
  assert.equal(exact.answers.intent.choice, "debug-review");
  assert.equal(seen.length, 1, "the profile call alone");

  // Words in a label or its description mean nothing here: the model is asked.
  seen.length = 0;
  const criteria = { "排查修复 debug bug fix review": "debug_review, code review", 代码: "implement", "none of these": "c" };
  const fetchAnswers = (choice) => async (_url, init) => {
    const request = JSON.parse(init.body);
    seen.push(request);
    const asked = JSON.parse(request.messages[1].content);
    const content = asked.questions ? { answers: { intent: { choice } } } : PROFILES.coupled;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  };
  const ask = (choice) =>
    handleSystemOneRequest({ state: { message: "x" }, questions: { intent: { type: "choice", criteria } } }, { ...classifier, fetch: fetchAnswers(choice), candidateModels: POOL });
  assert.equal((await ask("代码")).answers.intent.choice, "代码", "the model's choice, not the label's words");
  assert.equal(seen.length, 2);
  assert.equal((await ask("not a label")).answers.intent.choice, "none of these");
});

test("the levels probe: no table of words decides whether labels are a scale", async () => {
  const questions = { levels: { type: "noul" }, work0: { type: "score" }, work1: { type: "score" } };
  for (const kinds of [["简单", "复杂"], ["routine", "frontier"], ["frontend", "backend"]]) {
    const res = await handleSystemOneRequest({ state: { kinds }, questions });
    assert.ok(res.answers.levels.noul < 0.5, kinds.join());
    assert.deepEqual(Object.keys(res.answers), ["levels"]);
  }
});

test("allocator: nothing without a profile is ranked, whatever the task says", () => {
  for (const task of [{}, { objective: "Fix the bug in foo.js" }, { objective: "x", work_kind: "debug_review" }, { objective: "x", needs: { gui: true } }]) {
    const decision = selectBestRoute(task, { candidateModels: POOL, now: NOW });
    assert.equal(decision.ok, false);
    assert.equal(decision.routed, false);
    assert.equal(decision.targetModel, null);
    assert.equal(decision.notice, UNROUTED_NOTICE);
  }
});

test("the classifier hears the previous turn, so a turn that only continues it can be understood, and cache entries don't mix", async () => {
  clearProfileCache();
  const seen = [];
  const classifier = { ...classifierThatSays(PROFILES.coupled, seen), useCache: true };
  const turn = (previous) => ({
    model: "agentcompass/auto",
    messages: [{ role: "user", content: previous }, { role: "assistant", content: "ok" }, { role: "user", content: "继续" }],
  });
  for (const previous of ["Audit the lock manager", "Rename foo", "Rename foo"]) {
    await hookOnRequest(turn(previous), { state: {}, options: { ...classifier, candidateModels: POOL, now: NOW, continuityStore: new SessionContinuityStore() } });
  }
  assert.equal(seen.length, 2, "same previous turn: cached; another previous turn: asked again");
  assert.equal(JSON.parse(seen[0].messages[1].content).previous_user, "Audit the lock manager");
  assert.equal(JSON.parse(seen[1].messages[1].content).previous_user, "Rename foo");
});

// ---------------------------------------------------------------------------------------------------------------------
// Rule 6: the scan
// ---------------------------------------------------------------------------------------------------------------------

// The same length as the source, with comments and the inside of strings and regex literals blanked, so that prose is not
// read as code and a finding can quote the source. `${...}` stays code.
const REGEX_MAY_FOLLOW = new Set([..."(,=:[!&|?{};+-*%<>~^}"]);
function codeOf(src) {
  let out = "";
  let at = 0;
  let last = "";
  const blank = (from, to) => {
    out += src.slice(from, to).replace(/[^\n]/g, " ");
  };
  const script = (closer) => {
    let depth = 0;
    while (at < src.length) {
      const c = src[at];
      if (closer && c === "{") depth++;
      if (closer && c === "}" && depth-- === 0) return;
      if (c === "/" && src[at + 1] === "/") {
        const end = src.indexOf("\n", at) < 0 ? src.length : src.indexOf("\n", at);
        blank(at, end);
        at = end;
        continue;
      }
      if (c === "/" && src[at + 1] === "*") {
        const end = src.indexOf("*/", at) + 2;
        blank(at, end);
        at = end;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        out += c;
        at++;
        while (at < src.length && src[at] !== c) {
          if (c === "`" && src[at] === "$" && src[at + 1] === "{") {
            out += "${";
            at += 2;
            script("}");
            out += "}";
            at++;
            continue;
          }
          const step = src[at] === "\\" ? 2 : 1;
          blank(at, at + step);
          at += step;
        }
        out += c;
        at++;
        last = c;
        continue;
      }
      if (c === "/" && REGEX_MAY_FOLLOW.has(last)) {
        // the literal stays visible as `/ /` so a pass can tell there is one
        out += "/";
        at++;
        let inClass = false;
        while (at < src.length && (src[at] !== "/" || inClass)) {
          if (src[at] === "[") inClass = true;
          if (src[at] === "]") inClass = false;
          const step = src[at] === "\\" ? 2 : 1;
          blank(at, at + step);
          at += step;
        }
        out += "/";
        at++;
        last = "/";
        continue;
      }
      out += c;
      at++;
      if (c.trim()) last = c;
    }
  };
  script(null);
  return out;
}

// The usual names of a task's free text.
const TEXT_NAMES =
  "objective|effectiveObjective|effectivePrevUser|turnText|lastUserText|previousUser|previousUserText|previousAssistantText|prevUser|systemText|rawUserText|" +
  "userSaid|said|firstUserSaid|joinedText|collected|assistantText|rawText|cleaned|sample|reason|title|cwd";
const LOOKS_INTO = "test|exec|match|matchAll|search|includes|indexOf|lastIndexOf|startsWith|endsWith|split|replace|replaceAll|toLowerCase|toUpperCase|localeCompare|length";
// `objective.includes(`, `x.objective?.toLowerCase`, `lastUserText.length`
const NAME_LOOKED_INTO = new RegExp(`\\b(?:${TEXT_NAMES})\\b\\s*\\??\\.\\s*(?:${LOOKS_INTO})\\b`, "g");
// `/re/.test(objective)`, `WORDS.includes(lastUserText)`, `String(objective)`-style reads of the text as an argument of a look
const NAME_AS_ARGUMENT = new RegExp(`\\.\\s*(?:test|exec|match|matchAll|search|includes|indexOf|startsWith|endsWith)\\s*\\([^()]*\\b(?:${TEXT_NAMES})\\b`, "g");
// `objective in TABLE`, `TABLE[objective]`, `objective === "literal"`
const NAME_AS_KEY = new RegExp(`\\b(?:${TEXT_NAMES})\\b\\s+in\\s|\\[\\s*(?:${TEXT_NAMES})\\s*\\]|(?<!\\btypeof\\s+[\\w.?]*)\\b(?:${TEXT_NAMES})\\b\\s*(?:===|!==|==|!=)\\s*["'\`]`, "g");
// Every look that can read a string in the files a task's text passes through, on whatever it is called.
const ANY_LOOK = /\.\s*(?:test|exec|match|matchAll|search|includes|indexOf|lastIndexOf|startsWith|endsWith)\s*\(|\bRegExp\s*\(|\bnew\s+Set\s*\(/g;

// Files that hold model names, quota windows and paths, and never meet a task's text: the last test below holds them to that.
const NO_TASK_TEXT_FILES = {
  "allocator.js": "ranks a task profile against model names; takes no text",
  "catalog.js": "model names and the routing table; takes model names only",
  "quota.js": "subscription windows and seats; takes model and account names only",
  "quota-loader.js": "reads a quota file named in the plugin options",
  "axis-scores.js": "category scores, targets and the fit over them: numbers and model names only",
  "candidate-eval.js": "scores one bundle against a task profile's structured fields: model, effort and window names only",
  "candidate-ranking.js": "orders scored candidates: numbers only",
  "fleet.js": "turns a pool of model names and quota entries into accounts and bundles",
  "plans.js": "plan names and window ids of subscriptions",
  "quota-economy.js": "prices a window's spend: numbers and window ids",
  "quota-pools.js": "quota pools, windows and reset times",
  "reference-data.js": "generated from the pinned AgentCompass data: scores, plan capacity, tables",
  "user-scores.js": "the user's own category scores for a model, as typed in the settings",
};

// Everything the two passes find, by its exact text, with why it is not a look at a task's meaning. A new look fails until it is here.
const EXCEPTIONS = [
  {
    why:
      "the harness's envelope, not the task (stripAgentNoise): takes out the reminders coding agents inject into user messages, so a turn holding only those " +
      "is no user turn (Magpie's `user_said_test.go`), and the classifier isn't handed them. It reads no meaning into what the user asked",
    sites: [
      "continuity.js: rawText.length",
      "continuity.js: cleaned.includes",
      'continuity.js: cleaned.includes("<")',
      "continuity.js: cleaned.replace",
      "continuity.js: cleaned .split",
      "continuity.js: .test(cleaned",
      "continuity.js: PARAGRAPH_NOISE_FAST_RE.test(cleaned)",
      "continuity.js: re.test(block)",
    ],
  },
  {
    why: "the size of a request, to bound the work on a long body and to estimate tokens (chars / 4) for the context window and cache. It says nothing about what the task is",
    sites: ["continuity.js: collected.length", "continuity.js: joinedText.length", "index.js: turnText.length"],
  },
  {
    why: "the protocol's own marker for an image or video part (rule 4)",
    sites: ['continuity.js: mime.startsWith("image/")', 'continuity.js: mime.startsWith("video/")'],
  },
  {
    why: "model, provider and effort names (rule 4): cache lifetime by provider, effort suffixes, candidate pools, the router's virtual names",
    sites: [
      'continuity.js: lower.includes("chatgpt")',
      'continuity.js: lower.includes("codex")',
      'continuity.js: lower.includes("gpt-6.1-sol")',
      'continuity.js: lower.includes("gpt-6-sol")',
      'continuity.js: lower.includes("deepseek")',
      "continuity.js: allowedEfforts.includes(candidateEffort)",
      'continuity.js: allowedEfforts.includes("xhigh")',
      'continuity.js: allowedEfforts.includes("max")',
      "continuity.js: candidateKeys.includes(running)",
      "continuity.js: new Set(",
      'hooks.js: trimmed.lastIndexOf(":")',
      'hooks.js: "auto"].includes(suffix)',
      'hooks.js: clean.startsWith("agentcompass/")',
      "hooks.js: return DEFAULT_VIRTUAL_MODELS.includes(clean)",
      'middleware.js: trimmed.lastIndexOf(":")',
      'middleware.js: "auto"].includes(suffix)',
      'middleware.js: clean.startsWith("agentcompass/")',
      "middleware.js: return DEFAULT_VIRTUAL_MODELS.includes(clean)",
      'middleware.js: mappedModel.includes("/")',
      'middleware.js: targetModel.includes(":")',
    ],
  },
  {
    why: "the router's own keys, made here: a session key's separator, a turn's stamp, an account's identifiers from Magpie",
    sites: ['continuity.js: sessionKey.includes("\\x00")', "middleware.js: chain.accepts.includes(sessionState.anchor)", "middleware.js: allowedByKind.includes(id)"],
  },
  {
    why: "the classifier's reply and the endpoints in the options: parsing what the model already answered, and which URL to call",
    sites: [
      'scorer-live.js: trimmed.indexOf("{")',
      'scorer-live.js: trimmed.lastIndexOf("}")',
      'scorer-live.js: baseUrl.endsWith("/v1/systemone")',
      'scorer-live.js: baseUrl.endsWith("/chat/completions")',
      'scorer-live.js: baseUrl.endsWith("/v1")',
      'index.js: .endsWith("/systemone")',
    ],
  },
  {
    why: "the schema's enums on a profile's structured fields, and whether the classifier's choice is one of the question's keys: no word of a label means anything by itself",
    sites: [
      "index.js: choices.includes(choice)",
      "profiler-core.js: TASK_COUNTS.includes(value)",
      "profiler-core.js: PROFILE_KINDS.includes(raw.work_kind)",
      "profiler-core.js: ACCESS_LEVELS.includes(raw.access)",
      "profiler-core.js: levels.includes(raw[name])",
      "profiler-core.js: INTERACTION_STYLES.includes(raw.interaction_style)",
      "task-intake.js: return PROFILE_KINDS.includes(named)",
      "task-intake.js: GENERIC_CALLER_KINDS.includes(caller)",
      "task-intake.js: DIFFICULTY_ORDER.includes(difficulty)",
      "task-intake.js: COUPLINGS.includes(coupling)",
      "task-intake.js: DIRECT_SOURCES.includes(resolved.source)",
    ],
  },
];

function scanFindings() {
  const findings = new Set();
  const report = (file, text) => findings.add(`${file}: ${text.replace(/\s+/g, " ").trim()}`);
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    const code = codeOf(src);
    assert.equal(code.length, src.length, file);
    for (const re of [NAME_LOOKED_INTO, NAME_AS_ARGUMENT, NAME_AS_KEY]) {
      for (const m of code.matchAll(re)) report(file, src.slice(m.index, m.index + m[0].length));
    }
    if (file in NO_TASK_TEXT_FILES) continue;
    for (const m of code.matchAll(ANY_LOOK)) {
      // quoted from its receiver to the end of its first bracket on the line
      const lineStart = code.lastIndexOf("\n", m.index) + 1;
      const lineEnd = code.indexOf("\n", m.index);
      const receiver = code.slice(lineStart, m.index).match(/[\w$.?\[\]"'`/ -]*$/)?.[0].trimStart() || "";
      const close = code.slice(m.index, lineEnd).indexOf(")");
      report(file, src.slice(m.index - receiver.length, close >= 0 ? m.index + close + 1 : m.index + m[0].length));
    }
  }
  return findings;
}

test("static scan: nothing in src/ looks into a task's text, and each look that remains says why it may", () => {
  const claimed = new Set(EXCEPTIONS.flatMap((e) => e.sites));
  assert.deepEqual([...scanFindings()].filter((f) => !claimed.has(f)), [], "a look at a string with no reason written down in EXCEPTIONS");
});

test("static scan: every exception still has something to excuse, so the list can't outlive the code", () => {
  const findings = scanFindings();
  assert.deepEqual(EXCEPTIONS.flatMap((e) => e.sites).filter((site) => !findings.has(site)), []);
});

test("static scan: it does find the rules it is there to find", () => {
  const find = (src) => {
    const code = codeOf(src);
    return [NAME_LOOKED_INTO, NAME_AS_ARGUMENT, NAME_AS_KEY].flatMap((re) => [...code.matchAll(re)].map((m) => m[0]));
  };
  for (const rule of [
    'if (objective.includes("review")) return 1;',
    'const hit = /brainstorm|头脑风暴/i.test(facts.objective);',
    "const wide = task.objective?.toLowerCase();",
    "const long = turnText.length >= 260;",
    "WORDS.includes(lastUserText);",
    "const kind = TABLE[objective];",
    'if (profile.reason === "review") return 1;',
    "const marks = lastUserText.match(RE);",
    'const named = title.startsWith("Review");',
  ]) {
    assert.ok(find(rule).length > 0, rule);
  }
  // Under another name the second pass still sees it, in any file a task's text passes through
  assert.ok([...codeOf('const t = String(facts.objective).toLowerCase(); t.includes("review");').matchAll(ANY_LOOK)].length > 0);
  // Prose and a prompt's text are not code
  for (const prose of ['// objective.includes("x")', 'const q = "objective.includes(x)";', "/* turnText.length */"]) {
    assert.deepEqual(find(prose), [], prose);
  }
});

test("static scan: the removed classifiers stay removed, and the model-name files don't meet a task's text", () => {
  const REMOVED =
    /\b(?:inferTaskProfile|profileTask|inferKindFromObjective|isReadonlyReviewTask|inferDivergence|inferReasoningDepth|multiTaskMarks|capProfileText|isShortFollowupMessage|isCompactionText|detectTierEscalationOutgrowth|evaluateLevelsProbe|DIFFICULTY_SCALE_WORDS|COMPUTER_USE_PHRASES|GUI_WORDS|DIVERGENT_WORDS|READONLY_REVIEW_PHRASES|COUPLED_SIGNALS|FRONTIER_SIGNALS|CODE_FILE_RE|LOCAL_MACHINE_RE|OBJECTIVE_LOCAL_RUNTIME_RE|MULTI_TASK_MARK_RE|TRIVIAL_MECHANICAL_EDIT_RE|prefer_local_heuristic)\b/;
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".js"))) {
    assert.equal(REMOVED.exec(codeOf(fs.readFileSync(path.join(SRC, file), "utf8")))?.[0], undefined, file);
  }
  for (const file of Object.keys(NO_TASK_TEXT_FILES)) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    assert.doesNotMatch(src, /from "\.\/(?:continuity|scorer-live|hooks|middleware|index)\.js"/, file);
    // Validating a profile and the unrouted notice are all these take from the profiler: no task's text gets that far.
    assert.doesNotMatch(src.replace(/import \{ (?:PROFILE_KINDS, validateProfile|unroutedDecision) \} from "\.\/profiler-core\.js";/, ""), /from "\.\/profiler-core\.js"/, file);
    assert.doesNotMatch(codeOf(src), /\b(?:objective|turnText|lastUserText|userSaid|previousUser)\b/, file);
  }
  for (const file of ["hooks.js", "middleware.js", "index.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(SRC, file), "utf8"), /selectBestRoute\([^)]*objective/s, file);
  }
});
