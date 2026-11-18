import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const activeBrowsers = new Set()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

process.once("exit", () => {
  for (const child of activeBrowsers) {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
})

export function findBrowser(platform = process.platform, env = process.env) {
  if (env.QUWORK_BROWSER && existsSync(env.QUWORK_BROWSER)) return env.QUWORK_BROWSER
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "win32"
        ? [
            join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
            join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
          ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? ""
}

function browserArgs(profile, port, url) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-background-mode",
    "--new-window",
    url,
  ]
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function cdpTarget(port, targetPrefix) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) })
      const list = await response.json()
      const target = list.find(
        (item) =>
          item?.type === "page" &&
          typeof item.url === "string" &&
          item.url.startsWith(targetPrefix) &&
          item.webSocketDebuggerUrl,
      )
      if (target) return target
    } catch {}
    await sleep(200)
  }
  return null
}

class CDP {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.opened = new Promise((resolve, reject) => {
      this.socket.onopen = resolve
      this.socket.onerror = () => reject(new Error("无法连接浏览器调试接口"))
    })
    this.socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message || "浏览器命令失败"))
        else pending.resolve(message.result ?? {})
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {})
      }
    }
    this.socket.onclose = () => {
      this.closed = true
      for (const pending of this.pending.values()) pending.reject(new Error("浏览器调试连接已关闭"))
      this.pending.clear()
    }
  }

  async send(method, params = {}) {
    await this.opened
    if (this.closed) throw new Error("浏览器调试连接已关闭")
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  close() {
    try {
      this.socket.close()
    } catch {}
  }
}

function captureLoginResponses(client) {
  const captured = { webToken: "", llmToken: "" }
  const pending = new Set()
  client.on("Network.responseReceived", ({ requestId, response }) => {
    if (typeof response?.url !== "string") return
    if (/\/api\/user\/client\/login|\/api\/oauth\/wechat\/share\/exchange/.test(response.url)) {
      pending.add(requestId)
    }
  })
  client.on("Network.loadingFinished", async ({ requestId }) => {
    if (!pending.delete(requestId)) return
    try {
      const body = await client.send("Network.getResponseBody", { requestId })
      const text = body.base64Encoded
        ? Buffer.from(body.body, "base64").toString("utf8")
        : body.body
      const payload = JSON.parse(text)
      const data = payload?.data ?? payload
      if (typeof data?.token === "string" && data.token.trim()) captured.webToken = data.token.trim()
      if (typeof data?.llm_token === "string" && data.llm_token.trim()) captured.llmToken = data.llm_token.trim()
    } catch {}
  })
  return captured
}

export async function openChromeSession(url, { targetPrefix = "https://quwork.cn/" } = {}) {
  const browser = findBrowser()
  if (!browser) throw new Error("没有找到 Chrome 或 Edge；请安装浏览器后重试")
  const profile = mkdtempSync(join(tmpdir(), "magpie-quwork-browser-"))
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  try {
    chmodSync(profile, 0o700)
  } catch {}
  const port = await freePort()
  const child = spawn(browser, browserArgs(profile, port, url), { stdio: "ignore", detached: false })
  activeBrowsers.add(child)
  let spawnError = ""
  child.once("error", (error) => {
    spawnError = String(error?.message ?? error)
  })

  const target = await cdpTarget(port, targetPrefix)
  if (!target) {
    child.kill("SIGKILL")
    rmSync(profile, { recursive: true, force: true })
    throw new Error("浏览器没有打开 QuWork 官网")
  }
  const client = new CDP(target.webSocketDebuggerUrl)
  await client.send("Network.enable").catch(() => {})
  const captured = captureLoginResponses(client)
  let closed = false
  let closing = null

  async function evaluate(expression) {
    const result = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error("无法读取 QuWork 官网登录态")
    return result.result?.value
  }

  async function credentials(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let webSeenAt = 0
    while (Date.now() < deadline && !closed) {
      if (spawnError) throw new Error(`浏览器无法启动：${spawnError}`)
      if (!captured.webToken) {
        try {
          const value = await evaluate('localStorage.getItem("quwork_web_token")')
          if (typeof value === "string" && value.trim()) captured.webToken = value.trim()
        } catch {}
      }
      if (captured.webToken && !webSeenAt) webSeenAt = Date.now()
      if (captured.llmToken) return { ...captured }
      if (captured.webToken && Date.now() - webSeenAt > 3000) return { ...captured }
      await sleep(500)
    }
    return captured.webToken ? { ...captured } : null
  }

  function close() {
    if (closing) return closing
    closed = true
    closing = (async () => {
      activeBrowsers.delete(child)
      client.close()
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM")
        } catch {}
        await waitForExit(child, 2000)
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL")
        } catch {}
        await waitForExit(child, 1000)
      }
      rmSync(profile, { recursive: true, force: true })
    })()
    return closing
  }

  return { evaluate, credentials, close }
}
