import { createDecisionFetch, MODELS } from "./adapter.mjs";

const ID = "openrouter-decisions";
const BASE = "https://openrouter.ai/api/v1";
// $ per 1M tokens, billed on input only; both models answer with decisions,
// never conversation. 1.1 reads text and images, 1 is text-only.
const modelSpecs = {
  "microsoft-decision-1.1": {
    name: "Microsoft Decision 1.1",
    modalities: { input: ["text"], output: ["text"] },
  },
  "microsoft-decision-1": {
    name: "Microsoft Decision 1",
    modalities: { input: ["text"], output: ["text"] },
  },
};
const models = Object.fromEntries(Object.entries(MODELS).map(([id, spec]) => [
  id,
  {
    id,
    name: modelSpecs[id].name,
    decides: true,
    tool_call: false,
    reasoning: false,
    limit: { context: 32768, output: 0 },
    modalities: modelSpecs[id].modalities,
    cost: { input: 0.042, output: 0 },
  },
]));

// Export only the plugin function; Magpie invokes each exported function as a plugin.
export const OpenRouterDecisionsPlugin = async () => ({
  async config(config) {
    config.provider ??= {};
    config.provider[ID] ??= {
      name: "OpenRouter Decisions",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      decide: true,
      models,
    };
  },
  auth: {
    provider: ID,
    methods: [
      { type: "api", label: "OpenRouter API key", placeholder: "sk-or-…" },
    ],
    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.trim()) return {};
      return {
        baseURL: BASE,
        apiKey: auth.key,
        fetch: createDecisionFetch({ getKey: async () => {
          const current = await getAuth();
          return current?.type === "api" ? current.key : undefined;
        } }),
      };
    },
    // magpie's own hook: show this account's OpenRouter credit usage
    async usage(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.trim()) return { error: "Not signed in" };
      const headers = { authorization: `Bearer ${auth.key}` };
      try {
        const res = await fetch(`${BASE}/auth/key`, { headers });
        if (!res.ok) return { error: `OpenRouter answered ${res.status}` };
        const { data } = await res.json();
        if (!data) return { error: "OpenRouter returned no key info" };
        const windows = [];
        if (typeof data.limit === "number" && data.limit > 0 && typeof data.usage === "number") {
          windows.push({
            name: "Credits",
            used: Math.round((data.usage / data.limit) * 1000) / 10,
            amount: data.usage,
            limit: data.limit,
            unit: "credits",
            display: `${data.usage.toFixed(2)} / ${data.limit.toFixed(2)} credits`,
          });
        }
        const result = { plan: data.is_free_tier ? "Free tier" : "Paid", user: data.label, windows };
        try {
          const creditsRes = await fetch(`${BASE}/credits`, { headers });
          if (creditsRes.ok) {
            const credits = (await creditsRes.json()).data;
            if (credits && typeof credits.total_credits === "number" && typeof credits.total_usage === "number") {
              result.balance = `$${(credits.total_credits - credits.total_usage).toFixed(2)}`;
            }
          }
        } catch { /* balance is best-effort */ }
        return result;
      } catch {
        return { error: "Could not reach OpenRouter" };
      }
    },
  },
  provider: {
    id: ID,
    async models() {
      return models;
    },
  },
});
