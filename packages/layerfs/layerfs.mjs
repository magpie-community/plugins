// LayerFS backend for the magpie tools plugin.
//
// One backend sits behind the small surface (provision, checkpoint, fork,
// history, resolve, status): sim, a local content-addressed store that
// implements the same model LayerFS is built on — immutable blobs named
// by their SHA-256, branches as manifest pointers, checkpoints as
// deduplicated manifests — so the plugin runs and can be tested
// anywhere. Forking a branch copies no file bytes; a checkpoint stores
// only the blobs the store has not seen.
//
// The native backend — the real LayerFS through its JavaScript SDK —
// is NOT shipped in this registry package: the SDK is still not
// published to npm, so there is no pinned version to depend on, and
// the registry package must not load unversioned code from a path the
// user's environment names. It lives in the standalone repo
// (Mola-maker/magpie-layerfs) and returns here once the SDK is
// published and the plugin can depend on a pinned version.
//
// Environment:
//   MAGPIE_LAYERFS_BACKEND  auto (default) | sim — "native" is an
//                           explicit error in this package (above)
//   MAGPIE_LAYERFS_HOME     state root (default ~/.layerfs-tools; see
//                           defaultRoot below)
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync, symlinkSync, writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse, resolve, sep } from "node:path"

const BINDING = ".layerfs.json"

// Workspace-local scratch: two directories at the workspace root that
// are never checkpointed and never published. provision creates them,
// exec points TMPDIR and XDG_CACHE_HOME at them so toolchains keep
// their temporary files and caches inside the workspace instead of
// the host's real /tmp, and every checkpoint scan skips both names —
// their content lives and dies with the workspace directory itself.
const SCRATCH_DIRS = [".tmp", ".cache"]
const scanSkip = () => new Set([BINDING, ...SCRATCH_DIRS])
function ensureScratch(dir) {
  for (const name of SCRATCH_DIRS) mkdirPrivate(join(dir, name))
}

// ---- names -------------------------------------------------------------------

// Project names follow the SDK's rule: 1-63 chars of lowercase ASCII letters,
// digits, `_`, `-`, `.`, starting and ending alphanumeric.
export function checkProject(name) {
  if (typeof name !== "string" || !/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(name))
    throw new Error(`project is a LayerFS project name: 1-63 chars of a-z 0-9 _ - ., starting and ending with a letter or digit; got ${JSON.stringify(name)}`)
  return name
}

export function checkBranch(name) {
  if (typeof name !== "string" || !name || name.length > 100 || name.split("/").some((s) => !s || s === "." || s === ".." || !/^[A-Za-z0-9_.-]+$/.test(s)))
    throw new Error(`branch is a name like main or feat/x; got ${JSON.stringify(name)}`)
  return name
}

// A path inside a workspace: relative, and it must stay in.
export function checkInnerPath(p) {
  if (typeof p !== "string" || !p) throw new Error("path is a non-empty relative path")
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "")
  if (norm.startsWith("/") || norm.split("/").some((s) => s === ".."))
    throw new Error(`path must stay inside the workspace; got ${JSON.stringify(p)}`)
  return norm
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")
const nowIso = () => new Date().toISOString()

// ---- on-disk names -------------------------------------------------------------
// A branch name maps to ONE flat file (its head record) and one workspace
// directory segment. Every character outside [a-z0-9._-] is percent-
// encoded, so the mapping is injective AND case-injective: feat/x and
// feat__x are different branches with different files (feat%2Fx.json vs
// feat__x.json), and Main and main stay different on a case-insensitive
// volume too (branches/%4Dain.json vs branches/main.json). Every branch
// — slash branches included — sits at the top level, where listBranches
// reads. (Pre-0.7.1 encoders left some collisions: 0.7.0 encoded only
// "%" and "/", so uppercase branches shared files on case-insensitive
// volumes; pre-0.7 layouts are not migrated — see the README's notes.)
export function encodeBranchName(branch) {
  let out = ""
  for (const ch of branch)
    out += /[a-z0-9._-]/.test(ch)
      ? ch
      : "%" + ch.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")
  return out
}
export function decodeBranchName(stem) {
  return stem.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
}

// Workspaces live one directory per project — workspaces/<project>/
// <encoded branch> — because a flat `${project}--${branch}` name is
// not injective when both sides may contain "--" (project a branch
// b--c vs project a--b branch c). Project names cannot contain "/",
// so the per-project directory cannot collide. Counting workspaces
// means summing the branch directories across the project ones.
function countWorkspaces(workspacesDir) {
  if (!existsSync(workspacesDir)) return 0
  let n = 0
  for (const e of readdirSync(workspacesDir, { withFileTypes: true }))
    if (e.isDirectory()) n += readdirSync(join(workspacesDir, e.name)).length
  return n
}

// ---- private writes --------------------------------------------------------------
// The store can hold anything a source tree held, so it is created
// private: directories 0700, record files 0600, whatever the umask
// says. writeFileMode chmods after writing because writeFileSync's
// mode only applies when a file is created and is umask-masked anyway.
function writeFileMode(path, data, mode = 0o600) {
  writeFileSync(path, data, { mode })
  chmodSync(path, mode)
}
function writeJson(path, obj, pretty = false) {
  writeFileMode(path, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj))
}
function mkdirPrivate(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

// ---- importing a source tree ------------------------------------------------------
// An import sweeps a whole directory into the store, so it is the one
// place a tree the user did not mean to share can leak. The caller must
// pass the source explicitly (there is no default — magpie's
// ctx.directory is its config directory, not a working directory, and
// it holds plugin-auth.json: every signed-in plugin's token). The
// config directory, the classic credential stores, the home directory
// and the filesystem root are refused outright — as source, as a
// parent of the source, or inside it.
// The guard compares REAL paths, not spellings. A string comparison
// of resolve()d paths is bypassed two ways (round-2 review, item 1):
// a symlink pointing at a refused directory (readdirSync follows the
// root link), and a case-variant spelling on a case-insensitive
// volume ("~/.Config/Magpie", "~/.AWS"). So both sides are
// canonicalized with realpathSync and case-folded before comparing.
// A refused root that does not exist is canonicalized through its
// nearest existing ancestor — it can still be named by a case
// variant or reached through a symlinked parent, and canonicalizing
// it must never be what throws.
function canonicalForCompare(p) {
  let cur = resolve(p)
  const tail = []
  for (;;) {
    try { return join(realpathSync(cur), ...tail).toLowerCase() } catch { /* not there: walk up */ }
    const parent = dirname(cur)
    if (parent === cur) return resolve(p).toLowerCase()
    tail.unshift(cur.slice(parent.length + 1))
    cur = parent
  }
}

export function checkSourceDir(sourceDir, { configDir, storeRoot } = {}) {
  if (typeof sourceDir !== "string" || !sourceDir)
    throw new Error("source is required: the directory to import when the project is first created — pass the directory the user chose for this project")
  const given = resolve(sourceDir)
  if (!existsSync(given) || !statSync(given).isDirectory())
    throw new Error(`source is not a directory: ${sourceDir}`)
  const src = canonicalForCompare(given) // real path, case-folded: the guard's currency
  const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
  const refuses = [
    [join(homedir(), ".config", "magpie"), "the app's config directory, which holds plugin credentials (plugin-auth.json)"],
    [join(homedir(), ".ssh"), "the SSH directory"],
    [join(homedir(), ".aws"), "the AWS directory"],
    [join(homedir(), ".gnupg"), "the GnuPG directory"],
  ]
  if (configDir) refuses.unshift([configDir, "the app's config directory, which holds plugin credentials (plugin-auth.json)"])
  for (const [dir, what] of refuses)
    if (overlaps(src, canonicalForCompare(dir)))
      throw new Error(`refusing to import ${given}: it is, contains, or sits inside ${what}`)
  if (src === canonicalForCompare(homedir()) || src === canonicalForCompare(parse(given).root))
    throw new Error(`refusing to import ${given}: importing a home directory or a filesystem root would sweep far more than one project into the store — pass the project's own directory`)
  if (storeRoot && overlaps(src, canonicalForCompare(storeRoot)))
    throw new Error(`refusing to import ${given}: it overlaps the plugin's own store`)
  return given
}

// Secret-shaped paths never enter the store from an import: VCS
// internals, env files, private keys, credential stores. Matching is
// per path segment, so docs/.env.example is caught just like .env.
const KEY_FILE = /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\..*)?$/
export function isSecretPath(rel) {
  return rel.split("/").some((seg) =>
    seg === ".git" || seg === ".ssh" || seg === ".aws" || seg === ".gnupg" ||
    seg === ".netrc" || seg === ".env" || seg.startsWith(".env.") ||
    KEY_FILE.test(seg) || /\.(pem|key)$/i.test(seg))
}

// An import is bounded, so pointing it at the wrong tree fails loudly
// instead of sweeping a disk into the store.
export const IMPORT_MAX_FILES = 20000
export const IMPORT_MAX_BYTES = 512 * 1024 * 1024
function checkImportLimits(files) {
  let bytes = 0
  for (const f of files) bytes += f.size
  if (files.length > IMPORT_MAX_FILES)
    throw new Error(`source holds ${files.length} files, over the import limit of ${IMPORT_MAX_FILES} — pass the project's own directory, not a parent of it`)
  if (bytes > IMPORT_MAX_BYTES)
    throw new Error(`source holds ${bytes} bytes, over the import limit of ${IMPORT_MAX_BYTES} — pass the project's own directory, not a parent of it`)
}

// Files of a source tree with the secret-shaped ones set aside.
// Symlinks are not followed (scanTree's rule, kept): a link's target
// stays outside the import.
function walkSourceFiles(dir) {
  const files = [], skipped = []
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (isSecretPath(r)) { skipped.push(r); continue }
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full, r)
      else if (e.isFile()) {
        const st = statSync(full)
        files.push({ rel: r, full, size: st.size, mode: st.mode & 0o777 })
      }
    }
  }
  walk(dir, "")
  return { files, skipped }
}

// The sim backend's import scan: a manifest { rel: { sha, size, mode } }
// plus the list of secret-shaped paths left out, reported to the caller.
export function scanImportTree(dir) {
  const { files, skipped } = walkSourceFiles(dir)
  checkImportLimits(files)
  const manifest = {}
  for (const f of files) {
    const buf = readFileSync(f.full)
    manifest[f.rel] = { sha: sha256(buf), size: buf.length, mode: f.mode }
  }
  return { manifest, skipped }
}

// Walk a directory into a manifest: { "rel/path": { sha, size, mode } }.
// The mode rides along so a file keeps its permissions through the
// store: a 0600 file is stored and materialized as 0600, never widened
// to the umask's default.
function scanTree(dir, skip = new Set()) {
  const out = {}
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (skip.has(r)) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full, r)
      else if (e.isFile()) {
        const buf = readFileSync(full)
        out[r] = { sha: sha256(buf), size: buf.length, mode: statSync(full).mode & 0o777 }
      }
    }
  }
  walk(dir, "")
  return out
}

function manifestBytes(manifest) {
  let n = 0
  for (const f of Object.values(manifest)) n += f.size
  return n
}

function sameManifest(a, b) {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => b[k] && b[k].sha === a[k].sha)
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more bytes]` : s)

// Run a shell command in dir, capturing bounded output. Resolves with
// { code, stdout, stderr, timedOut }; never rejects on a non-zero exit —
// the caller reports the code, as a shell would. The child inherits
// the host environment except TMPDIR and XDG_CACHE_HOME, which point
// at the workspace's scratch directories (created first, so workspaces
// provisioned before they existed get them too): temporary files and
// caches stay inside the workspace instead of leaking to the host /tmp.
//
// The process plumbing is deliberate (round-2 review, item 6): stdin
// is closed, so a command that reads it gets EOF instead of waiting
// out the timeout; the child leads its own process group (detached),
// so a timeout kills the whole tree, not just /bin/sh; and the caller
// resolves on 'exit' plus a short drain, not on 'close' — a background
// child holding the stdout pipe open must not hold the call open.
function runShell(command, dir, timeoutMs) {
  return new Promise((resolvePromise) => {
    ensureScratch(dir)
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: join(dir, ".tmp"), XDG_CACHE_HOME: join(dir, ".cache") },
    })
    let out = "", err = "", timedOut = false, settled = false
    let timer = null
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout: clip(out, 8192), stderr: clip(err, 8192), timedOut })
    }
    timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, "SIGKILL") } // the whole group
      catch { try { child.kill("SIGKILL") } catch { /* already gone */ } }
      // 'exit' follows the group kill; this is only a backstop
      setTimeout(() => finish(-1), 250).unref()
    }, timeoutMs)
    child.stdout.on("data", (d) => { if (out.length < 65536) out += d })
    child.stderr.on("data", (d) => { if (err.length < 65536) err += d })
    child.on("error", (e) => { err += String(e); finish(-1) })
    child.on("exit", (code) => { setTimeout(() => finish(code), 25).unref() })
  })
}

// ---- the default state root ------------------------------------------------------
// The state root when MAGPIE_LAYERFS_HOME is unset. provision, resolve
// and exec answer workspace paths under it, and a tool result goes to
// the vendor in the agent's next request, so the default names neither
// the app nor the host (#360). A root made by 0.7.2 or earlier
// (~/.magpie-layerfs) is moved once to the new name, and a link is left
// at the old path so a session still holding an old workspace path keeps
// working. A legacy root that is itself a link (the user pointed it
// somewhere) is the user's own setup and is used where it is; so is a
// legacy root the move fails on.
export const DEFAULT_ROOT = ".layerfs-tools"
export const LEGACY_ROOT = ".magpie-layerfs"
export function defaultRoot(home = homedir()) {
  const root = join(home, DEFAULT_ROOT)
  const legacy = join(home, LEGACY_ROOT)
  if (existsSync(root)) return root
  let st
  try { st = lstatSync(legacy) } catch { return root }
  if (st.isSymbolicLink()) return legacy
  if (!st.isDirectory()) return root
  try {
    renameSync(legacy, root)
  } catch {
    // another host moved it first, or the move is refused: use what is there
    return existsSync(root) ? root : legacy
  }
  try { symlinkSync(root, legacy, process.platform === "win32" ? "junction" : "dir") } catch { /* the new paths still work */ }
  return root
}

// ---- sim backend ---------------------------------------------------------------

export class SimBackend {
  kind = "sim"

  constructor(root) {
    this.root = root || process.env.MAGPIE_LAYERFS_HOME || defaultRoot()
    this.objectsDir = join(this.root, "store", "objects")
    this.projectsDir = join(this.root, "projects")
    this.workspacesDir = join(this.root, "workspaces")
    // Commit summaries for trajectory(): records never change once
    // written, so a summary (everything but the manifest) is cached
    // per project/id for the life of this backend
    this._commitSummary = new Map()
    for (const d of [this.root, this.objectsDir, this.projectsDir, this.workspacesDir]) mkdirPrivate(d)
    // Seed the byte accounting before anything writes, so the bumps
    // below stay exact (a walk taken after a write would count it twice)
    if (!this.readAccounting())
      writeJson(this.accountingPath(), { storedBytes: this.storedBytesWalk(), logicalBytes: this.logicalBytesWalk() })
  }

  // -- store primitives
  blobPath(sha) { return join(this.objectsDir, sha.slice(0, 2), sha) }
  hasBlob(sha) { return existsSync(this.blobPath(sha)) }
  putBlob(buf, mode = 0o644) {
    const sha = sha256(buf)
    const p = this.blobPath(sha)
    if (!existsSync(p)) {
      mkdirPrivate(dirname(p))
      writeFileMode(p, buf, mode)
      this.bumpAccounting({ storedDelta: buf.length })
      return { sha, fresh: buf.length }
    }
    return { sha, fresh: 0 }
  }
  // Byte accounting, kept incrementally in a small record so status
  // never walks the whole store: putBlob and makeCommit bump it as
  // they write. storedBytes is the bytes the store actually occupies:
  // blob bytes PLUS the commit records (each holds its checkpoint's
  // full manifest — for a wide tree that is the larger half, and it
  // was not counted before 0.7.1; round-2 review, item 7). A missing
  // record (a pre-0.7 store) is rebuilt by one walk and then
  // maintained; a pre-0.7.1 record undercounts until it is rebuilt.
  accountingPath() { return join(this.root, "accounting.json") }
  readAccounting() {
    try { return JSON.parse(readFileSync(this.accountingPath(), "utf8")) } catch { return null }
  }
  bumpAccounting({ storedDelta = 0, logicalDelta = 0 } = {}) {
    if (!storedDelta && !logicalDelta) return
    const a = this.readAccounting() ?? { storedBytes: this.storedBytesWalk(), logicalBytes: this.logicalBytesWalk() }
    a.storedBytes += storedDelta
    a.logicalBytes += logicalDelta
    writeJson(this.accountingPath(), a)
  }
  storedBytes() {
    const a = this.readAccounting()
    if (a && Number.isFinite(a.storedBytes)) return a.storedBytes
    const n = this.storedBytesWalk()
    writeJson(this.accountingPath(), { storedBytes: n, logicalBytes: this.logicalBytesWalk() })
    return n
  }
  storedBytesWalk() {
    let n = 0
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name)
        if (e.isDirectory()) walk(full)
        else n += statSync(full).size
      }
    }
    walk(this.objectsDir)
    // the commit records count too: each carries a full manifest
    if (existsSync(this.projectsDir))
      for (const name of readdirSync(this.projectsDir)) {
        const cdir = join(this.projectDir(name), "commits")
        if (existsSync(cdir))
          for (const f of readdirSync(cdir)) n += statSync(join(cdir, f)).size
      }
    return n
  }
  logicalBytesWalk() {
    let n = 0
    if (!existsSync(this.projectsDir)) return 0
    for (const name of readdirSync(this.projectsDir)) {
      const cdir = join(this.projectDir(name), "commits")
      if (!existsSync(cdir)) continue
      for (const f of readdirSync(cdir)) n += JSON.parse(readFileSync(join(cdir, f), "utf8")).logicalBytes
    }
    return n
  }
  // Store every blob of a manifest that the store has not seen; returns the
  // number of genuinely new bytes written.
  storeManifestFiles(baseDir, manifest) {
    let fresh = 0
    for (const [rel, f] of Object.entries(manifest)) {
      if (!this.hasBlob(f.sha)) fresh += this.putBlob(readFileSync(join(baseDir, ...rel.split("/"))), f.mode ?? 0o644).fresh
    }
    return fresh
  }

  // -- project / branch / commit records
  projectDir(project) { return join(this.projectsDir, project) }
  projectExists(project) { return existsSync(join(this.projectDir(project), "project.json")) }
  commitPath(project, id) { return join(this.projectDir(project), "commits", `${id}.json`) }
  readCommit(project, id) { return JSON.parse(readFileSync(this.commitPath(project, id), "utf8")) }
  // A commit's summary: everything trajectory() shows, without the
  // manifest — the big part, which trajectory never uses. The walk
  // below reads each record once per backend lifetime; later rebuilds
  // hit this map and touch no files, so a host-shared plugin host is
  // stalled only by genuinely new commits, never by re-reading history.
  readCommitSummary(project, id) {
    const key = `${project}/${id}`
    let s = this._commitSummary.get(key)
    if (!s) {
      const c = this.readCommit(project, id)
      s = {
        id: c.id, parent: c.parent, branch: c.branch, message: c.message, time: c.time,
        files: c.files, logicalBytes: c.logicalBytes, newBytes: c.newBytes,
        delta: c.delta ?? { added: 0, modified: 0, deleted: 0 },
        ...(c.agent ? { agent: c.agent } : {}),
      }
      this._commitSummary.set(key, s)
    }
    return s
  }
  writeCommit(project, commit) {
    mkdirPrivate(join(this.projectDir(project), "commits"))
    writeJson(this.commitPath(project, commit.id), commit, true)
    return statSync(this.commitPath(project, commit.id)).size
  }
  branchHeadPath(project, branch) { return join(this.projectDir(project), "branches", `${encodeBranchName(branch)}.json`) }
  branchExists(project, branch) { return existsSync(this.branchHeadPath(project, branch)) }
  head(project, branch) {
    if (!this.branchExists(project, branch)) throw new Error(`no branch ${branch} in project ${project}`)
    return JSON.parse(readFileSync(this.branchHeadPath(project, branch), "utf8")).commit
  }
  setHead(project, branch, commitId) {
    mkdirPrivate(dirname(this.branchHeadPath(project, branch)))
    writeJson(this.branchHeadPath(project, branch), { commit: commitId })
  }
  listBranches(project) {
    const dir = join(this.projectDir(project), "branches")
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => decodeBranchName(f.slice(0, -5))).sort()
  }

  makeCommit(project, branch, parent, manifest, message, newBytes, delta = { added: 0, modified: 0, deleted: 0 }, agent = "") {
    const seed = JSON.stringify({ parent, branch, message, manifest }) + nowIso() + Math.random()
    const id = sha256(Buffer.from(seed)).slice(0, 12)
    const commit = {
      id, branch, parent, message, time: nowIso(),
      manifest, files: Object.keys(manifest).length,
      logicalBytes: manifestBytes(manifest), newBytes, delta,
      ...(agent ? { agent } : {}),
    }
    const recordBytes = this.writeCommit(project, commit)
    this.bumpAccounting({ logicalDelta: commit.logicalBytes, storedDelta: recordBytes })
    this.setHead(project, branch, id)
    return commit
  }

  // An append-only event log (provision / fork / checkpoint), the raw
  // material for the trajectory the magpie page replays. agent is the
  // calling agent as the gateway knows it (the tool host's ctx.agent),
  // when the caller passed one — the page attributes the work to the
  // agent that actually made it, not to a branch name's token.
  recordEvent(event) {
    const path = join(this.root, "events.json")
    let events = []
    try { events = JSON.parse(readFileSync(path, "utf8")) } catch { /* first event */ }
    events.push({ t: nowIso(), ...event })
    if (events.length > 500) events = events.slice(-500)
    writeFileMode(path, JSON.stringify(events))
  }
  readEvents() {
    try { return JSON.parse(readFileSync(join(this.root, "events.json"), "utf8")) } catch { return [] }
  }

  async ensureProject(project, sourceDir, agent = "") {
    if (this.projectExists(project)) return { created: false }
    mkdirPrivate(this.projectDir(project))
    writeJson(join(this.projectDir(project), "project.json"),
      { name: project, created: nowIso(), backend: "sim" }, true)
    let manifest = {}
    let newBytes = 0
    let skipped = []
    let src = null
    if (sourceDir) {
      src = checkSourceDir(sourceDir, { storeRoot: this.root })
      const scan = scanImportTree(src)
      manifest = scan.manifest
      skipped = scan.skipped
      newBytes = this.storeManifestFiles(src, manifest)
    }
    const commit = this.makeCommit(project, "main", null, manifest,
      src ? `Import ${src}` : "Empty project", newBytes,
      { added: Object.keys(manifest).length, modified: 0, deleted: 0 }, agent)
    return { created: true, commit: commit.id, skipped }
  }

  workspaceDir(project, branch) { return join(this.workspacesDir, project, encodeBranchName(branch)) }

  async provision(project, branch = "main", sourceDir, agent = "") {
    const created = await this.ensureProject(project, sourceDir, agent)
    if (!this.branchExists(project, branch)) throw new Error(`no branch ${branch} in project ${project}`)
    const headId = this.head(project, branch)
    const dir = this.workspaceDir(project, branch)
    if (existsSync(join(dir, BINDING))) {
      const binding = JSON.parse(readFileSync(join(dir, BINDING), "utf8"))
      return {
        path: dir, project, branch, backend: this.kind,
        commit: binding.baseCommit, reused: true, stale: binding.baseCommit !== headId,
      }
    }
    const commit = this.readCommit(project, headId)
    mkdirPrivate(dir)
    ensureScratch(dir)
    for (const [rel, f] of Object.entries(commit.manifest)) {
      const out = join(dir, ...rel.split("/"))
      mkdirSync(dirname(out), { recursive: true })
      copyFileSync(this.blobPath(f.sha), out)
      chmodSync(out, f.mode ?? 0o644) // the manifest's mode, not the blob's or the umask's
    }
    writeJson(join(dir, BINDING), { project, branch, baseCommit: headId }, true)
    this.recordEvent({ kind: "provision", project, branch, path: dir, commit: headId, agent })
    return {
      path: dir, project, branch, backend: this.kind, commit: headId,
      reused: false, files: commit.files, logicalBytes: commit.logicalBytes,
      ...(created.created ? { projectCreated: true } : {}),
      ...(created.skipped?.length ? {
        importSkipped: created.skipped.length,
        skippedSecrets: created.skipped.slice(0, 5),
      } : {}),
    }
  }

  async checkpoint(project, branch = "main", message = "", agent = "") {
    const dir = this.workspaceDir(project, branch)
    if (!existsSync(join(dir, BINDING))) throw new Error(`no workspace for ${project}/${branch}; provision it first`)
    const parent = this.head(project, branch)
    const prev = this.readCommit(project, parent)
    const manifest = scanTree(dir, scanSkip())
    const newBytes = this.storeManifestFiles(dir, manifest)
    let added = 0, modified = 0, deleted = 0
    for (const [rel, f] of Object.entries(manifest)) {
      if (!prev.manifest[rel]) added++
      else if (prev.manifest[rel].sha !== f.sha) modified++
    }
    for (const rel of Object.keys(prev.manifest)) if (!manifest[rel]) deleted++
    const commit = this.makeCommit(project, branch, parent, manifest, message || "Checkpoint", newBytes, { added, modified, deleted }, agent)
    this.recordEvent({ kind: "checkpoint", project, branch, commit: commit.id, message: commit.message, agent })
    writeJson(join(dir, BINDING), { project, branch, baseCommit: commit.id }, true)
    const stored = this.storedBytes()
    return {
      commit: commit.id, parent, branch, message: commit.message,
      added, modified, deleted, files: commit.files,
      logicalBytes: commit.logicalBytes, newBytes,
      storedBytes: stored, savedBytes: commit.logicalBytes - newBytes,
    }
  }

  async fork(project, branch, from = "main", agent = "") {
    if (!this.projectExists(project)) throw new Error(`no project ${project}`)
    if (this.branchExists(project, branch)) throw new Error(`branch ${branch} already exists in project ${project}`)
    const headId = this.head(project, from)
    this.setHead(project, branch, headId)
    this.recordEvent({ kind: "fork", project, branch, from, commit: headId, agent })
    return { project, branch, from, commit: headId, copiedBytes: 0 }
  }

  // Publish a branch's head as main's new Layer. The guard is the lesson
  // of a real dsh run, where publishing from a stale branch replaced
  // main and dropped it from 238 tests to 38: by default main must be
  // an ancestor of the branch head, so publishing can only ever move
  // main forward. force says "I know main has commits this branch never
  // saw" — the result then reports what was overwritten.
  async publish(project, branch, { force = false, agent = "" } = {}) {
    checkProject(project); checkBranch(branch)
    if (branch === "main") throw new Error("publish names a branch other than main; main is what gets published to")
    const branchHead = this.head(project, branch)
    const mainHead = this.head(project, "main")
    const layers = this.readEvents().filter((e) => e.kind === "publish" && e.project === project).length
    if (branchHead === mainHead)
      return { project, branch, layer: layers, commit: branchHead, alreadyPublished: true, overwrote: false }
    const chain = new Set()
    let id = branchHead
    while (id) { chain.add(id); id = this.readCommit(project, id).parent }
    const fastForward = chain.has(mainHead)
    if (!fastForward && !force)
      throw new Error(`main has moved since ${branch} forked: main is at ${mainHead}, which is not in ${branch}'s history. Publishing would drop main's newer checkpoints. Fork a fresh branch from main, or pass force: true to overwrite deliberately.`)
    this.setHead(project, "main", branchHead)
    const layer = layers + 1
    this.recordEvent({ kind: "publish", project, branch, commit: branchHead, layer, overwrote: !fastForward, agent })
    return { project, branch, layer, commit: branchHead, previousMain: mainHead, overwrote: !fastForward }
  }

  // Run a command in the branch's workspace and checkpoint whatever it
  // changed as one commit — the dsh shape, where every bash call is
  // mount, run, commit. A command that changes nothing commits nothing;
  // a failing command's changes are still checkpointed (they are
  // history, and history can be rewound), with its exit code reported.
  async exec(project, branch = "main", command, message = "", timeoutMs = 50000, agent = "") {
    checkProject(project); checkBranch(branch)
    if (typeof command !== "string" || !command.trim()) throw new Error("command is a non-empty string")
    const dir = this.workspaceDir(project, branch)
    if (!existsSync(join(dir, BINDING))) throw new Error(`no workspace for ${project}/${branch}; provision it first`)
    const prev = this.readCommit(project, this.head(project, branch))
    const r = await runShell(command, dir, Math.min(Math.max(100, timeoutMs || 50000), 55000))
    const manifest = scanTree(dir, scanSkip())
    const changed = !sameManifest(prev.manifest, manifest)
    let commit = null
    if (changed) {
      const c = await this.checkpoint(project, branch, message || `exec: ${command.trim().slice(0, 60)}`, agent)
      commit = c.commit
    }
    return {
      project, branch, exitCode: r.code, ...(r.timedOut ? { timedOut: true } : {}),
      stdout: r.stdout, stderr: r.stderr, changed, commit,
    }
  }

  async history(project, branch = "main", limit = 20) {
    let id = this.head(project, branch)
    const out = []
    while (id && out.length < limit) {
      const c = this.readCommit(project, id)
      out.push({
        commit: c.id, message: c.message, time: c.time,
        files: c.files, logicalBytes: c.logicalBytes, newBytes: c.newBytes,
      })
      id = c.parent
    }
    return { project, branch, commits: out }
  }

  // One project's slice of the recorded trajectory, oldest first per
  // branch. Commits carry their delta and byte accounting. The walk
  // reads through readCommitSummary, so a forked branch does not
  // re-read main's history: every record is parsed once per backend
  // lifetime, and a rebuild after a new checkpoint reads only the new
  // commits. Between branches the walk yields, so even a first build
  // over a large store never holds the shared plugin host's event
  // loop for its whole duration.
  async trajectoryProject(name) {
    if (!this.projectExists(name)) return null
    const branches = []
    for (const branch of this.listBranches(name)) {
      // the branch's OWN checkpoints: walk its whole chain (a publish
      // may have moved main's head onto another branch's work) and
      // keep only the commits made on this branch — ancestors belong
      // to the bough they were committed on
      const commits = []
      let id = this.head(name, branch)
      while (id) {
        const c = this.readCommitSummary(name, id)
        if (c.branch === branch) {
          commits.push({
            id: c.id, parent: c.parent, message: c.message, time: c.time,
            files: c.files, logicalBytes: c.logicalBytes, newBytes: c.newBytes,
            delta: c.delta,
            ...(c.agent ? { agent: c.agent } : {}),
          })
        }
        id = c.parent
      }
      branches.push({ name: branch, commits: commits.reverse() })
      await new Promise((r) => setImmediate(r))
    }
    return { name, branches }
  }

  // The whole recorded trajectory: what the magpie page replays.
  // The walk is cheap after the first build: readCommitSummary caches
  // every record's summary, so a rebuild reads only commits it has
  // never seen — a second rebuild with nothing new reads no records
  // at all (a test pins that). The stamp itself is always fresh.
  async trajectory() {
    const projects = []
    if (existsSync(this.projectsDir)) {
      for (const name of readdirSync(this.projectsDir).sort()) {
        const slice = await this.trajectoryProject(name)
        if (slice) projects.push(slice)
      }
    }
    const st = await this.status()
    return {
      generatedAt: nowIso(), backend: this.kind, projects,
      events: this.readEvents(),
      totals: {
        logicalBytes: st.logicalBytes, storedBytes: st.storedBytes,
        savedBytes: st.savedBytes, dedupRatio: st.dedupRatio, workspaces: st.workspaces,
      },
    }
  }

  // The recorded trajectory is built ON DEMAND by trajectory() and
  // by nothing else. An earlier version also kept a trajectory.json
  // in the store refreshed after every tool call — even scoped to
  // one project that re-walked the branch's whole chain, so the cost
  // of every call grew with the history, for a file the page cannot
  // read (its bridge serves a fixed host list) and nothing else did
  // (round-2 review, item 3). Removed in 0.7.1: no tool call creates
  // or updates a trajectory.json anymore. The page keeps its bundled
  // sample until the host can serve plugin data to a page.

  async resolve(project, branch = "main", inner = "") {
    const headId = this.head(project, branch)
    const dir = this.workspaceDir(project, branch)
    if (!existsSync(join(dir, BINDING)))
      return { path: null, project, branch, commit: headId, provisioned: false, hint: "call provision to materialize this workspace" }
    const out = { path: inner ? join(dir, ...inner.split("/")) : dir, project, branch, commit: headId, provisioned: true }
    if (inner) {
      const commit = this.readCommit(project, headId)
      const f = commit.manifest[inner]
      if (f) { out.sha = f.sha; out.size = f.size; out.inHead = true }
      else out.inHead = existsSync(out.path)
    }
    return out
  }

  async status() {
    const projects = []
    if (existsSync(this.projectsDir)) {
      for (const name of readdirSync(this.projectsDir).sort()) {
        if (!this.projectExists(name)) continue
        const branches = this.listBranches(name)
        const cdir = join(this.projectDir(name), "commits")
        const commits = existsSync(cdir) ? readdirSync(cdir).length : 0
        projects.push({ name, branches, commits })
      }
    }
    const stored = this.storedBytes()
    const a = this.readAccounting()
    const logical = a && Number.isFinite(a.logicalBytes) ? a.logicalBytes : this.logicalBytesWalk()
    const workspaces = countWorkspaces(this.workspacesDir)
    return {
      backend: this.kind, root: this.root, projects, workspaces,
      logicalBytes: logical, storedBytes: stored,
      savedBytes: Math.max(0, logical - stored),
      dedupRatio: stored ? +(logical / stored).toFixed(2) : 1,
    }
  }
}

// ---- selection ---------------------------------------------------------------------

// The registry package ships the sim backend only. A native request
// is refused loudly, never silently substituted: the SDK is still not
// published to npm, so there is no pinned version to run, and running
// unversioned code from an environment-named path is what the registry
// review refused. The native backend returns here once the SDK is
// published and the plugin pins it as a dependency.
const NATIVE_NOT_SHIPPED =
  "this package is sim-only: the native backend is not shipped in this package " +
  "(it returns in a follow-up PR once @layerfs/sdk is published to npm with a version to pin; " +
  "it is developed in its standalone repo). " +
  "Unset the native backend's environment switches and the \"native\" option to use the sim backend."

export async function createBackend(env = process.env, options = {}) {
  const want = (env.MAGPIE_LAYERFS_BACKEND || "auto").toLowerCase()
  if (want === "native" || env.MAGPIE_LAYERFS_NATIVE === "1" || options?.native === true)
    throw new Error(NATIVE_NOT_SHIPPED)
  if (want !== "auto" && want !== "sim")
    throw new Error(`the LayerFS backend setting is auto or sim; got ${JSON.stringify(want)}`)
  return new SimBackend(env.MAGPIE_LAYERFS_HOME)
}
