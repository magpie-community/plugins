import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

const runtimePlugin = pathToFileURL(fileURLToPath(new URL("./runtime/mcp-runtime.mjs", import.meta.url))).href
const inherited = new Set("PATH HOME USER LOGNAME USERNAME USERPROFILE APPDATA LOCALAPPDATA TEMP TMP TMPDIR SYSTEMROOT SYSTEMDRIVE WINDIR COMSPEC PATHEXT LANG LC_ALL LC_CTYPE TERM COLORTERM HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY SSL_CERT_FILE SSL_CERT_DIR".split(" "))

export function installMcpBridge(control) {
  const file = path.join(path.dirname(control), "ai-runtime/config-home/opencode/opencode.json")
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
  if (config.plugin?.includes(runtimePlugin)) return
  config.plugin = [...config.plugin ?? [], runtimePlugin]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.magpie-bridge.tmp`
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function hasMcpBridge(control, managed) {
  const file = path.join(path.dirname(control), "ai-runtime/config-home/opencode/opencode.json")
  if (!fs.existsSync(file)) return false
  const config = JSON.parse(fs.readFileSync(file, "utf8"))
  return config.plugin?.includes(runtimePlugin) ||
    Object.keys(managed).some((name) => Object.hasOwn(config.mcp ?? {}, name))
}

export function removeMcpBridge(control, managed) {
  const file = path.join(path.dirname(control), "ai-runtime/config-home/opencode/opencode.json")
  if (!fs.existsSync(file)) return
  const original = fs.readFileSync(file, "utf8")
  const config = JSON.parse(original)
  for (const [name, entry] of Object.entries(managed)) {
    if (!Object.hasOwn(config.mcp ?? {}, name)) continue
    const candidates = Array.isArray(entry) ? entry : [entry]
    if (!candidates.some((candidate) => isDeepStrictEqual(config.mcp[name], candidate))) {
      throw new Error(`Design MCP runtime config conflicts with Library; retained: ${name}`)
    }
    delete config.mcp[name]
  }
  if (config.plugin?.includes(runtimePlugin)) {
    config.plugin = config.plugin.filter((entry) => entry !== runtimePlugin)
  }
  const text = JSON.stringify(config, null, 2) + "\n"
  if (text === original) return
  const backup = `${file}.before-native-mcp.json`
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 })
  fs.writeFileSync(`${file}.magpie-bridge.tmp`, text, { mode: 0o600 })
  fs.renameSync(`${file}.magpie-bridge.tmp`, file)
}

export function createMcpBridge({ file, serverUrl, env = process.env, request = fetch }) {
  const gateway = new URL(env.GATEWAY_URL)
  if (gateway.protocol !== "http:" || gateway.hostname !== "127.0.0.1") throw new Error("Design MCP bridge requires a loopback gateway.")
  const headers = {
    "content-type": "application/json",
    "x-hilo-workspace": env.HILO_WORKSPACE_CLAIM,
    "x-hilo-workspace-instance": env.HILO_WORKSPACE_INSTANCE_ID,
    "x-hilo-workspace-generation": env.HILO_WORKSPACE_GENERATION,
  }
  if (Object.values(headers).some((value) => typeof value !== "string" || !value)) throw new Error("Design MCP workspace identity is missing.")
  const applied = new Map()
  const read = () => JSON.parse(fs.readFileSync(file, "utf8")).mcp ?? {}
  const call = async (route, body) => {
    const response = await request(new URL(route, gateway), {
      method: body ? "POST" : "GET", headers, redirect: "error",
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error(`Design MCP bridge returned HTTP ${response.status}.`)
    return response.json()
  }
  return {
    config(config) {
      for (const name of Object.keys(read())) {
        if (config.mcp?.[name]) config.mcp[name] = { ...config.mcp[name], enabled: false }
      }
    },
    async sync() {
      const servers = read()
      const status = await call("/api/connectors/proxy-status")
      const results = await Promise.allSettled(Object.entries(servers).map(async ([name, original]) => {
        if (name === "design" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(name)) throw new Error("Invalid Library MCP server name.")
        if (!["local", "remote"].includes(original.type)) throw new Error(`Invalid Library MCP transport: ${name}`)
        const fingerprint = JSON.stringify(original)
        if (applied.get(name)?.fingerprint === fingerprint &&
            status.servers[name]?.status === (original.enabled === false ? "disabled" : "connected")) return
        const config = original.type === "local" ? {
          ...original,
          environment: {
            ...Object.fromEntries([...Object.keys(env), "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"].filter((key) => !inherited.has(key.toUpperCase())).map((key) => [key, ""])),
            ...original.environment,
          },
        } : original
        const result = await call("/api/connectors/mcp", { name, config, expectedRuntimeUrl: String(serverUrl).replace(/\/$/, ""), timeoutMs: 15000 })
        if (result.status !== (original.enabled === false ? "disabled" : "connected")) throw new Error(`Design MCP registration failed: ${name} (${result.status})`)
        applied.set(name, { fingerprint, config })
      }))
      for (const name of applied.keys()) {
        if (Object.hasOwn(servers, name)) continue
        const result = await call("/api/connectors/mcp", {
          name, config: { ...applied.get(name).config, enabled: false },
          expectedRuntimeUrl: String(serverUrl).replace(/\/$/, ""), timeoutMs: 15000,
        })
        if (result.status !== "disabled") throw new Error(`Design MCP removal failed: ${name}`)
        applied.delete(name)
      }
      const failures = results.filter((result) => result.status === "rejected")
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), failures.map((result) => result.reason.message).join("; "))
    },
  }
}
