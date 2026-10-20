// A magpie provider that answers Claude Code's auto mode classifier with jev.
//
// Claude Code sends each action under review as an Anthropic Messages request
// whose system prompt carries the block rules and whose user message carries
// the transcript. jev answers questions rather than chat, and magpie refuses a
// chat request to a model named jev-*, so this provider reads the rules and the
// transcript out of the request, asks jev through magpie's own gateway, and
// returns the <block> verdict Claude Code parses.
//
// A request that isn't a classifier request is refused. A jev failure is
// returned as 503, which Claude Code treats as "the classifier can't tell" and
// denies the action — so a broken guard fails closed.

import { decide, parseRules, questionsFor, render, systemText, transcriptOf } from "./classify.mjs";

export const PROVIDER = "cc-guard";
const MODEL = "auto-mode";

const DEFAULTS = {
  gateway: "http://127.0.0.1:3425",
  model: "group/jev",
  token: "magpie",
};

// Stage 1 and stage 2 ask the same question about the same transcript seconds
// apart, so the second one reuses the first answer.
const CACHE = new Map();
const CACHE_LIMIT = 64;
const CACHE_TTL = 10 * 60 * 1000;

function remembered(key) {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL) {
    CACHE.delete(key);
    return undefined;
  }
  CACHE.delete(key);
  CACHE.set(key, hit);
  return hit.answers;
}

function remember(key, answers) {
  CACHE.set(key, { at: Date.now(), answers });
  while (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value);
}

export function settings(options) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = options?.[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  out.gateway = out.gateway.replace(/\/$/, "");
  return out;
}

function cacheKey(system, transcript) {
  return `${system.length}:${system.slice(0, 160)}\n${transcript}`;
}

// Asks jev one batch of questions. Throws with a message on any failure,
// including a body that isn't a System One answer.
export async function askJev(config, payload, signal) {
  const response = await fetch(`${config.gateway}/v1/systemone`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: config.model, ...payload }),
    signal,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`jev answered ${response.status} with a non-JSON body`);
  }
  if (!response.ok || !body?.answers) {
    const detail = body?.error?.message || body?.message || `HTTP ${response.status}`;
    throw new Error(`jev couldn't judge the action: ${detail}`);
  }
  return body;
}

function messageID() {
  return `msg_guard_${Math.random().toString(36).slice(2, 14)}`;
}

function anthropicError(status, message) {
  return new Response(
    JSON.stringify({ type: "error", error: { type: status === 503 ? "api_error" : "invalid_request_error", message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

// Anthropic's streamed shape, matching what magpie itself emits for a pi
// provider: one text block, then the stop reason.
function streamReply(model, text, usage, stop) {
  const id = messageID();
  const enc = new TextEncoder();
  const frames = [
    sse("message_start", {
      message: {
        id, type: "message", role: "assistant", model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: stop.reason, stop_sequence: stop.sequence }, usage: { output_tokens: usage.output_tokens } }),
    sse("message_stop", {}),
  ];
  return new Response(enc.encode(frames.join("")), {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function jsonReply(model, text, usage, stop) {
  return new Response(
    JSON.stringify({
      id: messageID(), type: "message", role: "assistant", model,
      content: [{ type: "text", text }],
      stop_reason: stop.reason, stop_sequence: stop.sequence, usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function reply(model, text, usage, stage, stream) {
  const stop = stage === 1
    ? { reason: "stop_sequence", sequence: "</block>" }
    : { reason: "end_turn", sequence: null };
  return stream ? streamReply(model, text, usage, stop) : jsonReply(model, text, usage, stop);
}

// Resolves one classifier request into the response Claude Code reads.
export async function classify(body, config, signal) {
  const system = systemText(body?.system);
  const message = body?.messages?.at(-1);
  const found = message ? transcriptOf({ ...message, stop_sequences: body?.stop_sequences }) : null;
  if (!found) {
    return anthropicError(400, "cc-guard only answers Claude Code auto mode classifier requests.");
  }

  const rules = parseRules(system);
  if (!rules) {
    return anthropicError(503, "cc-guard couldn't read the block rules from the classifier prompt, so it can't judge the action.");
  }

  const key = cacheKey(system, found.transcript);
  let answers = remembered(key);
  let usage = { input_tokens: 0, output_tokens: 0 };
  if (!answers) {
    let result;
    try {
      result = await askJev(config, questionsFor(rules, found.transcript, system), signal);
    } catch (error) {
      return anthropicError(503, error?.message || "jev couldn't judge the action.");
    }
    answers = result.answers;
    usage = {
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
    };
    remember(key, answers);
  }

  const verdict = decide(rules, answers, found.stage);
  return reply(body.model || MODEL, render(verdict, found.stage), usage, found.stage, body.stream === true);
}

function server(_input, options) {
  const config = settings(options);
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "Claude Code Guard",
        npm: "@ai-sdk/anthropic",
        api: config.gateway,
        models: {
          [MODEL]: {
            name: "Auto Mode Guard (jev)",
            limit: { context: 200000, output: 10240 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      };
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "本地 magpie 网关密钥（默认即可，与 Claude Code 的 ANTHROPIC_AUTH_TOKEN 相同）",
          placeholder: "magpie",
          async authorize() {
            return { type: "success", key: "local" };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        return {
          baseURL: config.gateway,
          apiKey: "local",
          async fetch(input, init) {
            const request = new Request(input, init);
            if (request.method !== "POST" || !request.url.endsWith("/messages")) {
              return anthropicError(404, "cc-guard only serves the Anthropic Messages endpoint.");
            }
            let body;
            try {
              body = await request.json();
            } catch {
              return anthropicError(400, "cc-guard expected a JSON request body.");
            }
            return classify(body, config, request.signal);
          },
        };
      },
    },
  };
}

export default { id: PROVIDER, server };
