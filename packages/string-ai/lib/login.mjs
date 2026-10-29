import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { accountRequest, readAccount, sessionAuth } from "./account.mjs"

export async function browserLogin() {
  const secret = randomBytes(32).toString("hex")
  const page = await readFile(new URL("./login.html", import.meta.url), "utf8")
  let finish
  let settled = false
  let busy = false
  let tempToken
  const result = new Promise((resolve) => { finish = resolve })
  const complete = (value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server.close()
    finish(value)
  }
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
      response.end(JSON.stringify(value))
    }
    if (request.headers.host !== address.host) return send(403, { error: "登录地址不匹配" })
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
      })
      return response.end(page)
    }
    if (request.method !== "POST" || request.url !== "/login") return send(404, { error: "接口不存在" })
    if (request.headers.origin !== address.origin || request.headers["x-login-state"] !== secret) {
      return send(403, { error: "登录会话校验失败，请从 Magpie 重新打开登录页面" })
    }
    if (settled) return send(410, { error: "登录会话已经结束" })
    if (busy) return send(409, { error: "正在登录，请稍候" })
    busy = true
    try {
      let body = ""
      for await (const chunk of request) {
        body += chunk
        if (body.length > 8192) throw new Error("登录请求过长")
      }
      const input = JSON.parse(body)
      let session
      if (tempToken) {
        if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code)) throw new Error("请输入 6 位验证码")
        session = await accountRequest("/auth/login/2fa", { body: { temp_token: tempToken, totp_code: input.code } })
      } else {
        if (typeof input.email !== "string" || !input.email.trim() || typeof input.password !== "string" || !input.password) {
          throw new Error("请输入邮箱和密码")
        }
        session = await accountRequest("/auth/login", { body: { email: input.email.trim(), password: input.password } })
      }
      if (session.requires_2fa) {
        if (!session.temp_token) throw new Error("String AI 未返回两步验证凭据")
        tempToken = session.temp_token
        return send(200, { requires2FA: true })
      }
      const tokens = sessionAuth(session)
      const { user, keys } = await readAccount(tokens.access)
      if (settled) throw new Error("登录已超时，请从 Magpie 重新登录")
      send(200, { success: true, keyCount: keys.length })
      complete({ type: "success", ...tokens, accountId: user.email, metadata: { email: user.email, userId: user.id } })
    } catch (error) {
      send(400, { error: error.message })
    } finally {
      busy = false
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = new URL(`http://127.0.0.1:${server.address().port}`)
  const timer = setTimeout(() => complete({ type: "failed", error: "登录超时，请重新登录" }), 10 * 60 * 1000)
  timer.unref()
  return {
    url: `${address.origin}/#${secret}`,
    method: "auto",
    instructions: "在浏览器中输入 String AI 邮箱和密码，登录后自动导入全部可用 API Key。",
    callback: () => result,
    cancel: () => complete({ type: "failed", error: "登录已取消" }),
  }
}
