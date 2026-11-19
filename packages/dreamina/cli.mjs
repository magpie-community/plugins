import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEFAULT_TIMEOUT_MS = 120_000

let testRunner = null
let testRunnerGen = 0

export class CliError extends Error {
  constructor(message, opts = {}) {
    super(message)
    this.name = "CliError"
    this.status = opts.status ?? 502
    this.code = opts.code ?? "cli_error"
    this.exitCode = opts.exitCode ?? null
    this.cliError = opts.cliError ?? null
    this.payload = opts.payload ?? null
    if (opts.signIn) this.signIn = opts.signIn
  }
}

export function createAbortError(message = "Aborted") {
  return new DOMException(message, "AbortError")
}

export function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === "ABORT_ERR"
}

export function redactSensitiveText(text) {
  if (typeof text !== "string" || !text) return ""
  return text
    .replace(/("creditConfirmationToken"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/(--credit-token(?:\s+|=))([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/[^\s"'<>]+?\?)(?:[^\s"'<>]*?(?:Signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Policy|Key-Pair-Id|token|auth|sig|sign|Expires)=[^\s"'<>]*)/gi, "$1[REDACTED]")
}

function isExecutableFile(filePath) {
  if (!filePath) return false
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile()) return false
    fs.accessSync(filePath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function pathExtensions() {
  if (process.platform !== "win32") return [""]
  const raw = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM"
  const exts = raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
  return ["", ...exts]
}

function searchPathFor(name, pathValue) {
  if (!pathValue) return null
  const dirs = pathValue.split(path.delimiter).filter(Boolean)
  const exts = pathExtensions()
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? name + ext : name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

export function resolveCliBin({ env = process.env, homedir = os.homedir() } = {}) {
  const override = String(env?.DREAMINA_CANVAS_BIN ?? "").trim()
  if (override) {
    if (override.includes(path.sep) || (path.altSeparator && override.includes(path.altSeparator))) {
      return isExecutableFile(override) ? override : null
    }
    const foundOverride = searchPathFor(override, env?.PATH || env?.Path || "")
    if (foundOverride) return foundOverride
    return isExecutableFile(override) ? override : null
  }

  const fromPath = searchPathFor("dreamina-canvas", env?.PATH || env?.Path || "")
  if (fromPath) return fromPath

  const candidates = [
    path.join(homedir, ".local", "bin", process.platform === "win32" ? "dreamina-canvas.exe" : "dreamina-canvas"),
    "/opt/homebrew/bin/dreamina-canvas",
    "/usr/local/bin/dreamina-canvas",
  ]
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

export function isCliInstalled(opts) {
  return resolveCliBin(opts) !== null
}

export function setCliRunnerForTests(fn) {
  testRunner = typeof fn === "function" ? fn : null
  testRunnerGen++
}

export function hasCliRunnerForTests() {
  return testRunner !== null
}

export function getCliRunnerGen() {
  return testRunnerGen
}

export function parseJsonOutput(text) {
  const raw = String(text ?? "").trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    const lines = raw.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line.startsWith("{") && !line.startsWith("[")) continue
      try {
        return JSON.parse(line)
      } catch {
        // continue scanning
      }
    }
  }
  return null
}

function classifyCliError(exitCode, cliErr, rawMessage) {
  const cls = String(cliErr?.class || "").toLowerCase()
  const code = String(cliErr?.code || "").toLowerCase()
  const action = String(cliErr?.requiredAction || "").toLowerCase()
  const msg = String(cliErr?.message || rawMessage || "")

  if (
    exitCode === 11 ||
    cls === "auth" ||
    action === "reauth" ||
    action === "login" ||
    /auth|unauthenticated|unauthorized|not_logged_in/.test(code) ||
    /not (?:logged|signed) in|unauthenticated|unauthorized|login required|please (?:log|sign) in|session.*expired|token.*expired/i.test(msg)
  ) {
    return { status: 401, code: cliErr?.code || "unauthorized", signIn: "expired" }
  }
  if (cls === "insufficient_credits" || /credit|balance|quota|积分不足/i.test(code + " " + msg)) {
    return { status: 402, code: cliErr?.code || "insufficient_credits" }
  }
  if (cls === "invalid_input" || exitCode === 2) {
    return { status: 400, code: cliErr?.code || "invalid_request_error" }
  }
  if (cls === "permission_denied" || cls === "forbidden") {
    return { status: 403, code: cliErr?.code || "permission_denied" }
  }
  if (cls === "not_found") {
    return { status: 404, code: cliErr?.code || "not_found" }
  }
  if (cls === "rate_limit") {
    return { status: 429, code: cliErr?.code || "rate_limit_exceeded" }
  }
  if (exitCode === 20 || cls === "timeout" || code.includes("timeout")) {
    return { status: 504, code: cliErr?.code || "timeout" }
  }
  return { status: 502, code: cliErr?.code || "cli_error" }
}

function spawnCliProcess(bin, fullArgs, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }
    let child
    try {
      child = spawn(bin, fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (err) {
      reject(new CliError(`Failed to start dreamina-canvas: ${redactSensitiveText(err?.message || String(err))}`, { status: 503, code: "cli_spawn_failed" }))
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    let killEscalation = null
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (killEscalation) clearTimeout(killEscalation)
      signal?.removeEventListener("abort", onAbort)
    }

    const killChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill("SIGTERM")
      } catch {}
      killEscalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL")
          } catch {}
        }
      }, 500)
      killEscalation.unref?.()
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      killChild()
      reject(createAbortError())
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        killChild()
        settled = true
        cleanup()
        resolve({ exitCode: 124, stdout, stderr, timedOut: true })
      }, timeoutMs)
    }

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new CliError(`dreamina-canvas process error: ${redactSensitiveText(err?.message || String(err))}`, { status: 502, code: "cli_process_error" }))
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

export async function runCli(profile, args = [], opts = {}) {
  const safeProfile = String(profile ?? "").trim() || "default"
  const safeArgs = Array.isArray(args) ? args.map((v) => String(v)) : []
  const signal = opts?.signal
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const check = opts?.check !== false

  if (signal?.aborted) throw createAbortError()

  const fullArgs = ["--profile", safeProfile, "--format", "json", "--non-interactive", ...safeArgs]

  let rawResult
  if (testRunner) {
    rawResult = await testRunner(safeProfile, safeArgs, { signal, timeoutMs, check, fullArgs })
    if (signal?.aborted) throw createAbortError()
  } else {
    const bin = resolveCliBin()
    if (!bin) {
      const err = new CliError("dreamina-canvas CLI not found on this machine. Install it or set DREAMINA_CANVAS_BIN.", {
        status: 503,
        code: "cli_not_found",
      })
      if (check) throw err
      return { ok: false, exitCode: 127, timedOut: false, payload: null, data: null, error: { code: "cli_not_found", message: err.message }, stderr: "" }
    }
    rawResult = await spawnCliProcess(bin, fullArgs, { signal, timeoutMs })
  }

  // Normalize either { code/exitCode, stdout, stderr } or pre-parsed { ok, data, error }
  let exitCode = 0
  let stdout = ""
  let stderr = ""
  let timedOut = Boolean(rawResult?.timedOut)
  let payload = null

  if (rawResult && typeof rawResult === "object" && ("stdout" in rawResult || "code" in rawResult || "exitCode" in rawResult) && !("ok" in rawResult && "data" in rawResult && typeof rawResult.stdout !== "string")) {
    exitCode = rawResult.exitCode ?? rawResult.code ?? 0
    stdout = String(rawResult.stdout ?? "")
    stderr = String(rawResult.stderr ?? "")
    payload = parseJsonOutput(stdout) ?? parseJsonOutput(stderr)
  } else if (rawResult && typeof rawResult === "object") {
    payload = rawResult
    exitCode = rawResult.exitCode ?? rawResult.code ?? (rawResult.ok === false ? 1 : 0)
    stderr = String(rawResult.stderr ?? "")
  }

  const cliErr = payload && typeof payload.error === "object" && payload.error ? payload.error : null
  const ok = !timedOut && exitCode === 0 && (payload ? payload.ok !== false : true)
  const data = payload && typeof payload === "object" && "data" in payload ? payload.data : payload

  if (!ok && check) {
    const fallbackText = redactSensitiveText((stderr || stdout || "").trim().slice(-800))
    const rawMsg = timedOut
      ? `dreamina-canvas ${safeArgs.slice(0, 2).join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`
      : cliErr?.message || fallbackText || `dreamina-canvas ${safeArgs.slice(0, 2).join(" ")} failed (exit ${exitCode})`
    const info = timedOut ? { status: 504, code: "timeout" } : classifyCliError(exitCode, cliErr, rawMsg)
    throw new CliError(redactSensitiveText(rawMsg), {
      status: info.status,
      code: info.code,
      exitCode,
      cliError: cliErr,
      payload,
      signIn: info.signIn,
    })
  }

  return {
    ok,
    exitCode,
    timedOut,
    payload,
    data,
    error: cliErr ?? (!ok ? { code: timedOut ? "timeout" : "cli_error", message: redactSensitiveText((stderr || stdout || "").trim() || `exit ${exitCode}`) } : null),
    stderr: redactSensitiveText(stderr),
  }
}
