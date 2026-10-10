// Bilibili's Index-Translate: open translation models, with a free
// public endpoint for the 35B flagship. The endpoint is an
// OpenAI-compatible chat API whose key is a placeholder (the official
// Immersive Translate bridge sends "index"), so signing in is
// pasting any string.
//
// The model is translation-specialised and must not reason for
// translation: the official bridge disables thinking and forces
// greedy decoding on every request. A custom provider can only add
// headers, so the loader's fetch rewrites the body instead.
const PROVIDER = "index-translate"
const BASE = "https://index-translate.bilibili.com/v1"
const MODEL = "Index-Translate-35B-A3B"

export const IndexTranslateAuthPlugin = async ({ client }) => ({
  // the provider and its model, before anyone signs in
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "Index Translate",
      npm: "@ai-sdk/openai-compatible", // chat completions
      api: BASE,
      models: {
        [MODEL]: {
          name: "Index Translate 35B",
          // the model card's vLLM serving preset; the shipped config
          // allows 262,144 (max_position_embeddings)
          limit: { context: 32_768, output: 4_096 },
          // a free public endpoint, at no cost to any allowance
          free: true,
        },
      },
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [
      // the public API answers any string, so the key is a placeholder
      { type: "api", label: "API key (any string works)", placeholder: "index" },
    ],
    // what every request of this account is sent with. The key itself
    // is sent as the AI SDK sends it (Authorization: Bearer), from the
    // saved sign-in.
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      return {
        baseURL: BASE,
        async fetch(input, init) {
          // keep thinking off and decoding greedy, unless the caller
          // chose otherwise: the official bridge sends exactly this
          const body = init?.body
          if (typeof body === "string") {
            try {
              const payload = JSON.parse(body)
              payload.chat_template_kwargs ??= {}
              payload.chat_template_kwargs.enable_thinking ??= false
              payload.temperature ??= 0
              init = { ...init, body: JSON.stringify(payload) }
            } catch {} // not JSON: send it as it is
          }
          return fetch(input, init)
        },
      }
    },
  },
})
