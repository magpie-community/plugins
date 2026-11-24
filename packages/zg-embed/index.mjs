// opencode-zg-embed-auth
// One funnel for every embedding name zvec-grep (zg) hardcodes: all of them
// are routed to ONE upstream you configure — { endpoint, model } in the
// plugin options, the key at sign-in. Defaults to Bailian (DashScope) flash.
//
//   zg sends (hardcoded)          all go to
//   qwen3.7-text-embedding   ┐
//   text-embedding-v4        ├─→  options.model @ options.endpoint
//   qwen3-vl-embedding       ┘    (default: qwen3.7-text-embedding-flash
//                                  @ dashscope.aliyuncs.com/compatible-mode/v1)
//
// The upstream protocol is detected from the endpoint (or set explicitly):
// OpenAI-compatible embeddings, or DashScope's native multimodal API.
// zg sends vl requests in the native shape; bodies and answers are
// translated both ways as needed, and each caller gets its own shape back.
//
// Sign in:  magpie plugin login zg-bailian-embed        (the API key)
// Options:  magpie plugin options zg-embed '{"endpoint":"…","model":"…"}'
//
// Works in magpie and OpenCode (OpenCode v1 provider-plugin shape).

const PROVIDER = "zg-bailian-embed";
const PUBLIC_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-text-embedding-flash";
const VL_NATIVE_PATH = "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";

// zg's hardcoded remote names, and what zg expects from each.
const ZG_MODELS = {
  "qwen3.7-text-embedding": { name: "Qwen3.7 Text Embedding", context: 128000 },
  "text-embedding-v4": { name: "Text Embedding v4", context: 8192 },
  "qwen3-vl-embedding": { name: "Qwen3 VL Embedding", context: 32000, vl: true },
};

// Public Bailian (Beijing) price of the default model: CNY 0.125 / 1M input.
// Other targets: set your own with `magpie model price`.
const FLASH_COST = { input: 0.018682, output: 0 };

const trimSlash = (s) => String(s).replace(/\/+$/, "");

// The one target every zg name is routed to.
// endpoint: options > sign-in metadata (older installs) > public Bailian.
// model: options.model > the old options.upstream bare-name entry > flash.
// protocol: explicit option, else read from the endpoint's path.
function resolveTarget(options, auth) {
  const opts = options ?? {};
  const meta = auth?.metadata ?? {};
  const endpoint = trimSlash(opts.endpoint || meta.baseURL || PUBLIC_BASE);
  const model = opts.model || opts.upstream?.["qwen3.7-text-embedding"] || DEFAULT_MODEL;
  let protocol = opts.protocol;
  if (protocol !== "openai" && protocol !== "dashscope") {
    protocol = /\/api\/v1(\/|$)/.test(new URL(endpoint).pathname) ? "dashscope" : "openai";
  }
  return { endpoint, model, protocol };
}

// The native multimodal endpoint beside the compatible-mode one:
// https://host/compatible-mode/v1 -> https://host/api/v1/services/…
// An endpoint that already names a native embeddings path is used as is.
function nativeUrl(endpoint) {
  const u = new URL(endpoint);
  return u.pathname.includes("/services/embeddings/") ? endpoint : u.origin + VL_NATIVE_PATH;
}

// DashScope native body -> OpenAI embeddings body.
function nativeToOpenAi(json) {
  const contents = json.input?.contents ?? json.input?.texts ?? [];
  const out = {
    model: json.model,
    input: contents.map((c) =>
      typeof c === "string" ? c : c.text ?? c.image ?? (Array.isArray(c.video) ? c.video[0] : JSON.stringify(c)),
    ),
  };
  if (json.parameters?.dimension) out.dimensions = json.parameters.dimension;
  return out;
}

// OpenAI embeddings body -> DashScope native multimodal body.
function openAiToNative(json) {
  const items = Array.isArray(json.input) ? json.input : [json.input];
  const native = {
    model: json.model,
    input: { contents: items.map((t) => (typeof t === "string" ? { text: t } : t)) },
  };
  if (json.dimensions) native.parameters = { dimension: json.dimensions };
  return native;
}

// OpenAI answer -> DashScope native answer (for a native caller).
function openAiResToNative(out, model) {
  const rows = out?.data ?? [];
  return {
    model,
    output: {
      embeddings: rows.map((d, i) => ({ embedding: d.embedding, index: d.index ?? i, text_index: d.index ?? i })),
    },
    usage: { total_tokens: out?.usage?.total_tokens ?? 0 },
  };
}

// DashScope native answer -> OpenAI answer (for an OpenAI caller).
function nativeResToOpenAi(out, model) {
  const rows = out?.output?.embeddings ?? [];
  const tokens = out?.usage?.total_tokens ?? 0;
  return {
    object: "list",
    model,
    data: rows.map((e, i) => ({
      object: "embedding",
      index: e.index ?? e.text_index ?? i,
      embedding: e.embedding,
    })),
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

// The vendor's refusal, in the caller's own error shape.
async function errorFor(res, nativeCaller) {
  const j = await res.json().catch(() => ({}));
  const message = j?.error?.message ?? j?.message ?? res.statusText;
  const code = j?.error?.code ?? j?.code ?? null;
  const body = nativeCaller
    ? { code, message, request_id: j?.request_id }
    : { error: { message, type: "invalid_request_error", code } };
  return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
}

export const ZgBailianEmbed = async (_input, options) => {
  const opts = options ?? {};
  const declared = resolveTarget(opts, null);

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "zg Embedding (Bailian)",
        npm: "@ai-sdk/openai-compatible",
        api: declared.endpoint,
        models: Object.fromEntries(
          Object.entries(ZG_MODELS).map(([zgName, m]) => [
            zgName,
            {
              name: m.name,
              id: declared.model,
              limit: { context: m.context, output: 0 },
              ...(declared.model === DEFAULT_MODEL ? { cost: FLASH_COST } : {}),
              ...(m.vl ? { modalities: { input: ["text", "image"] } } : {}),
            },
          ]),
        ),
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "API key / 密钥", placeholder: "sk-…" }],

      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return {};
        const target = resolveTarget(opts, auth);
        const upstreamNative = target.protocol === "dashscope";
        const nativeTarget = upstreamNative ? nativeUrl(target.endpoint) : null;

        return {
          baseURL: target.endpoint,
          async fetch(input, init) {
            const headers = new Headers(init?.headers);
            headers.set("authorization", `Bearer ${auth.key}`);
            const url = typeof input === "string" ? input : input.url;
            let json = null;
            if (typeof init?.body === "string") {
              try { json = JSON.parse(init.body); } catch { /* not JSON: pass through */ }
            }
            if (!json || typeof json.model !== "string") {
              return fetch(url, { ...init, headers });
            }

            // The funnel: every zg name goes to the one configured target.
            // (The gateway already sends the declared API id; this also catches
            // a host that ever sends zg's bare names instead.)
            if (ZG_MODELS[json.model]) json.model = target.model;
            // Native shape is input: {contents|texts: [...]}. An ARRAY input is
            // OpenAI's batch shape (what zg sends for the text names), not native.
            const callerNative = !!json.input && typeof json.input === "object" && !Array.isArray(json.input);

            if (upstreamNative) {
              const res = await fetch(nativeTarget, {
                ...init,
                method: "POST",
                headers,
                body: JSON.stringify(callerNative ? json : openAiToNative(json)),
              });
              if (!res.ok) return errorFor(res, callerNative);
              const out = await res.json();
              return Response.json(callerNative ? out : nativeResToOpenAi(out, json.model));
            }

            if (callerNative) {
              const res = await fetch(url, {
                ...init,
                method: "POST",
                headers,
                body: JSON.stringify(nativeToOpenAi(json)),
              });
              if (!res.ok) return errorFor(res, true);
              return Response.json(openAiResToNative(await res.json(), json.model));
            }

            return fetch(url, { ...init, method: "POST", headers, body: JSON.stringify(json) });
          },
        };
      },
    },
  };
};

// For tests only; magpie calls every exported function as a plugin, so keep
// helpers off the module's top level (an object without `server` is ignored).
export const _internal = {
  PROVIDER, PUBLIC_BASE, DEFAULT_MODEL, VL_NATIVE_PATH, ZG_MODELS,
  resolveTarget, nativeUrl, nativeToOpenAi, openAiToNative, openAiResToNative, nativeResToOpenAi,
};