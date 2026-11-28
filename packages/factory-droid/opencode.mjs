import { baseURL, createCatalog, npm } from "./catalog.mjs"
import { connect, failure } from "./acp.mjs"
import { prepare, estimateTokens, errorBody } from "./messages.mjs"
import { imageId, imageModel, imageResponse } from "./images.mjs"
import { webSearch } from "./native-tools.mjs"
import { accountQuota } from "./quota.mjs"
import { runMessages } from "./turns.mjs"

const id = "factory-droid"
const local = "factory-droid-local-login"
const name = "Factory Droid (local CLI)"

async function apiKey(auth) {
  const saved = typeof auth === "function" ? await auth() : auth
  return saved?.type === "api" && saved.key !== local ? saved.key : undefined
}

async function serve(request, init, key) {
  const signal = init?.signal ?? request?.signal
  try {
    const url = new URL(request instanceof Request ? request.url : request)
    const path = url.pathname.replace(/\/$/, "")
    if (/\/images\/(generations|edits)$/.test(path)) {
      const req = request instanceof Request && !init ? request : new Request(request, { method: "POST", ...init })
      return await imageResponse(req, path.endsWith("/edits"), key, signal)
    }
    const count = path.endsWith("/messages/count_tokens")
    if (!count && !path.endsWith("/messages")) throw failure(404, "Unknown Messages endpoint.")
    let body
    try {
      body = init?.body != null ? await new Response(init.body).json() : await request.json()
    } catch { throw failure(400, "Expected a JSON Messages request.") }
    const prepared = prepare(body)
    if (count) return Response.json({ input_tokens: estimateTokens(prepared) })
    const headers = new Headers(init?.headers ?? request?.headers)
    return await runMessages({ key, headers, body, prepared, signal })
  } catch (error) {
    signal?.throwIfAborted()
    return Response.json(errorBody(error), { status: error.status || 502 })
  }
}

async function server() {
  const catalog = createCatalog()
  return {
    config: async (config) => {
      config.provider ??= {}
      const prev = config.provider[id]
      config.provider[id] = { npm, name, ...prev, models: { default: { name: "Droid default" }, ...prev?.models } }
    },
    search: { droid: { name: "Factory Droid", auth: id, execute: async (input, ctx) => webSearch(input, await apiKey(ctx?.getAuth), ctx?.abort) } },
    auth: {
      provider: id,
      methods: [
        { type: "oauth", label: "Use local Droid login", authorize: async () => ({
          url: "", method: "auto", instructions: "Sign in with droid on the machine running this provider.",
          callback: async () => {
            let rpc
            try {
              rpc = connect({})
              await rpc.initialize()
              await rpc.newSession()
              return { type: "success", key: local }
            }
            catch (error) { return { type: "failed", error: error.message } }
            finally { rpc?.close() }
          },
        }) },
        { type: "api", label: "Factory API key" },
      ],
      usage: async getAuth => {
        const auth = typeof getAuth === "function" ? await getAuth() : getAuth
        return accountQuota(await apiKey(auth) || process.env.FACTORY_API_KEY, auth?.metadata?.region)
      },
      loader: async (getAuth) => ({ baseURL, apiKey: local,
        fetch: async (request, init) => serve(request, init, await apiKey(getAuth)) }),
    },
    provider: { id, npm, warming: catalog.warming, models: async (_provider, ctx) => {
      const models = await catalog.models(await apiKey(ctx?.auth), ctx?.signal)
      if (models[imageId]) models[imageId] = imageModel
      return models
    } },
  }
}

export default { id, server }
