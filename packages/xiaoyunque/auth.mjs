import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

const SOURCE = "pippit-tool-cli"
const ORIGINS = new Set(["https://xyq.jianying.com", "https://www.xiaoyunque.com"])
const tokenValid = (value) => typeof value === "string" && /^[A-Za-z0-9:._-]{1,128}$/.test(value)
const binding = (value) => createHash("sha256").update(value).digest()
const equal = (left, right) => typeof left === "string" && timingSafeEqual(binding(left), binding(right))

export async function beginLogin({ directory, signal, now = Date.now, timeout = 300_000 }) {
  signal?.throwIfAborted()
  const folder = join(directory, "xiaoyunque")
  const path = join(folder, "device.json")
  await mkdir(folder, { recursive: true, mode: 0o700 })
  let identity
  try {
    identity = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("小云雀设备记录无法读取，请检查 device.json。")
    identity = { deviceId: randomBytes(32).toString("base64url") }
    await writeFile(path, JSON.stringify(identity), { mode: 0o600, flag: "wx" })
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(identity.deviceId) ||
      (identity.tokenId !== undefined && !tokenValid(identity.tokenId))) {
    throw new Error("小云雀设备记录无效。")
  }
  const secret = randomBytes(32).toString("base64url")
  const state = randomBytes(32).toString("base64url")
  let callbackURL
  let accepted = false
  let resolvePayload
  let rejectPayload
  const payload = new Promise((resolve, reject) => {
    resolvePayload = resolve
    rejectPayload = reject
  })
  payload.catch(() => {})
  const server = createServer(async (request, response) => {
    const reply = (status, text) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      response.end(JSON.stringify({ ...(status === 200 ? { ok: true } : { error: text }) }))
    }
    try {
      const target = new URL(request.url, callbackURL)
      const expected = new URL(callbackURL)
      if (request.headers.host !== expected.host || target.pathname !== expected.pathname ||
          target.searchParams.getAll("state").length !== 1 || !equal(target.searchParams.get("state"), state) ||
          [...target.searchParams].some(([key, value]) => key !== "state" &&
            (!["a_bogus", "msToken"].includes(key) || target.searchParams.getAll(key).length !== 1 ||
              !value || value.length > 4096 || value.trim() !== value))) return reply(400, "invalid callback target")
      const origin = request.headers.origin
      if (!ORIGINS.has(origin)) return reply(403, "origin not allowed")
      response.setHeader("Access-Control-Allow-Origin", origin)
      response.setHeader("Access-Control-Allow-Methods", "POST")
      response.setHeader("Access-Control-Allow-Headers", "Content-Type")
      response.setHeader("Access-Control-Allow-Private-Network", "true")
      response.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
      if (request.method === "OPTIONS") {
        if (request.headers["access-control-request-method"]?.toUpperCase() !== "POST" ||
            !request.headers["access-control-request-headers"]?.toLowerCase().split(",").map((part) => part.trim()).includes("content-type")) {
          return reply(400, "invalid preflight")
        }
        response.writeHead(204)
        return response.end()
      }
      if (request.method !== "POST") return reply(405, "use POST")
      if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return reply(415, "use application/json")
      if (accepted) return reply(409, "callback already received")
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 65_536) return reply(413, "callback too large")
        chunks.push(chunk)
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const allowed = ["type", "access_key", "uid", "token_id", "expired_at", "random_secret_key", "source", "callback_url"]
      if (Object.keys(data).some((key) => !allowed.includes(key)) || data.type !== "access_key" ||
          typeof data.access_key !== "string" || !data.access_key.trim() || data.access_key.trim() !== data.access_key ||
          data.access_key.length > 4096 || typeof data.uid !== "string" || !data.uid.trim() || data.uid.length > 256 ||
          data.uid.trim() !== data.uid || !tokenValid(data.token_id) ||
          !Number.isSafeInteger(data.expired_at) || data.expired_at * 1000 < now() + 30_000 ||
          !equal(data.random_secret_key, secret) || !equal(data.source, SOURCE) || !equal(data.callback_url, callbackURL)) {
        return reply(400, "callback binding mismatch")
      }
      if (accepted) return reply(409, "callback already received")
      accepted = true
      reply(200)
      resolvePayload(data)
    } catch {
      if (!response.headersSent) reply(400, "invalid callback payload")
    }
  })
  server.headersTimeout = 5000
  server.requestTimeout = 10_000
  server.setTimeout(10_000, (socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  callbackURL = `http://127.0.0.1:${address.port}/pippit-tool/callback?state=${state}`
  const close = () => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    server.close()
    server.closeIdleConnections()
    server.closeAllConnections()
  }
  const abort = () => {
    rejectPayload(signal.reason)
    close()
  }
  const timer = setTimeout(() => {
    rejectPayload(new Error("小云雀登录超时，请重新登录。"))
    close()
  }, timeout)
  timer.unref()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  const url = new URL("https://www.xiaoyunque.com/cli/pippit-tool-login")
  for (const [key, value] of Object.entries({
    callback: callbackURL, random_secret_key: secret, source: SOURCE,
    cli_version: "1.0.52", auth_protocol: "1", device_id: identity.deviceId,
    ...(identity.tokenId ? { token_id: identity.tokenId } : {}),
  })) url.searchParams.set(key, value)
  return {
    url: url.href,
    instructions: "在小云雀网页确认授权，完成后自动返回。生成使用个人空间积分。",
    method: "auto",
    async callback(_code, context = {}) {
      const cancel = () => {
        rejectPayload(context.signal.reason)
        close()
      }
      context.signal?.addEventListener("abort", cancel, { once: true })
      if (context.signal?.aborted) cancel()
      try {
        const data = await payload
        const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
        await writeFile(temporary, JSON.stringify({ deviceId: identity.deviceId, tokenId: data.token_id }), { mode: 0o600, flag: "wx" })
        await rename(temporary, path)
        return {
          type: "success", key: data.access_key,
          metadata: {
            email: `小云雀 ${data.uid}`, uid: data.uid, teamId: "0",
            expiresAt: data.expired_at * 1000, deviceId: identity.deviceId, tokenId: data.token_id,
          },
        }
      } finally {
        context.signal?.removeEventListener("abort", cancel)
        close()
      }
    },
  }
}
