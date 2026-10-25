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
    throw new Error("Sign in with a TokenDance API key");
  return auth.key.trim();
}

export async function TokenDancePlugin(_input, options = {}) {
  const baseURL = base(options.baseURL ?? "https://tokendance.space/gateway/v1");
  const preferred = options.protocol ?? "auto";
  if (preferred !== "auto" && !Object.hasOwn(SDK, preferred)) throw new Error("protocol must be auto, chat, responses or anthropic");
  // Attribution also accepts desktop identifiers such as app://my-client.
  const appURL = options.appURL ? new URL(options.appURL).href : "";
  const paths = new Map([
    [`${baseURL}/chat/completions`, "chat"], [`${baseURL}/responses`, "responses"],
    [`${baseURL}/messages`, "anthropic"], [`${baseURL}/messages/count_tokens`, "anthropic"],
  ]);
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider.tokendance ??= {
        name: "TokenDance", npm: SDK.chat, api: baseURL,
        models: configModels(models(bootstrap, baseURL, preferred)),
      };
    },
    auth: {
      provider: "tokendance",
      methods: [{ type: "api", label: "TokenDance API key", placeholder: "Your TokenDance key" }],
      async loader(getAuth) {
        if (!(await getAuth())) return {};
        return {
          apiKey: keyOf(await getAuth()),
          async fetch(input, init) {
            const request = new Request(input, init);
            const url = new URL(request.url);
            const protocol = paths.get(url.origin + url.pathname);
            if (!protocol || request.method !== "POST") throw new Error("Unsupported TokenDance endpoint or method");
            const key = keyOf(await getAuth());
            const headers = new Headers(request.headers);
            headers.delete("authorization"); headers.delete("x-api-key");
            if (protocol === "anthropic") {
              headers.set("x-api-key", key);
              if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
            } else headers.set("authorization", `Bearer ${key}`);
            if (appURL) headers.set("x-app-url", appURL);
            return fetch(new Request(request, { headers, redirect: "error" }));
          },
        };
      },
    },
    provider: {
      id: "tokendance",
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        const response = await fetch(`${baseURL}/models`, {
          headers: { authorization: `Bearer ${keyOf(auth)}` },
          signal: AbortSignal.timeout(20000), redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          const error = new Error(`TokenDance model list returned HTTP ${response.status}`);
          if (response.status === 401) error.signIn = "expired";
          throw error;
        }
        return models(await response.json(), baseURL, preferred);
      },
    },
  };
}
