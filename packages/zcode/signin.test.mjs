// A request's failures, as magpie's built-in ZCode account answered them
// (internal/provider/zcode.go zcodeProvider): the plan's 401 goes on as it
// came, saying X-Magpie-Sign-In: kept, as the built-in never marked a
// ZCode account lapsed; a Start Plan sign-in past its end fails in
// errZCodeExpired's words.
import { afterEach, beforeAll, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin } = await import("./index.mjs"))
})
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const jwt = (exp) => ["{}", JSON.stringify({ exp })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"

async function send(auth, reply) {
  globalThis.fetch = async () => reply()
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  return opts.fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", body: "{}" })
}

const key = { type: "api", key: "one.secret", metadata: { site: "zai" } }

test("the plan's 401 goes on as it came, the account kept", async () => {
  const res = await send(key, () => Response.json({ error: { message: "token expired or incorrect" } }, { status: 401 }))
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(await res.json()).toEqual({ error: { message: "token expired or incorrect" } })
})

// nor cleared one: an answer that went through leaves the mark as it is
test("other answers go as they came, the account kept", async () => {
  for (const status of [200, 429]) {
    const res = await send(key, () => new Response("x", { status }))
    expect(res.status).toBe(status)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect(await res.text()).toBe("x")
  }
})

test("a Start Plan sign-in past its end fails as errZCodeExpired", async () => {
  const s = { site: "zai", jwt: jwt(Math.floor(Date.now() / 1000) - 60) }
  const auth = { type: "oauth", access: s.jwt, refresh: JSON.stringify(s), expires: 0 }
  await expect(send(auth, () => new Response(""))).rejects.toThrow("ZCode's sign-in has expired; sign in to ZCode again (or add the account again in magpie)")
})

// rtbeilin (X, 10-24): a key whose account has only ZCode's gift plan is
// refused 1113 by the coding plan; the answer says why, status kept
test("a key's 1113 says a ZCode gift plan needs ZCode's sign-in", async () => {
  const body = { error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." } }
  const res = await send(key, () => Response.json(body, { status: 429 }))
  expect(res.status).toBe(429)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const got = await res.json()
  expect(got.error.code).toBe("1113")
  expect(got.error.message).toStartWith("Insufficient balance or no resource package. Please recharge. — this key's account has no GLM Coding Plan;")
  expect(got.error.message).toContain("ZCode app's sign-in")
  // the code as Z.ai's 401 names its own (error.type), and in BigModel's envelope
  const typed = await send(key, () => Response.json({ error: { type: "1113", message: "no package" } }, { status: 429 }))
  expect((await typed.json()).error.message).toStartWith("no package — this key's account has no GLM Coding Plan;")
  const env = await send(key, () => Response.json({ code: 1113, msg: "余额不足", success: false }, { status: 429 }))
  expect((await env.json()).msg).toStartWith("余额不足 — this key's account has no GLM Coding Plan;")
  // another refusal, and a ZCode sign-in's 1113, go as they came
  const other = await send(key, () => Response.json({ error: { code: "1302", message: "rate" } }, { status: 429 }))
  expect(await other.json()).toEqual({ error: { code: "1302", message: "rate" } })
  const s = { site: "zai", key: "one.secret", jwt: jwt(Math.floor(Date.now() / 1000) + 3600) }
  const withJwt = { type: "oauth", access: s.key, refresh: JSON.stringify(s), expires: 0 }
  globalThis.fetch = async (u) => {
    // the plan list says a plan, so the request stays on the coding plan
    if (String(u).includes("/subscription/list")) return Response.json({ code: 200, data: [{ productName: "GLM Coding Lite", status: "VALID" }] })
    if (String(u).includes("/billing/balance")) return Response.json({ code: 0, data: { plans: [], balances: [] } })
    return Response.json(body, { status: 429 })
  }
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => withJwt, { id: "zcode" })
  const own = await opts.fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", body: "{}" })
  expect(await own.json()).toEqual(body)
})
