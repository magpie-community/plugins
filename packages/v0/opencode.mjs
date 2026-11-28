import { BASE, MODELS, chatFetch } from "./chat.mjs";

export const V0Plugin = async () => ({
  config(config) {
    config.provider ??= {};
    config.provider.v0 ??= { name: "Vercel v0", npm: "@ai-sdk/openai-compatible", api: BASE, models: MODELS };
  },
  auth: {
    provider: "v0",
    methods: [{ type: "api", label: "v0 Platform API key" }],
    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api" || !auth.key) return {};
      return { baseURL: BASE, fetch: chatFetch(auth.key) };
    },
  },
});
