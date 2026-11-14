import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const ORIGIN = "https://xyq.jianying.com"
export const PROVIDER = "xiaoyunque"
export const fingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24)

export class VendorError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function credentials(auth) {
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key) throw new VendorError("请在 Magpie 供应商页登录小云雀。", 401)
  if (auth.metadata?.expiresAt && auth.metadata.expiresAt <= Date.now()) throw new VendorError("小云雀授权已过期，请重新登录。", 401)
  return { key: auth.key, teamId: auth.metadata?.teamId ?? "0", account: fingerprint(auth.metadata?.uid ? `uid:${auth.metadata.uid}` : auth.key) }
}

export function createAPI({ fetchImpl = globalThis.fetch, directory, now = Date.now } = {}) {
  const catalogs = new Map()
  const safeMessage = (message, key) => String(message).split(key).join("[已隐藏密钥]").slice(0, 1000)
  async function post(auth, path, body, { signal, teamId = credentials(auth).teamId, multipart = false } = {}) {
    const { key } = credentials(auth)
    if (typeof teamId !== "string" || !/^(0|[1-9]\d*)$/.test(teamId) || BigInt(teamId) > 9223372036854775807n) {
      throw new VendorError("小云雀空间 ID 无效。")
    }
    const headers = { authorization: `Bearer ${key}`, accept: "application/json" }
    if (!multipart) headers["content-type"] = "application/json"
    if (teamId !== "0") headers["X-Team-Id"] = teamId
    let response
    try {
      response = await fetchImpl(ORIGIN + path, {
        method: "POST", headers, body: multipart ? body : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55_000)]) : AbortSignal.timeout(55_000),
        redirect: "error",
      })
    } catch (error) {
      throw new VendorError(`小云雀网络请求失败：${safeMessage(error.message, key)}`, 502)
    }
    let envelope
    try {
      envelope = await response.json()
    } catch {
      throw new VendorError(`小云雀未返回 JSON（HTTP ${response.status}）。`, response.ok ? 502 : response.status)
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || typeof envelope.ret !== "string") {
      throw new VendorError("小云雀响应缺少有效的状态标识。", 502)
    }
    if (!response.ok || envelope.ret !== "0") {
      const message = safeMessage(envelope.errmsg || `HTTP ${response.status} / ret=${String(envelope.ret)}`, key)
      const status = !response.ok ? response.status :
        /(?:登录|授权|access.?key|token.*(?:invalid|expired)|unauthorized)/i.test(message) ? 401 :
          /(?:积分.*不足|余额.*不足|insufficient)/i.test(message) ? 402 : 400
      throw new VendorError(safeMessage(`${message}${envelope.log_id ? `（LogID: ${envelope.log_id}）` : ""}`, key), status)
    }
    if (!envelope.data || typeof envelope.data !== "object") throw new VendorError("小云雀响应缺少 data。", 502)
    return envelope.data
  }
  async function models(auth, kind, { signal, refresh = false } = {}) {
    const cacheKey = `${fingerprint(credentials(auth).key)}:${kind}`
    const cached = catalogs.get(cacheKey)
    if (!refresh && cached && cached.expires > now()) return cached.rows
    catalogs.delete(cacheKey)
    const scene = kind === "image" ? "web_image_agent" : "web_turbo_video_generator"
    const data = await post(auth, "/api/biz/v1/skill/get_available_model_list", { scene, source_model_key: "" }, { signal, teamId: "0" })
    if (data.scene !== scene || !Array.isArray(data.config?.models)) throw new VendorError("小云雀模型目录格式不正确。", 502)
    const seenKeys = new Set()
    const seenNames = new Set()
    const rows = data.config.models.map((model) => {
      if (typeof model.key !== "string" || !model.key || typeof model.name !== "string" || !model.name ||
          model.kind !== kind || seenKeys.has(model.key) || seenNames.has(model.name)) throw new VendorError("小云雀模型目录存在缺失或重复项。", 502)
      seenKeys.add(model.key)
      seenNames.add(model.name)
      return model
    })
    catalogs.set(cacheKey, { rows, expires: now() + 300_000 })
    return rows
  }
  async function spaces(auth, signal) {
    const rows = [{ team_id: "0", team_name: "个人空间" }]
    let cursor = "0"
    const cursors = new Set()
    do {
      if (cursors.has(cursor)) throw new VendorError("小云雀团队分页重复。", 502)
      cursors.add(cursor)
      const data = await post(auth, "/api/biz/v1/skill/get_lite_team_list", { cursor, count: 100 }, { signal, teamId: "0" })
      if (!Array.isArray(data.team_info_list)) throw new VendorError("小云雀团队列表格式不正确。", 502)
      rows.push(...data.team_info_list)
      if (!data.has_more) return rows
      cursor = data.next_cursor
      if (typeof cursor !== "string" || !cursor) throw new VendorError("小云雀团队分页缺少游标。", 502)
    } while (true)
  }
  async function upload(auth, source, kind, { teamId, signal, index = 0 } = {}) {
    let data
    if (typeof source !== "string") throw new VendorError("参考媒体须为 data URL 或 HTTPS 地址。")
    if (source.startsWith("https://")) {
      const url = new URL(source)
      if (url.username || url.password || url.hash) throw new VendorError("参考媒体地址不得包含账号或 fragment。")
      data = await post(auth, "/api/biz/v1/skill/upload_file", { url: url.href }, { signal, teamId })
    } else {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source)
      if (!match || !match[1].startsWith(`${kind}/`)) throw new VendorError(`参考${kind}须为正确类型的 Base64 data URL 或 HTTPS 地址。`)
      const encoded = match[2].replace(/[\r\n]/g, "")
      const bytes = Buffer.from(encoded, "base64")
      if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new VendorError("参考素材 Base64 编码无效。")
      if (!bytes.length || bytes.length >= 500_000_000) throw new VendorError("参考素材须大于 0 且小于 500 MB。")
      const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg" }
      const extension = extensions[match[1]]
      if (!extension) throw new VendorError(`不支持素材类型 ${match[1]}。`)
      const form = new FormData()
      form.set("file", new Blob([bytes], { type: match[1] }), `reference-${index + 1}.${extension}`)
      data = await post(auth, "/api/biz/v1/skill/upload_file", form, { signal, teamId, multipart: true })
    }
    if (typeof data.pippit_asset_id !== "string" || !data.pippit_asset_id) throw new VendorError("小云雀上传响应缺少素材 ID。", 502)
    return data.pippit_asset_id
  }
  async function remember(task) {
    if (!directory) throw new Error("小云雀任务记录缺少配置目录。")
    const folder = join(directory, "xiaoyunque", "tasks")
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const path = join(folder, `${fingerprint(task.thread + ":" + task.run)}.json`)
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
    await writeFile(temporary, JSON.stringify(task), { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  }
  async function accountAuth(account, taskAccount) {
    if (!directory) throw new Error("小云雀工具缺少 Magpie 配置目录。")
    async function optionalJSON(file, empty) {
      try {
        return JSON.parse(await readFile(join(directory, file), "utf8"))
      } catch (error) {
        if (error.code === "ENOENT") return empty
        throw error
      }
    }
    const store = await optionalJSON("plugin-auth.json", {})
    const [logins, providers] = await Promise.all([optionalJSON("logins.json", []), optionalJSON("providers.json", { providers: [] })])
    if (!Array.isArray(logins) || !Array.isArray(providers.providers)) throw new VendorError("Magpie 账号配置格式无效，请在供应商页检查。")
    const provider = providers.providers.find((entry) => [PROVIDER, `${PROVIDER}-plugin`].includes(entry.id))
    if (provider?.off) throw new VendorError("小云雀供应商已关闭，请在 Magpie 供应商页开启。", 403)
    const accounts = Object.keys(store).filter((id) => id === PROVIDER || id.startsWith(`${PROVIDER}#`)).sort().map((id) => {
      const login = logins.find((entry) => entry.agent === `plugin:${PROVIDER}` && entry.home === id)
      const user = login?.user ?? store[id].metadata?.email ?? id
      const label = provider?.accountNames?.[user.toLowerCase()] ?? user
      return { id, label, user, login }
    }).filter((entry) => !entry.login?.hidden)
    if (!accounts.length) throw new VendorError("请在 Magpie 供应商页登录小云雀。", 401)
    const enabled = accounts.filter((entry) => !entry.login || (entry.login.on || entry.login.first) && !entry.login.paused && !entry.login.lapsed)
    enabled.sort((left, right) => Number(Boolean(right.login?.first)) - Number(Boolean(left.login?.first)) ||
      (left.login?.order ?? 0) - (right.login?.order ?? 0) || left.user.localeCompare(right.user))
    const matches = account ? accounts.filter((entry) => [entry.id, entry.label, entry.user, store[entry.id].metadata?.email].includes(account)) :
      taskAccount ? accounts.filter((entry) => fingerprint(store[entry.id].metadata?.uid ? `uid:${store[entry.id].metadata.uid}` : store[entry.id].key) === taskAccount) : enabled.slice(0, 1)
    if (matches.length > 1) throw new VendorError("账号备注重复，请使用完整 Magpie 小云雀账号 ID。")
    const selected = matches[0]
    if (!selected) throw new VendorError(taskAccount ? "请登录提交该任务的原小云雀账号。" : "没有可用的小云雀账号，请检查供应商页的账号开关。", 401)
    if (!enabled.includes(selected)) throw new VendorError("所选小云雀账号已关闭、暂停或失效，请在供应商页检查。", 403)
    credentials(store[selected.id])
    return { auth: store[selected.id], account: selected.id, accounts: enabled.map((entry) => ({ account: entry.id, label: entry.label })) }
  }
  async function recent(auth) {
    const folder = join(directory, "xiaoyunque", "tasks")
    let files
    try {
      files = await readdir(folder)
    } catch (error) {
      if (error.code === "ENOENT") return []
      throw error
    }
    const tasks = await Promise.all(files.filter((file) => /^[a-f0-9]{24}\.json$/.test(file)).map(async (file) =>
      JSON.parse(await readFile(join(folder, file), "utf8"))))
    return tasks.filter((task) => task.account === credentials(auth).account).sort((left, right) => right.created - left.created).slice(0, 20)
  }
  return { post, models, spaces, upload, remember, accountAuth, recent }
}
