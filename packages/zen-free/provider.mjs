import { createHash, randomBytes } from "node:crypto";
import {
  PROVIDER,
  SDK,
  bootstrapProvider,
  buildModels,
  configModels,
  parseProtocolDocs,
} from "./models.mjs";
import { collapseResponse } from "./stream.mjs";
import { guardToolResponse } from "./tool-response.mjs";

const DEFAULT_BASE = "https://opencode.ai/zen/v1";
const CATALOG = "https://models.opencode.ai/api.json";
const DOCS =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx";
const PATHS = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages" };
const CORE_TOOLS = ["bash", "edit", "glob", "grep", "read"];
const OPENCODE_VERSION = "1.19.0";
// What OpenCode 1.19.0 sends as its User-Agent, ai-sdk and Bun included.
const USER_AGENT = `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`;
// How long a request for a model the last list didn't have waits before it
// asks Zen's list again: a model Zen made free since is served at once,
// and a model typed in by hand doesn't ask the list on every request.
const RELIST_AFTER = 60_000;

function httpURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function requirePublic(auth) {
  if (auth?.type !== "api" || auth.key !== "public") {
    throw new Error(
      "OpenCode Zen Free uses the public credential. Enable its free access login method.",
    );
  }
}

async function readRemote(url, json, headers, callerSignal) {
  const timeout = AbortSignal.timeout(15000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Model discovery returned HTTP ${response.status}`);
  }
  return json ? response.json() : response.text();
}

function normalizeTools(body, protocol) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("tools must be an array");
  }
  body.tools ??= [];
  const present = new Set(
    body.tools.map((tool) => (protocol === "chat" ? tool?.function?.name : tool?.name)),
  );
  const declared = new Set([...present].filter((name) => typeof name === "string"));
  if (protocol === "chat" && Array.isArray(body.functions)) {
    for (const tool of body.functions) if (typeof tool?.name === "string") declared.add(tool.name);
  }
  for (const name of CORE_TOOLS) {
    if (present.has(name)) continue;
    const parameters = { type: "object", properties: {}, additionalProperties: false };
    const definition = { name, description: "Not available. Never call this tool." };
    body.tools.push(
      protocol === "chat"
        ? { type: "function", function: { ...definition, parameters } }
        : protocol === "anthropic"
          ? { ...definition, input_schema: parameters }
          : { type: "function", ...definition, parameters },
    );
  }
  return { declared };
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let counter = 0;

// An id the way OpenCode makes one (packages/schema/src/identifier.ts):
// 12 hex of Date.now() * 0x1000 + a per-millisecond counter (bit-inverted
// for a session, so newer sorts first), then 14 random base62 characters.
// Zen's free tier checks a session id has this shape, a small counter
// included, and answers 403 FreeTierError to one that doesn't (#100).
export function opencodeID(prefix, descending, now = Date.now()) {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter++;
  const current = BigInt(now) * 0x1000n + BigInt(counter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  const random = randomBytes(14);
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 62];
  return `${prefix}_${value.toString(16).padStart(12, "0")}${tail}`;
}

// A session id OpenCode itself could have made: its counter (the low 12
// bits, inverted) is small. A hash cut to the same shape isn't one.
export function realSessionID(value) {
  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(value ?? "");
  return !!match && 0xfff - Number.parseInt(match[1], 16) < 16;
}

// One made-up session per conversation, so its turns keep one session.
const SESSIONS = new Map();
const KEEP_SESSIONS = 1000;

export function sessionID(headers, body) {
  let signal;
  for (const name of [
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
    "conversation-id",
  ]) {
    if (headers.get(name)) {
      signal = headers.get(name);
      break;
    }
  }
  if (!signal && typeof body.metadata?.session_id === "string") signal = body.metadata.session_id;
  if (realSessionID(signal)) return signal;
  if (!signal) {
    const messages = body.messages ?? body.input;
    const first = Array.isArray(messages)
      ? messages.find((message) => message.role === "user")?.content
      : messages;
    if (!first) return opencodeID("ses", true);
    signal = JSON.stringify(first);
  }
  const key = createHash("sha256").update(`ses\0${signal}`).digest("hex");
  let session = SESSIONS.get(key);
  if (session) {
    SESSIONS.delete(key);
  } else {
    session = opencodeID("ses", true);
    if (SESSIONS.size >= KEEP_SESSIONS) SESSIONS.delete(SESSIONS.keys().next().value);
  }
  SESSIONS.set(key, session);
  return session;
}

async function server(_input, options = {}) {
  const baseURL = httpURL(options.baseURL ?? DEFAULT_BASE);
  const catalogURL = httpURL(options.catalogURL ?? CATALOG);
  const docsURL = httpURL(options.docsURL ?? DOCS);
  let known = buildModels(Object.keys(bootstrapProvider.models), bootstrapProvider, {}, baseURL);
  let metadata = bootstrapProvider;
  let protocols = {};
  let listed = false;
  let listedAt = 0;

  async function discover(signal) {
    const headers = { authorization: "Bearer public", "x-opencode-client": "cli" };
    const [listing, catalog, docs] = await Promise.allSettled([
      readRemote(`${baseURL}/models`, true, headers, signal),
      readRemote(catalogURL, true, undefined, signal),
      readRemote(docsURL, false, undefined, signal),
    ]);
    signal?.throwIfAborted();
    let partial = false;
    if (catalog.status === "fulfilled" && catalog.value?.opencode?.models) {
      metadata = catalog.value.opencode;
    } else {
      partial = true;
    }
    if (docs.status === "fulfilled" && Object.keys(parseProtocolDocs(docs.value)).length) {
      protocols = parseProtocolDocs(docs.value);
    } else {
      partial = true;
    }
    if (listing.status !== "fulfilled" || !Array.isArray(listing.value?.data)) {
      const fallback = { ...known };
      fallback[Symbol.for("magpie.fellBack")] = true;
      return fallback;
    }
    const ids = listing.value.data.map((item) => item.id);
    const discovered = buildModels(ids, metadata, protocols, baseURL);
    if (partial) {
      // Preserve previously verified models only while they remain in the live catalog.
      for (const id of ids) {
        if (!discovered[id] && !metadata.models?.[id] && !protocols[id] && known[id]) {
          discovered[id] = known[id];
        }
      }
      discovered[Symbol.for("magpie.fellBack")] = true;
    }
    known = discovered;
    listed = true;
    listedAt = Date.now();
    return discovered;
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "OpenCode Zen Free",
        npm: SDK.chat,
        api: baseURL,
        models: configModels(known),
      };
    },
    auth: {
      provider: PROVIDER,
      icon: "https://opencode.ai/favicon-v3.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: "Zen 免费访问（密钥填写 public）",
          placeholder: "public",
          async authorize() {
            return { type: "success", key: "public" };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        requirePublic(auth);
        return {
          baseURL,
          apiKey: "public",
          async fetch(input, init) {
            requirePublic(await getAuth());
            const request = new Request(input, init);
            const protocol = Object.keys(PATHS).find(
              (key) => request.url === `${baseURL}${PATHS[key]}`,
            );
            if (!protocol || request.method !== "POST")
              throw new Error("Unsupported Zen endpoint or method");
            request.signal.throwIfAborted();
            const body = await request.json();
            if (!body || typeof body !== "object" || Array.isArray(body))
              throw new Error("Expected a JSON request object");
            if (
              !Object.hasOwn(known, body.model) &&
              (!listed || Date.now() - listedAt >= RELIST_AFTER)
            ) {
              await discover(request.signal);
            }
            const model = Object.hasOwn(known, body.model) ? known[body.model] : undefined;
            if (!model) {
              // Zen no longer gives it free, or never did: said as a model
              // not served, so the caller sets this model aside and not the
              // account, whose other free models are still served.
              const free = Object.keys(known).sort().join(", ");
              const name = typeof body.model === "string" ? body.model : "";
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "not_found_error",
                    message: `Model ${name} is not available as an OpenCode Zen free model now. Free models: ${free || "none"}.`,
                  },
                }),
                { status: 404, headers: { "content-type": "application/json" } },
              );
            }
            if (model.api.npm !== SDK[protocol]) {
              throw new Error(
                "Model is not an available free model for this protocol. Refresh the model list.",
              );
            }
            const streaming = body.stream === true;
            body.stream = true;
            const toolPolicy = normalizeTools(body, protocol);
            if (protocol === "chat")
              body.stream_options = { ...body.stream_options, include_usage: true };
            const headers = new Headers(request.headers);
            for (const name of [
              "authorization",
              "x-api-key",
              "x-goog-api-key",
              "content-length",
              "content-encoding",
              "host",
              "cookie",
            ]) {
              headers.delete(name);
            }
            headers.set("content-type", "application/json");
            headers.set("accept", "text/event-stream");
            headers.set("user-agent", USER_AGENT);
            headers.set("x-opencode-client", "cli");
            headers.set("x-opencode-request", opencodeID("msg", false));
            if (!headers.has("x-opencode-project")) {
              const project = _input?.project;
              headers.set(
                "x-opencode-project",
                project?.vcs === "git" && project.id ? project.id : "global",
              );
            }
            const session = sessionID(headers, body);
            for (const name of [
              "x-session-id",
              "x-opencode-session",
              "x-opencode-session-id",
              "x-session-affinity",
            ])
              headers.set(name, session);
            if (protocol === "anthropic") {
              headers.set("x-api-key", "public");
              if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
            } else {
              headers.set("authorization", "Bearer public");
            }
            const response = await fetch(request.url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: "error",
            });
            const guarded = await guardToolResponse(response, protocol, toolPolicy, {
              endCutShort: streaming,
            });
            return streaming ? guarded : collapseResponse(guarded, protocol);
          },
        };
      },
      async usage() {
        return { plan: "OpenCode Zen Free", windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        requirePublic(auth);
        return discover();
      },
    },
    async "chat.headers"(input, output) {
      if (![PROVIDER, `${PROVIDER}-plugin`].includes(input.model?.providerID) || !input.sessionID)
        return;
      // Zen's free tier wants x-opencode-session and x-opencode-session-id
      // both present and equal, so every layer that names a session names
      // it twice (see fetch).
      output.headers["x-session-id"] = input.sessionID;
      output.headers["x-opencode-session"] = input.sessionID;
      output.headers["x-opencode-session-id"] = input.sessionID;
      output.headers["x-session-affinity"] = input.sessionID;
    },
  };
}

export default { id: PROVIDER, server };
