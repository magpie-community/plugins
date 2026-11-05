import assert from "node:assert/strict";
import test from "node:test";
import { createDecisionFetch, fromOpenAIResponse, toOpenAIRequest } from "../adapter.mjs";

const body = () => ({
  model: "gpt-6-luna",
  state: { message: "What does HTTP 404 mean?", previous_message_kind: "question" },
  questions: {
    intent: { type: "choice", instructions: "Which task?", criteria: { question: "Explain a fact", edit: null } },
    effort: { type: "score", instructions: "How hard?", criteria: ["Little work", "Some work", "Much work", "Most work"] },
    levels: { type: "noul", instructions: "Are these kinds levels of one scale?" },
  },
});

const reply = () => ({
  id: "decision-test", model: "gpt-6-luna", usage: { input_tokens: 42, output_tokens: 0 },
  answers: [
    { name: "levels", type: "predicate", probability: 0.9 },
    { name: "intent", type: "choice", choice: "question", confidence: 0.8, probabilities: [{ value: "question", probability: 0.9 }, { value: "edit", probability: 0.1 }] },
    { name: "effort", type: "score", score: 0.6, confidence: 0.3, probabilities: [0.6, 0.2, 0.2, 0].map((probability, value) => ({ value, label: String(value), probability })) },
  ],
});

test("converts JSON evidence and all three native classifier questions", () => {
  const source = body();
  const out = toOpenAIRequest(source);
  assert.equal(out.model, "gpt-6-luna");
  assert.deepEqual(out.input, [{ role: "user", content: [{ type: "input_json", data: source.state }] }]);
  assert.deepEqual(out.questions[0], { name: "intent", type: "choice", instructions: "Which task?", choices: [{ value: "question", description: "Explain a fact" }, { value: "edit" }] });
  assert.deepEqual(out.questions[1].levels, source.questions.effort.criteria.map((description, index) => ({ label: String(index), description })));
  assert.deepEqual(out.questions[2], { name: "levels", type: "predicate", instructions: source.questions.levels.instructions });
  assert.equal(source.questions.levels.type, "noul");
});

test("accepts text evidence and Magpie's documented choices shorthand", () => {
  const source = { model: "gpt-6-luna", state: "hello", questions: { intent: { type: "choice", instructions: "Kind?", choices: ["question", "edit"] } } };
  assert.equal(toOpenAIRequest(source).input, "hello");
  assert.deepEqual(toOpenAIRequest(source).questions[0].choices, [{ value: "question" }, { value: "edit" }]);
});

test("numeric and boolean System One state use text instead of an invalid input_json scalar", () => {
  for (const state of [42, true, false]) {
    assert.equal(toOpenAIRequest({ ...body(), state }).input, JSON.stringify(state));
  }
});

test("retains structured instructions and criteria, including predicate definitions", () => {
  const source = { model: "gpt-6-luna", state: [1, 2], questions: {
    kind: { type: "choice", instructions: { question: "Which?", record: { id: 1 } }, criteria: { first: { examples: [1] }, other: null } },
    yes: { type: "noul", instructions: "Does this match?", criteria: { true: { rule: "positive" }, false: "negative" } },
    rating: { type: "score", criteria: [1, { label: "higher" }, null] },
  } };
  const out = toOpenAIRequest(source);
  assert.deepEqual(JSON.parse(out.questions[0].instructions), source.questions.kind.instructions);
  assert.deepEqual(JSON.parse(out.questions[0].choices[0].description), { examples: [1] });
  assert.deepEqual(JSON.parse(out.questions[1].instructions), { instructions: "Does this match?", criteria: source.questions.yes.criteria });
  assert.deepEqual(out.questions[2].levels, [{ label: "0", description: "1" }, { label: "1", description: '{"label":"higher"}' }, { label: "2" }]);
});

test("restores named answers independent of order and preserves probabilities, confidence and usage", () => {
  const out = fromOpenAIResponse(reply(), body());
  assert.equal(out.answers.intent.choice, "question");
  assert.deepEqual(out.answers.intent.probabilities, { question: 0.9, edit: 0.1 });
  assert.equal(out.answers.intent.confidence, 0.8);
  assert.equal(out.answers.effort.score, 0.6);
  assert.deepEqual(out.answers.effort.probabilities, { 0: 0.6, 1: 0.2, 2: 0.2, 3: 0 });
  assert.deepEqual(out.answers.levels, { type: "noul", noul: 0.9 });
  assert.deepEqual(out.usage, { input_tokens: 42, output_tokens: 0 });
  assert.equal(out.id, "decision-test");
});

test("does not treat prototype-named choices or question IDs as object properties", () => {
  const source = JSON.parse('{"model":"gpt-6-luna","state":"hello","questions":{"__proto__":{"type":"choice","instructions":"Kind?","criteria":{"__proto__":null,"constructor":null}}}}');
  const out = fromOpenAIResponse({ model: "gpt-6-luna", answers: [{ name: "__proto__", type: "choice", choice: "__proto__", confidence: 1, probabilities: [{ value: "__proto__", probability: 1 }, { value: "constructor", probability: 0 }] }] }, source);
  assert.equal(Object.hasOwn(out.answers, "__proto__"), true);
  assert.equal(Object.hasOwn(out.answers.__proto__.probabilities, "__proto__"), true);
});

test("rejects unsupported fields and question types before requesting the upstream", () => {
  for (const source of [
    { ...body(), stream: true },
    { ...body(), model: "another-model" },
    { ...body(), questions: {} },
    { ...body(), questions: { x: { type: "text", instructions: "Explain" } } },
    { ...body(), questions: { x: { type: "choice", instructions: "Kind?", criteria: { only: null } } } },
    { ...body(), questions: { x: { ...body().questions.intent, choices: ["question", "edit"] } } },
    { ...body(), questions: { x: { ...body().questions.intent, temperature: 0 } } },
    { ...body(), questions: { x: { type: "noul", criteria: { other: "not a boolean definition" } } } },
  ]) assert.throws(() => toOpenAIRequest(source));
});

test("rejects missing, duplicate, wrong-type and unrequested answers", () => {
  for (const mutate of [
    (r) => r.answers.pop(),
    (r) => r.answers.push(r.answers[0]),
    (r) => { r.answers[0].name = "unexpected"; },
    (r) => { r.answers[0].type = "choice"; },
  ]) {
    const upstream = reply();
    mutate(upstream);
    assert.throws(() => fromOpenAIResponse(upstream, body()));
  }
});

test("rejects invalid or incomplete probability distributions and invalid scores", () => {
  for (const mutate of [
    (r) => { r.answers[1].probabilities[0].probability = NaN; },
    (r) => { r.answers[1].probabilities[0].probability = 1.1; },
    (r) => r.answers[1].probabilities.pop(),
    (r) => { r.answers[1].probabilities[1].value = "question"; },
    (r) => { r.answers[1].probabilities[0].probability = 0.1; },
    (r) => { r.answers[1].choice = "unknown"; },
    (r) => { r.answers[1].confidence = -1; },
    (r) => { r.answers[2].score = 4; },
    (r) => { r.answers[0].probability = -0.1; },
  ]) {
    const upstream = reply();
    mutate(upstream);
    assert.throws(() => fromOpenAIResponse(upstream, body()));
  }
});

test("fetch uses the fixed Decisions URL, current key and a fresh header set", async () => {
  let call;
  const fetcher = createDecisionFetch({ getKey: () => "fixture-upstream-key", fetchImpl: async (url, init) => { call = { url, init }; return Response.json(reply(), { headers: { "x-request-id": "req-test", "set-cookie": "not-forwarded" } }); } });
  const response = await fetcher("https://api.openai.com/v1/systemone", { method: "POST", headers: { authorization: "Bearer local-gateway-key", "x-magpie-private": "not-forwarded" }, body: JSON.stringify(body()) });
  assert.equal(response.status, 200);
  assert.equal(call.url, "https://api.openai.com/v1/decisions");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers.get("authorization"), "Bearer fixture-upstream-key");
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
    ["https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify(body()) }],
    ["https://api.openai.com/v1/systemone?upstream=elsewhere", { method: "POST", body: JSON.stringify(body()) }],
    ["https://api.openai.com/v1/systemone", { method: "GET" }],
    ["https://api.openai.com/v1/systemone", { method: "POST", body: "invalid-json" }],
  ]) assert.equal((await fetcher(url, init)).status, 400);
  assert.equal(sent, 0);
});

test("preserves upstream 401/429/503 status, error body and retry headers", async () => {
  for (const status of [401, 429, 503]) {
    const raw = JSON.stringify({ error: { message: "Upstream refused this request" } });
    const fetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async () => new Response(raw, { status, headers: { "retry-after": "5", "content-type": "application/json" } }) });
    const response = await fetcher("https://api.openai.com/v1/systemone", { method: "POST", body: JSON.stringify(body()) });
    assert.equal(response.status, status);
    assert.equal(await response.text(), raw);
    assert.equal(response.headers.get("retry-after"), "5");
  }
});

test("an incomplete successful upstream response becomes 502", async () => {
  const fetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async () => Response.json({ model: "gpt-6-luna", answers: [] }) });
  assert.equal((await fetcher("https://api.openai.com/v1/systemone", { method: "POST", body: JSON.stringify(body()) })).status, 502);
});

test("cancellation reaches the upstream without retries or a manufactured answer", async () => {
  const controller = new AbortController();
  const fetcher = createDecisionFetch({ getKey: () => "fixture", fetchImpl: async (_url, init) => { assert.equal(init.signal.aborted, false); controller.abort(); init.signal.throwIfAborted(); } });
  await assert.rejects(fetcher("https://api.openai.com/v1/systemone", { method: "POST", signal: controller.signal, body: JSON.stringify(body()) }), { name: "AbortError" });
});
