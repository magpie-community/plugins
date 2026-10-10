// The check-in mapping is magpie's contract (provider-plugins.md): every
// answer the upstream gives lands on one of its outcomes, and the plugin
// factory registers both providers with every hook check.mjs looks for.
import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoclawAuthPlugin, AutoclawCnAuthPlugin, _internal } from "./index.mjs"

const { checkinOutcome, signinConfig, bareToken, codeValue, tokenFields } = _internal

test("both providers register with models and every hook", async () => {
  for (const [Plugin, id, api] of [
    [AutoclawAuthPlugin, "autoclaw", "https://autoglm-api.autoglm.ai"],
    [AutoclawCnAuthPlugin, "autoclaw-cn", "https://autoglm-api.zhipuai.cn"],
  ]) {
    const hooks = await Plugin({ client: { auth: { set: async () => {} } } })
    expect(hooks.auth.provider).toBe(id)
    expect(hooks.auth.loader).toBeFunction()
    expect(hooks.auth.usage).toBeFunction()
    expect(hooks.auth.checkin).toBeFunction()
    expect(hooks.auth.methods[0].prompts.length).toBeGreaterThan(0)
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider[id].api).toBe(api)
    expect(Object.keys(cfg.provider[id].models).length).toBeGreaterThan(0)
  }
})

test("checkinOutcome maps every upstream answer onto the contract", () => {
  expect(checkinOutcome({ success: true, reward_points: 400, continuous_days: 7 })).toEqual({
    outcome: "claimed", credit: 400, streak: 7, message: "已签到 +400 · 连续 7 天",
  })
  expect(checkinOutcome({ already_completed: true, reward_points: 200 })).toEqual({
    outcome: "done", credit: 200,
  })
  expect(checkinOutcome(null)).toEqual({ outcome: "failed", message: "签到接口无响应" })
  expect(checkinOutcome({ success: false, message: "风控拦截" })).toEqual({
    outcome: "failed", message: "风控拦截",
  })
})

test("signinConfig: plugin options over the file, the file over the default", () => {
  const home = mkdtempSync(join(tmpdir(), "autoclaw-cfg-"))
  const prev = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = home
    // no file, no options: auto-signing stays off, left to the native switch
    expect(signinConfig(undefined)).toEqual({ signin: true, signinOnUsage: false, signinHour: null })

    mkdirSync(join(home, "magpie"), { recursive: true })
    const file = join(home, "magpie", "autoclaw.json")
    writeFileSync(file, JSON.stringify({ signin: false, signinHour: 8 }))
    expect(signinConfig(undefined)).toEqual({ signin: false, signinOnUsage: false, signinHour: 8 })
    expect(signinConfig({ signin: true, signinOnUsage: true })).toEqual({
      signin: true, signinOnUsage: true, signinHour: 8,
    })
    // a broken file reads as no file
    writeFileSync(file, "{ not json")
    expect(signinConfig(undefined)).toEqual({ signin: true, signinOnUsage: false, signinHour: null })
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test("the JWT's exp is the token's truth, with the 10-minute skew", () => {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const access = `${b64url({ alg: "none" })}.${b64url({ exp: 2_000_000_000 })}.sig`
  expect(bareToken(`Bearer ${access}`)).toBe(access)
  expect(tokenFields({ access_token: `Bearer ${access}`, refresh_token: "Bearer r1" })).toEqual({
    access, refresh: "r1", expires: 2_000_000_000_000 - 10 * 60 * 1000,
  })
  expect(codeValue("123456")).toBe(123456)
  expect(codeValue("12a45")).toBe("12a45")
})
