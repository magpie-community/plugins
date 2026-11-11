import { createDecisionFetch, MODEL } from "./adapter.mjs";

const ID = "openai-decisions";
const BASE = "https://api.openai.com/v1";
const model = {
  id: MODEL,
  name: "GPT-6 Luna · Decisions",
  decides: true,
  tool_call: false,
  reasoning: false,
  limit: { context: 0, output: 0 },
  modalities: { input: ["text"], output: ["text"] },
  cost: { input: 0.1, output: 0 },
};

// Export only the plugin function; Magpie invokes each exported function as a plugin.
export const OpenAIDecisionsPlugin = async () => ({
  async config(config) {
    config.provider ??= {};
    config.provider[ID] ??= { name: "OpenAI Decisions", npm: "@ai-sdk/openai-compatible", api: BASE, decide: true, models: { [MODEL]: model } };
  },
  auth: {
    provider: ID,
    methods: [
      { type: "api", label: "OpenAI API key", placeholder: "sk-…" },
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
  },
  provider: {
    id: ID,
    async models() {
      return { [MODEL]: model };
    },
  },
});
