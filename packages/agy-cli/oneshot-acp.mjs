import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { currentHome } from "./account.mjs"
import { spawnAgy, windowsTreeKill } from "./platform.mjs"
import { agyRefusal } from "./usage.mjs"
import { defuseSlashCommands } from "./cloak.mjs"

export const START_TIMEOUT_MS = 45 * 1000
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]

export class OneshotAgyError extends Error {
  constructor(status, message, { code, headers, signIn, noRetry = false } = {}) {
    super(message)
    this.status = status
    this.statusCode = status
    if (code) this.code = code
    if (headers) this.headers = headers
    if (signIn) this.signIn = signIn
    this.noRetry = noRetry
  }
}

function selectValues(options) {
  return (Array.isArray(options) ? options : []).flatMap((opt) =>
    Array.isArray(opt?.options) ? selectValues(opt.options)
      : typeof opt?.value === "string" ? [opt] : [])
}

function configSelect(options, category) {
  return (Array.isArray(options) ? options : []).find((o) => o?.type === "select" && (o.category === category || o.id === category)) || null
}

export function pickConfigDriver(configOptions, preferred) {
  const modelCfg = configSelect(configOptions, "model")
  if (!modelCfg) return null
  const values = selectValues(modelCfg.options).map((o) => o.value)
  if (!values.length) return null
  let wantModel = ""
  let wantEffort = "low"
  if (preferred) {
    const m = /^(.*)-(minimal|low|medium|high|xhigh|max)$/i.exec(preferred)
    const base = m ? m[1] : preferred
    if (m) wantEffort = m[2].toLowerCase()
    wantModel = values.find((v) => v === preferred) || values.find((v) => v === base) || ""
  }
  if (!wantModel) {
    wantModel = values.find((v) => /^gemini-[0-9.]+-flash$/i.test(v)) ||
      values.find((v) => /^gemini-.*flash/i.test(v) && !/orchestrator/i.test(v)) ||
      values.find((v) => /^gemini-/i.test(v) && !/orchestrator/i.test(v)) ||
      modelCfg.currentValue ||
      values[0]
  }
  return { modelCfg, wantModel, wantEffort }
}

export function pickLegacyDriver(modelsObj, preferred) {
  const available = (Array.isArray(modelsObj?.availableModels) ? modelsObj.availableModels : [])
    .map((m) => m?.modelId)
    .filter((id) => typeof id === "string" && id && !/orchestrator/i.test(id))
  if (preferred && (!available.length || available.includes(preferred))) return preferred
  const flashLow = available.find((id) => /^gemini-.*flash.*-low$/i.test(id))
  if (flashLow) return flashLow
  const flashAny = available.find((id) => /^gemini-.*flash/i.test(id))
  if (flashAny) return flashAny
  if (modelsObj?.currentModelId && /^gemini-.*flash/i.test(modelsObj.currentModelId)) {
    return modelsObj.currentModelId
  }
  return preferred || modelsObj?.currentModelId || "gemini-3.8-flash-low"
}

class OneshotAcpClient {
  constructor(child, { label, onRequest, onUpdate }) {
    this.child = child
    this.label = label
    this.onRequest = onRequest
    this.onUpdate = onUpdate
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ""
    this.closed = false
    child.stdin?.on("error", () => {})
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => this.#onData(chunk))
  }

  request(method, params, timeoutMs = 0) {
    if (this.closed) return Promise.reject(new Error(`ACP closed before ${method}`))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`agy ${this.label} ACP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        entry.timer.unref?.()
      }
      this.pending.set(id, entry)
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      } catch (err) {
        if (entry.timer) clearTimeout(entry.timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  notify(method, params) {
    if (this.closed) return
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
    } catch {}
  }

  close(err) {
    if (this.closed) return
    this.closed = true
    const reason = err || new Error("ACP connection closed")
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(reason)
    }
    this.pending.clear()
  }

  #onData(chunk) {
    this.buffer += chunk
    let nl
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const entry = this.pending.get(msg.id)
        if (!entry) continue
        this.pending.delete(msg.id)
        if (entry.timer) clearTimeout(entry.timer)
        if (msg.error) {
          const err = new Error(msg.error.message || JSON.stringify(msg.error))
          err.acpError = msg.error
          entry.reject(err)
        } else {
          entry.resolve(msg.result)
        }
      } else if (msg.id !== undefined && typeof msg.method === "string") {
        Promise.resolve()
          .then(() => this.onRequest(msg.method, msg.params))
          .then(
            (result) => {
              if (!this.closed) {
                try {
                  this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n")
                } catch {}
              }
            },
            (err) => {
              if (!this.closed) {
                try {
                  this.child.stdin.write(JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: { code: err?.code ?? -32603, message: err?.message || String(err) },
                  }) + "\n")
                } catch {}
              }
            },
          )
      } else if (msg.method === "session/update") {
        this.onUpdate(msg.params)
      }
    }
  }
}

export async function readTail(filePath, maxBytes = 16_384) {
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size <= 0) return ""
    const start = Math.max(0, stat.size - maxBytes)
    const fh = await fs.promises.open(filePath, "r")
    try {
      const buf = Buffer.alloc(stat.size - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      return buf.subarray(0, bytesRead).toString("utf8")
    } finally {
      await fh.close()
    }
  } catch {
    return ""
  }
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try { child.stdin?.end() } catch {}
  if (process.platform === "win32" && child.pid) {
    const kill = windowsTreeKill([child.pid])
    if (kill) {
      try { spawnSync(kill.file, kill.args, { stdio: "ignore", windowsHide: true, timeout: 5_000 }) } catch {}
    }
    try { child.kill("SIGKILL") } catch {}
    return
  }
  try { child.kill("SIGTERM") } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL") } catch {}
    }
  }, 1_500)
  timer.unref?.()
}

const liveChildren = new Set()

export function reapOneshotChildren() {
  const windows = process.platform === "win32"
  const pids = []
  for (const item of liveChildren) {
    const child = item.child
    if (!child || child.exitCode !== null || child.signalCode !== null) continue
    if (windows && child.pid) pids.push(child.pid)
    else {
      try { child.kill("SIGKILL") } catch {}
    }
  }
  const kill = windows ? windowsTreeKill(pids) : null
  if (kill) {
    try { spawnSync(kill.file, kill.args, { stdio: "ignore", windowsHide: true, timeout: 10_000 }) } catch {}
  }
  for (const item of liveChildren) {
    if (item.root) {
      try { fs.rmSync(item.root, { recursive: true, force: true, maxRetries: windows ? 5 : 0, retryDelay: 50 }) } catch {}
    }
  }
  liveChildren.clear()
}

async function classifyFailure({
  label,
  replyText,
  errMessage,
  stderrTail,
  logPath,
  agyPath,
  refusalNow,
  classifyAgyFailure,
  isUnavailableReply,
  unavailableMessage,
  emptyFallbackMessage,
}) {
  const logTail = logPath ? await readTail(logPath) : ""
  const detail = [replyText, errMessage, stderrTail, logTail].filter(Boolean).join("\n")

  if (typeof classifyAgyFailure === "function") {
    const classified = classifyAgyFailure(detail)
    if (classified) {
      return new OneshotAgyError(classified.status, classified.message, {
        code: classified.code,
        headers: classified.headers,
        signIn: classified.signIn,
        noRetry: classified.noRetry,
      })
    }
  } else {
    const refused = agyRefusal(detail)
    if (refused) return new OneshotAgyError(403, refused, { noRetry: true })
  }

  if (typeof isUnavailableReply === "function" && isUnavailableReply(replyText)) {
    const msg = typeof unavailableMessage === "function"
      ? unavailableMessage(replyText)
      : `this Antigravity account is not offered ${label}`
    return new OneshotAgyError(403, msg, { noRetry: true })
  }

  if (typeof refusalNow === "function") {
    const refused = await refusalNow(agyPath).catch(() => "")
    if (refused) return new OneshotAgyError(403, refused, { noRetry: true })
  }

  const trimmedReply = String(replyText || "").trim()
  const trimmedErr = String(errMessage || "").trim()
  if (typeof emptyFallbackMessage === "function") {
    return new OneshotAgyError(502, emptyFallbackMessage(trimmedReply, trimmedErr))
  }
  const reason = trimmedErr || trimmedReply
  const summary = reason
    ? `Antigravity ${label} failed (${reason.slice(0, 240)})`
    : `Antigravity ${label} failed without usable output`
  return new OneshotAgyError(502, summary)
}

// Run a single isolated `agy acp` session with a throwaway working folder and
// agent definition, cleaning up the process, brain artifacts and temp folder
// afterwards.
export async function runOneshotAgySession({
  label,
  tempPrefix,
  agentName,
  agentDefinition,
  driverEnvVar,
  timeoutMs,
  signal,
  deps,
  setupWorkdir,
  buildPrompt,
  isAllowedPermission,
  onUpdate,
  afterPrompt,
  isUnavailableReply,
  unavailableMessage,
  emptyFallbackMessage,
}) {
  if (signal?.aborted) throw new OneshotAgyError(499, `${label} cancelled`)

  const {
    agyPath,
    agyTooOld,
    clientInfo,
    noDefaultCustomizationsArgs,
    telemetryArgs,
    geminiDirArgs,
    refusalNow,
    classifyAgyFailure,
  } = deps

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), tempPrefix))
  const wd = path.join(root, "wd")
  const logPath = path.join(root, "agy.log")
  const agentDir = path.join(wd, ".agents", "agents", agentName)

  let child = null
  let conn = null
  let sessionId = ""
  let closable = false
  let agyDir = ""
  let replyText = ""
  let stderrTail = ""
  const tracked = { child: null, root }

  try {
    await fs.promises.mkdir(agentDir, { recursive: true, mode: 0o700 })
    await fs.promises.writeFile(path.join(agentDir, "agent.md"), agentDefinition, { encoding: "utf8", mode: 0o600 })

    const workdirState = typeof setupWorkdir === "function" ? await setupWorkdir(wd) : undefined

    const own = typeof geminiDirArgs === "function" ? await geminiDirArgs(agyPath) : { dir: "", args: [] }
    const home = currentHome()
    agyDir = own?.dir
      ? path.join(own.dir, "antigravity-cli")
      : path.join(home || os.homedir(), ".gemini", "antigravity-cli")

    const noDefaults = typeof noDefaultCustomizationsArgs === "function" ? await noDefaultCustomizationsArgs(agyPath) : []
    const telemetry = typeof telemetryArgs === "function" ? await telemetryArgs(agyPath) : []
    const args = [
      "acp",
      "--agent", agentName,
      "--log-file", logPath,
      ...noDefaults,
      ...telemetry,
      ...(own?.args || []),
    ]

    if (signal?.aborted) throw new OneshotAgyError(499, `${label} cancelled`)

    child = spawnAgy(agyPath, args, {
      cwd: wd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    tracked.child = child
    liveChildren.add(tracked)

    let configOptions = []
    child.stderr?.setEncoding?.("utf8")
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-8_192)
    })

    conn = new OneshotAcpClient(child, {
      label,
      onRequest: async (method, params) => {
        if (method === "session/request_permission") {
          const options = Array.isArray(params?.options) ? params.options : []
          if (typeof isAllowedPermission === "function" && isAllowedPermission(params?.toolCall, wd)) {
            const allow = options.find((o) => o?.kind === "allow_once") ||
              options.find((o) => o?.kind === "allow_always")
            if (allow?.optionId) return { outcome: { outcome: "selected", optionId: allow.optionId } }
          }
          const reject = options.find((o) => o?.kind === "reject_once") ||
            options.find((o) => o?.kind === "reject_always")
          return reject?.optionId
            ? { outcome: { outcome: "selected", optionId: reject.optionId } }
            : { outcome: { outcome: "cancelled" } }
        }
        const err = new Error(`Unsupported ACP client request: ${method}`)
        err.code = -32601
        throw err
      },
      onUpdate: (params) => {
        if (sessionId && params?.sessionId && params.sessionId !== sessionId) return
        const update = params?.update
        if (!update) return
        if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
          configOptions = update.configOptions
          return
        }
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
          replyText += update.content.text
        }
        if (typeof onUpdate === "function") onUpdate(update, params)
      },
    })

    child.once("error", (err) => conn?.close(err))
    child.once("close", (code, sig) => {
      conn?.close(new Error(`agy ${label} ACP exited (${code ?? sig ?? "closed"})${stderrTail.trim() ? ": " + stderrTail.trim() : ""}`))
    })

    const onAbort = () => {
      if (sessionId && conn && !conn.closed) conn.notify("session/cancel", { sessionId })
      conn?.close(new OneshotAgyError(499, `${label} cancelled`))
      stopChild(child)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      throw new OneshotAgyError(499, `${label} cancelled`)
    }

    try {
      const initRes = await conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo,
      }, START_TIMEOUT_MS)
      const tooOld = agyTooOld?.(initRes?.agentInfo?.version)
      if (tooOld) throw new OneshotAgyError(503, tooOld, { noRetry: true })
      closable = Boolean(initRes?.agentCapabilities?.sessionCapabilities?.close)

      const session = await conn.request("session/new", {
        cwd: wd,
        mcpServers: [],
      }, START_TIMEOUT_MS)
      sessionId = session?.sessionId || ""
      if (!sessionId) throw new Error(`agy ${label} session/new returned no sessionId`)

      const preferred = driverEnvVar ? (process.env[driverEnvVar] || "").trim() : ""
      if (Array.isArray(session?.configOptions) && session.configOptions.length) {
        configOptions = session.configOptions
      }
      const picked = configOptions.length ? pickConfigDriver(configOptions, preferred) : null
      if (picked) {
        try {
          if (picked.wantModel && picked.wantModel !== picked.modelCfg.currentValue) {
            const res = await conn.request("session/set_config_option", {
              sessionId,
              configId: picked.modelCfg.id,
              value: picked.wantModel,
            }, START_TIMEOUT_MS)
            if (Array.isArray(res?.configOptions)) configOptions = res.configOptions
          }
          const effortCfg = configSelect(configOptions, "thought_level")
          if (effortCfg) {
            const effortValues = selectValues(effortCfg.options).map((o) => o.value)
            const targetEffort = effortValues.includes(picked.wantEffort)
              ? picked.wantEffort
              : EFFORT_ORDER.find((e) => effortValues.includes(e)) || ""
            if (targetEffort && targetEffort !== effortCfg.currentValue) {
              await conn.request("session/set_config_option", {
                sessionId,
                configId: effortCfg.id,
                value: targetEffort,
              }, START_TIMEOUT_MS)
            }
          }
        } catch (err) {
          if (err?.acpError?.code !== -32601) throw err
          const modelId = pickLegacyDriver(session?.models, preferred)
          if (modelId && modelId !== session?.models?.currentModelId) {
            await conn.request("session/set_model", { sessionId, modelId }, START_TIMEOUT_MS)
          }
        }
      } else {
        const modelId = pickLegacyDriver(session?.models, preferred)
        if (modelId && modelId !== session?.models?.currentModelId) {
          await conn.request("session/set_model", { sessionId, modelId }, START_TIMEOUT_MS)
        }
      }

      // a command name in the prompt would run that command (cloak.mjs)
      const promptText = defuseSlashCommands(buildPrompt(workdirState))
      const promptResult = await conn.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      }, timeoutMs)

      if (signal?.aborted) throw new OneshotAgyError(499, `${label} cancelled`)

      const outcome = await afterPrompt({
        sessionId,
        agyDir,
        wd,
        replyText,
        promptResult,
        state: workdirState,
      })
      if (!outcome?.ok) {
        throw await classifyFailure({
          label,
          replyText,
          stderrTail,
          logPath,
          agyPath,
          refusalNow,
          classifyAgyFailure,
          isUnavailableReply,
          unavailableMessage,
          emptyFallbackMessage,
        })
      }
      return outcome.value
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  } catch (err) {
    if (err instanceof OneshotAgyError) throw err
    if (signal?.aborted) throw new OneshotAgyError(499, `${label} cancelled`)
    throw await classifyFailure({
      label,
      replyText,
      errMessage: err?.message || String(err),
      stderrTail,
      logPath,
      agyPath,
      refusalNow,
      classifyAgyFailure,
      isUnavailableReply,
      unavailableMessage,
      emptyFallbackMessage,
    })
  } finally {
    liveChildren.delete(tracked)
    if (sessionId && closable && conn && !conn.closed) {
      await conn.request("session/close", { sessionId }, 2_000).catch(() => {})
    }
    conn?.close()
    stopChild(child)
    const rmOpts = { recursive: true, force: true, maxRetries: process.platform === "win32" ? 5 : 0, retryDelay: 50 }
    if (agyDir && sessionId) {
      await fs.promises.rm(path.join(agyDir, "brain", sessionId), rmOpts).catch(() => {})
      await fs.promises.rm(path.join(agyDir, "conversations", `${sessionId}.pb`), { force: true }).catch(() => {})
    }
    await fs.promises.rm(root, rmOpts).catch(() => {})
  }
}
