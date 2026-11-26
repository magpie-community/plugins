import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { uebox_dir } from "./sync.mjs"

export const VALID_MCP_SERVER_ID = /^[a-zA-Z0-9_-]{1,32}$/

const BLOCK_BEGIN = "<!-- magpie:begin · written by magpie from its Library -->"
const BLOCK_END = "<!-- magpie:end -->"
const BLOCK_RE = /<!-- magpie:begin[^\n]*-->[\s\S]*?<!-- magpie:end -->/
const STATE_FILE = ".uebox-sync-state.json"

export function library_staging_dir(env = process.env) {
  if (env.MAGPIE_UEBOX_LIBRARY) return env.MAGPIE_UEBOX_LIBRARY
  return join(homedir(), ".config", "magpie", "uebox-library")
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
}

function writeAtomic(file, content) {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, content, "utf8")
    renameSync(tmp, file)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {}
  }
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

function normalizeSkillsState(rawSkills) {
  const out = {}
  if (Array.isArray(rawSkills)) {
    for (const name of rawSkills) {
      if (typeof name === "string") out[name] = { hash: null, srcSig: null, dstSig: null }
    }
    return out
  }
  if (isPlainObject(rawSkills)) {
    for (const [name, meta] of Object.entries(rawSkills)) {
      if (isPlainObject(meta)) {
        out[name] = {
          hash: typeof meta.hash === "string" ? meta.hash : null,
          srcSig: typeof meta.srcSig === "string" ? meta.srcSig : null,
          dstSig: typeof meta.dstSig === "string" ? meta.dstSig : null,
        }
      }
    }
  }
  return out
}

function normalizeWarned(rawWarned) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").sort() : [])
  return {
    skippedMcp: list(rawWarned?.skippedMcp),
    keptMcp: list(rawWarned?.keptMcp),
    keptSkills: list(rawWarned?.keptSkills),
    modifiedSkills: list(rawWarned?.modifiedSkills),
  }
}

function readState(stagingDir) {
  const raw = readJSON(join(stagingDir, STATE_FILE))
  return {
    mcp: Array.isArray(raw?.mcp) ? raw.mcp.filter((x) => typeof x === "string").sort() : [],
    skills: normalizeSkillsState(raw?.skills),
    warned: normalizeWarned(raw?.warned),
  }
}

function writeState(stagingDir, state) {
  mkdirSync(stagingDir, { recursive: true })
  writeAtomic(join(stagingDir, STATE_FILE), JSON.stringify(state, null, 2) + "\n")
}

function extractMagpieBlock(raw) {
  const text = String(raw || "").replace(/\r\n/g, "\n").trim()
  if (!text) return ""
  const match = text.match(BLOCK_RE)
  if (match) return match[0]
  return `${BLOCK_BEGIN}\n${text}\n${BLOCK_END}`
}

function mergeInstructions(existing, block) {
  const norm = String(existing || "").replace(/\r\n/g, "\n")
  if (BLOCK_RE.test(norm)) {
    if (!block) {
      const cleaned = norm
        .replace(BLOCK_RE, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
      return cleaned ? `${cleaned}\n` : ""
    }
    return norm.replace(BLOCK_RE, block).replace(/\n*$/, "\n")
  }
  if (!block) return norm
  const trimmed = norm.trimEnd()
  if (!trimmed) return `${block}\n`
  return `${trimmed}\n\n${block}\n`
}

export function syncInstructions({ stagingDir, targetDir, log = () => {} }) {
  const srcFile = join(stagingDir, "instructions.md")
  const dstFile = join(targetDir, "instructions.md")
  const srcText = existsSync(srcFile) ? readFileSync(srcFile, "utf8") : ""
  const block = extractMagpieBlock(srcText)
  const hadDst = existsSync(dstFile)
  const curText = hadDst ? readFileSync(dstFile, "utf8") : ""

  if (!block && !hadDst) return { changed: false, reason: "idle" }
  const nextText = mergeInstructions(curText, block)
  if (nextText === curText.replace(/\r\n/g, "\n")) return { changed: false, reason: "same" }

  if (!nextText) {
    rmSync(dstFile, { force: true })
    log("uebox: library instructions removed")
    return { changed: true, reason: "removed" }
  }
  writeAtomic(dstFile, nextText)
  log(block ? "uebox: library instructions synced" : "uebox: library instructions cleared")
  return { changed: true, reason: block ? "synced" : "cleared" }
}

export function syncMcp({
  stagingDir,
  targetDir,
  prevManaged = [],
  prevWarnedSkipped = [],
  prevWarnedKept = [],
  log = () => {},
}) {
  const srcFile = join(stagingDir, "mcp.json")
  const dstFile = join(targetDir, "mcp.json")
  const prevSet = new Set(prevManaged)
  const warnedSkippedSet = new Set(prevWarnedSkipped)
  const warnedKeptSet = new Set(prevWarnedKept)

  let srcServers = {}
  if (existsSync(srcFile)) {
    const parsed = readJSON(srcFile)
    if (!isPlainObject(parsed)) {
      return {
        changed: false,
        reason: "unreadable-source",
        managed: prevManaged,
        skipped: [],
        warnedSkipped: prevWarnedSkipped,
        warnedKept: prevWarnedKept,
      }
    }
    if (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers)) {
      return {
        changed: false,
        reason: "unreadable-source",
        managed: prevManaged,
        skipped: [],
        warnedSkipped: prevWarnedSkipped,
        warnedKept: prevWarnedKept,
      }
    }
    srcServers = parsed.mcpServers || {}
  }

  const wanted = {}
  const skipped = []
  for (const [id, cfg] of Object.entries(srcServers)) {
    if (!VALID_MCP_SERVER_ID.test(id)) {
      skipped.push(id)
      if (!warnedSkippedSet.has(id)) {
        log(`uebox: skipping MCP server "${id}": UEBox requires IDs matching ^[a-zA-Z0-9_-]{1,32}$`)
      }
      continue
    }
    wanted[id] = cfg
  }
  skipped.sort()

  const hadDst = existsSync(dstFile)
  if (!hadDst && Object.keys(wanted).length === 0 && prevSet.size === 0) {
    return {
      changed: false,
      reason: "idle",
      managed: [],
      skipped,
      warnedSkipped: skipped,
      warnedKept: [],
    }
  }

  let dstDoc = { version: 1, mcpServers: {} }
  if (hadDst) {
    const parsed = readJSON(dstFile)
    if (!isPlainObject(parsed)) {
      return {
        changed: false,
        reason: "unreadable-target",
        managed: prevManaged,
        skipped,
        warnedSkipped: skipped,
        warnedKept: prevWarnedKept,
      }
    }
    if (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers)) {
      return {
        changed: false,
        reason: "unreadable-target",
        managed: prevManaged,
        skipped,
        warnedSkipped: skipped,
        warnedKept: prevWarnedKept,
      }
    }
    dstDoc = parsed
  }

  const curServers = isPlainObject(dstDoc.mcpServers) ? dstDoc.mcpServers : {}
  const nextServers = { ...curServers }
  const nextManaged = []
  const kept = []

  for (const id of prevSet) {
    if (!Object.hasOwn(wanted, id)) {
      delete nextServers[id]
    }
  }

  for (const [id, cfg] of Object.entries(wanted)) {
    if (Object.hasOwn(curServers, id) && !prevSet.has(id)) {
      kept.push(id)
      if (!warnedKeptSet.has(id)) {
        log(`uebox: keeping existing user MCP server "${id}"`)
      }
      continue
    }
    // Preserve user-set UEBox fields (trusted, allowedTools, readOnlyTools, disabled, etc.)
    const prevEntry = prevSet.has(id) && isPlainObject(curServers[id]) ? curServers[id] : null
    nextServers[id] = prevEntry && isPlainObject(cfg) ? { ...prevEntry, ...cfg } : cfg
    nextManaged.push(id)
  }

  nextManaged.sort()
  kept.sort()
  const nextDoc = { ...dstDoc, version: dstDoc.version ?? 1, mcpServers: nextServers }
  const changed = !hadDst || !deepEqual(dstDoc, nextDoc)
  if (changed) {
    writeAtomic(dstFile, JSON.stringify(nextDoc, null, 2) + "\n")
    log(`uebox: library MCP synced (${nextManaged.length} managed)`)
  }
  return {
    changed,
    reason: changed ? "synced" : "same",
    managed: nextManaged,
    skipped,
    warnedSkipped: skipped,
    warnedKept: kept,
  }
}

function statSignature(dir) {
  const parts = []
  const walk = (rel) => {
    const full = rel ? join(dir, rel) : dir
    let entries
    try {
      entries = readdirSync(full).sort()
    } catch {
      return
    }
    for (const name of entries) {
      const childRel = rel ? `${rel}/${name}` : name
      const childFull = join(dir, childRel)
      let st
      try {
        st = statSync(childFull)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        parts.push(`D:${childRel}`)
        walk(childRel)
      } else if (st.isFile()) {
        parts.push(`F:${childRel}:${st.size}:${Math.trunc(st.mtimeMs)}`)
      }
    }
  }
  walk("")
  return createHash("sha256").update(parts.join("\n")).digest("hex")
}

function hashDirectory(dir) {
  const hash = createHash("sha256")
  const walk = (rel) => {
    const full = rel ? join(dir, rel) : dir
    const entries = readdirSync(full).sort()
    for (const name of entries) {
      const childRel = rel ? `${rel}/${name}` : name
      const childFull = join(dir, childRel)
      let st
      try {
        st = statSync(childFull)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        hash.update(`D:${childRel}\n`)
        walk(childRel)
      } else if (st.isFile()) {
        hash.update(`F:${childRel}\n`)
        hash.update(readFileSync(childFull))
        hash.update("\n")
      }
    }
  }
  walk("")
  return hash.digest("hex")
}

function listStagingSkills(stagingSkillsDir) {
  const out = new Map()
  if (!existsSync(stagingSkillsDir)) return out
  let names
  try {
    names = readdirSync(stagingSkillsDir)
  } catch {
    return out
  }
  for (const name of names) {
    if (name.startsWith(".")) continue
    const entryPath = join(stagingSkillsDir, name)
    let st
    try {
      st = statSync(entryPath)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (!existsSync(join(entryPath, "SKILL.md"))) continue
    try {
      out.set(name, realpathSync(entryPath))
    } catch {
      out.set(name, entryPath)
    }
  }
  return out
}

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isRealDirectory(path) {
  try {
    const st = lstatSync(path)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function isTargetModifiedByUser(dstPath, prevMeta, curDstSig) {
  if (!prevMeta || !prevMeta.hash) return false
  if (prevMeta.dstSig && curDstSig === prevMeta.dstSig) return false
  if (!isRealDirectory(dstPath)) return false
  return hashDirectory(dstPath) !== prevMeta.hash
}

export function syncSkills({
  stagingDir,
  targetDir,
  prevManaged = {},
  prevWarnedKept = [],
  prevWarnedModified = [],
  log = () => {},
}) {
  const srcRoot = join(stagingDir, "skills")
  const dstRoot = join(targetDir, "skills")
  const prevMap = normalizeSkillsState(prevManaged)
  const warnedKeptSet = new Set(prevWarnedKept)
  const warnedModSet = new Set(prevWarnedModified)
  const wanted = listStagingSkills(srcRoot)

  if (wanted.size === 0 && Object.keys(prevMap).length === 0) {
    return {
      changed: false,
      reason: "idle",
      managed: [],
      managedState: {},
      warnedKept: [],
      warnedModified: [],
    }
  }

  let changed = false
  const nextManagedState = {}
  const kept = []
  const modified = []

  // Remove skills unticked from magpie, unless the user modified the copy in UEBox
  for (const [name, prevMeta] of Object.entries(prevMap)) {
    if (wanted.has(name)) continue
    const dstPath = join(dstRoot, name)
    if (!pathExists(dstPath)) continue
    const curDstSig = isRealDirectory(dstPath) ? statSignature(dstPath) : null
    if (isTargetModifiedByUser(dstPath, prevMeta, curDstSig)) {
      modified.push(name)
      if (!warnedModSet.has(name)) {
        log(`uebox: keeping modified skill "${name}" (edited in UEBox)`)
      }
      continue
    }
    rmSync(dstPath, { recursive: true, force: true })
    changed = true
  }

  if (wanted.size > 0) mkdirSync(dstRoot, { recursive: true })

  for (const [name, realSrc] of wanted.entries()) {
    const dstPath = join(dstRoot, name)
    const dstExists = pathExists(dstPath)
    const prevMeta = Object.hasOwn(prevMap, name) ? prevMap[name] : null

    if (dstExists && !prevMeta) {
      kept.push(name)
      if (!warnedKeptSet.has(name) && !warnedModSet.has(name)) {
        log(`uebox: keeping existing user skill "${name}"`)
      }
      continue
    }

    const curSrcSig = statSignature(realSrc)
    const dstIsReal = dstExists && isRealDirectory(dstPath)
    const curDstSig = dstIsReal ? statSignature(dstPath) : null

    // Fast path: neither source nor target changed since last sync
    if (prevMeta && dstIsReal && prevMeta.srcSig && prevMeta.dstSig && curSrcSig === prevMeta.srcSig && curDstSig === prevMeta.dstSig) {
      nextManagedState[name] = prevMeta
      continue
    }

    // Never overwrite a skill copy that the user edited in UEBox
    if (prevMeta && dstIsReal && isTargetModifiedByUser(dstPath, prevMeta, curDstSig)) {
      modified.push(name)
      if (!warnedModSet.has(name)) {
        log(`uebox: keeping modified skill "${name}" (edited in UEBox)`)
      }
      continue
    }

    const srcHash = hashDirectory(realSrc)
    const dstHash = dstIsReal ? hashDirectory(dstPath) : null
    if (dstIsReal && dstHash === srcHash) {
      nextManagedState[name] = { hash: srcHash, srcSig: curSrcSig, dstSig: curDstSig }
      continue
    }

    const tmpDir = join(dstRoot, `.${name}.${randomUUID()}.tmp`)
    try {
      cpSync(realSrc, tmpDir, { recursive: true, dereference: true })
      if (dstExists) rmSync(dstPath, { recursive: true, force: true })
      renameSync(tmpDir, dstPath)
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
    }
    nextManagedState[name] = { hash: srcHash, srcSig: curSrcSig, dstSig: statSignature(dstPath) }
    changed = true
  }

  const managedNames = Object.keys(nextManagedState).sort()
  kept.sort()
  modified.sort()
  if (changed) log(`uebox: library skills synced (${managedNames.length} managed)`)
  return {
    changed,
    reason: changed ? "synced" : "same",
    managed: managedNames,
    managedState: nextManagedState,
    warnedKept: kept,
    warnedModified: modified,
  }
}

export function syncLibrary({ env = process.env, platform = process.platform, log = () => {} } = {}) {
  const targetDir = uebox_dir(env, platform)
  if (!existsSync(targetDir)) return { changed: false, reason: "no-uebox" }
  const stagingDir = library_staging_dir(env)
  const prev = readState(stagingDir)

  const instructions = syncInstructions({ stagingDir, targetDir, log })
  const mcp = syncMcp({
    stagingDir,
    targetDir,
    prevManaged: prev.mcp,
    prevWarnedSkipped: prev.warned.skippedMcp,
    prevWarnedKept: prev.warned.keptMcp,
    log,
  })
  const skills = syncSkills({
    stagingDir,
    targetDir,
    prevManaged: prev.skills,
    prevWarnedKept: prev.warned.keptSkills,
    prevWarnedModified: prev.warned.modifiedSkills,
    log,
  })

  const nextState = {
    mcp: mcp.managed,
    skills: skills.managedState,
    warned: {
      skippedMcp: mcp.warnedSkipped,
      keptMcp: mcp.warnedKept,
      keptSkills: skills.warnedKept,
      modifiedSkills: skills.warnedModified,
    },
  }
  if (!deepEqual(prev, nextState)) {
    writeState(stagingDir, nextState)
  }

  const changed = instructions.changed || mcp.changed || skills.changed
  return {
    changed,
    reason: changed ? "synced" : "same",
    instructions,
    mcp,
    skills,
  }
}
