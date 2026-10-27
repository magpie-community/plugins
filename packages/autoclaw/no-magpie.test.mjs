// Nothing the plugin sends upstream names magpie (#355): a refresh that
// fetches the profile, and a chat carrying magpie's own hint headers, are
// recorded whole (URL, every header, body) and searched for the word.
import { expect, test } from "bun:test"
import { AutoclawAuthPlugin, AutoclawCnAuthPlugin, _internal } from "./index.mjs"

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const jwt = (claims) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`
const DEVICE = "ab".repeat(32)

function record() {
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = [...new Headers(init?.headers)].map(([k, v]) => `${k}: ${v}`).join("\n")
    sent.push({ url, text: `${url}\n${headers}\n${String(init?.body ?? "")}`, body: String(init?.body ?? "") })
    if (url.pathname.endsWith("/refresh")) {
      return Response.json({ code: 0, msg: "ok", data: {
        access_token: jwt({ exp: 2_000_000_000, device_id: DEVICE }),
        refresh_token: jwt({ device_id: DEVICE, source_id: "autoclaw" }),
      } })
    }
    if (url.pathname === "/userapi/v1/user-profile") return Response.json({ code: 0, msg: "ok", data: { user_name: "Tester" } })
    return Response.json({ code: 0, msg: "ok", data: {} })
  }
  return { sent, restore: () => { globalThis.fetch = realFetch } }
}

test("a refresh and a chat send nothing upstream that names magpie", async () => {
  for (const Plugin of [AutoclawAuthPlugin, AutoclawCnAuthPlugin]) {
    const { sent, restore } = record()
    try {
      const hooks = await Plugin({ client: { auth: { set: async () => {} } } })
      const old = { type: "oauth", access: "a0", refresh: jwt({ device_id: DEVICE, source_id: "autoclaw" }), accountId: "已登录" }
      const t = await hooks.auth.refresh(old)
      expect(t.accountId).toBe("Tester")
      const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: t.access }))
      await loader.fetch("x", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Magpie-Session": "s1", "x-magpie-agent": "codex" },
        body: JSON.stringify({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }),
      })
    } finally {
      restore()
    }
    expect(sent.some((r) => r.url.pathname === "/userapi/v1/user-profile")).toBe(true)
    expect(sent.some((r) => r.url.pathname.endsWith("/chat/completions"))).toBe(true)
    for (const r of sent) expect(r.text.toLowerCase()).not.toContain("magpie")
    // user-profile carries the account's own device id, as AutoClaw's client does
    const profile = sent.find((r) => r.url.pathname === "/userapi/v1/user-profile")
    expect(JSON.parse(profile.body).device_id).toBe(DEVICE)
  }
})

test("the device id comes from the login, else the account's tokens", () => {
  const { accountDeviceId } = _internal
  expect(accountDeviceId("d1", jwt({ device_id: "d2" }))).toBe("d1")
  expect(accountDeviceId(undefined, "opaque", jwt({ device_id: "d2" }))).toBe("d2")
  expect(accountDeviceId(undefined, "opaque")).toBe("")
})
