// The plugin reads the Comate desktop app's own account. These tests give it
// a home of their own: the app's files are fixtures under a temporary
// directory, and no request leaves the machine (fetch is stubbed).
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WpsComateAuthPlugin } from "./index.mjs"

const BASE = "https://comate.wps.cn/llmproxy/v1/user"
const realFetch = globalThis.fetch
const realUserProfile = process.env.USERPROFILE
const realHome = process.env.HOME
let home
let calls = []

function stubFetch(impl) {
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init })
    return impl(String(url), init)
  }
}

function writeConfig(apiKey, baseUrl = BASE) {
  mkdirSync(join(home, ".wpscomate"), { recursive: true })
  writeFileSync(join(home, ".wpscomate", "config.json"), JSON.stringify({ providers: { official: { apiKey, baseUrl } } }))
}

function writeAuth(token, savedAt = 1) {
  mkdirSync(join(home, ".wpscomate", "agent", "auth"), { recursive: true })
  writeFileSync(join(home, ".wpscomate", "agent", "auth", "user_auth.json"), JSON.stringify({ token, saved_at: savedAt }))
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
const signIn = (sid) => async () => ({ type: "api", key: sid })
const plugin = await WpsComateAuthPlugin()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wps-comate-"))
  process.env.USERPROFILE = home
  process.env.HOME = home
  calls = []
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

test("config declares wps-comate: openai-compatible npm, the cloud base URL and its eight models", async () => {
  const config = { provider: {} }
  await plugin.config(config)
  const p = config.provider["wps-comate"]
  expect(p.name).toBe("WPS Comate")
  expect(p.npm).toBe("@ai-sdk/openai-compatible")
  expect(p.api).toBe(BASE)
  expect(Object.keys(p.models)).toHaveLength(8)
  const flash = p.models["610387340/deepseek/deepseek-v4.1-flash//public"]
  // the id stays the cloud's own name: it is the request's model field
  expect(flash.name).toBe("DeepSeek V4.1 Flash")
  expect(flash.limit).toEqual({ context: 1_000_000, output: 32_768 })
  expect(flash.tool_call).toBe(true)
  // the listing flags the multimodal models
  expect(flash.attachment).toBe(true)
  expect(flash.modalities.input).toEqual(["text", "image"])
  expect(p.models["610387340/deepseek/deepseek-v4-pro//public"].attachment).toBe(false)
})

test("config keeps what the user already wrote for the provider", async () => {
  const config = { provider: { "wps-comate": { name: "Mine", models: { "my-model": { name: "My Model" } } } } }
  await plugin.config(config)
  const p = config.provider["wps-comate"]
  expect(p.name).toBe("Mine")
  expect(p.models["my-model"].name).toBe("My Model")
  expect(Object.keys(p.models)).toHaveLength(9)
})

test("models hands back the configured catalog", async () => {
  const config = { provider: {} }
  await plugin.config(config)
  expect(await plugin.provider.models({ models: config.provider["wps-comate"].models })).toBe(config.provider["wps-comate"].models)
})

test("a pasted wps_sid is the cookie, the desktop app's device key is the bearer, and stale keys are dropped", async () => {
  writeConfig("device-key-1")
  stubFetch(() => ok({ ok: true }))
  const loader = await plugin.auth.loader(signIn("V02S-pasted"))
  const res = await loader.fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stale", "x-api-key": "stale" },
    body: "{}",
  })
  expect(res.status).toBe(200)
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe(`${BASE}/chat/completions`)
  const headers = calls[0].init.headers
  expect(headers.get("cookie")).toBe("wps_sid=V02S-pasted")
  expect(headers.get("authorization")).toBe("Bearer device-key-1")
  expect(headers.get("x-api-key")).toBeNull()
})

test("a 401 with no account file to re-read is returned as it came, not retried forever", async () => {
  writeConfig("device-key-1")
  stubFetch(() => new Response("no", { status: 401 }))
  const loader = await plugin.auth.loader(signIn("V02S-old"))
  const res = await loader.fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  expect(res.status).toBe(401)
  expect(calls).toHaveLength(1)
})

test("the loader says which file is missing when no sign-in can be found", async () => {
  const loader = plugin.auth.loader(async () => null)
  await expect(loader).rejects.toThrow("user_auth.json")
})

const cardWindow = (card, name) => card.windows.find((w) => w.name === name)
// the windows are display-only; the figure is the number the line starts with
const figure = (card, name) => {
  const w = cardWindow(card, name)
  return w ? Number.parseFloat(w.display) : Number.NaN
}
const answer = (credits) => ok({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, credits } })
const chunk = (credits) =>
  `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "x" } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, credits } })}\n\n`
const verdict = () => ok({ code: 0, data: { decision: "continue", wouldSkip: false } })
const withBalance = (n) => ok({ code: 0, data: { decision: "continue", wouldSkip: false, balance: n } })
const post = (loader, session = "conv-a") =>
  loader.fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-session": session },
    body: "{}",
  })

test("the card is three spend lines, and no quota line when Comate gives no figure", async () => {
  writeConfig("device-key-1")
  stubFetch(() => verdict())
  const card = await plugin.auth.usage(signIn("V02S-t1"))
  expect(card.plan).toBe("WPS Comate")
  expect(card.windows.map((w) => w.name)).toEqual(["今日消耗", "本对话消耗", "总计消耗"])
  expect(card.windows[0].display).toContain("今天还没有请求")
  expect(card.windows.every((w) => w.amount === undefined)).toBe(true)
  expect(card.signIn).toBe("kept")
})

test("a balance from /credits becomes a remaining-quota line", async () => {
  writeConfig("device-key-1")
  stubFetch(() => withBalance(1234))
  const card = await plugin.auth.usage(signIn("V02S-t2"))
  const q = cardWindow(card, "剩余额度")
  expect(q.amount).toBeUndefined()
  expect(q.display).toBe("1234 智点")
})

test("no sign-in and no account file is a card with the spend only, never an error", async () => {
  const card = await plugin.auth.usage(async () => null)
  expect(card.error).toBeUndefined()
  expect(card.windows.map((w) => w.name)).toEqual(["今日消耗", "本对话消耗", "总计消耗"])
})

test("a refused /credits simply leaves the quota line out", async () => {
  writeConfig("device-key-1")
  stubFetch(() => new Response("no", { status: 401 }))
  const card = await plugin.auth.usage(signIn("V02S-t3"))
  expect(card.error).toBeUndefined()
  expect(cardWindow(card, "剩余额度")).toBeUndefined()
})

test("the card adds what each answer cost: usage.credits is the price the vendor reports", async () => {
  writeConfig("device-key-1")
  stubFetch((url) => (url.endsWith("/credits") ? verdict() : answer(0.01)))
  const loader = await plugin.auth.loader(signIn("V02S-t4"))
  await post(loader)
  await post(loader)
  const card = await plugin.auth.usage(signIn("V02S-t5"))
  expect(figure(card, "今日消耗")).toBeCloseTo(0.02, 6)
  expect(figure(card, "本对话消耗")).toBeCloseTo(0.02, 6)
  expect(figure(card, "总计消耗")).toBeCloseTo(0.02, 6)
  expect(cardWindow(card, "今日消耗").display).toContain("次请求")
})

test("two conversations are counted apart, and the last one is the card's", async () => {
  writeConfig("device-key-1")
  stubFetch((url) => (url.endsWith("/credits") ? verdict() : answer(0.01)))
  const loader = await plugin.auth.loader(signIn("V02S-t6"))
  await post(loader, "conv-a")
  await post(loader, "conv-a")
  await post(loader, "conv-b")
  const card = await plugin.auth.usage(signIn("V02S-t7"))
  expect(figure(card, "本对话消耗")).toBeCloseTo(0.01, 6)
  expect(figure(card, "今日消耗")).toBeCloseTo(0.03, 6)
  expect(figure(card, "总计消耗")).toBeCloseTo(0.03, 6)
})

test("a streamed answer is counted once, from the last chunk that carries its usage", async () => {
  writeConfig("device-key-1")
  stubFetch((url) =>
    url.endsWith("/credits")
      ? verdict()
      : new Response(chunk(0) + chunk(0) + chunk(0.03) + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
  )
  const loader = await plugin.auth.loader(signIn("V02S-t8"))
  await post(loader)
  const card = await plugin.auth.usage(signIn("V02S-t9"))
  expect(figure(card, "今日消耗")).toBeCloseTo(0.03, 6)
})

test("a refused request costs nothing", async () => {
  writeConfig("device-key-1")
  stubFetch((url) => (url.endsWith("/credits") ? verdict() : new Response("no", { status: 401 })))
  const loader = await plugin.auth.loader(signIn("V02S-t10"))
  await post(loader)
  const card = await plugin.auth.usage(signIn("V02S-t11"))
  expect(cardWindow(card, "今日消耗").display).toBe("今天还没有请求")
})

test("the spend file is read back: a restart keeps the totals", async () => {
  writeConfig("device-key-1")
  stubFetch((url) => (url.endsWith("/credits") ? verdict() : answer(0.02)))
  const loader = await plugin.auth.loader(signIn("V02S-t12"))
  await post(loader)
  // the write is debounced; flush it the way the plugin does on the next read
  const statePath = join(home, ".magpie", "wps-comate-usage.json")
  const seen = JSON.parse(readFileSync(statePath, "utf8"))
  expect(seen.total.credits).toBeCloseTo(0.02, 6)
})
