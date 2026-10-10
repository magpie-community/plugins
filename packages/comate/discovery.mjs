import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"

const DEFAULT_PORT = 8741
const string = (value) => (typeof value === "string" ? value : "")

function discoveryError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function optionsOf(options) {
  return options && typeof options === "object" ? options : {}
}

function platformOf(options) {
  return string(options.platform) || process.platform
}

function envOf(options) {
  return options.env && typeof options.env === "object" ? options.env : process.env
}

function pathOf(platform) {
  return platform === "win32" ? win32 : posix
}

function homeOf(options, platform, env, paths) {
  if (options.home !== undefined && options.home !== null) {
    if (typeof options.home !== "string" || !paths.isAbsolute(options.home)) {
      throw discoveryError("COMATE_HOME_INVALID", "Comate home must be an absolute path.")
    }
    return paths.normalize(options.home)
  }

  const candidate = platform === "win32" ? env.USERPROFILE : env.HOME
  if (typeof candidate === "string" && paths.isAbsolute(candidate)) return paths.normalize(candidate)

  const home = homedir()
  return paths.isAbsolute(home) ? paths.normalize(home) : paths.parse(home).root
}

function overridePath(options, optionName, envName, env) {
  const value = options[optionName] ?? env[envName]
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") {
    throw discoveryError("COMATE_PATH_INVALID", `${envName} must be an absolute path.`)
  }
  const clean = value.trim()
  if (!clean) return ""
  const paths = pathOf(platformOf(options))
  if (!paths.isAbsolute(clean)) {
    throw discoveryError("COMATE_PATH_INVALID", `${envName} must be an absolute path.`)
  }
  return paths.normalize(clean)
}

function absoluteEnvPath(value, paths) {
  return typeof value === "string" && paths.isAbsolute(value) ? paths.normalize(value) : ""
}

export function settingsFile(input = {}) {
  const options = optionsOf(input)
  const platform = platformOf(options)
  const env = envOf(options)
  const paths = pathOf(platform)
  const explicit = overridePath(options, "settingsPath", "COMATE_SETTINGS_PATH", env)
  if (explicit) return explicit

  const home = homeOf(options, platform, env, paths)
  let directory
  if (platform === "win32") {
    const appData = absoluteEnvPath(env.APPDATA, paths) || paths.join(home, "AppData", "Roaming")
    directory = paths.join(appData, "Comate", "User")
  } else if (platform === "darwin") {
    directory = paths.join(home, "Library", "Application Support", "Comate", "User")
  } else {
    const config = absoluteEnvPath(env.XDG_CONFIG_HOME, paths) || paths.join(home, ".config")
    directory = paths.join(config, "Comate", "User")
  }
  return paths.join(directory, "settings.json")
}

export function pidFile(input = {}) {
  const options = optionsOf(input)
  const platform = platformOf(options)
  const env = envOf(options)
  const paths = pathOf(platform)
  const explicit = overridePath(options, "pidPath", "COMATE_PID_PATH", env)
  if (explicit) return explicit
  return paths.join(homeOf(options, platform, env, paths), ".comate", "zulu-serve.pid")
}

function jsoncWithoutComments(source) {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  let out = ""
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]

    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }

    if (c === '"') {
      inString = true
      out += c
      continue
    }

    if (c === "/" && next === "/") {
      out += "  "
      i += 1
      while (i + 1 < text.length && text[i + 1] !== "\n" && text[i + 1] !== "\r") {
        out += " "
        i += 1
      }
      continue
    }

    if (c === "/" && next === "*") {
      out += "  "
      i += 1
      let closed = false
      while (i + 1 < text.length) {
        const current = text[++i]
        if (current === "*" && text[i + 1] === "/") {
          out += "  "
          i += 1
          closed = true
          break
        }
        out += current === "\n" || current === "\r" ? current : " "
      }
      if (!closed) throw new Error("unterminated comment")
      continue
    }

    out += c
  }

  return out
}

function removeTrailingCommas(source) {
  let out = ""
  let inString = false
  let escaped = false

  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }

    if (c === '"') {
      inString = true
      out += c
      continue
    }

    if (c === ",") {
      let next = i + 1
      while (next < source.length && /\s/.test(source[next])) next += 1
      if (source[next] === "}" || source[next] === "]") {
        out += source.slice(i + 1, next)
        i = next - 1
        continue
      }
    }

    out += c
  }

  return out
}

function parseJsonc(source, kind) {
  try {
    return JSON.parse(removeTrailingCommas(jsoncWithoutComments(source)))
  } catch {
    const code = kind === "settings" ? "COMATE_SETTINGS_INVALID" : "COMATE_PID_INVALID"
    const message = kind === "settings"
      ? "Comate settings are not valid JSONC."
      : "Comate service discovery data is not valid JSON."
    throw discoveryError(code, message)
  }
}

function readText(path, kind) {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    const code = kind === "settings" ? "COMATE_SETTINGS_UNREADABLE" : "COMATE_PID_UNREADABLE"
    const message = kind === "settings"
      ? "Comate settings could not be read."
      : "Comate service discovery data could not be read."
    throw discoveryError(code, message)
  }
}

export function readState(input = {}) {
  const source = readText(settingsFile(input), "settings", false)
  if (source === null) return null

  const value = parseJsonc(source, "settings")
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw discoveryError("COMATE_SETTINGS_INVALID", "Comate settings are not valid JSONC.")
  }

  const license = string(value["baidu.comate.license"]).trim()
  if (!license) return null
  return { license, username: string(value["baidu.comate.username"]).trim() }
}

function parsePort(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0
  }
  if (typeof value !== "string") return 0
  const text = value.trim()
  if (!/^\d+$/.test(text)) return 0
  const port = Number(text)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

function explicitPort(input) {
  const options = optionsOf(input)
  const env = envOf(options)
  const hasOption = options.port !== undefined && options.port !== null && !(typeof options.port === "string" && options.port.trim() === "")
  const configured = hasOption
    ? options.port
    : env.COMATE_PORT
  if (configured === undefined || configured === null || (typeof configured === "string" && configured.trim() === "")) return 0
  const port = parsePort(configured)
  if (!port) {
    throw discoveryError("COMATE_PORT_INVALID", "COMATE_PORT must be an integer from 1 to 65535.")
  }
  return port
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export function readPort(input = {}) {
  const source = readText(pidFile(input), "pid")
  if (source === null) return 0

  const value = parseJsonc(source, "pid")
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw discoveryError("COMATE_PID_INVALID", "Comate service discovery data has no valid port.")
  }

  const port = parsePort(value.port)
  if (!port) throw discoveryError("COMATE_PID_INVALID", "Comate service discovery data has no valid port.")

  if (value.pid !== undefined && value.pid !== null) {
    const processId = typeof value.pid === "number"
      ? value.pid
      : typeof value.pid === "string" && /^\d+$/.test(value.pid.trim())
        ? Number(value.pid.trim())
        : 0
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw discoveryError("COMATE_PID_INVALID", "Comate service discovery data has no valid process id.")
    }
  }

  if (value.host !== undefined && value.host !== null && value.host !== "") {
    if (typeof value.host !== "string" || !loopbackHosts.has(value.host.trim().toLowerCase())) {
      throw discoveryError("COMATE_PID_HOST_INVALID", "Comate service discovery host must be loopback.")
    }
  }
  return port
}

function portFromAuth(auth) {
  return parsePort(auth?.port) || parsePort(auth?.metadata?.port)
}

export function portOf(auth, input = {}) {
  const configured = explicitPort(input)
  if (configured) return configured
  const discovered = readPort(input)
  if (discovered) return discovered
  return portFromAuth(auth) || DEFAULT_PORT
}

export function zulu(auth, options = {}) {
  return `http://127.0.0.1:${portOf(auth, options)}`
}

function authSource(auth) {
  const sources = [auth?.source, auth?.metadata?.source]
    .filter((source) => typeof source === "string" && source.trim() !== "")
    .map((source) => source.trim())
  return sources
}

export function isComate(auth) {
  if (!auth || typeof auth !== "object") return false
  if (auth.type === "oauth") return auth.source === "comate" || auth.source === "comate-paste"
  if (auth.type !== "api") return false
  return authSource(auth).every((source) => source === "comate-paste")
}

function expired(message) {
  const error = new Error(message)
  error.signIn = "expired"
  return error
}

function desktopStateError(error) {
  if (error?.code === "COMATE_SETTINGS_INVALID") return "Comate settings are not valid JSONC."
  if (error?.code === "COMATE_SETTINGS_UNREADABLE") return "Comate settings could not be read."
  return "Comate sign-in could not be read."
}

export async function credential(getAuth, input = {}) {
  const auth = await getAuth()
  if (!isComate(auth)) return null

  if (auth.type === "oauth" && auth.source === "comate") {
    let state
    try {
      state = readState(input)
    } catch (error) {
      const message = `${desktopStateError(error)} Fix the settings file or its read permissions, then retry.`
      const kept = new Error(message)
      kept.code = error?.code || "COMATE_SETTINGS_ERROR"
      kept.signIn = "kept"
      throw kept
    }
    if (!state) {
      throw expired("Comate isn't signed in on this computer. Sign in to Comate, then add it here again.")
    }
    return {
      license: state.license,
      port: portOf(auth, input),
      who: state.username || string(auth.accountId),
    }
  }

  const license = (string(auth.access) || string(auth.key)).trim()
  if (!license) throw expired("This Comate sign-in carries no license. Add it again.")
  return { license, port: portOf(auth, input), who: string(auth.accountId) }
}
