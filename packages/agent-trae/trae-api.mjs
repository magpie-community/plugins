// Silent model configuration for Trae, through its own model API.
//
// Trae stores custom models on its cloud. The Add Model dialog ultimately
// calls:
//   POST /api/ide/v1/add_custom_model
//   POST /api/ide/v1/update_custom_model   (update/delete)
// and reads:
//   GET  /api/ide/v1/get_detail_param
//
// The account is this package's own "trae-agent" sign-in: the user runs
// `magpie plugin login trae-agent`, Magpie stores the result in
// plugin-auth.json, and this module reads only that entry. No other app's
// encrypted credential store is read, and no other plugin's sign-in is used.
// No Trae window is opened, no debugging port is used, and state.vscdb is
// never read. The API key stored in each model is the encrypted `ak` Trae's
// own dialog produced; this module copies that ciphertext and never decrypts
// it.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { cpus, homedir, release } from "node:os"
import { dirname, join } from "node:path"

export const MAGPIE_PREFIX = "Magpie · "
export const AUTH_PROVIDER_ID = "trae-agent"
const DEFAULT_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8"
const DEFAULT_VERSION_CODE = "20260212"
const CONFIG_DETAIL = { support_image: true, thinking_mode: "on", max_tool_calls: 500 }

// displayNameFor is the label Trae shows for the model this plugin owns. The
// prefix is how the previous models are found and replaced. Routing groups
// keep their human name; direct models carry their full id, so two providers
// offering the same model name still get two distinct Trae entries.
export function displayNameFor(model = {}) {
  const id = String(model.modelId || model.model || "").trim()
  const name = String(model.modelName || model.name || "").trim()
  const groupLike = /^(group|auto)\//.test(id)
  const base = groupLike && name ? name : id || name || "Model"
  const out = MAGPIE_PREFIX + base
  return out.length <= 64 ? out : out.slice(0, 64)
}

export function endpointForForm(endpoint) {
  const s = String(endpoint || "").trim().replace(/\/+$/, "")
  return s.replace(/\/chat\/completions$/i, "")
}

export function keyHash(key) {
  return createHash("sha256").update(String(key || "")).digest("hex").slice(0, 16)
}


function readJson(file) {
  try {
    const text = readFileSync(file, "utf8")
    if (!text.trim()) return { ok: true, value: undefined }
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, value: undefined }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function writeSecret(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8")
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows has no POSIX modes.
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// ideToken returns this package's own "trae-agent" sign-in from Magpie's
// plugin-auth.json, created by `magpie plugin login trae-agent`. Only that id
// is read — never another plugin's entry.
export function ideToken(p) {
  return ownAuth(p) || { error: "missing" }
}

function checkToken(token, extra = {}) {
  const claims = decodeJwt(token)
  const exp = Number(claims?.exp || 0)
  const accountId = String(claims?.data?.id || claims?.data?.user_id || "")
  if (exp > 0 && exp * 1000 <= Date.now() + 60_000) {
    return { error: "expired", accountId, claims, ...extra }
  }
  return { token, claims, accountId, ...extra }
}

// ownAuth reads this package's own sign-in from Magpie's plugin-auth.json.
// The id is the one this package declares (AUTH_PROVIDER_ID); entries written
// by other plugins are never touched.
export function ownAuth(p, id = AUTH_PROVIDER_ID) {
  for (const dir of magpieDirs(p)) {
    const read = readJson(join(dir, "plugin-auth.json"))
    if (!read.ok || !isObject(read.value)) continue
    const auth = read.value[id]
    if (isObject(auth) && auth.type === "oauth" && typeof auth.access === "string" && auth.access) {
      return checkToken(auth.access, {
        source: "own-signin",
        refresh: auth.refresh,
        authHost: auth.authHost || auth.host,
        deviceId: auth.deviceId || "",
        machineId: auth.machineId || "",
        clientId: auth.clientId || "",
        region: auth.region || "",
      })
    }
  }
  return null
}

function magpieDirs(p) {
  return [...new Set([p.magpieConfig, join(p.home, ".config", "magpie")].filter(Boolean))]
}


// resourcesDir is where the app's resources/ folder sits; on macOS the app
// binary lives inside Contents/MacOS, not beside Resources.
function resourcesDir(app) {
  if (process.platform === "darwin" && app.includes(".app/")) {
    return join(app.slice(0, app.indexOf(".app/") + 4), "Contents", "Resources")
  }
  return join(dirname(app), "resources")
}

function decodeJwt(token) {
  try {
    const payload = String(token).split(".")[1]
    if (!payload) return null
    return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
  } catch {
    return null
  }
}

function run(command, args, timeout = 5000, shell = false) {
  try {
    return spawnSync(command, args, { encoding: "utf8", timeout, windowsHide: true, shell })
  } catch {
    return null
  }
}

// PowerShell 7 when it is installed, Windows PowerShell otherwise.
function runPowerShell(args, timeout = 8000) {
  const pwsh = run("pwsh", ["-NoProfile", ...args], timeout)
  if (pwsh && !pwsh.error) return pwsh
  return run("powershell", ["-NoProfile", ...args], timeout)
}

export function findTraeApp() {
  const env = process.env.MAGPIE_TRAE_APP
  if (env && existsSync(env)) return env
  if (process.platform === "win32") {
    const where = run("where", ["trae"])
    if (where && where.status === 0) {
      const cmd = String(where.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      if (cmd) {
        const exe = join(dirname(dirname(cmd)), "Trae.exe")
        if (existsSync(exe)) return exe
      }
    }
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    const pf = process.env.ProgramFiles || "C:\\Program Files"
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    for (const p of [
      join(local, "Programs", "Trae", "Trae.exe"),
      join(local, "Programs", "Trae CN", "Trae CN.exe"),
      join(pf, "Trae", "Trae.exe"),
      join(pf86, "Trae", "Trae.exe"),
    ]) {
      if (existsSync(p)) return p
    }
    const ps = runPowerShell([
      "-Command",
      "$p = Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like '*TRAE*' } | Select-Object -First 1 -ExpandProperty DisplayIcon; if ($p) { $p }",
    ], 8000)
    const line = String(ps?.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (line) {
      const exe = line.replace(/,\s*\d+$/, "")
      if (existsSync(exe)) return exe
    }
    return null
  }
  if (process.platform === "darwin") {
    for (const p of [
      "/Applications/Trae.app/Contents/MacOS/Trae",
      join(homedir(), "Applications", "Trae.app", "Contents", "MacOS", "Trae"),
      "/Applications/Trae CN.app/Contents/MacOS/Trae CN",
    ]) {
      if (existsSync(p)) return p
    }
    return null
  }
  const which = run("which", ["trae"])
  if (which && which.status === 0) {
    const p = String(which.stdout || "").trim()
    if (p && existsSync(p)) return p
  }
  for (const p of [join(homedir(), ".local", "share", "trae", "Trae"), "/opt/Trae/trae"]) {
    if (existsSync(p)) return p
  }
  return null
}

function productFor(p) {
  const app = process.env.MAGPIE_TRAE_APP || findTraeApp()
  if (app) {
    const read = readJson(join(resourcesDir(app), "app", "product.json"))
    if (read.ok && isObject(read.value)) {
      const boot = isObject(read.value.bootConfig) ? read.value.bootConfig : {}
      const agent = isObject(boot.agent) ? boot.agent : {}
      return {
        appId: typeof agent.appId === "string" && agent.appId ? agent.appId : DEFAULT_APP_ID,
        versionCode: String(read.value.traeVersionCode || DEFAULT_VERSION_CODE),
      }
    }
  }
  return { appId: DEFAULT_APP_ID, versionCode: DEFAULT_VERSION_CODE }
}

// contextFor builds the headers and Request body Trae's own client sends. The
// device values come from this package's own sign-in record; the user id comes
// from its token. Nothing is read from Trae's own credential storage.
export function contextFor(p, auth) {
  const machineId = String(auth.machineId || "")
  const deviceId = String(auth.deviceId || "")
  const product = productFor(p)
  const claims = decodeJwt(auth.token)
  const userId = String(claims?.data?.id || "")
  const platform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  const osVersion =
    process.platform === "win32"
      ? `Windows 11 ${release()}`
      : process.platform === "darwin"
        ? `macOS ${release()}`
        : `Linux ${release()}`
  const cpu = (cpus()[0]?.model || "unknown").split(" ")[0]
  const request = {
    device_id: deviceId,
    machine_id: machineId,
    device_brand: "unknown",
    device_type: platform,
    os_version: osVersion,
    app_version: product.versionCode,
    ide_version: product.versionCode,
    user_id: userId,
  }
  const headers = {
    Authorization: `Cloud-IDE-JWT ${auth.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-App-Id": product.appId,
    "X-Device-Id": deviceId,
    "X-Machine-Id": machineId,
    "X-Device-Type": platform,
    "X-Os-Version": encodeURIComponent(osVersion),
    "X-Device-Cpu": cpu,
    "X-Device-Brand": "unknown",
    "X-Trae-Client-Type": "ide",
    "X-User-Region": process.env.MAGPIE_TRAE_REGION || "SG",
    "x-ide-version-code": product.versionCode,
    "x-plugin-channel": "icube-ai",
  }
  return { headers, request, deviceId, machineId, userId }
}

function candidateHosts(p) {
  const saved = readJson(join(p.magpieDir, "trae-host.json"))
  const host = saved.ok && isObject(saved.value) ? saved.value.host : null
  return [
    ...new Set(
      [
        host,
        "https://coresg-normal.trae.ai",
        "https://core-normal.trae.ai",
        "https://coreva-normal.trae.ai",
        "https://core-normal.traeapi.us",
        "https://core-normal.trae.cn",
      ].filter(Boolean),
    ),
  ]
}

async function fetchJson(url, options = {}, timeout = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: res.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

function modelsFrom(detail) {
  const list = Array.isArray(detail?.config_info_list) ? detail.config_info_list : []
  const out = []
  for (const c of list) {
    if (!isObject(c) || !c.display_config?.is_custom_model) continue
    const d = Array.isArray(c.model_detail_list) ? c.model_detail_list[0] : null
    const cc = isObject(d?.custom_config) ? d.custom_config : {}
    out.push({
      name: String(c.config_name || ""),
      displayName: String(c.display_config?.display_name || ""),
      provider: String(d?.provider || "custom_openai_compatible"),
      baseUrl: String(cc.base_url || ""),
      ak: String(cc.ak || ""),
      id: cc.custom_model_id,
      status: cc.status,
    })
  }
  return out
}

async function listAt(host, ctx, auth) {
  const url = `${host}/api/ide/v1/get_detail_param?function=solo_agent&need_prompt=false`
  const res = await fetchJson(url, { headers: { ...ctx.headers, Authorization: `Cloud-IDE-JWT ${auth.token}` } })
  if (res.status === 401) {
    throw Object.assign(new Error("Trae refused this account's sign-in token"), { signIn: "expired" })
  }
  if (res.status !== 200 || !isObject(res.body)) {
    throw new Error(`Trae answered ${res.status} at ${host}`)
  }
  return { host, detail: res.body, models: modelsFrom(res.body) }
}

async function findHost(p, ctx, auth) {
  let lastError = null
  for (const host of candidateHosts(p)) {
    try {
      const found = await listAt(host, ctx, auth)
      writeSecret(join(p.magpieDir, "trae-host.json"), { host })
      return found
    } catch (err) {
      if (err?.signIn === "expired") throw err
      lastError = err
    }
  }
  throw lastError || new Error("Trae's model API was not reachable")
}

// isMagpieBaseUrl says a model's base URL points at the same gateway as the
// row's endpoint; that model's encrypted ak is the gateway key we can copy.
export function isMagpieBaseUrl(base, endpoint) {
  try {
    const a = new URL(base)
    const b = new URL(endpoint)
    return a.origin === b.origin && /\/v1(?:\/|$)/.test(a.pathname)
  } catch {
    return false
  }
}

function pickAk(models, endpoint) {
  const magpie = models.find(
    (m) => m.ak && m.displayName.startsWith(MAGPIE_PREFIX) && isMagpieBaseUrl(m.baseUrl, endpoint),
  )
  if (magpie) return magpie
  return models.find((m) => m.ak && isMagpieBaseUrl(m.baseUrl, endpoint)) || null
}

function rowsOf(models) {
  return models.filter((m) => m.displayName.startsWith(MAGPIE_PREFIX)).map((m) => m.displayName)
}

async function deleteModel(host, ctx, auth, model) {
  const body = {
    action: "delete",
    id: model.id,
    provider: model.provider || "custom_openai_compatible",
    model_name: model.name,
    ak: model.ak,
    status: true,
    auth_type: 0,
    sk: "",
    region: null,
    base_url: model.baseUrl,
    custom_model_type: "",
    config_detail: CONFIG_DETAIL,
    display_name: model.displayName,
    Request: ctx.request,
  }
  const res = await fetchJson(`${host}/api/ide/v1/update_custom_model`, {
    method: "POST",
    headers: { ...ctx.headers, Authorization: `Cloud-IDE-JWT ${auth.token}` },
    body: JSON.stringify(body),
  })
  if (res.status !== 200) {
    throw new Error(`Trae refused to remove ${model.displayName || model.name}: ${res.status} ${res.text.slice(0, 200)}`)
  }
}

async function addModel(host, ctx, auth, { modelId, displayName, endpoint, ak }) {
  const body = {
    provider: "custom_openai_compatible",
    model_name: modelId,
    ak,
    is_custom: true,
    auth_type: 0,
    sk: "",
    region: null,
    base_url: endpoint,
    custom_model_type: "",
    config_detail: CONFIG_DETAIL,
    display_name: displayName,
    Request: ctx.request,
  }
  const res = await fetchJson(`${host}/api/ide/v1/add_custom_model`, {
    method: "POST",
    headers: { ...ctx.headers, Authorization: `Cloud-IDE-JWT ${auth.token}` },
    body: JSON.stringify(body),
  })
  if (res.status !== 200) {
    throw new Error(`Trae refused to add ${displayName}: ${res.status} ${res.text.slice(0, 300)}`)
  }
}

// planMirror is the pure heart of the sync: given Trae's existing custom
// models and the wanted Magpie set, it decides what to add, remove and keep
// without calling anything. Models the user added themselves (no Magpie
// prefix) are never touched; a Magpie-named model whose base URL is not this
// gateway is reported as a conflict and left alone.
export function planMirror(existing, wanted, endpoint) {
  const wantedByName = new Map(wanted.map((m) => [m.modelId, m]))
  const add = []
  const remove = []
  const keep = []
  const conflicts = []
  const seen = new Set()
  for (const old of existing) {
    // Only entries this plugin wrote (the Magpie · prefix) are managed. A
    // model the user added themselves is never touched, even when its model
    // id collides with an enabled Magpie model.
    if (!old.displayName.startsWith(MAGPIE_PREFIX)) {
      keep.push(old)
      continue
    }
    const target = wantedByName.get(old.name)
    seen.add(old.name)
    if (!target) {
      // A previous mirror of a model that is no longer enabled.
      if (isMagpieBaseUrl(old.baseUrl, endpoint)) remove.push(old)
      else conflicts.push(old)
      continue
    }
    if (!isMagpieBaseUrl(old.baseUrl, endpoint)) {
      conflicts.push(old)
      continue
    }
    if (old.displayName !== target.displayName) {
      // Name changed (model renamed in Magpie): rewrite by add+remove.
      remove.push(old)
      add.push(target)
    } else {
      keep.push(old)
    }
  }
  for (const m of wanted) {
    if (!seen.has(m.modelId)) add.push(m)
  }
  return { add, remove, keep, conflicts }
}

function displayNameForCatalog(entry) {
  return displayNameFor({ modelId: entry.id, modelName: entry.display_name })
}

// modelsOfCatalog turns the gateway's /v1/models answer into the wanted set.
// Chat-completions is all a Trae custom model can speak, and the gateway's
// default list is already chat-only.
export function modelsOfCatalog(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  const out = []
  for (const m of list) {
    if (!isObject(m) || typeof m.id !== "string" || !m.id) continue
    out.push({
      modelId: m.id,
      displayName: displayNameForCatalog(m),
      contextWindow: Number(m.context_window) > 0 ? Number(m.context_window) : undefined,
      maxOutputTokens: Number(m.max_output_tokens) > 0 ? Number(m.max_output_tokens) : undefined,
      supportsImages: Array.isArray(m.modalities) ? m.modalities.includes("image") : undefined,
    })
  }
  return out
}

// previewTraeMirror reads Trae's current custom models and returns what a
// mirror would add, remove and keep. It writes nothing; the page shows this
// to the user and asks for confirmation before applyTraeMirror runs.
export async function previewTraeMirror(p, { models: wanted, endpoint }) {
  if (!Array.isArray(wanted) || wanted.length === 0) {
    return { ok: false, code: "no-models", error: "No models are enabled for Trae." }
  }
  const auth = ideToken(p)
  if (auth.error) {
    return {
      ok: false,
      code: "token-required",
      error:
        auth.error === "expired"
          ? "Trae 登录已过期，请运行 magpie plugin login trae-agent 重新登录。"
          : "还没有登录 Trae 账号，请运行 magpie plugin login trae-agent。",
    }
  }
  const ctx = contextFor(p, auth)
  let found
  try {
    found = await findHost(p, ctx, auth)
  } catch (err) {
    return {
      ok: false,
      code: err?.signIn === "expired" ? "token-required" : "unreachable",
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const plan = planMirror(found.models, wanted, endpoint)
  const previewId = createHash("sha256")
    .update(
      JSON.stringify({
        endpoint,
        wanted: wanted.map((m) => [m.modelId, m.displayName]),
        existing: found.models.map((m) => [m.name, m.displayName, m.baseUrl]),
      }),
    )
    .digest("hex")
    .slice(0, 16)
  return {
    ok: true,
    host: found.host,
    previewId,
    wanted,
    existing: found.models.map((m) => ({
      name: m.name,
      displayName: m.displayName,
      baseUrl: m.baseUrl,
    })),
    plan: {
      add: plan.add.map((m) => m.displayName),
      remove: plan.remove.map((m) => m.displayName),
      keep: plan.keep.map((m) => m.displayName),
      conflicts: plan.conflicts.map((m) => m.displayName),
    },
  }
}

// syncTraeModels is the whole silent job for every enabled model at once. It
// needs no Trae window and uses the model API's own encrypted ak from an
// existing Magpie model; the plugin never decrypts or invents that key. The
// account is the one signed in to Trae itself.
export async function syncTraeModels(p, { models: wanted, endpoint, keyHash: currentKeyHash }) {
  if (!Array.isArray(wanted) || wanted.length === 0) {
    return { ok: true, action: "none", added: [], removed: [], kept: [], failed: [], rows: [] }
  }
  if (!endpoint) throw new Error("The Trae row has no gateway endpoint")

  const auth = ideToken(p)
  if (auth.error) {
    return {
      ok: false,
      code: "token-required",
      tokenError: auth.error,
      error:
        auth.error === "expired"
          ? "Trae 的登录令牌已过期：打开一次 Trae 让它刷新，或运行 magpie plugin login trae-agent 用本插件自己的登录兜底。"
          : "还没有可用的 Trae 账号令牌：打开一次 Trae（它会自动刷新令牌），或运行 magpie plugin login trae-agent 登录。",
    }
  }

  const ctx = contextFor(p, auth)
  let found
  try {
    found = await findHost(p, ctx, auth)
  } catch (err) {
    return {
      ok: false,
      code: err?.signIn === "expired" ? "token-required" : "unreachable",
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const { host, models: existing } = found
  const plan = planMirror(existing, wanted, endpoint)

  // One encrypted ak serves every mirrored model: Trae encrypts the gateway
  // key itself, and the ciphertext is copied from a model that already works.
  const akStatePath = join(p.magpieDir, "trae-ak.json")
  const akRead = readJson(akStatePath)
  const akState = akRead.ok && isObject(akRead.value) ? akRead.value : null
  let source = pickAk(existing, endpoint)
  if (source) {
    writeSecret(akStatePath, {
      ak: source.ak,
      keyHash: currentKeyHash,
      source: source.displayName || source.name,
      at: new Date().toISOString(),
    })
  } else if (akState?.ak && (!currentKeyHash || akState.keyHash === currentKeyHash)) {
    source = { ak: akState.ak }
  } else if (akState?.ak && currentKeyHash && akState.keyHash && akState.keyHash !== currentKeyHash) {
    return {
      ok: false,
      code: "needs-key",
      error:
        "Magpie 的 Gateway key 已更换，Trae 里的加密密钥还是旧 key 的。在 Trae 里手动更新一次任意 Magpie 模型的 API Key 即可恢复静默。",
      rows: rowsOf(existing),
    }
  } else if (plan.add.length) {
    return {
      ok: false,
      code: "bootstrap-required",
      error:
        "Trae 里还没有可复制密钥的自定义模型。先在 Trae 手动添加一个（Endpoint、Gateway key、Model ID），之后插件即可静默镜像全部模型。",
      rows: rowsOf(existing),
    }
  }
  const ak = source?.ak

  const added = []
  const failed = []
  for (const model of plan.add) {
    if (!ak) break
    try {
      await addModel(host, ctx, auth, { ...model, endpoint, ak })
      added.push(model.displayName)
    } catch (err) {
      failed.push({ model: model.displayName, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const removed = []
  for (const old of plan.remove) {
    try {
      await deleteModel(host, ctx, auth, old)
      removed.push(old.displayName)
    } catch (err) {
      // A stale model that refuses to go is retried next sync; not fatal.
      failed.push({ model: old.displayName, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // A fresh read confirms what Trae's cloud now holds.
  let after = existing
  if (added.length || removed.length) {
    for (let i = 0; i < 3; i++) {
      try {
        const fresh = await listAt(host, ctx, auth)
        after = fresh.models
        if (after.some((m) => added.some((n) => m.displayName === n))) break
      } catch {
        // keep the previous list
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  const rows = rowsOf(after)
  return {
    ok: failed.length === 0,
    action: added.length ? "added" : removed.length ? "cleaned" : "unchanged",
    host,
    total: wanted.length,
    added,
    removed,
    kept: plan.keep.map((m) => m.displayName),
    conflicts: plan.conflicts.map((m) => m.displayName),
    failed,
    rows,
    keySource: "gateway",
  }
}
