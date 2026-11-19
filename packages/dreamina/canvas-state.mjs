import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCli } from "./cli.mjs"

const STATE_FILENAME = "dreamina-canvas-state.json"
const CANVAS_NAME = "Magpie Gateway"
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"
const MAX_VIDEO_RECORDS = 500

const writeQueues = new Map()
const inflightCanvases = new Map()

export function newNodeId() {
  const bytes = randomBytes(10)
  let suffix = ""
  for (let i = 0; i < 10; i++) {
    suffix += CROCKFORD[bytes[i] & 31]
  }
  return `node_${suffix}`
}

function defaultState() {
  return { version: 1, canvases: {}, videos: {}, credits: {} }
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function finiteNonNeg(val, fallback = 0) {
  if (val === null || val === undefined || (typeof val === "string" && val.trim() === "")) return fallback
  const n = Number(val)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function nullableNonNeg(val) {
  if (val === null || val === undefined || (typeof val === "string" && val.trim() === "")) return null
  const n = Number(val)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function normalizeState(raw) {
  const state = defaultState()
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state
  if (raw.canvases && typeof raw.canvases === "object" && !Array.isArray(raw.canvases)) {
    for (const [k, v] of Object.entries(raw.canvases)) {
      if (!k || k === "__proto__" || k === "constructor" || k === "prototype") continue
      if (v && typeof v === "object" && typeof v.projectId === "string" && v.projectId) {
        state.canvases[k] = {
          projectId: v.projectId,
          name: typeof v.name === "string" ? v.name : CANVAS_NAME,
          createdAt: Number.isFinite(v.createdAt) ? v.createdAt : Date.now(),
        }
      }
    }
  }
  if (raw.videos && typeof raw.videos === "object" && !Array.isArray(raw.videos)) {
    for (const [k, v] of Object.entries(raw.videos)) {
      if (!k || k === "__proto__" || k === "constructor" || k === "prototype") continue
      if (v && typeof v === "object" && typeof v.submitId === "string" && v.submitId) {
        state.videos[k] = {
          profile: typeof v.profile === "string" && v.profile ? v.profile : "default",
          projectId: typeof v.projectId === "string" ? v.projectId : "",
          nodeId: typeof v.nodeId === "string" ? v.nodeId : "",
          submitId: v.submitId,
          model: typeof v.model === "string" ? v.model : "",
          duration: Number.isFinite(v.duration) ? v.duration : 5,
          createdAt: Number.isFinite(v.createdAt) ? v.createdAt : Date.now(),
          ...(typeof v.size === "string" && v.size ? { size: v.size } : {}),
        }
      }
    }
  }
  if (raw.credits && typeof raw.credits === "object" && !Array.isArray(raw.credits)) {
    for (const [k, v] of Object.entries(raw.credits)) {
      if (!k || k === "__proto__" || k === "constructor" || k === "prototype") continue
      if (v && typeof v === "object") {
        state.credits[k] = {
          todayDate: typeof v.todayDate === "string" ? v.todayDate : "",
          todayCredits: finiteNonNeg(v.todayCredits, 0),
          totalCredits: finiteNonNeg(v.totalCredits, 0),
          lastQuotedCredits: nullableNonNeg(v.lastQuotedCredits),
          lastQuotedAt: nullableNonNeg(v.lastQuotedAt),
          lastSpentCredits: nullableNonNeg(v.lastSpentCredits),
          lastRunAt: nullableNonNeg(v.lastRunAt),
          runCount: Math.trunc(finiteNonNeg(v.runCount, 0)),
          configuredBalance: nullableNonNeg(v.configuredBalance),
          spentSinceBalanceSet: finiteNonNeg(v.spentSinceBalanceSet, 0),
        }
      }
    }
  }
  return state
}

function candidatePaths(directory) {
  const fallback = path.join(os.tmpdir(), STATE_FILENAME)
  const dir = typeof directory === "string" ? directory.trim() : ""
  if (!dir) return [fallback]
  const primary = path.join(path.resolve(dir), STATE_FILENAME)
  return primary === fallback ? [fallback] : [primary, fallback]
}

function tryReadState(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8")
    return normalizeState(JSON.parse(text))
  } catch {
    return null
  }
}

function writeAtomic0600(filePath, data) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    const payload = JSON.stringify(data, null, 2) + "\n"
    fs.writeFileSync(tmp, payload, { mode: 0o600, encoding: "utf8" })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {}
    fs.renameSync(tmp, filePath)
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {}
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

function pruneVideos(state) {
  const entries = Object.entries(state.videos)
  if (entries.length <= MAX_VIDEO_RECORDS) return
  entries.sort((a, b) => (a[1].createdAt ?? 0) - (b[1].createdAt ?? 0))
  const dropCount = entries.length - MAX_VIDEO_RECORDS
  for (let i = 0; i < dropCount; i++) {
    delete state.videos[entries[i][0]]
  }
}

export function resolveStatePath(directory) {
  const paths = candidatePaths(directory)
  for (const p of paths) {
    if (fs.existsSync(p)) return p
  }
  return paths[0]
}

export function readCanvasState(directory) {
  const paths = candidatePaths(directory)
  for (const p of paths) {
    const parsed = tryReadState(p)
    if (parsed) return parsed
  }
  return defaultState()
}

export function writeCanvasState(directory, state) {
  const clean = normalizeState(state)
  pruneVideos(clean)
  const paths = candidatePaths(directory)
  let lastErr = null
  for (const p of paths) {
    try {
      writeAtomic0600(p, clean)
      return p
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error("Unable to write dreamina-canvas-state.json")
}

async function mutateCanvasState(directory, mutator) {
  const key = path.resolve(directory || os.tmpdir())
  const prev = writeQueues.get(key) ?? Promise.resolve()
  const next = prev.then(async () => {
    const state = readCanvasState(directory)
    const result = await mutator(state)
    writeCanvasState(directory, state)
    return result
  })
  const settled = next.then(() => {}, () => {})
  writeQueues.set(key, settled)
  return next
}

export async function ensureCanvas(profile = "default", { directory, signal } = {}) {
  const safeProfile = String(profile ?? "").trim() || "default"
  const state = readCanvasState(directory)
  const existing = Object.hasOwn(state.canvases, safeProfile) ? state.canvases[safeProfile] : null
  if (existing?.projectId) {
    return existing.projectId
  }

  const inflightKey = `${path.resolve(directory || os.tmpdir())}\0${safeProfile}`
  const pending = inflightCanvases.get(inflightKey)
  if (pending) return pending

  const createPromise = (async () => {
    const freshState = readCanvasState(directory)
    const rechecked = Object.hasOwn(freshState.canvases, safeProfile) ? freshState.canvases[safeProfile] : null
    if (rechecked?.projectId) return rechecked.projectId

    const candidateProjectId = randomUUID()
    const res = await runCli(
      safeProfile,
      ["canvas", "create", CANVAS_NAME, "--project-id", candidateProjectId],
      { signal },
    )
    const createdProjectId = res.data?.project?.projectId || candidateProjectId
    await mutateCanvasState(directory, (s) => {
      s.canvases[safeProfile] = {
        projectId: createdProjectId,
        name: res.data?.project?.name || CANVAS_NAME,
        createdAt: Date.now(),
      }
    })
    return createdProjectId
  })()

  inflightCanvases.set(inflightKey, createPromise)
  try {
    return await createPromise
  } finally {
    if (inflightCanvases.get(inflightKey) === createPromise) {
      inflightCanvases.delete(inflightKey)
    }
  }
}

export async function saveVideoTask(directory, videoTaskId, record) {
  if (!videoTaskId || typeof videoTaskId !== "string") {
    throw new Error("videoTaskId is required")
  }
  await mutateCanvasState(directory, (state) => {
    state.videos[videoTaskId] = {
      profile: String(record.profile ?? "").trim() || "default",
      projectId: String(record.projectId || ""),
      nodeId: String(record.nodeId || ""),
      submitId: String(record.submitId || ""),
      model: String(record.model || ""),
      duration: Number.isFinite(record.duration) ? record.duration : 5,
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
      ...(typeof record.size === "string" && record.size ? { size: record.size } : {}),
    }
  })
}

export function getVideoTask(directory, videoTaskId) {
  if (!videoTaskId || typeof videoTaskId !== "string") return null
  const state = readCanvasState(directory)
  if (Object.hasOwn(state.videos, videoTaskId)) {
    return { videoTaskId, ...state.videos[videoTaskId] }
  }
  // Fallback lookup by submitId
  for (const [id, rec] of Object.entries(state.videos)) {
    if (rec.submitId === videoTaskId) {
      return { videoTaskId: id, ...rec }
    }
  }
  return null
}

function emptyCreditRecord(todayKey = localDateKey()) {
  return {
    todayDate: todayKey,
    todayCredits: 0,
    totalCredits: 0,
    lastQuotedCredits: null,
    lastQuotedAt: null,
    lastSpentCredits: null,
    lastRunAt: null,
    runCount: 0,
    configuredBalance: null,
    spentSinceBalanceSet: 0,
  }
}

export async function setCreditBalance(profile = "default", { balance, directory } = {}) {
  if (balance === null || balance === undefined || balance === "") return
  if (typeof balance === "string" && balance.trim() === "") return
  const val = Number(balance)
  if (!Number.isFinite(val) || val < 0) return
  const safeProfile = String(profile ?? "").trim() || "default"
  await mutateCanvasState(directory, (state) => {
    const todayKey = localDateKey()
    const prev = Object.hasOwn(state.credits, safeProfile) ? state.credits[safeProfile] : emptyCreditRecord(todayKey)
    state.credits[safeProfile] = {
      ...prev,
      configuredBalance: val,
      spentSinceBalanceSet: 0,
    }
  })
}

export async function recordCreditQuote(profile = "default", { quotedCredits, directory } = {}) {
  const safeProfile = String(profile ?? "").trim() || "default"
  const val = Number(quotedCredits)
  if (!Number.isFinite(val) || val < 0) return
  await mutateCanvasState(directory, (state) => {
    const todayKey = localDateKey()
    const prev = Object.hasOwn(state.credits, safeProfile) ? state.credits[safeProfile] : emptyCreditRecord(todayKey)
    const todayCredits = prev.todayDate === todayKey ? finiteNonNeg(prev.todayCredits, 0) : 0
    state.credits[safeProfile] = {
      ...prev,
      todayDate: todayKey,
      todayCredits,
      lastQuotedCredits: val,
      lastQuotedAt: Date.now(),
    }
  })
}

export async function recordCreditSpend(profile = "default", { credits, directory } = {}) {
  const safeProfile = String(profile ?? "").trim() || "default"
  const val = Number(credits)
  if (!Number.isFinite(val) || val < 0) return
  await mutateCanvasState(directory, (state) => {
    const todayKey = localDateKey()
    const prev = Object.hasOwn(state.credits, safeProfile) ? state.credits[safeProfile] : emptyCreditRecord(todayKey)
    const prevToday = prev.todayDate === todayKey ? finiteNonNeg(prev.todayCredits, 0) : 0
    state.credits[safeProfile] = {
      ...prev,
      todayDate: todayKey,
      todayCredits: prevToday + val,
      totalCredits: finiteNonNeg(prev.totalCredits, 0) + val,
      spentSinceBalanceSet: finiteNonNeg(prev.spentSinceBalanceSet, 0) + val,
      lastSpentCredits: val,
      lastRunAt: Date.now(),
      runCount: Math.trunc(finiteNonNeg(prev.runCount, 0)) + 1,
    }
  })
}

export async function getCreditStats(profile = "default", { directory } = {}) {
  const safeProfile = String(profile ?? "").trim() || "default"
  const state = readCanvasState(directory)
  const rec = Object.hasOwn(state.credits, safeProfile) ? state.credits[safeProfile] : null
  if (!rec) {
    return {
      todayCredits: 0,
      totalCredits: 0,
      lastQuotedCredits: null,
      lastSpentCredits: null,
      runCount: 0,
      configuredBalance: null,
      spentSinceBalanceSet: 0,
      remainingCredits: null,
    }
  }
  const todayKey = localDateKey()
  const configuredBalance = nullableNonNeg(rec.configuredBalance)
  const spentSinceBalanceSet = finiteNonNeg(rec.spentSinceBalanceSet, 0)
  return {
    todayCredits: rec.todayDate === todayKey ? finiteNonNeg(rec.todayCredits, 0) : 0,
    totalCredits: finiteNonNeg(rec.totalCredits, 0),
    lastQuotedCredits: nullableNonNeg(rec.lastQuotedCredits),
    lastSpentCredits: nullableNonNeg(rec.lastSpentCredits),
    runCount: Math.trunc(finiteNonNeg(rec.runCount, 0)),
    configuredBalance,
    spentSinceBalanceSet,
    remainingCredits: configuredBalance !== null ? Math.max(0, configuredBalance - spentSinceBalanceSet) : null,
  }
}
