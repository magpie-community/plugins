// An enterprise (SaaS) subscription signs in on the same authorization
// page as a personal one, when the page is not told to hide that sign-in
// (@shad70w0 on X). A host the sign-in names on Trae's own domains is kept
// and used; one anywhere else is not, and a personal sign-in is as before.
// Not tried with a real enterprise account: the hosts below are made up.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, _internal } from "./index.mjs"
import { fakeTrae, signedIn } from "./fake.mjs"

const CN = _internal.SITES["trae-cn"]
const GLOBAL = _internal.SITES["trae-global"]

let f
afterEach(() => f?.close())

async function start() {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const a = await hooks.auth.methods[0].authorize()
  return { a, q: new URL(a.url).searchParams, cb: new URL(new URL(a.url).searchParams.get("auth_callback_url")) }
}

async function signIn(info, extra = {}) {
  const { a, cb } = await start()
  const jwt = { Token: "jwt-1", RefreshToken: "r-1", TokenExpireAt: Math.floor(Date.now() / 1000) + 7200, ClientID: "ono9krqynydwx5" }
  const url = new URL(cb)
  url.searchParams.set("userJwt", JSON.stringify(jwt))
  url.searchParams.set("userInfo", JSON.stringify(info))
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  await fetch(url)
  return a.callback()
}

test("the sign-in page doesn't hide the enterprise (SaaS) sign-in", async () => {
  f = fakeTrae()
  const { a, q } = await start()
  expect(q.get("hide_saas_login")).not.toBe("true")
  await fetch(new URL(q.get("auth_callback_url")) + "?error=x")
  await a.callback()
})

test("only an https host on Trae's own domains is taken", () => {
  const t = _internal.traeHost
  expect(t("https://trae-api-cn.mchost.guru")).toBe("https://trae-api-cn.mchost.guru")
  expect(t("https://ent-acme.trae.cn/")).toBe("https://ent-acme.trae.cn")
  expect(t("https://ent.trae.ai")).toBe("https://ent.trae.ai")
  for (const bad of ["http://ent.trae.cn", "https://trae.cn.evil.com", "https://eviltrae.cn", "https://trae-api-cn.evil.com", "https://u:p@ent.trae.cn", "https://ent.trae.cn:8443", "https://ent.trae.cn/?x=1", "ent.trae.cn", "", undefined]) {
    expect(t(bad)).toBe("")
  }
})

test("a sign-in naming an enterprise Trae CN host keeps it, and requests go there", async () => {
  f = fakeTrae()
  const info = { UserID: "u-e", ScreenName: "Acme", Host: "https://ent-acme.trae.cn", TenantID: "t-1", LoginType: "saas", TenantToken: "no" }
  const got = await signIn(info)
  expect(got.type).toBe("success")
  expect(got.api).toBe("https://ent-acme.trae.cn")
  expect(got.host).toBe("https://ent-acme.trae.cn")
  // the account's kind is kept, never a field that looks like a secret
  expect(got.account).toEqual({ TenantID: "t-1", LoginType: "saas" })
  expect(CN.apiOf(got)).toBe("https://ent-acme.trae.cn")
  // a request goes to that host (nonet stops it before it leaves)
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn({ api: got.api }))
  const e = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }) }).catch((e) => e)
  expect(String(e?.message)).toContain("https://ent-acme.trae.cn/api/agent/v3/llm_utils_chat")
})

test("a personal sign-in is as before", async () => {
  f = fakeTrae()
  const got = await signIn({ UserID: "u-1", ScreenName: "Ann", Region: "CN", Host: "https://api.trae.cn" })
  expect(got.api).toBeUndefined()
  expect(got.authHost).toBeUndefined()
  expect(got.account).toBeUndefined()
  expect(CN.apiOf(got)).toBe(CN.hosts.api)
  expect(CN.apiOf({ api: "https://trae-api-cn.mchost.guru" })).toBe("https://trae-api-cn.mchost.guru")
  for (const h of ["https://www.trae.cn", "https://api.trae.cn", "https://growcn-normal.trae.cn"]) expect(CN.modelHost(h)).toBe(false)
  // Global's personal hosts route as they did
  expect(GLOBAL.apiOf({ api: "https://api-us-east.trae.ai" })).toBe(GLOBAL.hosts.us)
  expect(GLOBAL.apiOf({ api: "https://api-sg-central.trae.ai" })).toBe(GLOBAL.hosts.api)
  expect(GLOBAL.apiOf({ api: "https://growsg-normal.trae.ai" })).toBe(GLOBAL.hosts.api)
  expect(GLOBAL.apiOf({ api: "https://coresg-normal.trae.ai" })).toBe("https://coresg-normal.trae.ai")
  expect(GLOBAL.apiOf({ api: "https://ent-acme.trae.ai" })).toBe("https://ent-acme.trae.ai")
})

test("a host off Trae's domains is refused, and the consumer one is used", async () => {
  f = fakeTrae()
  const got = await signIn({ UserID: "u-x", ScreenName: "X", Host: "https://trae-api-cn.evil.com" }, { authHost: "https://api.evil.com" })
  expect(got.type).toBe("success")
  expect(got.api).toBeUndefined()
  expect(got.host).toBeUndefined()
  expect(got.authHost).toBeUndefined()
  expect(CN.apiOf({ api: "https://trae-api-cn.evil.com" })).toBe(CN.hosts.api)
  expect(CN.apiOf({ api: "http://ent-acme.trae.cn" })).toBe(CN.hosts.api)
  expect(GLOBAL.apiOf({ api: "https://coresg.evil.com" })).toBe(GLOBAL.hosts.api)
  expect(GLOBAL.modelHost("https://trae.ai.evil.com")).toBe(false)
})

test("a token host the sign-in named is where the token is renewed", async () => {
  f = fakeTrae()
  const got = await signIn({ UserID: "u-e", ScreenName: "Acme", Host: "https://ent-acme.trae.cn" }, { authHost: "https://auth-acme.trae.cn" })
  expect(got.authHost).toBe("https://auth-acme.trae.cn")
  const hooks = await TraeCNAuthPlugin({ client: {} })
  // nonet stops the renewal before it leaves, naming where it went
  const e = await hooks.auth.refresh(signedIn({ authHost: got.authHost, refresh: "r-ent" })).catch((e) => e)
  expect(String(e?.message)).toContain("https://auth-acme.trae.cn/")
  // a token host off the site's domain is not taken
  const g = await signIn({ UserID: "u-e", ScreenName: "Acme" }, { authHost: "https://auth.trae.ai" })
  expect(g.authHost).toBeUndefined()
})
