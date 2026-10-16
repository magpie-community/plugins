import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, win32 } from "node:path"

const HOST_REGIONS = {
  "api.modelverse.cn": "china", "api.umodelverse.ai": "global",
  "api-cn-wlcb.modelverse.cn": "wulanchabu", "api-cn-sh2.modelverse.cn": "shanghai",
  "api-sg.umodelverse.ai": "singapore", "api-us-ca.umodelverse.ai": "los-angeles",
  "api-ge-fra.umodelverse.ai": "frankfurt",
}
const WIRE_PROTOCOLS = { "chat-completions": "chat", responses: "responses", anthropic: "anthropic", gemini: "gemini" }
const fail = (message) => new Error(`AstraFlow CLI: ${message}`)
const MAX_FILE = 1024 * 1024
const configName = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

export const cliPrompts = [{
  type: "select", key: "source", message: "Which AstraFlow CLI configuration should be copied?",
  options: [
    { value: "auto", label: "CLI environment or default configuration", hint: "No workspace search; copies the inference key only" },
    { value: "named", label: "Named CLI configuration" },
    { value: "path", label: "Explicit credential file" },
    { value: "environment", label: "API key from CLI environment" },
  ],
}, {
  type: "text", key: "configName", message: "AstraFlow CLI configuration name",
  condition: (inputs) => inputs.source === "named",
  validate: (value) => configName(value) ? undefined : "Enter a valid CLI configuration name (1–64 letters, digits, '.', '-' or '_')",
}, {
  type: "text", key: "path", message: "Absolute path to AstraFlow CLI credentials.json or a named config JSON",
  condition: (inputs) => inputs.source === "path",
  validate: (value) => isAbsolute(value) ? undefined : "Enter an absolute file path",
}]

export function cliDirectory({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (env.ASTRAFLOW_HOME) {
    if (!isAbsolute(env.ASTRAFLOW_HOME)) throw fail("ASTRAFLOW_HOME must be an absolute directory")
    return env.ASTRAFLOW_HOME
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "cn.UCloud.AstraFlow")
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "UCloud", "AstraFlow", "config")
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config")
  return join(config, "astraflow")
}

async function readJSON(path, optional = false) {
  let handle
  try {
    // Match the CLI's private-file requirement and reject symlinked files
    // and immediate directories. O_NOFOLLOW also closes the final-file race.
    const parent = await lstat(dirname(path))
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw fail("credential directory must not be a symlink")
    if (process.platform !== "win32" && (parent.mode & 0o022)) throw fail("credential directory must not be writable by other users")
    const before = await lstat(path)
    if (before.isSymbolicLink() || !before.isFile()) throw fail("credential file must be a regular file, not a symlink")
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) throw fail("credential file changed while opening it")
    if (process.platform !== "win32" && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) {
      throw fail("credential file must belong to you and have private permissions; run `astraflow workspace --repair`")
    }
    if (stat.size > MAX_FILE) throw fail("credential file is too large")
    const bytes = Buffer.alloc(MAX_FILE + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > MAX_FILE) throw fail("credential file is too large")
    let value
    try { value = JSON.parse(bytes.subarray(0, size).toString("utf8")) } catch { throw fail("configuration is not valid JSON") }
    if (!object(value)) throw fail("configuration must be a JSON object")
    return value
  } catch (e) {
    if (e?.code === "ENOENT") {
      if (optional) return null
      throw fail("configuration was not found; run `astraflow config list` or choose an explicit file")
    }
    if (e?.message?.startsWith("AstraFlow CLI:")) throw e
    throw fail("configuration cannot be read safely")
  } finally {
    await handle?.close()
  }
}

function inference(value, endpoint, declared = "all", selected) {
  const key = typeof value === "string" ? value.trim() : ""
  if (!key || key.length > 8192 || /\s|[\x00-\x1f\x7f]/.test(key)) throw fail("configuration has no valid ModelVerse API key")
  let url
  try { url = new URL(endpoint) } catch { throw fail("configuration has an invalid inference endpoint") }
  const region = HOST_REGIONS[url.hostname]
  if (!region || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) {
    throw fail("custom inference endpoints cannot be imported into the AstraFlow provider")
  }
  const protocol = declared === "all" ? selected || "chat" : WIRE_PROTOCOLS[declared]
  if (!["chat", "responses", "anthropic", "gemini"].includes(protocol) || (selected && selected !== protocol)) throw fail("configuration has an unsupported or conflicting API protocol")
  return { key, region, protocol }
}

function result(credential, source, name, inputs) {
  if (!Number.isInteger(credential.version) || credential.version < 1 || credential.version > 3) throw fail("unsupported credential file version")
  if (credential.kind === "custom") throw fail("custom provider configurations cannot be imported into the AstraFlow provider")
  if (credential.kind !== undefined && !["astraflow-key", "ucloud-oauth", "environment"].includes(credential.kind)) throw fail("unsupported configuration kind")
  if (credential.region !== undefined && !Object.values(HOST_REGIONS).includes(credential.region)) throw fail("configuration has an unsupported region")
  const cred = inference(credential.api_key, credential.endpoint ?? "https://api.modelverse.cn", credential.protocol ?? "all", inputs.protocol)
  const metadata = { region: cred.region, protocol: cred.protocol, cliImport: true, cliSource: source }
  if (name) metadata.cliConfig = name
  // OAuth tokens and arbitrary CLI fields are intentionally not copied. This
  // is a snapshot, so another CLI login or token rotation cannot replace it.
  return { type: "success", key: cred.key, metadata, accountId: name ? `AstraFlow CLI / ${name}` : `AstraFlow CLI / ${source}` }
}

export async function importCliCredential(inputs = {}, runtime = {}) {
  const env = runtime.env ?? process.env
  const source = inputs.source || "auto"
  if (!["auto", "named", "path", "environment"].includes(source)) throw fail("choose a supported import source")
  if (source === "path") {
    if (typeof inputs.path !== "string" || !isAbsolute(inputs.path)) throw fail("enter an absolute credential file path")
    return result(await readJSON(inputs.path), "file", null, inputs)
  }
  const dir = cliDirectory({ ...runtime, env })
  const named = source === "named" ? inputs.configName : source === "auto" ? env.ASTRAFLOW_CONFIG?.trim() : null
  if (named || source === "named") {
    if (!configName(named)) throw fail("enter a valid CLI configuration name")
    // Check the base as well as configs/ so a symlinked ASTRAFLOW_HOME does
    // not redirect named imports through an otherwise regular directory.
    const base = await lstat(dir).catch(() => null)
    if (base?.isSymbolicLink()) throw fail("credential directory must not be a symlink")
    return result(await readJSON(join(dir, "configs", named + ".json")), "named", named, inputs)
  }
  const value = typeof env.ASTRAFLOW_API_KEY === "string" && env.ASTRAFLOW_API_KEY.trim() ? env.ASTRAFLOW_API_KEY : env.MODELVERSE_API_KEY
  if ((source === "auto" || source === "environment") && typeof value === "string" && value.trim()) {
    return result({ version: 3, api_key: value, endpoint: env.ASTRAFLOW_MODELVERSE_ENDPOINT ?? "https://api.modelverse.cn" }, "environment", null, inputs)
  }
  if (source === "environment") throw fail("neither ASTRAFLOW_API_KEY nor MODELVERSE_API_KEY is set")
  const settings = await readJSON(join(dir, "config.json"), true)
  if (settings?.default_config !== undefined && settings.default_config !== null) {
    if (!configName(settings.default_config)) throw fail("configuration has an invalid default_config name")
    return result(await readJSON(join(dir, "configs", settings.default_config + ".json")), "named", settings.default_config, inputs)
  }
  return result(await readJSON(join(dir, "credentials.json")), "legacy", null, inputs)
}

export async function cliAuthorize(inputs = {}, runtime) {
  return {
    url: "", instructions: "Read-only import of the AstraFlow CLI inference key. OAuth tokens are not copied and the original configuration is never changed.", method: "auto",
    callback: async () => {
      try { return await importCliCredential(inputs, runtime) }
      catch (e) { return { type: "failed", error: e?.message || "AstraFlow CLI: import failed" } }
    },
  }
}
