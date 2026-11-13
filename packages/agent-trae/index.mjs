// Magpie loads this module twice over:
//
//   * the default export is the Bun-side companion: it keeps MCP servers in
//     step and starts the page service that previews a model mirror;
//   * every named exported function is loaded as its own provider plugin.
//     TraeAgentAuthPlugin declares the "trae-agent" provider, this package's
//     own Trae-account sign-in. It is the only credential source: `magpie
//     plugin login trae-agent` signs in with the same account a Trae IDE
//     login would use. The sign-in is stored under "trae-agent" in
//     plugin-auth.json and is never shared with or taken from any other
//     app or plugin.

import { pathsFor, startBridge } from "./bridge.mjs"
import { startPageServer } from "./trae-page.mjs"
import { ownSigninFlow } from "./trae-auth.mjs"
import { AUTH_PROVIDER_ID } from "./trae-api.mjs"

const STARTED = Symbol.for("magpie-agent-trae.bridge.v1")
const PAGE = Symbol.for("magpie-agent-trae.page.v1")

export default async function TraeAgentCompanion(input, options = {}) {
  const paths = pathsFor({ magpieConfig: input?.directory })
  if (!globalThis[STARTED]) {
    try {
      // input.directory is Magpie's config directory; reading the Gateway key
      // from there also works when the user moved Magpie's data folder.
      globalThis[STARTED] = startBridge(paths)
    } catch (err) {
      // The agent row still works without the companion; say why it did not.
      console.error(`trae companion: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!globalThis[PAGE]) {
    try {
      const wanted = Number(options?.port ?? 3499)
      globalThis[PAGE] = startPageServer({
        port: Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : 3499,
        paths,
      })
    } catch (err) {
      console.error(`trae page: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {}
}

// makeTraeAgentAuthPlugin builds the provider plugin Magpie loads for the
// "trae-agent" sign-in. The provider serves no chat of its own; it only holds
// the sign-in (browser method), keeps the token renewed, and exposes it
// through auth.loader for anything that asks.
export function TraeAgentAuthPlugin() {
  return {
    auth: {
      provider: AUTH_PROVIDER_ID,
      refreshLead: 10 * 60 * 1000,
      refresh: ownSigninFlow.refresh,
      loader: async (getAuth) => {
        const auth = await getAuth()
        if (!auth?.access) return {}
        return {
          // The provider is not a chat endpoint; the header factory is what
          // matters, and baseURL only has to be a plausible OpenAI face.
          baseURL: "https://coresg-normal.trae.ai/v1",
          apiKey: "unused",
          async fetch(input, init = {}) {
            const headers = new Headers(init?.headers || (typeof input === "object" && input?.headers) || {})
            headers.set("Authorization", `Cloud-IDE-JWT ${auth.access}`)
            return fetch(input, { ...init, headers })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Trae 账号（浏览器登录，与 Trae IDE 相同账号）",
          authorize: () => ownSigninFlow.authorize(),
        },
      ],
    },
  }
}
