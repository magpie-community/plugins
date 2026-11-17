// deepseek-v4.1-flash as each build serves it, against each build's own
// /v3/config (testdata/config-561.json: copilot.tencent.com's and
// www.workbuddy.ai's, 2026-10-31, cut to the models compared here).
//   plugins#561: 0.2.7 capped it at 100000 on the China build from one
//   report's error. China Free-plan accounts of three other users took
//   110,041 to 992,389-token prompts there, and the vendor's own refusal of
//   a 1,157,831-token one named 1048576 as the maximum, so both builds give
//   it the config's million again (0.2.8), and a prompt WorkBuddy finds too
//   long is its own 400, passed on as it came.
//   plugins#563: it takes reasoning_effort "none" (0 reasoning tokens),
//   though the config says onlyReasoning, so it lists an off level.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { WorkBuddyAuthPlugin, _internal } from "./index.mjs"
import { unz } from "./testdata/unz.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const configs = JSON.parse(readFileSync(new URL("./testdata/config-561.json", import.meta.url), "utf8"))

async function listed(site) {
  globalThis.fetch = async () => new Response(JSON.stringify(configs[site]))
  const out = await _internal.liveModels(_internal.SITES[site], { access: "a", uid: "u" })
  return Object.fromEntries(out.map((m) => [m.id, m]))
}

test("the China build's deepseek-v4.1-flash takes the config's million, as its other models do", async () => {
  const m = await listed("workbuddy")
  expect(m["deepseek-v4.1-flash"].context).toBe(1000000)
  expect(m["glm-5.3-flash"].context).toBe(1000000)
  expect(m["deepseek-v4-pro"].context).toBe(1000000)
})

test("WorkBuddy AI's deepseek-v4.1-flash keeps the config's million", async () => {
  const m = await listed("workbuddy-ai")
  expect(m["deepseek-v4.1-flash"].context).toBe(1000000)
  expect(m["deepseek-v4.1-flash-sg"].context).toBe(1000000)
})

test("a context the config gives is what is listed, whatever its size", async () => {
  const cfg = structuredClone(configs.workbuddy)
  for (const d of cfg.data.models) if (d.id === "deepseek-v4.1-flash") d.maxInputTokens = 1048576
  globalThis.fetch = async () => new Response(JSON.stringify(cfg))
  const out = await _internal.liveModels(_internal.SITES.workbuddy, { access: "a", uid: "u" })
  expect(out.find((m) => m.id === "deepseek-v4.1-flash").context).toBe(1048576)
})

test("neither build caps a model below its config", () => {
  for (const site of ["workbuddy", "workbuddy-ai"]) {
    expect(_internal.SITES[site].contextCap).toBeUndefined()
    const listed = _internal.configModels(_internal.SITES[site])
    for (const [id, , context] of _internal.SITES[site].models) expect(listed[id].limit.context).toBe(context)
  }
  expect(_internal.configModels(_internal.SITES.workbuddy)["deepseek-v4.1-flash"].limit.context).toBe(1000000)
})

// The refusal's words are the ones 1529119384 got from copilot.tencent.com
// (plugins#561); the envelope around them is WorkBuddy's {code, msg,
// extError} as it words other 400s, and the bare OpenAI shape.
const TOO_LONG = "prompt is too long: 1157831 tokens > 1048576 maximum"
for (const [shape, body] of [
  ["WorkBuddy's own envelope", { code: 11102, msg: TOO_LONG, extError: { code: "400001", message: TOO_LONG, type: "invalid_request_error", StatusCode: 400 } }],
  ["an OpenAI error", { error: { message: TOO_LONG, type: "invalid_request_error" } }],
]) {
  test(`a prompt WorkBuddy finds too long is its 400 as it came, once, the sign-in kept (${shape})`, async () => {
    const sent = []
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(unz(init.body)))
      return new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } })
    }
    const hooks = await WorkBuddyAuthPlugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "access", uid: "uid", expires: Date.now() + 3600_000 }))
    const res = await loader.fetch("https://copilot.tencent.com/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(sent.length).toBe(1)
    expect(res.status).toBe(400)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    // word for word, so magpie reads it as the context overflowing (its
    // tooLongRe: "prompt is too long"), not as quota or a refusal
    const text = await res.text()
    expect(JSON.parse(text)).toEqual(body)
    expect(text).not.toMatch(/insufficient_quota|permission_error/)
  })
}

test("deepseek-v4.1-flash lists none on both builds, its paid id too", async () => {
  const cn = await listed("workbuddy")
  const ai = await listed("workbuddy-ai")
  expect(cn["deepseek-v4.1-flash"].efforts).toEqual(["none", "low", "high", "max"])
  expect(ai["deepseek-v4.1-flash"].efforts).toEqual(["none", "low", "high", "max"])
  expect(ai["deepseek-v4.1-flash-sg"].efforts).toEqual(["none", "low", "high", "max"])
  // its default stays what the config says
  expect(cn["deepseek-v4.1-flash"].effort).toBe("high")
  expect(Object.keys(_internal.configModels(_internal.SITES.workbuddy)["deepseek-v4.1-flash"].variants)).toEqual(["none", "low", "high", "max"])
})

test("glm-5.3-flash, which can't turn thinking off, still lists no none", async () => {
  const cn = await listed("workbuddy")
  const ai = await listed("workbuddy-ai")
  expect(cn["glm-5.3-flash"].efforts).toEqual(["low", "high", "max"])
  expect(ai["glm-5.3-flash"].efforts).toEqual(["low", "high", "max"])
  expect(cn["deepseek-v4-pro"].efforts).toEqual(["none", "high", "xhigh"])
})

// sayagoodbyeplz on Discord: WorkBuddy's deepseek-v4.1-flash read as a
// 384000-token reply. That is models.dev's, which magpie fills in for a
// model its list gives no output for: the list declared before an
// account's own is read (a key, a config that can't be read) said 0. It
// says the config's maxOutputTokens now, for every model the configs read
// give one.
test("the declared list's reply limits are the configs' maxOutputTokens", async () => {
  const efforts = JSON.parse(readFileSync(new URL("./testdata/config-efforts.json", import.meta.url), "utf8"))
  const said = { workbuddy: [configs.workbuddy], "workbuddy-ai": [configs["workbuddy-ai"], efforts] }
  let checked = 0
  for (const [site, cfgs] of Object.entries(said)) {
    const declared = _internal.configModels(_internal.SITES[site])
    for (const cfg of cfgs) {
      for (const d of cfg.data.models) {
        if (!declared[d.id]) continue
        expect([site, d.id, declared[d.id].limit.output]).toEqual([site, d.id, d.maxOutputTokens])
        checked++
      }
    }
  }
  expect(_internal.configModels(_internal.SITES.workbuddy)["deepseek-v4.1-flash"].limit.output).toBe(128000)
  expect(checked).toBeGreaterThan(5)
})
