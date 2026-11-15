// Antigravity through a Google account, retired (0.2.0).
//
// Up to 0.1.18 this plugin signed in with Antigravity's own Google client
// and sent each request to Code Assist (cloudcode-pa) the way the
// Antigravity app does. Google bans accounts it sees used that way, and
// since this was the plugin magpie offered first, anyone who reached for
// Antigravity in magpie put their account at that risk.
//
// Antigravity is now served by "Antigravity (local agy CLI)",
// @magpie-community/opencode-agy-cli-auth, which runs the agy CLI the user
// installed and signed in to over the Agent Client Protocol (agy acp): the
// requests Google sees are agy's own.
//
// This version sends nothing anywhere. It keeps the provider id so an
// account moved onto it stays listed, and answers every request with a
// 410 that says where Antigravity went: magpie reads it as a retired model,
// so a routing group asks its next member. Signing in is turned away with
// the same words, and there are no models, usage or web search.

const PROVIDER = "antigravity"
const AGY_CLI = "@magpie-community/opencode-agy-cli-auth"

export const RETIRED =
  "Antigravity with a Google account has been retired in magpie: Google bans accounts it sees used this way. " +
  `Install "Antigravity (local agy CLI)" from Plugins (magpie plugin add ${AGY_CLI}), which runs your own agy CLI over ACP, then remove this plugin.`

// the reply to every request: Gemini's error shape, which magpie and the
// AI SDK read, saying the model has been retired
function retiredResponse() {
  const body = {
    error: {
      code: 410,
      status: "ModelDeprecated",
      message: `Antigravity: this model has been retired. ${RETIRED}`,
    },
  }
  return new Response(JSON.stringify(body), { status: 410, headers: { "content-type": "application/json" } })
}

export async function AntigravityAuthPlugin() {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = { ...was, name: "Antigravity (retired)", npm: "@ai-sdk/google", models: {} }
    },
    provider: {
      id: PROVIDER,
      async models() {
        return {}
      },
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "Use Antigravity (local agy CLI) instead",
          async authorize() {
            throw new Error(RETIRED)
          },
        },
      ],
      async loader() {
        return {
          apiKey: "antigravity",
          async fetch() {
            return retiredResponse()
          },
        }
      },
    },
  }
}

export const _internal = { RETIRED, retiredResponse }
