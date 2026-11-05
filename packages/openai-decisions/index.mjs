import { createDecisionFetch, MODEL } from "./adapter.mjs";
import { keyFromAuth, readOpenAIKey, SAVED_OPENAI } from "./credentials.mjs";

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

// 入口只导出插件函数；Magpie 会把导出的函数逐一作为插件加载。
export const OpenAIDecisionsPlugin = async () => ({
  async config(config) {
    config.provider ??= {};
    config.provider[ID] ??= { name: "OpenAI Decisions", npm: "@ai-sdk/openai-compatible", api: BASE, decide: true, models: { [MODEL]: model } };
  },
  auth: {
    provider: ID,
    methods: [
      { type: "api", label: "OpenAI API key", placeholder: "sk-…" },
      {
        type: "api", keyless: true,
        label: "Use the OpenAI key already saved in Magpie",
        async authorize() {
          readOpenAIKey();
          return { type: "success", key: SAVED_OPENAI };
        },
      },
    ],
    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api" || !auth.key) return {};
      return { baseURL: BASE, apiKey: keyFromAuth(auth), fetch: createDecisionFetch({ getKey: async () => keyFromAuth(await getAuth()) }) };
    },
  },
  provider: {
    id: ID,
    async models() {
      return { [MODEL]: model };
    },
  },
});
