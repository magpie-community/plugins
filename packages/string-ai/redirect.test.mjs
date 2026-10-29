import { test } from "bun:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import StringAIPlugin from "./index.mjs"
import { SITE, accountRequest } from "./lib/account.mjs"
import { MODELS_DEV, fetchJSON, fetchEfforts } from "./lib/helpers.mjs"

const fakeKey = "sk-redirect-test-only"

for (const [path, options] of [
  ["/auth/login", { body: { email: "redirect@example.invalid", password: "fake-password-only" } }],
  ["/auth/login/2fa", { body: { temp_token: "fake-temp-token", totp_code: "000000" } }],
  ["/auth/refresh", { body: { refresh_token: "fake-refresh-token" } }],
  ["/auth/me", { token: "fake-access-token" }],
  ["/keys?page=1&page_size=100", { token: "fake-access-token" }],
]) {
  test(`账号凭据请求拒绝 307 跨源重定向: ${path}`, async () => {
    await withRedirect(async ({ received }) => {
      let failure
      try { await accountRequest(path, options) } catch (error) { failure = error }
      assert.equal(received.source.length, 1)
      assert.equal(received.source[0].path, `/api/v1${path}`)
      if (options.body) assert.deepEqual(JSON.parse(received.source[0].body), options.body)
      if (options.token) assert.equal(received.source[0].headers.authorization, `Bearer ${options.token}`)
      assert.deepEqual(received.target, [], "账号密码或 Token 不得随重定向发送")
      assert.ok(failure, "账号接口必须拒绝重定向")
    })
  })
}

// 仅允许两个回环服务器；公共模型目录使用桩，账号站点仅映射到本地。
async function withRedirect(run, redirectModels = false) {
  const realFetch = globalThis.fetch
  const received = { source: [], target: [] }
  const listen = async (handler) => {
    const server = createServer(handler)
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    return server
  }
  const capture = async (request) => {
    let body = ""
    for await (const chunk of request) body += chunk
    return { path: request.url, headers: request.headers, body }
  }
  const target = await listen(async (request, response) => {
    received.target.push(await capture(request))
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ code: 0, data: {}, models: [] }))
  })
  let source
  try {
    const targetURL = `http://127.0.0.1:${target.address().port}`
    source = await listen(async (request, response) => {
      received.source.push(await capture(request))
      if (request.url === "/v1/models" && !redirectModels) {
        response.writeHead(200, { "Content-Type": "application/json" })
        return response.end(JSON.stringify({ data: [{ id: "redirect-model" }] }))
      }
      response.writeHead(307, { Location: `${targetURL}/sink` })
      response.end()
    })
    const origin = `http://127.0.0.1:${source.address().port}`
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (url.href === MODELS_DEV) return Promise.resolve(Response.json({}))
      if (url.origin === SITE) return realFetch(`${origin}${url.pathname}${url.search}`, init)
      assert.equal(url.origin, origin, `禁止外部网络: ${url.origin}`)
      return realFetch(input, init)
    }
    await run({ origin, received })
  } finally {
    globalThis.fetch = realFetch
    await Promise.all([source, target].filter(Boolean).map((server) => new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })))
  }
}

for (const path of ["/v1/models", "/v1/usage", "/backend-api/codex/models"]) {
  test(`API Key 查询拒绝 307 跨源重定向: ${path}`, async () => {
    await withRedirect(async ({ origin, received }) => {
      let failure
      let result
      try {
        result = path === "/backend-api/codex/models"
          ? await fetchEfforts(`${origin}/v1`, fakeKey)
          : await fetchJSON(`${origin}/v1`, path, fakeKey)
      } catch (error) { failure = error }
      assert.equal(received.source.length, 1)
      assert.equal(received.source[0].path, path)
      assert.equal(received.source[0].headers.authorization, `Bearer ${fakeKey}`)
      assert.deepEqual(received.target, [], "API Key 查询不得跟随重定向")
      if (path === "/backend-api/codex/models") assert.deepEqual(result, {})
      else assert.ok(failure, "模型和余额查询必须拒绝重定向")
    }, true)
  })
}

test("登录页密码提交拒绝 307 跨源重定向", async () => {
  const page = readFileSync(new URL("./lib/login.html", import.meta.url), "utf8")
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1]
  await withRedirect(async ({ origin, received }) => {
    let submit
    const elements = {
      form: { addEventListener: (_, callback) => { submit = callback }, reset() {} },
      submit: {}, error: {}, password: { value: "fake-page-password" },
      code: {}, email: { value: "page@example.invalid" }, description: {},
    }
    // 直接执行实际页面脚本；DOM 使用最小桩，HTTP 仍走两个真实回环服务器。
    runInNewContext(script, {
      location: { hash: "#fake-login-state" }, history: { replaceState() {} },
      document: { getElementById: (id) => elements[id] },
      fetch: (input, init) => globalThis.fetch(new URL(input, origin), init),
    })
    await submit({ preventDefault() {} })
    assert.equal(received.source.length, 1)
    assert.equal(received.source[0].path, "/login")
    assert.equal(JSON.parse(received.source[0].body).password, "fake-page-password")
    assert.deepEqual(received.target, [], "页面密码不得随重定向发送")
    assert.ok(elements.error.textContent, "页面应显示重定向失败")
    assert.equal(elements.form.hidden, undefined)
  })
})

for (const redirect of [undefined, "follow", "manual"]) {
  test(`模型签名请求拒绝 307 跨源重定向，调用者 redirect=${redirect}`, async () => {
    await withRedirect(async ({ origin, received }) => {
      const plugin = await StringAIPlugin({}, { baseURL: origin })
      const auth = { type: "api", key: fakeKey }
      const loader = await plugin.auth.loader(async () => auth)
      let failure
      try {
        await loader.fetch(`${origin}/v1/responses`, {
          method: "POST", headers: {}, body: JSON.stringify({ model: "redirect-model" }),
          ...(redirect === undefined ? {} : { redirect }),
        })
      } catch (error) { failure = error }
      assert.equal(received.source.at(-1).headers["x-api-key"], fakeKey)
      assert.deepEqual(received.target, [], "重定向目标不得收到请求或凭据")
      assert.ok(failure, "签名请求必须拒绝重定向，不能返回 307 响应")
    })
  })
}
