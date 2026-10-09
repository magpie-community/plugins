import { afterEach, expect, test } from "bun:test"
import { _internal as w } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const P = w.PB
const fraction = (value) => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setFloat32(0, value, true)
  const p = new P().tag(1, 5)
  p.b.push(...bytes)
  return p
}
const finished = (metadata, tokens) => {
  const end = new P().m(2, new P()).m(11, metadata)
  if (tokens) end.m(8, tokens)
  return `data: ${Buffer.from(new P().m(3, end).out()).toString("base64url")}\n\n`
}
const ask = async (metadata, { stream = false, tokens, model = "auto-efficient", window } = {}) => {
  globalThis.fetch = async () => {
    if (!window) throw new Error("offline model discovery")
    return Response.json({ data: { user: { user: { workspaces: [{ featureModelChoice: { agentMode: { choices: [
      { id: model, contextWindow: { default: window } },
    ] } } }] } } } })
  }
  const plugin = await w.createPlugin({ client: { auth: { set: async () => {} } } }, {
    post: async () => ({ status: 200, body: async function* () { yield Buffer.from(finished(metadata, tokens)) } }),
  })
  const loader = await plugin.auth.loader(async () => ({ access: "context-offline-" + (window || 0), expires: Date.now() + 3600_000 }))
  const res = await loader.fetch("https://offline.invalid/chat/completions", { body: JSON.stringify({
    model, stream, messages: [{ role: "user", content: "offline context probe" }],
  }) })
  expect(res.status).toBe(200)
  if (!stream) return (await res.json()).usage
  const events = (await res.text()).split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map(line => JSON.parse(line.slice(6)))
  return events.find(event => event.usage)?.usage
}

test("public context-only metadata produces marked input estimates in both completion formats", async () => {
  for (const stream of [false, true]) {
    const usage = await ask(fraction(0.125), { stream })
    expect(usage.prompt_tokens).toBe(62_500)
    expect(usage.context_window_usage).toBe(0.125)
    expect(usage.prompt_tokens_details).toEqual({ estimated: true, source: "warp_context_window_usage", context_window: 500_000 })
    expect(usage.completion_tokens).toBe(0)
    expect(usage.total_tokens).toBe(62_500)
  }
})

test("context conversion uses the discovered model window rather than the snapshot", async () => {
  const usage = await ask(fraction(0.25), { model: "context-probe-model", window: 16_000 })
  expect(usage.prompt_tokens).toBe(4_000)
  expect(usage.prompt_tokens_details.context_window).toBe(16_000)
})

test("exact input and output take precedence over a context fraction, including explicit zero input", async () => {
  for (const input of [71, 0]) {
    for (const stream of [false, true]) {
      const metadata = fraction(0.5).tag(10, 0).uv(input)
      const usage = await ask(metadata, { stream, tokens: new P().v(2, 999).v(3, 23) })
      expect(usage.prompt_tokens).toBe(input)
      expect(usage.completion_tokens).toBe(23)
      expect(usage.total_tokens).toBe(input + 23)
      expect(usage.prompt_tokens_details).toBeUndefined()
      expect(usage.context_window_usage).toBe(0.5)
    }
  }
})

test("invalid context fractions cannot manufacture usage; zero is retained", async () => {
  for (const value of [NaN, Infinity, -0.5]) expect(await ask(fraction(value))).toBeUndefined()
  expect((await ask(fraction(0))).prompt_tokens).toBe(0)
  expect(await ask(fraction(0.25), { model: "unknown-window" })).toBeUndefined()
})
