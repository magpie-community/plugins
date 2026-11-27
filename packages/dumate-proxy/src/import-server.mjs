import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

const jsonResponse = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) })
  res.end(body)
}

export function importUploadPage(token) {
  const safeToken = JSON.stringify(token)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DuMate 文件导入</title>
<style>
body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:32px auto;padding:0 20px;color:#1f2329}
h1{font-size:22px}
label{display:block;margin:18px 0 6px;font-weight:600}
input{display:block;width:100%;padding:9px 12px;border:1px solid #d0d7de;border-radius:8px;box-sizing:border-box}
button{margin-top:22px;padding:10px 18px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
#status{margin-top:16px;white-space:pre-wrap}
.ok{color:#0a7a35}.err{color:#c1121f}
code{background:#f3f4f6;padding:2px 5px;border-radius:4px}
</style>
</head>
<body>
<h1>导入 DuMate 登录态</h1>
<p>选择两个本机文件：<code>auth.json</code> 和 <code>.cookie-key</code>（也支持 key 的 Base64 文本）。文件只发送到当前 Magpie 服务，由插件解密并验证。</p>
<label for="auth">auth.json</label>
<input id="auth" type="file" accept=".json,application/json,text/plain">
<label for="key">.cookie-key</label>
<input id="key" type="file">
<button id="go">导入账号</button>
<div id="status"></div>
<script>
const token = ${safeToken}
const status = document.getElementById("status")
const set = (text, cls) => { status.textContent = text; status.className = cls || "" }
const readBase64 = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
async function readKey(file) {
  const text = (await file.text()).trim()
  if (/^-----BEGIN/.test(text) || /^[A-Za-z0-9+/=]+$/.test(text) || /^[0-9a-fA-F]{64}$/.test(text)) return text
  return readBase64(file)
}
document.getElementById("go").onclick = async () => {
  const authFile = document.getElementById("auth").files[0]
  const keyFile = document.getElementById("key").files[0]
  if (!authFile || !keyFile) return set("请选择两个文件：auth.json 和 .cookie-key", "err")
  const button = document.getElementById("go")
  button.disabled = true
  set("正在验证…")
  try {
    const body = { authJson: await authFile.text(), cookieKey: await readKey(keyFile) }
    const response = await fetch(location.pathname.replace(/\/?$/, "/") + "upload?token=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || "导入失败")
    set("导入成功：" + (result.user || "DuMate") + "。可以关闭本页，回到 Magpie 完成登录。", "ok")
  } catch (error) {
    set(String(error?.message || error), "err")
  } finally {
    button.disabled = false
  }
}
</script>
</body>
</html>
`
}

export async function startImportUploadServer({ config = {}, fetchImpl = fetch, deps }) {
  const sessions = new Map()
  let server

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://import.local")
      const token = url.searchParams.get("token") || ""
      if (!sessions.has(token)) {
        if (url.pathname.endsWith("/dumate-import")) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
          return res.end("导入链接已失效，请回到 Magpie 重新选择上传方式。")
        }
        return jsonResponse(res, 400, { error: "导入链接已失效" })
      }
      if (req.method === "GET" && url.pathname.endsWith("/dumate-import")) {
        const body = importUploadPage(token)
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body) })
        return res.end(body)
      }
      if (req.method !== "POST" || !url.pathname.endsWith("/dumate-import/upload")) {
        return jsonResponse(res, 404, { error: "not found" })
      }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 4 * 1024 * 1024) return jsonResponse(res, 413, { error: "文件过大" })
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { return jsonResponse(res, 400, { error: "上传内容不是 JSON" }) }
      const login = deps.decryptDesktopAuth(body?.authJson ?? body?.auth, body?.cookieKey ?? body?.key, "uploaded-auth")
      if (!login) return jsonResponse(res, 400, { error: "auth.json 与 key 内容不匹配，或登录态已失效" })
      let info
      try { info = await deps.consoleGet("/api/dumate/user/info", deps.cookieHeaderOf(login.cookies), fetchImpl) }
      catch (error) { return jsonResponse(res, 400, { error: `登录态验证失败：${error?.message ?? error}` }) }
      const result = deps.seat(login.cookies, "uploaded-auth", { ...login, ...info })
      sessions.delete(token)
      sessions.set(token, { done: true, result })
      jsonResponse(res, 200, { ok: true, user: result.name || result.accountId || "DuMate" })
    } catch (error) {
      jsonResponse(res, 500, { error: error?.message || String(error) })
    }
  }

  server = createServer(handler)
  const bind = String(config.bind || "127.0.0.1")
  const port = Number.isSafeInteger(Number(config.port)) ? Number(config.port) : 8788
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, bind, resolve)
  })
  const address = server.address()
  const actualPort = address && typeof address === "object" ? address.port : port
  const publicBase = String(config.publicUrl || "").replace(/\/+$/, "")
  const shownHost = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind
  const base = publicBase || `http://${shownHost}:${actualPort}`

  return {
    base,
    sessions,
    createSession() {
      const token = randomBytes(24).toString("base64url")
      sessions.set(token, { done: false, result: undefined })
      return token
    },
    takeSession(token) {
      const session = sessions.get(token)
      sessions.delete(token)
      return session
    },
    async wait(token, timeoutMs = 10 * 60 * 1000, signal) {
      const deadline = Date.now() + timeoutMs
      while (!signal?.aborted && Date.now() < deadline) {
        const session = sessions.get(token)
        if (session?.done) {
          sessions.delete(token)
          return session.result
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      sessions.delete(token)
      return signal?.aborted
        ? { type: "failed", error: "导入已取消" }
        : { type: "failed", error: "等待文件上传超时，请重新选择上传方式" }
    },
    close() {
      return new Promise((resolve) => {
        if (!server) return resolve()
        const old = server
        server = null
        old.close(resolve)
      })
    },
  }
}
