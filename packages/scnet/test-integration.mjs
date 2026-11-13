// 集成测试：本地假站点复刻 SCNet 的模型 API 与控制台额度接口。
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

import { ScnetPlugin, _internal } from "./index.mjs"

const { API_BASE } = _internal
const TOKEN_PLAN_KEY = "sk-t-fake-0001"
const FREE_KEY = "sk-N-fake-0002"
const GOOD_COOKIE = "Token=fake-session; other=1"
const BAD_COOKIE = "Token=expired"

let server
let base
const realFetch = globalThis.fetch

before(async () => {
  server = createServer((req, res) => {
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const auth = req.headers.authorization ?? ""
    const cookie = req.headers.cookie ?? ""

    // 模型 API
    if (req.url === "/api/llm/v1/models") {
      if (auth === `Bearer ${TOKEN_PLAN_KEY}`) {
        return send({ object: "list", data: [{ id: "DeepSeek-V4.1-Flash-1017-Event" }] })
      }
      if (auth === `Bearer ${FREE_KEY}`) {
        return send({
          object: "list",
          data: [{ id: "GLM-5.3-Flash" }, { id: "Other-Model" }],
        })
      }
      return send({ error: { message: "Invalid API key" } }, 401)
    }

    // 控制台接口：只认 GOOD_COOKIE
    if (req.url.startsWith("/acx/")) {
      if (cookie !== GOOD_COOKIE) {
        return send({ code: "401", msg: "用户未登录!", data: null })
      }
      if (req.url.startsWith("/acx/user/customer/group/curuser-group-list")) {
        return send({ code: "0", msg: "success", data: [{ accountId: "acc-1" }] })
      }
      if (req.url === "/acx/charge/account/currentuser/tokenplan/list") {
        return send({
          code: "0",
          msg: "success",
          data: [
            {
              resourceAccountId: "res-1",
              orderId: "order-1",
              resourceId: "TP-Event-022",
              name: "DeepSeek-V4.1-Flash-1017首单5千万",
              status: "enable",
              usedAmount: "0.152",
              totalAmount: "50000",
              unit: "CREDITS",
              maxExpireTime: "2026-12-13 23:59:59",
            },
          ],
        })
      }
      if (req.url === "/acx/charge/account/llmapi/resource/list/statistics") {
        let raw = ""
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          const body = JSON.parse(raw || "{}")
          if (body.accountId !== "acc-1") {
            return send({ code: "1004", msg: "accountId can not be blank" })
          }
          send({
            code: "0",
            msg: "success",
            data: {
              list: [
                {
                  resourceId: "GLM-5.3-Flash",
                  purchaseCount: "100000000",
                  balance: "99999642",
                  unit: "MTOKENS",
                  expireTime: "2026-12-13T23:59:59",
                  status: "enable",
                },
              ],
            },
          })
        })
        return
      }
      return send({ code: "404", msg: "not found" })
    }

    send({ code: "404", msg: "not found" }, 404)
  })

  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`

  // 把两个真实域名改写到本地假站点
  globalThis.fetch = (input, init) => {
    const u = String(input)
      .replace("https://api.scnet.cn", base)
      .replace("https://www.scnet.cn", base)
      .replace("https://api.scnet.cn/api", base + "/api")
    return realFetch(u, init)
  }
})

after(async () => {
  globalThis.fetch = realFetch
  await new Promise((r) => server.close(r))
})

async function plugin() {
  return ScnetPlugin({})
}

// ---- 登录：两档 Key 不能混用 ------------------------------------------------

test("Token Plan 档用 sk-t 登录成功", async () => {
  const p = await plugin()
  const flow = await p.auth.methods[0].authorize({
    tier: "tokenplan",
    apiKey: TOKEN_PLAN_KEY,
    consoleCookie: GOOD_COOKIE,
  })
  const r = await flow.callback()
  assert.equal(r.type, "success")
  assert.equal(r.metadata.tier, "tokenplan")
  assert.equal(r.metadata.consoleCookie, GOOD_COOKIE)
  assert.equal(r.key, TOKEN_PLAN_KEY)
})

test("Token Plan 档拒绝通用 Key", async () => {
  const p = await plugin()
  const flow = await p.auth.methods[0].authorize({
    tier: "tokenplan",
    apiKey: FREE_KEY,
    consoleCookie: "",
  })
  const r = await flow.callback()
  assert.equal(r.type, "failed")
  assert.match(r.error, /不是 Token Plan 专属 Key/)
})

test("免费额度档用通用 Key 登录成功", async () => {
  const p = await plugin()
  const flow = await p.auth.methods[0].authorize({
    tier: "free",
    apiKey: FREE_KEY,
    consoleCookie: GOOD_COOKIE,
  })
  const r = await flow.callback()
  assert.equal(r.type, "success")
  assert.equal(r.metadata.tier, "free")
})

test("免费额度档拒绝 Token Plan Key", async () => {
  const p = await plugin()
  const flow = await p.auth.methods[0].authorize({
    tier: "free",
    apiKey: TOKEN_PLAN_KEY,
    consoleCookie: "",
  })
  const r = await flow.callback()
  assert.equal(r.type, "failed")
  assert.match(r.error, /不能用于免费额度/)
})

test("免费额度档拒绝看不到 GLM-5.3-Flash 的 Key", async () => {
  // 用 Token Plan Key 之外的另一个 key，让服务器返回不含 GLM 的列表
  const p = await plugin()
  const flow = await p.auth.methods[0].authorize({
    tier: "free",
    apiKey: "sk-N-no-glm",
    consoleCookie: "",
  })
  const r = await flow.callback()
  assert.equal(r.type, "failed")
  assert.match(r.error, /API Key 不可用|看不到免费模型/)
})

test("Cookie 无效时登录失败，提前暴露过期", async () => {
  const p = await plugin()
  const flow = await p.auth.methods[0].authorize({
    tier: "tokenplan",
    apiKey: TOKEN_PLAN_KEY,
    consoleCookie: BAD_COOKIE,
  })
  const r = await flow.callback()
  assert.equal(r.type, "failed")
  assert.match(r.error, /控制台 Cookie 不可用/)
})

test("不填 Cookie 也能登录，只做模型", async () => {
  const p = await plugin()
  const flow = await p.auth.methods[0].authorize({
    tier: "free",
    apiKey: FREE_KEY,
    consoleCookie: "",
  })
  const r = await flow.callback()
  assert.equal(r.type, "success")
  assert.equal(r.metadata.consoleCookie, undefined)
})

// ---- 模型：免费档只暴露免费模型 ---------------------------------------------

test("Token Plan 账号列出套餐模型", async () => {
  const p = await plugin()
  const auth = { type: "api", key: TOKEN_PLAN_KEY, metadata: { tier: "tokenplan" } }
  const models = await p.provider.models({ models: {} }, { auth })
  assert.deepEqual(Object.keys(models), ["DeepSeek-V4.1-Flash-1017-Event"])
  assert.equal(models["DeepSeek-V4.1-Flash-1017-Event"].api.url, API_BASE)
})

test("免费额度账号只列出 GLM-5.3-Flash，避免误用其他模型", async () => {
  const p = await plugin()
  const auth = { type: "api", key: FREE_KEY, metadata: { tier: "free" } }
  const models = await p.provider.models({ models: {} }, { auth })
  assert.deepEqual(Object.keys(models), ["GLM-5.3-Flash"])
})

// ---- 额度 ------------------------------------------------------------------

test("Token Plan 额度：Credits 用量与剩余", async () => {
  const p = await plugin()
  const auth = {
    type: "api",
    key: TOKEN_PLAN_KEY,
    metadata: { tier: "tokenplan", consoleCookie: GOOD_COOKIE },
  }
  const u = await p.auth.usage(async () => auth)
  assert.equal(u.plan, "DeepSeek-V4.1-Flash-1017首单5千万")
  assert.equal(u.windows.length, 1)
  assert.match(u.windows[0].display, /已用 0\.15 \/ 共 50,000 Credits/)
  assert.equal(u.balance, "49,999.85 Credits")
  assert.equal(u.until, "2026-12-13 23:59:59")
  assert.equal(u.error, undefined)
})

test("免费额度：先取 accountId，再查资源统计", async () => {
  const p = await plugin()
  const auth = {
    type: "api",
    key: FREE_KEY,
    metadata: { tier: "free", consoleCookie: GOOD_COOKIE },
  }
  const u = await p.auth.usage(async () => auth)
  assert.match(u.plan, /GLM-5\.3-Flash/)
  assert.match(u.windows[0].display, /已用 358 \/ 共 100,000,000 MTOKENS/)
  assert.equal(u.balance, "99,999,642 MTOKENS")
})

test("没有 Cookie 时额度给出明确提示，不静默", async () => {
  const p = await plugin()
  const auth = { type: "api", key: TOKEN_PLAN_KEY, metadata: { tier: "tokenplan" } }
  const u = await p.auth.usage(async () => auth)
  assert.equal(u.windows.length, 0)
  assert.match(u.error, /未提供控制台 Cookie/)
})

test("Cookie 过期时额度标记需要重新登录", async () => {
  const p = await plugin()
  const auth = {
    type: "api",
    key: TOKEN_PLAN_KEY,
    metadata: { tier: "tokenplan", consoleCookie: BAD_COOKIE },
  }
  const u = await p.auth.usage(async () => auth)
  assert.equal(u.signIn, "expired")
  assert.match(u.error, /未登录|请求失败/)
})
