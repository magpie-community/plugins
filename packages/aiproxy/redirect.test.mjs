import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { AiProxyPlugin, _internal } from "./index.mjs"

async function listen(handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
      await closed
    },
  }
}

// These are actual fetch requests with synthetic credentials, not a mocked
// assertion on RequestInit. A second origin records any forwarded request.
for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP ${status} cannot forward login, Cookie or API credentials`, async () => {
    const forwarded = []
    const received = []
    const target = await listen((req, res) => {
      forwarded.push({ path: req.url, headers: req.headers })
      req.resume()
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
    let redirectPath = ""
    let redirectURL = `${target.url}/collect`
    const site = await listen((req, res) => {
      received.push({ path: req.url, headers: req.headers })
      req.resume()
      if (req.url === redirectPath || redirectPath === "*") {
        res.writeHead(status, { location: redirectURL })
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ email: "test@example.test", balance_usd: 1 }))
    })
    try {
      // Positive control: an ordinary fetch follows this exact redirect.
      redirectPath = "/control"
      await fetch(`${site.url}/control`)
      assert.equal(forwarded.length, 1)
      forwarded.length = 0

      const plugin = await AiProxyPlugin()
      const credential = {
        type: "api",
        key: "synthetic-api-key",
        metadata: { baseURL: site.url, cookies: "session=synthetic-cookie" },
      }
      for (const destination of [`${target.url}/collect`, `${site.url}/collect`]) {
        redirectURL = destination
        received.length = 0
        redirectPath = "/api/v1/auth/login"
        const passwordResult = await plugin.auth.methods[0].authorize({
          baseURL: site.url,
          apiKey: credential.key,
          email: "test@example.test",
          password: "synthetic-password",
        })
        assert.equal(passwordResult.type, "failed")

        redirectPath = "/api/v1/user/me"
        const cookieResult = await plugin.auth.methods[1].authorize({
          baseURL: site.url,
          apiKey: credential.key,
          cookies: credential.metadata.cookies,
        })
        assert.equal(cookieResult.type, "failed")
        assert.ok(received.some((req) => req.headers.cookie === credential.metadata.cookies))

        redirectPath = "/api/v1/user/entitlements"
        // A fresh instance avoids the quota cache hiding a redirect.
        const quotaPlugin = await AiProxyPlugin()
        const quota = await quotaPlugin.auth.usage(async () => credential)
        assert.ok(quota.error)

        redirectPath = "/v1/models"
        const models = await plugin.provider.models(
          { id: "aiproxy", models: {} },
          { auth: { ...credential, metadata: { ...credential.metadata, protocols: { chat: true } } } },
        )
        assert.deepEqual(models, {})
        assert.ok(received.some((req) => req.path === "/v1/models" &&
          req.headers.authorization === `Bearer ${credential.key}`))

        redirectPath = "*"
        const protocols = await _internal.detectProtocols(fetch, credential)
        assert.deepEqual(protocols, {})
        assert.equal(forwarded.length, 0, "no request may reach the other origin")
        assert.equal(received.filter((req) => req.path === "/collect").length, 0,
          "same-origin redirects must also be refused")
      }
    } finally {
      await site.close()
      await target.close()
    }
  })
}
