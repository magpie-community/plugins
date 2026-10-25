import bootstrap from "./bootstrap.json" with { type: "json" };
import { SDK, models, configModels } from "./models.mjs";

function base(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Expected an HTTP(S) URL without credentials, query or fragment");
  return url.href.replace(/\/+$/, "");
}

function keyOf(auth) {
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.trim())
    throw new Error("Sign in with a ZenMux API key");
  return auth.key.trim();
}

// A separate id leaves the existing zenmux OAuth plugin and its accounts alone.
export async function ZenMuxAPIPlugin(_input, options = {}) {
  const bases = {
    chat: base(options.baseURL ?? "https://zenmux.ai/api/v1"),
    responses: base(options.baseURL ?? "https://zenmux.ai/api/v1"),
    anthropic: base(options.anthropicBaseURL ?? "https://zenmux.ai/api/anthropic/v1"),
  };
  const catalogURL = base(options.catalogURL ?? "https://models.dev/api.json");
  let cached, expires = 0, pending;
  async function catalog() {
    if (cached && Date.now() < expires) return cached;
    if (!pending) pending = (async () => {
      // Public metadata is shared by accounts, without sharing credentials.
      const response = await fetch(catalogURL, { signal: AbortSignal.timeout(30000), redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`ZenMux model catalog returned HTTP ${response.status}`);
      }
      const result = models((await response.json()).zenmux, bases);
      cached = result;
      expires = Date.now() + 5 * 60_000;
      return result;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  const paths = new Map([
    [`${bases.chat}/chat/completions`, "chat"], [`${bases.responses}/responses`, "responses"],
    [`${bases.anthropic}/messages`, "anthropic"], [`${bases.anthropic}/messages/count_tokens`, "anthropic"],
  ]);
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider["zenmux-api"] ??= {
        name: "ZenMux API Key", npm: SDK.chat, api: bases.chat,
        models: configModels(models(bootstrap, bases)),
      };
    },
    auth: {
      provider: "zenmux-api",
      methods: [{ type: "api", label: "ZenMux API key", placeholder: "sk-…" }],
      async loader(getAuth) {
        if (!(await getAuth())) return {};
        return {
          apiKey: keyOf(await getAuth()),
          // No baseURL: each model's API URL must survive for Anthropic.
          async fetch(input, init) {
            const request = new Request(input, init);
            const url = new URL(request.url);
            const protocol = paths.get(url.origin + url.pathname);
            if (!protocol || request.method !== "POST") throw new Error("Unsupported ZenMux endpoint or method");
            const key = keyOf(await getAuth());
            const headers = new Headers(request.headers);
            headers.delete("authorization"); headers.delete("x-api-key");
            if (protocol === "anthropic") {
              headers.set("x-api-key", key);
              if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
            } else headers.set("authorization", `Bearer ${key}`);
            return fetch(new Request(request, { headers, redirect: "error" }));
          },
        };
      },
    },
    provider: {
      id: "zenmux-api",
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        keyOf(auth);
        // A public metadata request never carries the account's key.
        return structuredClone(await catalog());
      },
    },
  };
}
