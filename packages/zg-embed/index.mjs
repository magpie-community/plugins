// opencode-zg-embed-auth
// Bridges zvec-grep (zg)'s hardcoded embedding model names to real Bailian
// (DashScope) models inside a magpie gateway, so zg talks to magpie directly.
//
//   zg name (hardcoded)        default upstream API id
//   qwen3.7-text-embedding  -> qwen3.7-text-embedding-flash
//   text-embedding-v4       -> text-embedding-v4
//   qwen3-vl-embedding      -> qwen3-vl-embedding (DashScope native API)
//
// Sign in:  magpie plugin login zg-bailian-embed
// Options:  magpie plugin options zg-embed '{"endpoint":"…","upstream":{…}}'
//
// Works in magpie and OpenCode (OpenCode v1 provider-plugin shape).

const PROVIDER = "zg-bailian-embed";
const PUBLIC_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
// qwen3-vl-embedding speaks DashScope's native multimodal API, not OpenAI's.
const VL_NATIVE_PATH = "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";

// key = the name zg sends; id = the API id declared to the gateway, which is
// what the gateway puts in the request body. Override ids via options.upstream.
const BRIDGES = {
  "qwen3.7-text-embedding": {
    id: "qwen3.7-text-embedding-flash",
    name: "Qwen3.7 Text Embedding (flash)",
    context: 128000,
    // Public Bailian (Beijing) price: CNY 0.125 / 1M input tokens.
    // Workspace deployments may price differently; override with
    // `magpie model price zg-bailian-embed/qwen3.7-text-embedding <in>,<out>,…`.
    cost: { input: 0.018682, output: 0 },
  },
  "text-embedding-v4": {
    id: "text-embedding-v4",
    name: "Text Embedding v4",
    context: 8192,
  },
  "qwen3-vl-embedding": {
    id: "qwen3-vl-embedding",
    name: "Qwen3 VL Embedding",
    context: 32000,
    vl: true,
  },
};

const trimSlash = (s) => String(s).replace(/\/+$/, "");

// Where this account's requests go: plugin options win over the endpoint
// chosen at sign-in (auth.metadata), which wins over the public endpoint.
function resolveBase(options, auth) {
  const meta = auth?.metadata ?? {};
  const raw = options?.endpoint || meta.baseURL || PUBLIC_BASE;
  return trimSlash(raw);
}

// The native multimodal endpoint lives beside the compatible-mode one:
// https://host/compatible-mode/v1 -> https://host/api/v1/services/…
function nativeVlUrl(base) {
  const u = new URL(base);
  return u.origin + VL_NATIVE_PATH;
}

// OpenAI embeddings body -> DashScope native multimodal body.
function toNativeVl(json) {
  const items = Array.isArray(json.input) ? json.input : [json.input];
  const native = {
    model: json.model,
    input: { contents: items.map((t) => (typeof t === "string" ? { text: t } : t)) },
  };
  if (json.dimensions) native.parameters = { dimension: json.dimensions };
  return native;
}

// DashScope native multimodal answer -> OpenAI embeddings answer.
function fromNativeVl(out, model) {
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

export const ZgBailianEmbed = async (_input, options) => {
  const opts = options ?? {};
  // zg name -> the upstream id this installation sends (options may override).
  const upstream = {};
  // upstream id -> zg name, to recognise a request's bridge from its body.
  const bridgeOf = {};
  for (const [zgName, b] of Object.entries(BRIDGES)) {
    const id = opts.upstream?.[zgName] || b.id;
    upstream[zgName] = id;
    bridgeOf[id] = zgName;
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "Bailian Embedding (zg)",
        npm: "@ai-sdk/openai-compatible",
        api: resolveBase(opts, null),
        models: Object.fromEntries(
          Object.entries(BRIDGES).map(([zgName, b]) => [
            zgName,
            {
              name: b.name,
              id: upstream[zgName],
              limit: { context: b.context, output: 0 },
              ...(b.cost ? { cost: b.cost } : {}),
              ...(b.vl ? { modalities: { input: ["text", "image"] } } : {}),
            },
          ]),
        ),
      };
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "Bailian API key / 百炼密钥",
          placeholder: "sk-…",
          prompts: [
            {
              type: "select",
              key: "endpoint",
              message: "Endpoint / 端点",
              options: [
                { label: "Public DashScope / 公共百炼", value: "public", hint: "dashscope.aliyuncs.com" },
                { label: "Custom workspace / 自定义业务空间", value: "custom", hint: "https://<workspace>.maas.aliyuncs.com/…" },
              ],
            },
            {
              type: "text",
              key: "baseURL",
              message: "Workspace base URL / 业务空间地址（…/compatible-mode/v1）",
              placeholder: "https://…/compatible-mode/v1",
              when: { key: "endpoint", op: "eq", value: "custom" },
              validate: (v) =>
                /^https:\/\/\S+\/v1\/?$/.test(String(v).trim())
                  ? undefined
                  : "Must be an https:// URL ending in /v1",
            },
          ],
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return {};
        const base = resolveBase(opts, auth);
        const vlUrl = nativeVlUrl(base);

        return {
          baseURL: base,
          async fetch(input, init) {
            const headers = new Headers(init?.headers);
            headers.set("authorization", `Bearer ${auth.key}`);
            const url = typeof input === "string" ? input : input.url;
            let body = init?.body;
            let json = null;
            if (typeof body === "string") {
              try { json = JSON.parse(body); } catch { /* not JSON: pass through */ }
            }

            if (json && typeof json.model === "string") {
              // Safety net: the gateway already sends the declared API id.
              // If a future host ever sends zg's bare name instead, rename here.
              const want = upstream[json.model];
              if (want && want !== json.model) {
                json.model = want;
                body = JSON.stringify(json);
              }

              const bridge = bridgeOf[json.model];
              if (BRIDGES[bridge]?.vl) {
                // Native DashScope body (zg sends this): forward untouched.
                if (json.input && typeof json.input === "object") {
                  return fetch(vlUrl, { method: "POST", headers, body: JSON.stringify(json), signal: init?.signal });
                }
                // OpenAI-shaped body (other agents): translate both ways.
                const res = await fetch(vlUrl, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(toNativeVl(json)),
                  signal: init?.signal,
                });
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}));
                  return new Response(
                    JSON.stringify({ error: { message: err.message ?? res.statusText, type: "invalid_request_error", code: err.code ?? null } }),
                    { status: res.status, headers: { "content-type": "application/json" } },
                  );
                }
                return Response.json(fromNativeVl(await res.json(), json.model));
              }
            }

            return fetch(url, { ...init, body, headers });
          },
        };
      },
    },
  };
};

// For tests only; magpie calls every exported function as a plugin, so keep
// helpers off the module's top level (an object without `server` is ignored).
export const _internal = { PROVIDER, PUBLIC_BASE, VL_NATIVE_PATH, BRIDGES, resolveBase, nativeVlUrl, toNativeVl, fromNativeVl };