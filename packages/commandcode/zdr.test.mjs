// Zero Data Retention (magpie-community/plugins#246): with the provider's
// "Zero Data Retention" switch on in magpie, or CMD_ZDR=1 as for the CLI,
// every request carries x-cmd-zdr: 1, the Provider API's and Go's
// /alpha/generate alike (command-code 1.74.1 sends it on both, captured
// through a proxy). A model no ZDR upstream serves is refused, and that
// refusal reaches the agent as Command Code said it.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
let env
beforeEach(() => {
  env = process.env.CMD_ZDR
  delete process.env.CMD_ZDR
})
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  if (env === undefined) delete process.env.CMD_ZDR
  else process.env.CMD_ZDR = env
})

// Command Code's own answers, as they came on 2026-10-19 for
// poolside/laguna-s-2.1-free with x-cmd-zdr: 1: the Provider API's 422,
// and /alpha/generate's error line (a 200, the error in the stream)
const PROVIDER_422 =
  '{"error":{"message":"This model has no zero-data-retention upstream. Remove the x-cmd-zdr header or choose a different model.","type":"invalid_request_error","code":"cmd_zdr_no_providers"}}'
const GENERATE_LINE =
  '{"type":"error","error":{"type":"cmd_zdr_no_providers","code":"CMD_ZDR_NO_PROVIDERS","message":"This model has no zero-data-retention upstream. Disable CMD_ZDR or pick a different model.","statusCode":400,"isRetryable":false}}'

const OK_LINES = [{ type: "text-delta", text: "ok" }, { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } }]
  .map((l) => JSON.stringify(l))
  .join("\n")

// setup gives the plugin a magpie whose switch is as on.zdr says, and
// records each request's path and its x-cmd-zdr
function setup(on, reply = {}) {
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === "string" ? input : input.url ?? String(input)).pathname
    sent.push({ path, zdr: new Headers(init.headers).get("x-cmd-zdr") })
    if (path === "/alpha/generate") return new Response(reply.generate ?? OK_LINES + "\n")
    if (path.endsWith("/chat/completions")) return reply.provider ? reply.provider() : Response.json({ choices: [] })
    return new Response("", { status: 404 })
  }
  const asked = []
  const magpie = {
    option(provider, key) {
      asked.push([provider, key])
      return on.zdr === true && provider === "commandcode-plan" && key === "zdr"
    },
  }
  return { sent, asked, magpie }
}

async function ask(magpie, plan, model = "deepseek/deepseek-v4-flash") {
  const hooks = await CommandCodePlugin({ magpie })
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "k-" + plan, metadata: { plan } }))
  return opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
}

test("the plugin declares a Zero Data Retention switch, off unless turned on", async () => {
  const hooks = await CommandCodePlugin()
  const o = hooks.auth.options
  expect(o.map((x) => x.key)).toEqual(["zdr"])
  expect(o[0].label).toBe("Zero Data Retention")
  expect(o[0].default).not.toBe(true)
  expect(o[0].description).toContain("x-cmd-zdr: 1")
  expect(o[0].description.length).toBeLessThanOrEqual(300)
})

test("the Provider API is sent x-cmd-zdr: 1 while the switch is on, read at each request", async () => {
  const on = { zdr: true }
  const { sent, asked, magpie } = setup(on)
  const hooks = await CommandCodePlugin({ magpie })
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "k", metadata: { plan: "GOAT" } }))
  const go = () =>
    opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", messages: [] }) })
  await go()
  on.zdr = false
  await go()
  const chats = sent.filter((s) => s.path.endsWith("/chat/completions"))
  expect(chats.map((s) => s.zdr)).toEqual(["1", null])
  expect(asked).toContainEqual(["commandcode-plan", "zdr"])
})

test("a Go request to /alpha/generate carries x-cmd-zdr: 1 as the CLI's does, and none while off", async () => {
  const on = { zdr: true }
  const { sent, magpie } = setup(on)
  expect((await ask(magpie, "Go")).status).toBe(200)
  on.zdr = false
  expect((await ask(magpie, "Go")).status).toBe(200)
  expect(sent.filter((s) => s.path === "/alpha/generate").map((s) => s.zdr)).toEqual(["1", null])
})

test("CMD_ZDR=1 turns it on as for the CLI, and only \"1\" does", async () => {
  const { sent } = setup({})
  process.env.CMD_ZDR = "1"
  await ask(undefined, "GOAT")
  await ask(undefined, "Go")
  process.env.CMD_ZDR = "true"
  await ask(undefined, "GOAT")
  await ask(undefined, "Go")
  delete process.env.CMD_ZDR
  await ask(undefined, "GOAT")
  expect(sent.filter((s) => s.path === "/alpha/generate" || s.path.endsWith("/chat/completions")).map((s) => s.zdr)).toEqual(["1", "1", null, null, null])
})

test("the Provider API's 422 cmd_zdr_no_providers reaches the agent as it came", async () => {
  const { magpie } = setup({ zdr: true }, { provider: () => new Response(PROVIDER_422, { status: 422, headers: { "Content-Type": "application/json" } }) })
  const res = await ask(magpie, "GOAT", "poolside/laguna-s-2.1-free")
  expect(res.status).toBe(422)
  expect(await res.text()).toBe(PROVIDER_422)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})

test("Go's cmd_zdr_no_providers error line reaches the agent with its status, message and type", async () => {
  const { magpie } = setup({ zdr: true }, { generate: GENERATE_LINE + "\n" })
  const res = await ask(magpie, "Go", "poolside/laguna-s-2.1-free")
  expect(res.status).toBe(400)
  expect((await res.json()).error).toEqual({
    message: "This model has no zero-data-retention upstream. Disable CMD_ZDR or pick a different model.",
    type: "cmd_zdr_no_providers",
    code: 400,
  })
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})
