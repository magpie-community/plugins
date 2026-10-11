// The plugin's smoke test: no download, no Google — the ACP server is faked
// by test/fake-acp-server.mjs behind AGY_ACP_BIN, and the sign-in it keeps is
// faked in a temporary AGY_ACP_HOME. Exercises the config, sign-in, models,
// usage, and streaming / tool-call / non-streaming fetch paths end to end.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginPath = path.join(here, "..", "index.mjs")
const fail = (why) => {
  console.error(`FAIL: ${why}`)
  process.exit(1)
}
const ok = (what) => console.log(`ok - ${what}`)

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-smoke-"))
process.env.AGY_ACP_HOME = home
process.env.AGY_ACP_AUTH_DIR = path.join(home, ".gemini", "antigravity-acp")
fs.mkdirSync(process.env.AGY_ACP_AUTH_DIR, { recursive: true })
fs.writeFileSync(path.join(process.env.AGY_ACP_AUTH_DIR, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }))
fs.writeFileSync(path.join(process.env.AGY_ACP_AUTH_DIR, "acp_token.json"), JSON.stringify({ refresh_token: "x", email: "me@example.com" }))

// the fake server as an executable the launcher accepts (a shebang wrapper;
// the smoke test needs a POSIX shell for that, so on Windows it skips)
if (process.platform === "win32") {
  console.log("skip - the fake ACP server needs a POSIX shell; run the smoke test on macOS/Linux")
  process.exit(0)
}
const bin = path.join(home, "bin")
fs.mkdirSync(bin, { recursive: true })
const wrapper = path.join(bin, "agy_acp_server.par")
fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, "fake-acp-server.mjs")}" "$@"\n`, { mode: 0o755 })
process.env.AGY_ACP_BIN = wrapper

const { AntigravityAcpPlugin, _internal } = await import(pluginPath)

const work = path.join(home, "work")
const logs = []
const input = {
  client: {
    app: { log: async (o) => logs.push(String(o?.body?.message ?? o?.message ?? "")) },
    tui: { showToast: async (o) => logs.push(`toast: ${String(o?.body?.message ?? o?.message ?? "")}`) },
  },
  directory: work,
}
const plugin = await AntigravityAcpPlugin(input)

// config
{
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider["antigravity-acp"]
  if (!p || p.npm !== "@ai-sdk/openai-compatible" || !p.models["gemini-3.8-flash"]) fail(`config: ${JSON.stringify(p)}`)
  ok("config registers the provider with fallback models")
}

// the launcher finds the fake
{
  const found = _internal.resolveLaunch()
  if (!found || found.command !== wrapper || found.source !== "env") fail(`resolveLaunch: ${JSON.stringify(found)}`)
  ok(`resolveLaunch finds AGY_ACP_BIN (${found.args.join(" ") || "no args"})`)
}

// sign-in: use the sign-in Antigravity already has
{
  const method = plugin.auth.methods[1]
  const a = await method.authorize()
  if (a.method !== "auto" || !/me@example\.com|sign-in/.test(a.instructions)) fail(`authorize: ${JSON.stringify(a)}`)
  const r = await a.callback()
  if (r.type !== "success" || r.refresh !== "managed-by-the-acp-server" || r.accountId !== "me@example.com") fail(`sign-in: ${JSON.stringify(r)}`)
  ok(`sign-in with the current Google account (${r.accountId})`)
}

// models: the fake's effort-qualified ids, folded into families
const PROVIDER_INFO = { id: "antigravity-acp", models: {} }
let models
{
  models = await plugin.provider.models(PROVIDER_INFO, { auth: { type: "oauth", refresh: "x" } })
  const flash = models["gemini-3.8-flash"]
  const pro = models["gemini-3.1-pro"]
  if (!flash || flash.variants.low?.reasoningEffort !== "low" || flash.variants.medium?.reasoningEffort !== "medium" || flash.variants.high?.reasoningEffort !== "high") fail(`models: ${JSON.stringify(models)}`)
  if (!pro || !pro.variants.low || !pro.variants.high || pro.variants.medium) fail(`models: ${JSON.stringify(pro)}`)
  if (models["gemini-3.8-flash-low"]) fail("the effort-qualified ids should be folded away")
  ok(`models: ${Object.keys(models).join(", ")}`)
}

const loaderOptions = await plugin.auth.loader(async () => ({ type: "oauth", refresh: "x" }))
const URL_ = "https://antigravity-acp.invalid/v1/chat/completions"

// a streaming reply
{
  const res = await loaderOptions.fetch(URL_, {
    method: "POST",
    headers: {},
    body: JSON.stringify({
      model: "gemini-3.8-flash",
      stream: true,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hello" },
      ],
    }),
  })
  if (res.status !== 200 || !String(res.headers.get("content-type")).includes("text/event-stream")) fail(`fetch: ${res.status} ${res.headers.get("content-type")}`)
  const body = await res.text()
  for (const want of ["Hello ", "from fake at gemini-3.8-flash-high", '"finish_reason":"stop"', "[DONE]"]) {
    // the model chosen from the effort lands in the reply text, so the
    // assertion doubles as a check that the variant was set on the session
    if (!body.includes(want)) fail(`stream is missing ${JSON.stringify(want)}: ${body.slice(0, 600)}`)
  }
  if (body.includes("gemini-3.8-flash-low")) fail("the session kept the default model")
  ok("streaming reply with the effort's variant, thought, usage and [DONE]")
}

// a tool call through the MCP bridge
{
  const res = await loaderOptions.fetch(URL_, {
    method: "POST",
    headers: {},
    body: JSON.stringify({
      model: "gemini-3.1-pro",
      stream: true,
      reasoning_effort: "low",
      tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
      messages: [{ role: "user", content: "USE_TOOL please" }],
    }),
  })
  const body = await res.text()
  if (!body.includes('"tool_calls"') || !body.includes('"finish_reason":"tool_calls"')) fail(`tool call: ${body.slice(0, 600)}`)
  const call = JSON.parse(body.split("\n").find((l) => l.includes("tool_calls"))?.replace(/^data: /, "") ?? "{}")
  const tc = call.choices?.[0]?.delta?.tool_calls?.[0]
  if (tc?.function?.name !== "bash") fail(`tool name: ${JSON.stringify(call)}`)
  const args = JSON.parse(tc.function.arguments)
  if (args.command !== "echo hi" || args._from !== "fake-acp") fail(`tool args: ${JSON.stringify(args)}`)
  ok("client tool called through the bridge, delivered as tool_calls")
}

// a non-streaming reply, history with tool results trailing the last user message
{
  const res = await loaderOptions.fetch(URL_, {
    method: "POST",
    headers: {},
    body: JSON.stringify({
      model: "gemini-3.8-flash",
      stream: false,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
        { role: "tool", tool_call_id: "c1", name: "bash", content: "file.txt" },
      ],
    }),
  })
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? ""
  // the tool result rides in the context; the reply is the model's own text
  if (data.object !== "chat.completion" || data.choices?.[0]?.finish_reason !== "stop") fail(`non-stream: ${JSON.stringify(data)}`)
  if (!String(text).includes("Hello")) fail(`non-stream content: ${JSON.stringify(data)}`)
  if (!data.usage || data.usage.total_tokens !== 15) fail(`non-stream usage: ${JSON.stringify(data.usage)}`)
  ok("non-streaming reply with usage")
}

// usage, as the last prompt's quota said it
{
  const u = await plugin.auth.usage(async () => ({ type: "oauth", refresh: "x" }))
  if (u.plan !== "ultra" || u.windows?.[0]?.name !== "Antigravity quota" || u.windows[0].used !== 10) fail(`usage: ${JSON.stringify(u)}`)
  ok("usage reads the quota the prompt answered with")
}

// refresh is a no-op: the server owns the tokens, wherever it keeps them
{
  const nothing = await plugin.auth.refresh({ type: "oauth", refresh: "x" })
  if (nothing !== undefined) fail(`refresh: ${JSON.stringify(nothing)}`)
  ok("refresh leaves the sign-in to the server")
}

// projectModels directly
{
  const projected = _internal.projectModels([
    { modelId: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
    { modelId: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
    { modelId: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
    { modelId: "gemini-3.7-flash-tiered", name: "Gemini 3.7 Flash (Tiered)" },
  ])
  const ids = projected.map((m) => m.id)
  if (!ids.includes("gemini-3.7-flash") || !ids.includes("gemini-3.7-flash-tiered")) fail(`project: ${ids.join(", ")}`)
  ok(`projectModels folds families, keeps one-offs (${ids.join(", ")})`)
}

fs.rmSync(home, { recursive: true, force: true })
console.log("\nsmoke passed")
process.exit(0)
