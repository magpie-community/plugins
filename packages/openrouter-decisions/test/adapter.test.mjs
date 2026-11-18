import assert from "node:assert/strict";
import test from "node:test";
import { createDecisionFetch, fromOpenRouterResponse, MODELS, toOpenRouterRequest } from "../adapter.mjs";

const UPSTREAM_MODEL = MODELS["microsoft-decision-1.1"].upstream;

const body = () => ({
  model: "microsoft-decision-1.1",
  state: { message: "What does HTTP 404 mean?", previous_message_kind: "question" },
  questions: {
    intent: { type: "choice", instructions: "Which task?", criteria: { question: "Explain a fact", edit: null } },
    effort: { type: "score", instructions: "How hard?", criteria: ["Little work", "Some work", "Much work", "Most work"] },
    levels: { type: "noul", instructions: "Are these kinds levels of one scale?" },
  },
});

const reply = () => ({
  id: "gen-dec-test",
  model: UPSTREAM_MODEL,
  provider: "Microsoft",
  usage: { input_tokens: 42, output_tokens: 0, cost: 0.0000018 },
  answers: {
    levels: { type: "noul", noul: 0.9, confidence: 0.9 },
    intent: { type: "choice", choice: "question", confidence: 0.8, probabilities: { question: 0.9, edit: 0.1 } },
    effort: { type: "score", score: 1.84, confidence: 0.85, probabilities: { 0: 0.01, 1: 0.14, 2: 0.85, 3: 0 } },
  },
});

test("serves both Microsoft decision models and maps the upstream slug", () => {
  for (const id of Object.keys(MODELS)) {
    const out = toOpenRouterRequest({ ...body(), model: id });
    assert.equal(out.model, MODELS[id].upstream);
  }
  assert.throws(() => toOpenRouterRequest({ ...body(), model: "microsoft-decision-9" }));
});

test("maps the System One request onto the OpenRouter Decisions request", () => {
  const out = toOpenRouterRequest(body());
  assert.equal(out.model, UPSTREAM_MODEL);
  assert.equal(typeof out.state, "string");
  assert.deepEqual(JSON.parse(out.state), body().state);
  assert.deepEqual(out.questions.intent, { type: "choice", instructions: "Which task?", criteria: { question: "Explain a fact", edit: "edit" } });
  assert.deepEqual(out.questions.effort.criteria, ["Little work", "Some work", "Much work", "Most work"]);
  assert.deepEqual(out.questions.levels, { type: "noul", instructions: "Are these kinds levels of one scale?" });
});

test("passes text state through and expands the choices shorthand", () => {
  const out = toOpenRouterRequest({ model: "microsoft-decision-1.1", state: "hello", questions: { intent: { type: "choice", instructions: "Kind?", choices: ["question", "edit"] } } });
  assert.equal(out.state, "hello");
  assert.deepEqual(out.questions.intent.criteria, { question: "question", edit: "edit" });
});

test("keeps multimodal state parts as an array of strings", () => {
  const state = ["Look:", { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } }];
  const out = toOpenRouterRequest({ ...body(), state });
  assert.equal(Array.isArray(out.state), true);
  assert.equal(out.state[0], "Look:");
  assert.deepEqual(JSON.parse(out.state[1]), state[1]);
});

test("supplies fallback instructions and keeps predicate definitions", () => {
  const source = body();
  for (const question of Object.values(source.questions)) question.instructions = "  ";
  source.questions.levels.criteria = { true: "Matches", false: "Does not match" };
  const out = toOpenRouterRequest(source);
  for (const question of Object.values(out.questions)) assert.ok(question.instructions.trim().length > 0);
  assert.deepEqual(out.questions.levels.criteria, { true: "Matches", false: "Does not match" });
});

test("restores probabilities, confidence, legend and usage", () => {
  const out = fromOpenRouterResponse(reply(), body());
  assert.equal(out.answers.intent.choice, "question");
  assert.deepEqual(out.answers.intent.probabilities, { question: 0.9, edit: 0.1 });
  assert.equal(out.answers.effort.score, 1.84);
  assert.deepEqual(out.answers.effort.probabilities, { 0: 0.01, 1: 0.14, 2: 0.85, 3: 0 });
  assert.deepEqual(out.answers.levels, { type: "noul", noul: 0.9 });
  assert.deepEqual(out.usage, reply().usage);
});

test("a per-question refusal stays a refusal", () => {
  const upstream = reply();
  upstream.answers.intent = { type: "refusal" };
  const out = fromOpenRouterResponse(upstream, body());
  assert.deepEqual(out.answers.intent, { type: "refusal" });
  assert.equal(out.answers.effort.score, 1.84);
});

test("rejects unsupported requests before calling upstream", () => {
  for (const source of [
    { ...body(), stream: true },
    { ...body(), model: "typesafe/jev-1.14" },
    { ...body(), questions: {} },
    { ...body(), questions: { x: { type: "text", instructions: "Explain" } } },
    { ...body(), questions: { x: { type: "choice", instructions: "Kind?", criteria: { only: null } } } },
    { ...body(), questions: { x: { ...body().questions.intent, choices: ["a", "b"] } } },
    { ...body(), questions: { x: { type: "noul", criteria: { other: "x" } } } },
  ]) assert.throws(() => toOpenRouterRequest(source));
});

test("rejects missing, wrong-type and malformed answers", () => {
  for (const mutate of [
    (r) => delete r.answers.intent,
    (r) => { r.answers.intent.type = "noul"; },
    (r) => { r.answers.intent.choice = "unknown"; },
    (r) => { r.answers.intent.probabilities = { question: 1 }; },
    (r) => { r.answers.intent.probabilities = { question: 0.5, edit: 0.4 }; },
    (r) => { r.answers.intent.confidence = 2; },
    (r) => { r.answers.effort.score = 9; },
    (r) => { r.answers.levels.noul = -0.1; },
  ]) {
    const upstream = reply();
    mutate(upstream);
    assert.throws(() => fromOpenRouterResponse(upstream, body()));
  }
});

test("fetch posts to the fixed Decisions URL with the current key only", async () => {
  let call;
  const fetcher = createDecisionFetch({ getKey: () => "sk-or-fixture", fetchImpl: async (url, init) => { call = { url, init }; return Response.json(reply(), { headers: { "x-request-id": "req-test", "set-cookie": "no" } }); } });
  const response = await fetcher("https://openrouter.ai/api/v1/systemone", { method: "POST", headers: { authorization: "Bearer gateway-key", "x-magpie-private": "no" }, body: JSON.stringify(body()) });
  assert.equal(response.status, 200);
  assert.equal(call.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers.get("authorization"), "Bearer sk-or-fixture");
  assert.equal(call.init.headers.has("x-magpie-private"), false);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(response.headers.get("x-request-id"), "req-test");
  assert.equal((await response.json()).answers.intent.choice, "question");
});

test("does not send malformed requests or arbitrary endpoints upstream", async () => {
  let sent = 0;
  const fetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async () => { sent++; throw Error("should not send"); } });
  for (const [url, init] of [
    ["https://elsewhere.example/v1/systemone", { method: "POST", body: JSON.stringify(body()) }],
    ["https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: JSON.stringify(body()) }],
    ["https://openrouter.ai/api/v1/systemone", { method: "GET" }],
    ["https://openrouter.ai/api/v1/systemone", { method: "POST", body: "nope" }],
  ]) assert.equal((await fetcher(url, init)).status, 400);
  assert.equal(sent, 0);
});

test("missing credentials become 503 and never reach upstream", async () => {
  let sent = 0;
  const fetcher = createDecisionFetch({ getKey: async () => undefined, fetchImpl: async () => { sent++; return Response.json({}); } });
  assert.equal((await fetcher("https://openrouter.ai/api/v1/systemone", { method: "POST", body: JSON.stringify(body()) })).status, 503);
  assert.equal(sent, 0);
});

test("preserves upstream error status, body and retry headers", async () => {
  for (const status of [401, 429, 503]) {
    const raw = JSON.stringify({ error: { message: "upstream refused" } });
    const fetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async () => new Response(raw, { status, headers: { "retry-after": "5", "content-type": "application/json" } }) });
    const response = await fetcher("https://openrouter.ai/api/v1/systemone", { method: "POST", body: JSON.stringify(body()) });
    assert.equal(response.status, status);
    assert.equal(await response.text(), raw);
    assert.equal(response.headers.get("retry-after"), "5");
  }
});

test("a transient network failure is retried once, an HTTP error is not", async () => {
  let calls = 0;
  const retryFetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async () => { calls++; if (calls === 1) throw new Error("socket hang up"); return Response.json(reply()); } });
  const ok = await retryFetcher("https://openrouter.ai/api/v1/systemone", { method: "POST", body: JSON.stringify(body()) });
  assert.equal(ok.status, 200);
  assert.equal(calls, 2);
  const noRetryFetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async () => { calls++; return new Response("{}", { status: 503 }); } });
  const refused = await noRetryFetcher("https://openrouter.ai/api/v1/systemone", { method: "POST", body: JSON.stringify(body()) });
  assert.equal(refused.status, 503);
  assert.equal(calls, 3);
  const giveUpFetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  const failed = await giveUpFetcher("https://openrouter.ai/api/v1/systemone", { method: "POST", body: JSON.stringify(body()) });
  assert.equal(failed.status, 502);
  assert.match(JSON.stringify(await failed.json()), /ECONNREFUSED/);
});

test("an incomplete upstream success becomes 502", async () => {
  const fetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async () => Response.json({ model: UPSTREAM_MODEL, answers: {} }) });
  assert.equal((await fetcher("https://openrouter.ai/api/v1/systemone", { method: "POST", body: JSON.stringify(body()) })).status, 502);
});

test("cancellation reaches upstream", async () => {
  const controller = new AbortController();
  const fetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async (_url, init) => { assert.equal(init.signal.aborted, false); controller.abort(); init.signal.throwIfAborted(); } });
  await assert.rejects(fetcher("https://openrouter.ai/api/v1/systemone", { method: "POST", signal: controller.signal, body: JSON.stringify(body()) }), { name: "AbortError" });
});
