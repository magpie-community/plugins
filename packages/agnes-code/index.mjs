// Agnes Code（Agnes 桌面端）for OpenCode and magpie.
//
// Agnes Code 桌面端登录后把会话写进 Electron safeStorage（Chromium os_crypt，
// Chrome 同款方案）：
//   <userData>/Local State                 — os_crypt.encrypted_key（base64，
//                                            去 5 字节 "DPAPI" 前缀后 DPAPI 解出
//                                            AES-256-GCM 主密钥）
//   <userData>/code-auth-session.v1        — "v10" + 12 字节 nonce + AES-GCM 密文
//                                            明文 = { accessToken(JWT, Bearer 用),
//                                            userInfo{username,...}, bffPublicBaseUrl }
// 云端（与桌面端同源同凭据）：
//   模型调用  POST https://api-agnes-code.agnes-ai.com/v1/chat/completions
//             （OpenAI chat 协议，Authorization: Bearer <accessToken>，
//             思考在 reasoning_content 字段）
//   模型目录  GET  https://api-agnes-code.agnes-ai.com/v1/models
//   积分余额  GET  https://api.agnes-ai.com/api/v2/subscription/credits-balance
//
// 本插件复用这份登录态：第一种登录方式在磁盘上解出桌面端会话（同用户同机器的
// DPAPI 即可解，无需密钥口令，仅 Windows；magpie 的 oauth 方式，没解到时给出
// 官网链接并轮询，等用户去装/重开桌面端），第二种让用户手动粘贴 accessToken。
// 积分「每日登录送 600」（免费档）由服务端随当日会话发放、无领取接口，
// auth.checkin 用发放前后余额差观测：涨了记 claimed，没涨不谎称已签——
// 记 inactive 并说明未观测到（宿主把 done 渲染成「今日已签到」，是没发生的断言）。

import { spawn } from "node:child_process"
import { createDecipheriv } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir as osHomedir } from "node:os"
import { join } from "node:path"

const ID = "agnes-code"

// 云端地址（2026-11-01 实测）。
const CHAT_GATEWAY_BASE = "https://api-agnes-code.agnes-ai.com/v1"
const MODELS_URL = "https://api-agnes-code.agnes-ai.com/v1/models"
const POINTS_API_BASE = "https://api.agnes-ai.com"
const BALANCE_PATH = "/api/v2/subscription/credits-balance"

// 读取桌面端登录态失败时展示的跳转页：Agnes Code 官网页（含桌面端下载）。
const OFFICIAL_SITE = "https://agnes-ai.com/agnescode"
// PowerShell 解 DPAPI 的超时：它卡住时 read() 不返回，5 分钟的截止时间根本检查不到。
const DPAPI_TIMEOUT_MS = 15000
// 等待「用户去装/重开桌面端并登录」的窗口与轮询间隔。
const DESKTOP_POLL_MS = 2000
const DESKTOP_WAIT_MS = 5 * 60 * 1000

// 模型目录读不到时的启动表（2026-11-01 实测快照；models 钩子会用实时目录覆盖）。
const BOOTSTRAP = [
  { id: "agnes-3.0-flash", context: 512000, output: 65536, thinking: true },
  { id: "agnes-2.5-flash", context: 512000, output: 65536, thinking: true },
  { id: "agnes-2.5-pro", context: 512000, output: 65536, thinking: true },
  { id: "gpt-6.1-sol", context: 1000000, output: 131072, thinking: false },
  { id: "gpt-6-astra", context: 1000000, output: 131072, thinking: false },
  { id: "grok-4.7", context: 500000, output: 128000, thinking: false },
  { id: "claude-opus-5-5", context: 1000000, output: 128000, thinking: false },
  { id: "deepseek-v4.1-flash", context: 1000000, output: 393216, thinking: true },
  { id: "deepseek-v4-pro", context: 1000000, output: 393216, thinking: true },
  { id: "glm-5.3", context: 1000000, output: 131072, thinking: false },
  { id: "kimi-k3", context: 1048576, output: 131072, thinking: false },
]

// rowFromCatalogEntry 把 /v1/models 的一个模型变成 OpenCode 的 Model。
// member_only 模型照常列出：免费账号调用会得到上游透明的 403
// （subscription_required），magpie 按模型被拒处理，不会误标登录态。
function rowFromCatalogEntry(m) {
  const thinking = !!m?.thinking_toggle
  return {
    id: m.id,
    name: m.id,
    limit: {
      context: typeof m?.max_input_tokens === "number" && m.max_input_tokens > 0 ? m.max_input_tokens : 0,
      output: typeof m?.max_output_tokens === "number" && m.max_output_tokens > 0 ? m.max_output_tokens : 0,
    },
    reasoning: thinking,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      reasoning: thinking,
      toolcall: true,
      attachment: false,
      input: { text: true, image: false },
      output: { text: true },
    },
  }
}

function bootstrapRows() {
  return Object.fromEntries(
    BOOTSTRAP.map((m) => [
      m.id,
      {
        id: m.id,
        name: m.id,
        limit: { context: m.context, output: m.output },
        reasoning: m.thinking,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        capabilities: {
          reasoning: m.thinking,
          toolcall: true,
          attachment: false,
          input: { text: true, image: false },
          output: { text: true },
        },
      },
    ]),
  )
}

// parseEncryptedKey 从 Local State 的 os_crypt.encrypted_key（base64）解出
// DPAPI 包裹前的形态校验：去 5 字节 "DPAPI" 前缀，返回待 DPAPI 解密的字节。
function parseEncryptedKey(b64) {
  const blob = Buffer.from(b64, "base64")
  if (blob.subarray(0, 5).toString("latin1") !== "DPAPI") {
    throw new Error("Local State 的 encrypted_key 不是 DPAPI 形态")
  }
  return blob.subarray(5)
}

// decryptSessionWithKey 用主密钥解开 "v10" safeStorage 会话文件。
function decryptSessionWithKey(keyBuf, rawBuf) {
  if (rawBuf.subarray(0, 3).toString("latin1") !== "v10") {
    throw new Error("会话文件不是 v10 safeStorage 形态")
  }
  const nonce = rawBuf.subarray(3, 15)
  const tagged = rawBuf.subarray(15)
  if (tagged.length < 28) throw new Error("会话文件内容太短")
  const decipher = createDecipheriv("aes-256-gcm", keyBuf, nonce)
  decipher.setAuthTag(tagged.subarray(tagged.length - 16))
  const plain = Buffer.concat([decipher.update(tagged.subarray(0, tagged.length - 16)), decipher.final()])
  return JSON.parse(plain.toString("utf8"))
}

// dpapiUnprotect 用当前 Windows 用户的 DPAPI 解出主密钥（经 PowerShell）。
async function dpapiUnprotect(blob, spawnImpl = spawn, { timeoutMs = DPAPI_TIMEOUT_MS, platform = process.platform } = {}) {
  if (platform !== "win32") {
    throw new Error("桌面端会话解密目前仅支持 Windows；请改用「粘贴 accessToken」方式")
  }
  const b64 = blob.toString("base64")
  const result = await new Promise((resolve, reject) => {
    const child = spawnImpl(
      "powershell",
      ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Security; $k=[Convert]::FromBase64String('${b64}'); [Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($k, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)))`],
      { windowsHide: true },
    )
    let out = ""
    let settled = false
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(value)
    }
    // PowerShell 卡住时不能无限等：到点杀掉子进程，让这次 read() 带原因返回。
    const timer = setTimeout(() => {
      // 先落定再 kill：kill 会同步触发 close，顺序反了就会把「失败 exit」当成结果。
      finish(reject, new Error(`DPAPI 解密超时（PowerShell 超过 ${Math.round(timeoutMs / 1000)}s 没有响应）`))
      try {
        child.kill()
      } catch {}
    }, timeoutMs)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("error", (error) => finish(reject, error))
    child.on("close", (code) => finish(code === 0 ? resolve : reject, code === 0 ? out.trim() : new Error(`DPAPI 解密失败（exit ${code}）`)))
  })
  const key = Buffer.from(result, "base64")
  if (key.length !== 32) throw new Error("DPAPI 解出的主密钥长度异常")
  return key
}

function isExpiredJwt(token, nowMs = Date.now()) {
  const payload = token.split(".")[1]
  if (!payload) return false
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof claims.exp === "number" && claims.exp * 1000 < nowMs
  } catch {
    return false
  }
}

// readDesktopCredential 在磁盘上解出桌面端登录态，返回 { key, accountId, username, source }。
async function readDesktopCredential({ homedir = osHomedir(), platform = process.platform, env = process.env, readFileImpl, dpapiImpl, nowMs, keyCache } = {}) {
  // 平台检查前置：macOS/Linux 走不到 DPAPI，先在读盘前给出明确指引，
  // 而不是让 encrypted_key 形状检查抢先把错误说糊。
  if (platform !== "win32") {
    throw new Error("桌面端会话解密目前仅支持 Windows；请改用「粘贴 accessToken」方式")
  }
  const readFile = readFileImpl ?? ((path) => readFileSync(path))
  const dataDirs = [join(env.APPDATA ?? join(homedir, "AppData", "Roaming"), "AgnesCode")]

  const problems = []
  for (const dir of dataDirs) {
    const statePath = join(dir, "Local State")
    const sessionPath = join(dir, "code-auth-session.v1")
    let keyBlob, raw
    try {
      const state = JSON.parse(readFile(statePath).toString("utf8"))
      keyBlob = parseEncryptedKey(state?.os_crypt?.encrypted_key ?? "")
      raw = readFile(sessionPath)
    } catch (error) {
      // ENOENT = 这台机器上没有 Agnes Code；其它读盘错误要留痕。
      if (error?.code !== "ENOENT") problems.push(`${dir}（${error?.message ?? "读取失败"}）`)
      continue
    }
    // 同一次登录里主密钥解出一次就缓存：轮询时不必每 2 秒再起一次 PowerShell。
    let key = keyCache?.get(statePath)
    if (!key) {
      try {
        const dpapi = dpapiImpl ?? ((blob) => dpapiUnprotect(blob))
        key = await dpapi(keyBlob)
        keyCache?.set(statePath, key)
      } catch (error) {
        problems.push(`${dir}（解密失败：${error?.message ?? "未知"}）`)
        continue
      }
    }
    let session
    try {
      session = decryptSessionWithKey(key, raw)
    } catch (error) {
      // 缓存的主密钥解不开这份帧（文件被别的用户/实例重写过）：丢掉缓存下次重解。
      keyCache?.delete(statePath)
      problems.push(`${dir}（解密失败：${error?.message ?? "未知"}）`)
      continue
    }
    if (typeof session?.accessToken !== "string" || !session.accessToken.trim()) {
      problems.push(`${dir}（会话里没有 accessToken）`)
      continue
    }
    if (isExpiredJwt(session.accessToken, nowMs)) {
      throw Object.assign(new Error("Agnes Code 登录已过期，请打开 Agnes Code 重新登录后重试"), { code: "expired" })
    }
    const username = typeof session.userInfo?.username === "string" && session.userInfo.username.trim()
      ? session.userInfo.username.trim()
      : undefined
    return { key: session.accessToken.trim(), accountId: username, username, source: sessionPath }
  }

  const detail = problems.length ? `：${problems.join("；")}` : ""
  // 「什么都没找到」与「有数据但读不出来」分开说：后者的用户多半已经装好了。
  const message = problems.length
    ? `Agnes Code 桌面端登录态读不出来${detail}。请先启动 Agnes Code 并登录，或改用「粘贴 accessToken」方式。`
    : "未找到 Agnes Code 桌面端登录态。请先启动 Agnes Code 并登录，或改用「粘贴 accessToken」方式。"
  throw Object.assign(
    new Error(message),
    // problems 为空 = 这些路径上什么都没有（新机器）；非空 = 有 Agnes Code 的数据但用不了。
    { code: problems.length ? "unreadable" : "missing" },
  )
}

async function fetchModels(key, fetchImpl) {
  return await fetchImpl(MODELS_URL, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

async function fetchBalance(key, fetchImpl) {
  return await fetchImpl(POINTS_API_BASE + BALANCE_PATH, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

// authResult 把解出的桌面端会话变成 magpie 的登录结果：带 key 会被存成 API key，
// metadata 整份留给 loader / usage / checkin。
function authResult(cred) {
  return {
    type: "success",
    key: cred.key,
    accountId: cred.accountId,
    metadata: { username: cred.username, source: cred.source, method: "desktop" },
  }
}

// probeDesktopCredential 解一次桌面端会话，把「没解到」变成返回值而不是异常。
async function probeDesktopCredential(deps) {
  try {
    return { cred: await readDesktopCredential(deps) }
  } catch (error) {
    return { error }
  }
}

// waitForDesktopCredential 轮询磁盘，等用户装好/重开桌面端并登录。返回
// {status:"ready", result} / {status:"timeout", error} / {status:"aborted"}。
async function waitForDesktopCredential({ read, sleep, now, signal, waitMs = DESKTOP_WAIT_MS, stepMs = DESKTOP_POLL_MS }) {
  const deadline = now() + waitMs
  for (;;) {
    // magpie 取消登录时会 abort 这个 signal，别再空转剩下的几分钟。
    if (signal?.aborted) return { status: "aborted" }
    const trial = await read()
    if (trial.cred) return { status: "ready", result: authResult(trial.cred) }
    if (now() >= deadline) return { status: "timeout", error: trial.error }
    await sleep(stepMs)
  }
}

// reasonOf 把读盘失败压成一句给用户看的话（超时失败时带上最后一次的原因）。
function reasonOf(error) {
  return ["unreadable", "expired", "unsupported"].includes(error?.code)
    ? error.message
    : "本机没有读到 Agnes Code 桌面端登录态"
}

function createPlugin({ fetchImpl = globalThis.fetch, env = process.env, readFileImpl, dpapiImpl, homedir = osHomedir(), platform = process.platform, sleepImpl, nowMsImpl = () => Date.now() } = {}) {
  const sleep = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function readBalance(key) {
    const res = await fetchBalance(key, fetchImpl)
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`Agnes 拒绝了这份凭据（HTTP ${res.status}），请重新登录 Agnes Code`), { signIn: "expired" })
    }
    if (!res.ok) throw new Error(`积分余额读取失败（HTTP ${res.status}）`)
    const body = await res.json()
    const data = body?.data
    if (!data || typeof data.total_balance !== "number") throw new Error("积分余额格式异常")
    return data
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // ??= 保留用户在 plugins.json 里自己配置的同名供应商。
      cfg.provider[ID] ??= {
        name: "Agnes",
        npm: "@ai-sdk/openai-compatible", // OpenAI chat completions；网关在 baseURL 后拼 /chat/completions
        api: CHAT_GATEWAY_BASE,
        models: bootstrapRows(),
      }
    },

    auth: {
      provider: ID,
      methods: [
        {
          // oauth 方式：magpie 不显示 key 输入框，authorize 必须立刻返回
          // { url, instructions, method, callback }，结果由 callback 交回。
          // 解得出就立刻完成（url 留空）；解不出就给出官网链接，边等边让用户去装。
          type: "oauth",
          label: "读取 Agnes Code 桌面端登录态",
          async authorize(_inputs, { signal } = {}) {
            // 非 Windows 解不了 DPAPI：抛错（宿主把 message 原样当失败原因），
            // 别把用户丢进一个注定等不到的轮询里。
            if (platform !== "win32") {
              throw new Error("桌面端会话解密仅支持 Windows；本机请改用「粘贴 accessToken」方式")
            }
            // 主密钥在同一次登录里只解一次（轮询不再每 2 秒起一次 PowerShell）。
            const keyCache = new Map()
            const read = () => probeDesktopCredential({ readFileImpl, dpapiImpl, homedir, platform, env, nowMs: nowMsImpl(), keyCache })
            const probe = await read()
            if (probe.cred) {
              return {
                url: "",
                instructions: `已读取本机 Agnes Code 登录态（${probe.cred.username ?? probe.cred.accountId}），正在完成登录…`,
                method: "auto",
                callback: async () => authResult(probe.cred),
              }
            }
            return {
              url: OFFICIAL_SITE,
              instructions:
                probe.error?.code === "unreadable" || probe.error?.code === "expired"
                  ? `${probe.error.message}（上方链接是官网；打开 Agnes Code 登录或修好后，这一步会自动完成。）`
                  : "本机没有读到 Agnes Code 桌面端登录态。装上或打开 Agnes Code 桌面端并登录就好——上方链接是官网，可下载；登录后这一步会自动完成。已有 token 的话，也可以改用「粘贴 accessToken」。",
              method: "auto",
              callback: async (_code, { signal: callbackSignal } = {}) => {
                const waited = await waitForDesktopCredential({ read, sleep, now: nowMsImpl, signal: callbackSignal ?? signal })
                if (waited.status === "ready") return waited.result
                if (waited.status === "aborted") return { type: "failed", error: "登录已取消" }
                return {
                  type: "failed",
                  error: `仍未读到 Agnes Code 桌面端登录态（最后一次：${reasonOf(waited.error)}）。登录 Agnes Code 后，重新点一次「读取 Agnes Code 桌面端登录态」即可。`,
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "粘贴 accessToken",
          prompts: [
            {
              type: "password",
              key: "accessToken",
              message: "Agnes Code 会话里的 JWT accessToken（eyJ…）",
              validate: (v) => (v && v.trim() ? undefined : "必填"),
            },
            {
              type: "text",
              key: "username",
              message: "用户名（可选，用于显示）",
            },
          ],
          // username 只作显示名；原先没 authorize，输入会被整体丢弃。
          async authorize(inputs) {
            const key = String(inputs?.accessToken ?? "").trim()
            if (!key) return { type: "failed", error: "accessToken 必填" }
            const username = String(inputs?.username ?? "").trim() || undefined
            return {
              type: "success",
              key,
              accountId: username,
              metadata: { username, source: "paste", method: "paste" },
            }
          },
        },
      ],
      // @ai-sdk/openai-compatible 把 apiKey 发成 Authorization: Bearer <key>，
      // 与桌面端对网关的调用完全一致，无需自定义头。
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return { baseURL: CHAT_GATEWAY_BASE, apiKey: auth.key }
      },
      // 免费档「每日登录送 600」由服务端随当日会话发放；这里显示真实积分余额，
      // 读取不计费。
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        let balance
        try {
          balance = await readBalance(auth.key)
        } catch (error) {
          if (error?.signIn === "expired") {
            return { error: error.message, signIn: "expired", windows: [] }
          }
          return { error: error?.message ?? "Agnes 积分读取失败", windows: [] }
        }
        const windows = [{ name: "积分", balance: balance.total_balance, aside: false }]
        if (balance.time_sensitive_balance > 0) {
          windows.push({ name: "限时积分", balance: balance.time_sensitive_balance, aside: true })
        }
        if (balance.permanent_balance > 0) {
          windows.push({ name: "永久积分", balance: balance.permanent_balance, aside: true })
        }
        return {
          plan: balance.level_name || (balance.level ? `Level ${balance.level}` : "Free"),
          windows,
        }
      },
      // 「每日登录送积分」由服务端随当日会话发放，无领取接口；这里做一次账号
      // 会话活跃（只读请求）并观测发放前后的余额差：涨了记 claimed，没涨记 done。
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        let before
        try {
          before = await readBalance(auth.key)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          return { outcome: "failed", message: error?.message ?? "积分余额读取失败" }
        }
        // 会话活跃 touch：与桌面端启动时同类只读请求。
        await fetchModels(auth.key, fetchImpl).catch(() => null)
        await fetchBalance(auth.key, fetchImpl).catch(() => null)
        await sleep(2500)
        let after
        try {
          after = await readBalance(auth.key)
        } catch (error) {
          if (error?.signIn === "expired") throw error
          return { outcome: "failed", message: error?.message ?? "积分余额读取失败" }
        }
        const delta = after.total_balance - before.total_balance
        if (delta > 0) return { outcome: "claimed", credit: delta, message: `每日登录积分 +${delta}` }
        // 余额没涨 ≠ 已发放：无领取接口，发放可能挂靠桌面端登录，本次未观测到。
        // 不能报 done（宿主渲染成「今日已签到」）；inactive 是静默结算态，message 仍带实情。
        return { outcome: "inactive", message: "未观测到新发放：余额无变化（发放可能挂靠桌面端登录）" }
      },
    },

    provider: {
      id: ID,
      // 按账号实时拉目录（模型增删、thinking 标记可能随时间变）。
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        let res
        try {
          res = await fetchModels(auth.key, fetchImpl)
        } catch {
          // 网络失败保留原列表，与目录接口非 2xx 同待遇。
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`Agnes 拒绝了这份凭据（HTTP ${res.status}），请重新登录 Agnes Code`), { signIn: "expired" })
        }
        if (!res.ok) return provider.models
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("Agnes 模型目录不是有效 JSON")
        }
        const list = body?.data
        if (!Array.isArray(list) || list.some((m) => typeof m?.id !== "string" || !m.id)) {
          throw new Error("Agnes 模型目录格式异常")
        }
        const rows = Object.fromEntries(list.map((m) => [m.id, rowFromCatalogEntry(m)]))
        if (!Object.keys(rows).length) throw new Error("Agnes 模型目录为空")
        return rows
      },
    },
  }
}

// 插件是唯一的导出函数；magpie 会把入口导出的每个函数都当插件调用，测试需要的
// 内部函数按社区约定放在 _internal 对象上。
export const AgnesPlugin = async () => createPlugin()
export const _internal = {
  createPlugin,
  rowFromCatalogEntry,
  bootstrapRows,
  parseEncryptedKey,
  decryptSessionWithKey,
  dpapiUnprotect,
  readDesktopCredential,
  probeDesktopCredential,
  waitForDesktopCredential,
  reasonOf,
  authResult,
  isExpiredJwt,
  CHAT_GATEWAY_BASE,
  MODELS_URL,
  POINTS_API_BASE,
  BALANCE_PATH,
  OFFICIAL_SITE,
  DESKTOP_WAIT_MS,
  DPAPI_TIMEOUT_MS,
  BOOTSTRAP,
  ID,
}
