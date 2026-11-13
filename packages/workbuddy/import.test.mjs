// Accounts from a file (magpie's auth.import; marchen_cc on X): WorkBuddy
// desktop's sign-in file or a copy of a sign-in comes in as a sign-in does,
// renewed with WorkBuddy and named by its account. An encrypted file, or
// the other build's, is refused with why.
// A cloud-hosted enterprise's account is served at its enterprise's host,
// as WorkBuddy's own client serves it (emilochen on X).
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const cn = _internal.SITES.workbuddy
const ai = _internal.SITES["workbuddy-ai"]

// WorkBuddy, as its answers come: each refresh rotates the tokens
const vendor = (asked, accounts = []) => async (url, init) => {
  const u = new URL(String(url))
  const h = new Headers(init?.headers)
  asked.push({ url: String(url), refresh: h.get("X-Refresh-Token"), domain: h.get("X-Domain") })
  const data =
    u.pathname.endsWith("/auth/token/refresh") ? (h.get("X-Refresh-Token") === "r-dead"
      ? null : { accessToken: "a2-" + h.get("X-Refresh-Token"), refreshToken: "r2-" + h.get("X-Refresh-Token"), expiresIn: 3600 })
    : u.pathname.endsWith("/plugin/accounts") ? { accounts }
    : u.pathname.endsWith("/v3/config") ? { agents: [], models: [] }
    : {}
  if (!data) return new Response(JSON.stringify({ code: 11013, msg: "refresh token invalid" }), { status: 401 })
  return new Response(JSON.stringify({ code: 0, data }))
}

const desktop = (over = {}) => JSON.stringify({
  account: { uid: "u-1", nickname: "Ann", type: "personal" },
  auth: { accessToken: "a-1", refreshToken: "r-1", expiresIn: 3600, refreshExpiresIn: 86400, domain: "www.codebuddy.cn", tokenType: "Bearer", ...over },
})

test("the plugin offers an import, with which file in each language", async () => {
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  expect(typeof hooks.auth.import).toBe("function")
  expect(hooks.auth.importFrom).toContain("workbuddy-desktop.info")
  expect(hooks.auth.importFroms.zh).toContain("登录文件")
})

test("desktop's sign-in file comes in renewed and named by its account", async () => {
  const asked = []
  globalThis.fetch = vendor(asked)
  const [r] = await _internal.importSignIns(cn, [desktop()])
  expect(r.type).toBe("success")
  expect(r.accountId).toBe("Ann")
  expect(r.uid).toBe("u-1")
  expect(r.refresh).toBe("r2-r-1")
  expect(r.access).toBe("a2-r-1")
  expect(r.domain).toBe("www.codebuddy.cn")
  expect(asked[0].url).toBe("https://copilot.tencent.com/v2/plugin/auth/token/refresh")
  expect(asked[0].refresh).toBe("r-1")
})

test("a copy of a sign-in with no account named is looked up in the account list", async () => {
  const asked = []
  globalThis.fetch = vendor(asked, [{ uid: "u-9", nickname: "Bob", type: "personal", lastLogin: true }, { uid: "u-9", nickname: "Bob", type: "team", enterpriseId: "e-1" }])
  const rs = await _internal.importSignIns(cn, [JSON.stringify({ "workbuddy-1": { type: "oauth", access: "x", refresh: "r-9", expires: 1 } }), "nope"])
  expect(rs[0].type).toBe("success")
  expect(rs[0].accountId).toBe("Bob")
  expect(rs[0].uid).toBe("u-9")
  expect(rs[1]).toEqual({ type: "failed", error: "not JSON" })
})

test("an encrypted desktop file, the other build's and a spent token are refused with why", async () => {
  globalThis.fetch = vendor([])
  const sealed = desktop({ accessToken: { $wbEncrypted: 1, envelope: "x" }, refreshToken: { $wbEncrypted: 1, envelope: "y" } })
  const [s] = await _internal.importSignIns(cn, [sealed])
  expect(s.type).toBe("failed")
  expect(s.error).toContain("encrypted")
  const [o] = await _internal.importSignIns(ai, [desktop()])
  expect(o.error).toContain("import it under WorkBuddy")
  const [d] = await _internal.importSignIns(cn, [desktop({ refreshToken: "r-dead" })])
  expect(d.type).toBe("failed")
  expect(d.accountId).toBe("Ann")
})

test("a cloud-hosted enterprise's account goes to its enterprise's host (emilochen on X)", () => {
  const ent = { domain: "acme.sso.copilot.tencent.com" }
  expect(_internal.endpointOf(cn, ent)).toBe("https://acme.sso.copilot.tencent.com")
  expect(_internal.endpointOf(cn, { domain: "acme.copilot.qq.com" })).toBe("https://acme.copilot.qq.com")
  expect(_internal.endpointOf(cn, { domain: "acme.sso.codebuddy.cn" })).toBe("https://acme.sso.codebuddy.cn")
  // Tencent's own (iOA), a personal account and an API key stay on the site
  expect(_internal.endpointOf(cn, { domain: "tencent.sso.copilot.tencent.com" })).toBe(cn.endpoint)
  expect(_internal.endpointOf(cn, { domain: "www.codebuddy.cn" })).toBe(cn.endpoint)
  expect(_internal.endpointOf(ai, { domain: "www.workbuddy.ai" })).toBe(ai.endpoint)
  expect(_internal.endpointOf(cn, { domain: "", source: "key" })).toBe(cn.endpoint)
  expect(_internal.moved(cn, ent, "https://copilot.tencent.com/v2/chat/completions")).toBe("https://acme.sso.copilot.tencent.com/v2/chat/completions")
})

test("a cloud-hosted enterprise's refresh and chats reach its host", async () => {
  const asked = []
  globalThis.fetch = vendor(asked)
  const auth = { type: "oauth", access: "a", refresh: "r-e", expires: Date.now() + 3600_000, uid: "u", enterpriseId: "e-1", domain: "acme.sso.copilot.tencent.com" }
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  await opts.fetch("https://copilot.tencent.com/v2/chat/completions", { method: "POST", body: '{"messages":[]}' })
  expect(asked.some((x) => x.url === "https://acme.sso.copilot.tencent.com/v2/chat/completions")).toBe(true)
  expect(asked.some((x) => x.url.startsWith("https://copilot.tencent.com/"))).toBe(false)
  asked.length = 0
  const [r] = await _internal.importSignIns(cn, [JSON.stringify({ access: "a", refresh: "r-e", uid: "u", nickname: "Eve", domain: "acme.sso.copilot.tencent.com" })])
  expect(r.type).toBe("success")
  expect(asked[0].url).toBe("https://acme.sso.copilot.tencent.com/v2/plugin/auth/token/refresh")
  expect(asked[0].domain).toBe("acme.sso.copilot.tencent.com")
})
