// Converts Magpie's System One requests into OpenRouter's Decisions API
// (POST https://openrouter.ai/api/alpha/decisions) and converts the answers back.
// OpenRouter already speaks a System One dialect, so the mapping is shallow:
// validate, translate the state into a supported form, and verify answers.

// The models this provider serves. Both are Microsoft's System One decision
// models on OpenRouter; 1.1 reads text and images, 1 is text-only and cheaper.
export const MODELS = {
  "microsoft-decision-1.1": { upstream: "microsoft/microsoft-decision-1.1", images: true },
  "microsoft-decision-1": { upstream: "microsoft/microsoft-decision-1", images: false },
};
export const MODEL = "microsoft-decision-1.1";
const BASE = "https://openrouter.ai/api/v1";
const SYSTEM_ONE_URL = `${BASE}/systemone`;
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const FALLBACK_INSTRUCTIONS = "Answer this question using the supplied input and criteria.";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function fields(value, allowed, name) {
  requireValue(record(value), `${name} must be an object`);
  requireValue(Object.keys(value).every((key) => allowed.includes(key)), `${name} contains an unsupported field`);
}

function description(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function questionInstructions(question) {
  const supplied = question.instructions == null ? "" : description(question.instructions);
  return supplied.trim() ? supplied : FALLBACK_INSTRUCTIONS;
}

// Magpie allows `choices: ["a", "b"]` as a shorthand for a criteria map.
// OpenRouter's Decisions API documents the criteria form only, so expand it.
function choiceCriteria(question) {
  if (question.choices !== undefined) {
    requireValue(question.criteria === undefined, "choice accepts criteria or choices, not both");
    requireValue(Array.isArray(question.choices) && question.choices.every((value) => typeof value === "string"), "choices must be strings");
    requireValue(question.choices.every((value) => value.length > 0), "Choice names must not be empty");
    requireValue(new Set(question.choices).size === question.choices.length, "choices must be unique");
    return Object.fromEntries(question.choices.map((value) => [value, null]));
  }
  requireValue(record(question.criteria), "choice requires a criteria object");
  return question.criteria;
}

// OpenRouter rejects blank criteria text ("String should have at least 1
// character"), while System One allows a bare option name or a null level.
// Fall back to the option name, then to a positional label.
function criterionText(value, fallback) {
  const text = value == null ? "" : description(value);
  return text.trim() ? text : fallback;
}

export function toOpenRouterRequest(body) {
  fields(body, ["model", "state", "questions"], "request");
  const spec = MODELS[body.model];
  requireValue(spec, `Only ${Object.keys(MODELS).join(" and ")} are supported`);
  requireValue(Object.hasOwn(body, "state") && body.state !== null, "state is required");
  requireValue(record(body.questions), "questions must be an object");
  const entries = Object.entries(body.questions);
  requireValue(entries.length > 0 && entries.length <= 400, "Expected 1–400 questions");
  const questions = {};
  for (const [name, question] of entries) {
    requireValue(name.length > 0, "Question IDs must not be empty");
    fields(question, ["type", "instructions", "criteria", "choices"], "question");
    requireValue(question.instructions == null || typeof question.instructions === "string" || typeof question.instructions === "object", "instructions must be text or structured JSON");
    const common = { type: question.type, instructions: questionInstructions(question) };
    switch (question.type) {
      case "choice": {
        const criteria = choiceCriteria(question);
        const keys = Object.keys(criteria);
        requireValue(keys.length >= 2 && keys.length <= 255, "choice requires 2–255 options");
        requireValue(keys.every((key) => key.length > 0), "Choice names must not be empty");
        requireValue(new Set(keys).size === keys.length, "Choice names must be unique");
        questions[name] = { ...common, criteria: Object.fromEntries(keys.map((key) => [key, criterionText(criteria[key], key)])) };
        break;
      }
      case "score":
        requireValue(question.choices === undefined, "score does not accept choices");
        requireValue(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10, "score requires 2–10 ordered criteria");
        questions[name] = { ...common, criteria: question.criteria.map((value, index) => criterionText(value, `Level ${index}`)) };
        break;
      case "noul":
        requireValue(question.choices === undefined, "noul does not accept choices");
        if (question.criteria !== undefined) {
          requireValue(record(question.criteria) && Object.keys(question.criteria).every((key) => key === "true" || key === "false"), "noul criteria accept true and false only");
          questions[name] = {
            ...common,
            criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, criterionText(value, key === "true" ? "True" : "False")])),
          };
        } else {
          questions[name] = common;
        }
        break;
      default:
        throw new Error("Unsupported question type; use choice, score or noul");
    }
  }
  // OpenRouter accepts a text state, or an array of text/media parts. Anything
  // else (plain objects, numbers, booleans) becomes JSON text evidence. The
  // text-only model takes every part as its JSON text.
  const state = typeof body.state === "string"
    ? body.state
    : (Array.isArray(body.state) ? body.state.map((part) => typeof part === "string" ? part : JSON.stringify(part)) : JSON.stringify(body.state));
  return { model: spec.upstream, state, questions };
}

function probability(value, name) {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, `Invalid ${name}`);
  return value;
}

function distribution(map, expected, name) {
  requireValue(record(map), `${name} probabilities must be an object`);
  const keys = Object.keys(map);
  requireValue(keys.length === expected.length && expected.every((key) => Object.hasOwn(map, key)), `Incomplete ${name} probability distribution`);
  let sum = 0;
  const result = {};
  for (const key of expected) {
    result[key] = probability(map[key], name);
    sum += result[key];
  }
  requireValue(Math.abs(sum - 1) <= 0.02, `${name} probabilities do not sum to one`);
  return result;
}

export function fromOpenRouterResponse(upstream, source) {
  const request = toOpenRouterRequest(source);
  requireValue(record(upstream), "Invalid upstream decision response");
  requireValue(record(upstream.answers), "Invalid upstream answers");
  const answers = {};
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = upstream.answers[name];
    requireValue(record(answer), `Missing upstream answer for "${name}"`);
    if (answer.type === "refusal") {
      answers[name] = { type: "refusal" };
      continue;
    }
    requireValue(answer.type === question.type, `Wrong upstream answer type for "${name}"`);
    if (answer.type === "noul") {
      answers[name] = { type: "noul", noul: probability(answer.noul, "noul") };
    } else if (answer.type === "choice") {
      const keys = Object.keys(request.questions[name].criteria);
      requireValue(keys.includes(answer.choice), "Upstream chose an unknown option");
      answers[name] = {
        type: "choice",
        choice: answer.choice,
        probabilities: distribution(answer.probabilities, keys, "choice"),
        confidence: probability(answer.confidence, "confidence"),
      };
    } else {
      const count = request.questions[name].criteria.length;
      requireValue(typeof answer.score === "number" && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= count - 1, "Invalid upstream score");
      answers[name] = {
        type: "score",
        score: answer.score,
        legend: Object.fromEntries(request.questions[name].criteria.map((text, index) => [String(index), text])),
        probabilities: distribution(answer.probabilities, request.questions[name].criteria.map((_, index) => String(index)), "score"),
        confidence: probability(answer.confidence, "confidence"),
      };
    }
  }
  return { ...upstream, answers };
}

function responseHeaders(response) {
  const headers = new Headers({ "content-type": response.headers.get("content-type") || "application/json" });
  for (const [key, value] of response.headers) {
    if (key === "retry-after" || key === "x-request-id" || key.startsWith("x-ratelimit-")) headers.set(key, value);
  }
  return headers;
}

function refused(status, message, headers) {
  return Response.json({ error: { type: status === 400 ? "invalid_request_error" : "api_error", message } }, { status, headers });
}

export function createDecisionFetch({ getKey, fetchImpl = globalThis.fetch }) {
  return async (input, init) => {
    let request, source, payload;
    try {
      request = new Request(input, init);
      requireValue(request.url === SYSTEM_ONE_URL && request.method === "POST", "Only POST /v1/systemone is supported");
      source = await request.json();
      payload = toOpenRouterRequest(source);
    } catch (error) {
      if (request?.signal.aborted) throw error;
      return refused(400, error instanceof SyntaxError ? "Invalid JSON request" : error.message);
    }
    request.signal.throwIfAborted();
    let key;
    try {
      key = await getKey();
      requireValue(typeof key === "string" && key.trim().length > 0 && !/[\r\n]/.test(key), "Missing OpenRouter API key");
    } catch {
      return refused(503, "OpenRouter credentials unavailable; check this provider's API-key sign-in");
    }
    const headers = new Headers({ "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` });
    // A momentary network failure (proxy restart, DNS hiccup) should not lose
    // the routing decision: retry network-level errors once, quickly. HTTP
    // error responses are upstream answers and are never retried.
    let upstream;
    for (let attempt = 0; ; attempt++) {
      try {
        upstream = await fetchImpl(DECISIONS_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: request.signal, redirect: "error" });
        break;
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (attempt > 0) return refused(502, `Could not reach OpenRouter: ${error?.message || "network error"}`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    const keptHeaders = responseHeaders(upstream);
    if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: keptHeaders });
    try {
      const result = fromOpenRouterResponse(await upstream.json(), source);
      return Response.json(result, { status: upstream.status, headers: keptHeaders });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return refused(502, "OpenRouter returned an invalid or incomplete decision answer", keptHeaders);
    }
  };
}

export const _internal = { SYSTEM_ONE_URL, DECISIONS_URL };
