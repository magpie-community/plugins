import { execFileSync } from "node:child_process"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { hasMcpBridge, removeMcpBridge } from "./mcp-sync.mjs"

function designRunning() {
  if (process.platform === "darwin") {
    return execFileSync("/bin/ps", ["-axo", "args="], { encoding: "utf8" }).split("\n")
      .some((line) => /\/MiniMax Design\.app\/Contents\/MacOS\/MiniMax Design$/.test(line.trim()))
  }
  if (process.platform === "win32") {
    return execFileSync("tasklist", ["/FI", "IMAGENAME eq MiniMax Design.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" })
      .toLowerCase().includes('"minimax design.exe"')
  }
  throw new Error("Native MCP persistence requires macOS or Windows.")
}

export function readMcpVault(control) {
  const stored = JSON.parse(fs.readFileSync(control, "utf8")).customMcpVault
  if (!stored) return { version: 1, servers: {}, records: {} }
  let text = stored
  if (stored.startsWith("v2enc:")) {
    const parts = stored.slice(6).split(":")
    if (parts.length !== 3) throw new Error("Invalid Design MCP vault encoding.")
    const key = fs.readFileSync(path.join(path.dirname(control), ".token-key"))
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64"))
    decipher.setAuthTag(Buffer.from(parts[1], "base64"))
    text = Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8")
  }
  const vault = JSON.parse(text)
  if (vault.version !== 1 || !vault.servers || typeof vault.servers !== "object" || Array.isArray(vault.servers)) {
    throw new Error("Unsupported Design MCP vault.")
  }
  return vault
}

function serverIdentity(name) {
  return name.replaceAll(".", "_").toLowerCase()
}

function normalizeConfig(config) {
  const normalized = { ...config }
  for (const field of ["command", "url"]) {
    if (normalized[field] !== undefined) normalized[field] = normalized[field].trim()
  }
  for (const field of ["env", "headers"]) {
    if (normalized[field] !== undefined) {
      normalized[field] = Object.fromEntries(Object.entries(normalized[field]).map(([key, value]) => [key.trim(), value]))
    }
  }
  return normalized
}

export function nativeMcpServer(name, entry) {
  const identity = serverIdentity(name)
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(identity) ||
      identity === "design" || identity.startsWith("design_")) {
    throw new Error(`Invalid Design MCP server name: ${name}`)
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      (entry.enabled !== undefined && typeof entry.enabled !== "boolean")) {
    throw new Error(`Invalid Library MCP config: ${name}`)
  }
  let config
  if (entry.type === "local" && Array.isArray(entry.command) && entry.command.length &&
      entry.command.length <= 129 && entry.command.every((value) => typeof value === "string" && value.length <= 4096) &&
      entry.command[0].trim() && entry.command[0].length <= 1024) {
    config = { transport: "stdio", command: entry.command[0], args: entry.command.slice(1),
      ...(entry.environment ? { env: entry.environment } : {}) }
  } else if (entry.type === "remote" && typeof entry.url === "string") {
    const url = new URL(entry.url)
    if (!["http:", "https:"].includes(url.protocol) || entry.url.length > 8192 ||
        (entry.transport !== undefined && !["sse", "http", "streamable-http"].includes(entry.transport))) {
      throw new Error(`Unsupported Library MCP URL or transport: ${name}`)
    }
    config = { transport: entry.transport === "sse" ? "sse" : "http", url: entry.url,
      ...(entry.headers ? { headers: entry.headers } : {}) }
  } else throw new Error(`Unsupported Library MCP config: ${name}`)
  for (const field of ["env", "headers"]) {
    const values = config[field]
    if (values === undefined) continue
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 64 ||
        Object.entries(values).some(([key, value]) => !key.trim() || key.length > 256 || typeof value !== "string" || value.length > 8192)) {
      throw new Error(`Invalid Library MCP ${field}: ${name}`)
    }
    const keys = Object.keys(values).map((key) => field === "headers" ? key.trim().toLowerCase() : key.trim())
    if (new Set(keys).size !== keys.length) throw new Error(`Conflicting Library MCP ${field}: ${name}`)
  }
  if (entry.timeout !== undefined) {
    if (!Number.isSafeInteger(entry.timeout) || entry.timeout <= 0 || entry.timeout > 3600000) {
      throw new Error(`Invalid Library MCP timeout: ${name}`)
    }
    config.timeoutMs = entry.timeout
  }
  config.timeoutMs ??= 60000
  return { name, enabled: entry.enabled !== false, config: normalizeConfig(config) }
}

function runtimeMcpServer(server) {
  const { config } = server
  let transport
  if (config.transport === "stdio") {
    transport = {
      type: "local", command: [config.command, ...config.args ?? []],
      ...(config.env && Object.keys(config.env).length ? { environment: config.env } : {}),
    }
  } else {
    transport = {
      type: "remote", url: config.url,
      ...(config.headers && Object.keys(config.headers).length ? { headers: config.headers } : {}),
    }
  }
  return {
    ...transport,
    enabled: server.enabled,
    ...(config.timeoutMs ? { timeout: config.timeoutMs } : {}),
  }
}

export function syncMcpStore({ control }, { isRunning, legacyManaged = {} } = {}) {
  const directory = path.dirname(control)
  const input = path.join(directory, "library-mcp.json")
  if (!fs.existsSync(input)) return { changed: false }
  const ownership = path.join(directory, ".magpie-mcp", "ownership.json")
  const previous = fs.existsSync(ownership) ? JSON.parse(fs.readFileSync(ownership, "utf8")) : { servers: {} }
  const managed = JSON.parse(fs.readFileSync(input, "utf8")).mcp
  if (!managed || typeof managed !== "object" || Array.isArray(managed)) {
    throw new Error("Library MCP staging must contain an mcp object.")
  }
  const identities = Object.keys(managed).map(serverIdentity)
  if (new Set(identities).size !== identities.length) throw new Error("Conflicting Library MCP server identities.")
  for (const [name, entry] of Object.entries(legacyManaged)) nativeMcpServer(name, entry)
  const desired = Object.fromEntries(Object.entries(managed)
    .map(([name, entry]) => [name, nativeMcpServer(name, entry)]))
  const vault = readMcpVault(control)
  const servers = { ...vault.servers }
  const records = { ...vault.records }
  const priorRuntime = {}
  for (const [name, old] of Object.entries(previous.servers)) {
    priorRuntime[name] = [runtimeMcpServer(old)]
    const existing = servers[name]
    if (existing && isDeepStrictEqual(normalizeConfig(existing.config), normalizeConfig(old.config))) {
      priorRuntime[name].push(runtimeMcpServer(existing))
    }
  }
  const next = {}
  for (const [name, server] of Object.entries(desired)) {
    const identity = serverIdentity(name)
    if (Object.keys(servers).some((existingName) => existingName !== name && serverIdentity(existingName) === identity)) {
      throw new Error(`Design MCP runtime identity is already in use: ${name}`)
    }
    const existing = servers[name]
    const old = previous.servers[name]
    if (existing && !old) {
      throw new Error(`Design MCP already exists outside Magpie management: ${name}`)
    }
    if (existing && old) {
      const existingConfig = normalizeConfig(existing.config)
      if (!isDeepStrictEqual(existingConfig, normalizeConfig(old.config)) &&
          !isDeepStrictEqual(existingConfig, server.config)) {
        throw new Error(`Design MCP was edited locally; retained: ${name}`)
      }
    }
    const enabled = existing && old && server.enabled === old.enabled ? existing.enabled : server.enabled
    servers[name] = { ...server, enabled }
    records[name] ??= { source: "custom" }
    next[name] = server
  }
  for (const [name, old] of Object.entries(previous.servers)) {
    if (Object.hasOwn(desired, name)) continue
    if (servers[name] && !isDeepStrictEqual(normalizeConfig(servers[name].config), normalizeConfig(old.config))) {
      throw new Error(`Withdrawn Design MCP has local edits; retained: ${name}`)
    }
    delete servers[name]
    delete records[name]
  }
  const changed = !isDeepStrictEqual(vault.servers, servers) || !isDeepStrictEqual(vault.records ?? {}, records)
  const currentRuntime = Object.fromEntries(Object.keys(desired).map((name) => [
    name, [managed[name], runtimeMcpServer(servers[name])],
  ]))
  const cleanup = {}
  for (const entries of [previous.runtime, legacyManaged, priorRuntime, currentRuntime]) {
    for (const [name, entry] of Object.entries(entries ?? {})) {
      cleanup[name] ??= []
      for (const candidate of Array.isArray(entry) ? entry : [entry]) {
        if (!cleanup[name].some((existing) => isDeepStrictEqual(existing, candidate))) cleanup[name].push(candidate)
      }
    }
  }
  if (!changed && isDeepStrictEqual(previous.servers, next) && previous.nativeReady === true &&
      !hasMcpBridge(control, cleanup)) return { changed: false }
  if (isRunning === undefined) isRunning = designRunning()
  if (isRunning) return { changed: false, pending: true }
  fs.mkdirSync(path.dirname(ownership), { recursive: true, mode: 0o700 })
  if (changed) {
    const key = fs.readFileSync(path.join(directory, ".token-key"))
    if (key.length !== 32) throw new Error("Design encryption key is invalid; no configuration written.")
    const iv = randomBytes(16)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    const retained = { ...vault, servers, records }
    if (retained.serverOAuth) {
      retained.serverOAuth = Object.fromEntries(Object.entries(retained.serverOAuth).filter(([name]) => Object.hasOwn(servers, name)))
    }
    if (retained.pausedForUpdate) retained.pausedForUpdate = retained.pausedForUpdate.filter((name) => Object.hasOwn(servers, name))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(retained), "utf8"), cipher.final()])
    const config = JSON.parse(fs.readFileSync(control, "utf8"))
    const backup = path.join(path.dirname(ownership), "hub-config.before-native-mcp.json")
    if (!fs.existsSync(backup)) fs.copyFileSync(control, backup)
    fs.chmodSync(backup, 0o600)
    config.customMcpVault = `v2enc:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`
    fs.writeFileSync(`${control}.magpie-mcp.tmp`, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
    fs.renameSync(`${control}.magpie-mcp.tmp`, control)
  }
  function saveOwnership(nativeReady) {
    fs.writeFileSync(`${ownership}.tmp`, JSON.stringify({
      servers: next, runtime: nativeReady ? currentRuntime : cleanup, nativeReady,
    }, null, 2) + "\n", { mode: 0o600 })
    fs.renameSync(`${ownership}.tmp`, ownership)
  }
  saveOwnership(false)
  removeMcpBridge(control, cleanup)
  saveOwnership(true)
  return { changed }
}
