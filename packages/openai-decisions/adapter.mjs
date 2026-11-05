export const MODEL = "gpt-6-luna";
const SYSTEM_ONE_URL = "https://api.openai.com/v1/systemone";
const DECISIONS_URL = "https://api.openai.com/v1/decisions";
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
  if (question.type === "noul" && record(question.criteria)) {
    return JSON.stringify({ instructions: question.instructions ?? null, criteria: question.criteria });
  }
  return question.instructions == null ? "" : description(question.instructions);
}

function choiceEntries(question) {
  if (question.choices !== undefined) {
    requireValue(question.criteria === undefined, "choice accepts criteria or choices, not both");
    requireValue(Array.isArray(question.choices) && question.choices.every((value) => typeof value === "string"), "choices must be strings");
    requireValue(new Set(question.choices).size === question.choices.length, "choices must be unique");
    return question.choices.map((value) => [value, null]);
  }
  requireValue(record(question.criteria), "choice requires a criteria object");
  return Object.entries(question.criteria);
}

export function toOpenAIRequest(body) {
  fields(body, ["model", "state", "questions"], "request");
  requireValue(body.model === MODEL, `Only ${MODEL} is supported`);
  requireValue(Object.hasOwn(body, "state") && body.state !== null, "state is required");
  requireValue(record(body.questions), "questions must be an object");
  const entries = Object.entries(body.questions);
  requireValue(entries.length > 0 && entries.length <= 400, "Expected 1–400 questions");
  const questions = entries.map(([name, question]) => {
    requireValue(name.length > 0, "Question IDs must not be empty");
    fields(question, ["type", "instructions", "criteria", "choices"], "question");
    requireValue(question.instructions == null || typeof question.instructions === "string" || typeof question.instructions === "object", "instructions must be text or structured JSON");
    const common = { name, type: question.type, instructions: questionInstructions(question) };
    switch (question.type) {
      case "choice": {
        const criteria = choiceEntries(question);
        requireValue(criteria.length >= 2 && criteria.length <= 255, "choice requires 2–255 options");
        requireValue(criteria.every(([key]) => key.length > 0), "Choice names must not be empty");
        return { ...common, choices: criteria.map(([value, text]) => ({ value, ...(text != null ? { description: description(text) } : {}) })) };
      }
      case "score":
        requireValue(question.choices === undefined, "score does not accept choices");
        requireValue(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10, "score requires 2–10 ordered criteria");
        return { ...common, levels: question.criteria.map((value, index) => ({ label: String(index), ...(value != null ? { description: description(value) } : {}) })) };
      case "noul":
        requireValue(question.choices === undefined, "noul does not accept choices");
        requireValue(question.criteria == null || record(question.criteria) && Object.keys(question.criteria).every((key) => key === "true" || key === "false"), "noul criteria accept true and false only");
        return { ...common, type: "predicate" };
      default:
        throw new Error("Unsupported question type; use choice, score or noul");
    }
  });
  const input = typeof body.state === "string"
    ? body.state
    : typeof body.state === "object"
      ? [{ role: "user", content: [{ type: "input_json", data: body.state }] }]
      : JSON.stringify(body.state);
  return { model: MODEL, input, questions };
}

function probability(value) {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, "Invalid upstream probability or confidence");
  return value;
}

function distribution(values, expected, score) {
  requireValue(Array.isArray(values) && values.length === expected.length, "Incomplete upstream probability distribution");
  const seen = new Set();
  const result = values.map((item) => {
    requireValue(record(item), "Invalid upstream probability entry");
    requireValue(score ? Number.isInteger(item.value) : typeof item.value === "string", "Invalid upstream probability value");
    const key = String(item.value);
    requireValue(expected.includes(key) && !seen.has(key), "Unexpected or duplicate upstream probability value");
    seen.add(key);
    return [key, probability(item.probability)];
  });
  requireValue(Math.abs(result.reduce((sum, [, value]) => sum + value, 0) - 1) <= 0.02, "Upstream probabilities do not sum to one");
  return Object.fromEntries(result);
}

export function fromOpenAIResponse(upstream, source) {
  const request = toOpenAIRequest(source);
  requireValue(record(upstream) && typeof upstream.model === "string", "Invalid upstream decision response");
  requireValue(Array.isArray(upstream.answers) && upstream.answers.length === request.questions.length, "Incomplete upstream answers");
  const byName = new Map(request.questions.map((question) => [question.name, question]));
  const answers = new Map();
  for (const answer of upstream.answers) {
    requireValue(record(answer) && byName.has(answer.name) && !answers.has(answer.name), "Unexpected or duplicate upstream answer");
    const question = byName.get(answer.name);
    requireValue(answer.type === question.type, "Wrong upstream answer type");
    let result;
    if (answer.type === "predicate") {
      result = { type: "noul", noul: probability(answer.probability) };
    } else if (answer.type === "choice") {
      const keys = question.choices.map((choice) => choice.value);
      requireValue(keys.includes(answer.choice), "Upstream chose an unknown option");
      result = { type: "choice", choice: answer.choice, probabilities: distribution(answer.probabilities, keys, false), confidence: probability(answer.confidence) };
    } else {
      requireValue(typeof answer.score === "number" && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= question.levels.length - 1, "Invalid upstream score");
      result = {
        type: "score", score: answer.score,
        legend: Object.fromEntries(question.levels.map((level, index) => [String(index), level.description ?? level.label])),
        probabilities: distribution(answer.probabilities, question.levels.map((_, index) => String(index)), true),
        confidence: probability(answer.confidence),
      };
    }
    answers.set(answer.name, result);
  }
  // 按请求顺序组织答案；供应商可以按不同顺序返回命名问题。
  return { ...upstream, answers: Object.fromEntries(request.questions.map(({ name }) => [name, answers.get(name)])) };
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
      payload = toOpenAIRequest(source);
    } catch (error) {
      if (request?.signal.aborted) throw error;
      return refused(400, error instanceof SyntaxError ? "Invalid JSON request" : error.message);
    }
    request.signal.throwIfAborted();
    let key;
    try {
      key = await getKey();
      requireValue(typeof key === "string" && key.length > 0 && !/[\r\n]/.test(key), "Missing OpenAI API key");
    } catch {
      return refused(503, "OpenAI credentials unavailable; check this provider's sign-in or its saved OpenAI key");
    }
    const headers = new Headers({ "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` });
    let upstream;
    try {
      upstream = await fetchImpl(DECISIONS_URL, { method: "POST", headers, body: JSON.stringify(payload), signal: request.signal, redirect: "error" });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return refused(502, "Could not reach OpenAI Decisions");
    }
    const keptHeaders = responseHeaders(upstream);
    if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: keptHeaders });
    try {
      const result = fromOpenAIResponse(await upstream.json(), source);
      return Response.json(result, { status: upstream.status, headers: keptHeaders });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return refused(502, "OpenAI returned an invalid or incomplete decision answer", keptHeaders);
    }
  };
}
