import { afterEach, beforeEach, expect, test } from "bun:test"
import { ZCodeAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
const sent = []
let active, reply
beforeEach(() => {
  sent.length = 0
  active = [{ status: "VALID", productName: "GLM Coding Pro" }]
  reply = () => Response.json({ type: "message", content: [{ type: "text", text: "Hi" }] })
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), ...init })
    if (String(url).endsWith("/api/biz/subscription/list")) return Response.json({ code: 0, data: active })
    if (String(url).endsWith("/api/anthropic/v1/messages")) return reply()
    throw new Error("unexpected request: " + url)
  }
})
afterEach(() => { globalThis.fetch = real })
const api = (site = "zai") => ({ type: "api", key: "warm.secret", metadata: { site } })
async function warm(auth = api(), options) {
  const hooks = await ZCodeAuthPlugin({ client: {} }, { freeFirst: true })
  return hooks.auth.warmup(async () => auth, { id: "zcode", options: { freeFirst: true } }, options)
}

test("预热只走 Coding Plan，关闭思考并限制输出", async () => {
  expect(await warm()).toEqual({ outcome: "sent", model: "GLM-5-Turbo" })
  expect(sent).toHaveLength(2)
  const req = sent[1]
  expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/messages")
  expect(req.headers["x-api-key"]).toBe("warm.secret")
  expect(req.headers.Authorization).toBe("Bearer warm.secret")
  const body = JSON.parse(req.body)
  expect(body).toMatchObject({ model: "GLM-5-Turbo", max_tokens: 16, stream: false, thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }] })
  expect(JSON.parse(body.metadata.user_id).session_id).toBe(req.headers["x-session-id"])
})

test("同时持有赠送额度的 OAuth 账号也只预热订阅", async () => {
  const auth = { type: "oauth", refresh: JSON.stringify({ site: "zai", key: "coding.secret", jwt: "gift.token" }) }
  expect((await warm(auth)).outcome).toBe("sent")
  expect(sent).toHaveLength(2)
  expect(sent.every((r) => !r.url.startsWith("https://zcode.z.ai/"))).toBe(true)
  expect(sent[1].headers.Authorization).toBe("Bearer coding.secret")
  expect(sent.every((r) => r.signal instanceof AbortSignal)).toBe(true)
})

test("团队缺少已保存 key 时不创建 key 或发送消息", async () => {
  const auth = { type: "oauth", refresh: JSON.stringify({ site: "zai", org: "org", project: "project", token: "team.token" }) }
  expect((await warm(auth)).outcome).toBe("ineligible")
  expect(sent).toHaveLength(0)
})

test("BigModel 使用自己的订阅端点", async () => {
  expect((await warm(api("bigmodel"))).outcome).toBe("sent")
  expect(sent.every((r) => r.url.startsWith("https://open.bigmodel.cn/"))).toBe(true)
})

test("团队账号使用团队 key，不检查个人套餐", async () => {
  const auth = { type: "oauth", refresh: JSON.stringify({ site: "zai", org: "org", project: "project", key: "team.secret" }) }
  expect((await warm(auth)).outcome).toBe("sent")
  expect(sent).toHaveLength(1)
  expect(sent[0].headers["x-api-key"]).toBe("team.secret")
})

test("未登录及仅有赠送额度的账号不发送请求", async () => {
  expect((await warm(null)).outcome).toBe("ineligible")
  expect((await warm({ type: "oauth", refresh: JSON.stringify({ jwt: "gift.token" }) })).outcome).toBe("ineligible")
  expect(sent).toHaveLength(0)
})

test("过期套餐不发送消息，套餐查询失败不猜测资格", async () => {
  active = []
  expect((await warm()).outcome).toBe("ineligible")
  active = null
  expect((await warm()).outcome).toBe("failed")
  expect(sent.every((r) => !r.url.endsWith("/messages"))).toBe(true)
})

for (const [name, answer] of [
  ["HTTP 429", () => Response.json({ error: { message: "busy" } }, { status: 429 })],
  ["HTTP 200 错误体", () => Response.json({ code: 1113, msg: "no quota" })],
  ["伪装成 message 的错误", () => Response.json({ type: "message", content: [], error: { message: "denied" } })],
  ["非 JSON", () => new Response("<html>blocked</html>")],
  ["网络错误", () => { throw new Error("network down") }],
]) test(name + "返回失败且不自行重试", async () => {
  reply = answer
  expect((await warm()).outcome).toBe("failed")
  expect(sent.filter((r) => r.url.endsWith("/messages"))).toHaveLength(1)
})

test("调用方取消后不发送请求", async () => {
  const signal = AbortSignal.abort()
  expect((await warm(api(), { signal })).outcome).toBe("failed")
  expect(sent).toHaveLength(0)
})

test("加载插件不会自动发起预热", async () => {
  const hooks = await ZCodeAuthPlugin({ client: {} })
  expect(typeof hooks.auth.warmup).toBe("function")
  expect(sent).toHaveLength(0)
})
