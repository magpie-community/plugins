import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

export const PROVIDER_ID = "magpie"
export const PROVIDER_NAME = "magpie"

export function uebox_dir(env = process.env) {
  if (env.UEBOX_USER_DATA) return env.UEBOX_USER_DATA
  if (process.platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "unreal-box")
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "unreal-box")
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "unreal-box")
}

export function link_path(env = process.env) {
  if (env.MAGPIE_UEBOX_LINK) return env.MAGPIE_UEBOX_LINK
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie", "uebox-link.json")
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
}

function shellEcho(value) {
  return process.platform === "win32" ? `echo ${value}` : `printf %s '${value}'`
}

export function toModel(m) {
  const efforts = Array.isArray(m.efforts) ? m.efforts.filter((e) => typeof e === "string") : []
  const out = {
    id: String(m.id),
    displayName: m.name ? String(m.name) : String(m.id),
    supportsTools: true,
    supportsVision: m.images === true,
    supportsVideo: false,
    supportsReasoning: efforts.length > 0,
  }
  if (Number.isInteger(m.context) && m.context > 0) out.contextWindow = m.context
  if (Number.isInteger(m.output) && m.output > 0) out.maxOutputTokens = m.output
  return out
}

export function buildProvider(link) {
  const seen = new Set()
  const models = []
  for (const m of link.magpie_models || []) {
    if (!m || !m.id || seen.has(m.id)) continue
    seen.add(String(m.id))
    models.push(toModel(m))
  }
  return {
    id: PROVIDER_ID,
    displayName: PROVIDER_NAME,
    kind: "chat",
    protocol: "openai-responses",
    baseUrl: String(link.magpie_v1).replace(/\/+$/, ""),
    apiKey: { kind: "shell", command: shellEcho(link.magpie_key) },
    headers: { "x-magpie-agent": "uebox" },
    models,
  }
}

export function linkReady(link) {
  return !!(link && typeof link.magpie_key === "string" && link.magpie_key && typeof link.magpie_v1 === "string" && link.magpie_v1 && Array.isArray(link.magpie_models) && link.magpie_models.length > 0)
}

export function merge(settings, link) {
  const base = settings && typeof settings === "object" && Array.isArray(settings.providers) ? settings : { version: 3, providers: [], roles: {} }
  const providers = base.providers.filter((p) => !p || p.id !== PROVIDER_ID)
  if (linkReady(link)) providers.push(buildProvider(link))
  return { ...base, providers }
}

export function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function sync({ env = process.env, log = () => {} } = {}) {
  const dir = uebox_dir(env)
  const file = join(dir, "models.json")
  if (!existsSync(file)) return { changed: false, reason: "no-uebox" }
  const current = readJSON(file)
  // a file whose providers isn't a list is one we can't read as UEBox's:
  // merge would start it over and drop the user's roles and the rest
  if (!current || !Array.isArray(current.providers)) return { changed: false, reason: "unreadable" }
  const link = readJSON(link_path(env))
  const had = current.providers.some((p) => p && p.id === PROVIDER_ID)
  if (!linkReady(link) && !had) return { changed: false, reason: "idle" }
  const next = merge(current, link)
  if (equal(current, next)) return { changed: false, reason: "same" }
  const backup = join(dir, "models.json.magpie-backup")
  if (!existsSync(backup)) copyFileSync(file, backup)
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
    renameSync(tmp, file)
  } finally {
    try { rmSync(tmp, { force: true }) } catch {}
  }
  log(linkReady(link) ? `uebox: magpie provider written (${next.providers.find((p) => p.id === PROVIDER_ID).models.length} models)` : "uebox: magpie provider removed")
  return { changed: true, reason: linkReady(link) ? "linked" : "unlinked" }
}

export function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true })
}
