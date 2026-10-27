import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { LayerfsTools } from "./index.mjs"
import {
  DEFAULT_ROOT, IMPORT_MAX_FILES, LEGACY_ROOT, SimBackend, checkSourceDir, createBackend,
  defaultRoot, scanImportTree,
} from "./layerfs.mjs"

const sha = (s) => createHash("sha256").update(s).digest("hex")

// Hygiene: every temp dir a test makes is registered and removed, and
// the process env the suite mutates is restored whole at the end —
// a test run leaves nothing behind but its results.
const envSnapshot = { ...process.env }
const tmpDirs = []
function mkTmp(prefix, base = tmpdir()) {
  const d = mkdtempSync(join(base, prefix))
  tmpDirs.push(d)
  return d
}
// The cleanup's time grows with the machine's disk load, not with the
// suite: on a loaded box removing every dir took over bun's default 5s
// hook bar (#362), so the hook carries its own.
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k]
  Object.assign(process.env, envSnapshot)
}, 120_000)

function fixture() {
  const src = mkTmp("layerfs-src-")
  mkdirSync(join(src, "docs"), { recursive: true })
  writeFileSync(join(src, "README.md"), "hello layerfs\n")
  writeFileSync(join(src, "docs", "a.txt"), "A".repeat(1000))
  writeFileSync(join(src, "docs", "b.txt"), "A".repeat(1000)) // identical to a.txt on purpose
  writeFileSync(join(src, "code.js"), "console.log(1)\n")
  return src
}

async function simTools(opts = { exec: true }) {
  const home = mkTmp("layerfs-home-")
  process.env.MAGPIE_LAYERFS_HOME = home
  process.env.MAGPIE_LAYERFS_BACKEND = "sim"
  delete process.env.MAGPIE_LAYERFS_EXEC
  const src = fixture()
  // ctx.directory is magpie's CONFIG directory in the real host — the
  // harness models it as its own temp dir, never the source
  const { tool } = await LayerfsTools({ directory: mkTmp("magpie-config-") }, opts)
  // provision's source is a required argument since 0.7.0: the wrapper
  // passes the fixture explicitly, the way a caller now must
  const call = (name, args) => tool[name].execute(
    name === "provision" && args.source === undefined ? { ...args, source: src } : args,
    { agent: "test", abort: AbortSignal.timeout(5000) })
  return { call, home, src, tool }
}

test("gives eight tools, each with a JSON Schema and an execute", async () => {
  const { tool } = await LayerfsTools({})
  expect(Object.keys(tool).sort()).toEqual(["checkpoint", "exec", "fork", "history", "provision", "publish", "resolve", "status"])
  for (const [name, t] of Object.entries(tool)) {
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,48}$/)
    expect(t.description.length).toBeGreaterThan(40)
    expect(typeof t.execute).toBe("function")
    expect(t.args.type).toBe("object")
  }
  // source is a required provision argument; there is no default
  expect(tool.provision.args.required).toEqual(["project", "source"])
})

test("provision imports the source once, then answers the same path without copying", async () => {
  const { call } = await simTools()
  const first = await call("provision", { project: "website" })
  expect(first.projectCreated).toBe(true)
  expect(first.reused).toBe(false)
  expect(first.files).toBe(4)
  expect(readFileSync(join(first.path, "README.md"), "utf8")).toBe("hello layerfs\n")
  const again = await call("provision", { project: "website" })
  expect(again.path).toBe(first.path)
  expect(again.reused).toBe(true)
  expect(again.stale).toBe(false)
})

test("checkpoint stores only the blobs that changed", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  writeFileSync(join(ws.path, "code.js"), "console.log(2)\n") // modified, 15 bytes
  writeFileSync(join(ws.path, "new.txt"), "brand new\n") // added, 10 bytes
  const cp = await call("checkpoint", { project: "website", message: "second take" })
  expect(cp.added).toBe(1)
  expect(cp.modified).toBe(1)
  expect(cp.deleted).toBe(0)
  expect(cp.newBytes).toBe(15 + 10)
  expect(cp.logicalBytes).toBe(14 + 1000 + 1000 + 15 + 10)
  expect(cp.savedBytes).toBe(cp.logicalBytes - cp.newBytes)
})

test("fork copies no bytes and shares the history", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const before = await call("status", {})
  const f = await call("fork", { project: "website", branch: "agent-2" })
  expect(f.copiedBytes).toBe(0)
  const after = await call("status", {})
  expect(after.storedBytes).toBe(before.storedBytes)
  const ws2 = await call("provision", { project: "website", branch: "agent-2" })
  expect(readFileSync(join(ws2.path, "docs", "a.txt"), "utf8")).toBe("A".repeat(1000))
  const hist = await call("history", { project: "website", branch: "agent-2" })
  expect(hist.commits.length).toBe(1)
  expect(hist.commits[0].message).toContain("Import")
  await expect(call("fork", { project: "website", branch: "agent-2" })).rejects.toThrow("already exists")
})

test("identical files are stored once (dedup at import)", async () => {
  const { call, home } = await simTools()
  await call("provision", { project: "website" })
  const st = await call("status", {})
  // unique contents: "hello layerfs\n" (14) + "A"*1000 (1000) + "console.log(1)\n" (15)
  // storedBytes is those blobs PLUS the import's commit record, whose
  // manifest the accounting has counted since 0.7.1 (r2 item 7)
  const cdir = join(home, "projects", "website", "commits")
  const recordBytes = readdirSync(cdir).reduce((n, f) => n + statSync(join(cdir, f)).size, 0)
  expect(recordBytes).toBeGreaterThan(0)
  expect(st.storedBytes).toBe(14 + 1000 + 15 + recordBytes)
  expect(st.logicalBytes).toBe(14 + 1000 + 1000 + 15)
  expect(st.dedupRatio).toBeGreaterThan(1)
})

test("resolve answers a path and a file's hash without copying", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  const root = await call("resolve", { project: "website" })
  expect(root.path).toBe(ws.path)
  const file = await call("resolve", { project: "website", path: "docs/a.txt" })
  expect(file.path).toBe(join(ws.path, "docs", "a.txt"))
  expect(file.sha).toBe(sha("A".repeat(1000)))
  expect(file.size).toBe(1000)
})

test("names and paths are validated", async () => {
  const { call } = await simTools()
  await expect(call("provision", { project: "Bad Name" })).rejects.toThrow("project name")
  await call("provision", { project: "website" })
  await expect(call("resolve", { project: "website", path: "../escape" })).rejects.toThrow("stay inside")
})

test("a workspace file survives on disk where resolve says it is", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const file = await call("resolve", { project: "website", path: "code.js" })
  expect(existsSync(file.path)).toBe(true)
})

test("publish moves main forward to the branch head, as a numbered Layer", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "feat" })
  const feat = await call("provision", { project: "website", branch: "feat" })
  writeFileSync(join(feat.path, "feature.js"), "export const f = 1\n")
  const cp = await call("checkpoint", { project: "website", branch: "feat", message: "add feature" })
  const pub = await call("publish", { project: "website", branch: "feat" })
  expect(pub.layer).toBe(1)
  expect(pub.commit).toBe(cp.commit)
  expect(pub.overwrote).toBe(false)
  const main = await call("history", { project: "website", branch: "main" })
  expect(main.commits[0].commit).toBe(cp.commit) // main now answers for the feature
  expect(main.commits[0].message).toBe("add feature")
  const again = await call("publish", { project: "website", branch: "feat" })
  expect(again.alreadyPublished).toBe(true)
  expect(ws.path).toBeTruthy()
})

test("publish refuses to drop a main that moved, unless forced", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "feat" })
  const feat = await call("provision", { project: "website", branch: "feat" })
  writeFileSync(join(feat.path, "feature.js"), "f\n")
  await call("checkpoint", { project: "website", branch: "feat", message: "feature" })
  // main advances on its own after the fork: the branch no longer contains it
  const mainWs = await call("provision", { project: "website", branch: "main" })
  writeFileSync(join(mainWs.path, "hotfix.js"), "h\n")
  const hot = await call("checkpoint", { project: "website", branch: "main", message: "hotfix" })
  await expect(call("publish", { project: "website", branch: "feat" })).rejects.toThrow("main has moved")
  const forced = await call("publish", { project: "website", branch: "feat", force: true })
  expect(forced.overwrote).toBe(true)
  expect(forced.previousMain).toBe(hot.commit)
  await expect(call("publish", { project: "website", branch: "main" })).rejects.toThrow("other than main")
})

test("exec runs in the workspace and checkpoints what changed", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const before = await call("history", { project: "website" })
  const r = await call("exec", { project: "website", command: "echo built > build.log && echo hello" })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain("hello")
  expect(r.changed).toBe(true)
  expect(r.commit).toBeTruthy()
  const after = await call("history", { project: "website" })
  expect(after.commits.length).toBe(before.commits.length + 1)
  expect(after.commits[0].message).toContain("exec:")
  const noop = await call("exec", { project: "website", command: "true" })
  expect(noop.changed).toBe(false)
  expect(noop.commit).toBeNull()
  const failed = await call("exec", { project: "website", command: "echo x > partial.txt; exit 3" })
  expect(failed.exitCode).toBe(3)
  expect(failed.changed).toBe(true) // a failing command's edits are still history
})

test("exec redirects TMPDIR and the cache home into the workspace scratch dirs", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  // provision pre-creates both scratch directories
  expect(existsSync(join(ws.path, ".tmp"))).toBe(true)
  expect(existsSync(join(ws.path, ".cache"))).toBe(true)
  const r = await call("exec", {
    project: "website",
    command: 'echo "$TMPDIR" && echo scratch > "$TMPDIR/probe.txt" && echo cache > "$XDG_CACHE_HOME/probe.txt"',
  })
  expect(r.exitCode).toBe(0)
  expect(r.stdout).toContain(join(ws.path, ".tmp")) // $TMPDIR points inside the workspace
  expect(readFileSync(join(ws.path, ".tmp", "probe.txt"), "utf8")).toBe("scratch\n")
  expect(readFileSync(join(ws.path, ".cache", "probe.txt"), "utf8")).toBe("cache\n")
  // scratch is not history: a run that touched only scratch commits nothing
  expect(r.changed).toBe(false)
  expect(r.commit).toBeNull()
})

test("checkpoint never captures the scratch directories", async () => {
  const { call } = await simTools()
  const ws = await call("provision", { project: "website" })
  writeFileSync(join(ws.path, ".tmp", "junk.txt"), "junk\n")
  writeFileSync(join(ws.path, ".cache", "junk.txt"), "junk\n")
  writeFileSync(join(ws.path, "real.txt"), "real\n") // the one real change, 5 bytes
  const cp = await call("checkpoint", { project: "website", message: "with scratch present" })
  expect(cp.added).toBe(1) // real.txt only — the scratch files are not counted
  expect(cp.modified).toBe(0)
  expect(cp.deleted).toBe(0)
  expect(cp.files).toBe(5) // the 4 imported files + real.txt
  expect(cp.newBytes).toBe(5)
  expect(cp.logicalBytes).toBe(14 + 1000 + 1000 + 15 + 5)
  // the scratch content itself stays put in the live workspace
  expect(readFileSync(join(ws.path, ".tmp", "junk.txt"), "utf8")).toBe("junk\n")
  expect(readFileSync(join(ws.path, ".cache", "junk.txt"), "utf8")).toBe("junk\n")
})

// ---- the review's findings, one regression test each -------------------------

test("item 1: provision has no default source — the host's config directory is never imported", async () => {
  const home = mkTmp("layerfs-home-")
  process.env.MAGPIE_LAYERFS_HOME = home
  process.env.MAGPIE_LAYERFS_BACKEND = "sim"
  const cfg = mkTmp("magpie-config-")
  writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify({ token: "secret" }))
  mkdirSync(join(cfg, "sub"))
  const { tool } = await LayerfsTools({ directory: cfg })
  const call = (name, args) => tool[name].execute(args, { agent: "test", abort: AbortSignal.timeout(5000) })
  // no source at all
  await expect(call("provision", { project: "website" })).rejects.toThrow("source is required")
  // the config directory itself, a directory under it, and a parent of it
  await expect(call("provision", { project: "website", source: cfg })).rejects.toThrow("refusing to import")
  await expect(call("provision", { project: "website", source: join(cfg, "sub") })).rejects.toThrow("refusing to import")
  await expect(call("provision", { project: "website", source: tmpdir() })).rejects.toThrow("refusing to import")
  // and the home directory
  await expect(call("provision", { project: "website", source: homedir() })).rejects.toThrow("refusing to import")
  // nothing was imported anywhere along the way
  const st = await call("status", {})
  expect(st.projects).toEqual([])
})

test("item 2: exec is disabled by default and runs only on the user's opt-in", async () => {
  const off = await simTools({}) // no plugin options, no env switch
  await off.call("provision", { project: "website" })
  await expect(off.call("exec", { project: "website", command: "echo hi > hi.txt" }))
    .rejects.toThrow("disabled by default")
  const hist = await off.call("history", { project: "website" })
  expect(hist.commits.length).toBe(1) // the refused exec committed nothing
  // the environment switch turns it on for the same tools
  process.env.MAGPIE_LAYERFS_EXEC = "1"
  try {
    const r = await off.call("exec", { project: "website", command: "echo hi > hi.txt" })
    expect(r.exitCode).toBe(0)
    expect(r.changed).toBe(true)
  } finally {
    delete process.env.MAGPIE_LAYERFS_EXEC
  }
  // and the plugin option turns it on without the environment (the
  // other exec tests run through simTools' default { exec: true })
  const on = await simTools({ exec: true })
  await on.call("provision", { project: "website" })
  const r2 = await on.call("exec", { project: "website", command: "true" })
  expect(r2.exitCode).toBe(0)
})

test("item 3: an import skips secret-shaped files and reports them", async () => {
  const { call, src } = await simTools()
  writeFileSync(join(src, ".env"), "TOKEN=x\n")
  writeFileSync(join(src, "docs", ".env.local"), "TOKEN=y\n")
  mkdirSync(join(src, ".git"))
  writeFileSync(join(src, ".git", "config"), "[core]\n")
  writeFileSync(join(src, "id_rsa"), "-----BEGIN-----\n")
  writeFileSync(join(src, "cert.pem"), "-----BEGIN-----\n")
  mkdirSync(join(src, "sub", ".ssh"), { recursive: true })
  writeFileSync(join(src, "sub", ".ssh", "known_hosts"), "host\n")
  const ws = await call("provision", { project: "website" })
  expect(ws.files).toBe(4) // only the fixture's real files
  expect(ws.importSkipped).toBe(6) // .env, docs/.env.local, .git, id_rsa, cert.pem, sub/.ssh
  expect(ws.skippedSecrets).toContain(".env")
  expect(existsSync(join(ws.path, ".env"))).toBe(false)
  expect(existsSync(join(ws.path, "id_rsa"))).toBe(false)
  expect(existsSync(join(ws.path, ".git"))).toBe(false)
  const st = await call("status", {})
  expect(st.logicalBytes).toBe(14 + 1000 + 1000 + 15) // none of the secrets' bytes either
})

test("item 3: an import over the file limit is refused, not swept in", () => {
  const src = mkTmp("layerfs-big-")
  for (let i = 0; i <= IMPORT_MAX_FILES; i++) writeFileSync(join(src, `f${i}.txt`), "")
  expect(() => scanImportTree(src)).toThrow("import limit")
}, 30000)

test("item 4: the store is private, and a file's mode survives the store", async () => {
  const { call, home, src } = await simTools()
  writeFileSync(join(src, "secret.txt"), "s3cret\n")
  chmodSync(join(src, "secret.txt"), 0o600)
  const ws = await call("provision", { project: "website" })
  const mode = (p) => statSync(p).mode & 0o777
  expect(mode(join(home, "store"))).toBe(0o700)
  expect(mode(join(home, "projects"))).toBe(0o700)
  expect(mode(join(home, "workspaces"))).toBe(0o700)
  expect(mode(ws.path)).toBe(0o700)
  expect(mode(join(ws.path, "secret.txt"))).toBe(0o600) // 0600 in, 0600 out
  expect(mode(join(ws.path, "README.md"))).toBe(mode(join(src, "README.md"))) // the source's own mode, kept
  expect(mode(join(home, "accounting.json"))).toBe(0o600) // record files stay private
})

test("the registry package ships the sim backend only; native is refused, never silently substituted", async () => {
  const sim = await createBackend({ MAGPIE_LAYERFS_HOME: mkTmp("layerfs-sim-") })
  expect(sim).toBeInstanceOf(SimBackend)
  // an SDK path lying around changes nothing: there is no native backend to turn on
  const sim2 = await createBackend({ MAGPIE_LAYERFS_HOME: mkTmp("layerfs-sim-"), LAYERFS_SDK_PATH: "/x/index.js" })
  expect(sim2).toBeInstanceOf(SimBackend)
  // an explicit native request — env or option — is refused loudly
  await expect(createBackend({ MAGPIE_LAYERFS_BACKEND: "native" })).rejects.toThrow("not shipped")
  await expect(createBackend(
    { MAGPIE_LAYERFS_HOME: mkTmp("layerfs-sim-") }, { native: true })).rejects.toThrow("not shipped")
  await expect(createBackend({ MAGPIE_LAYERFS_BACKEND: "bogus" })).rejects.toThrow("auto or sim")
})

test("item 8 + r2 item 3: no trajectory file in the store, and no tool call writes into the page folder", async () => {
  const pageDir = join(import.meta.dir, "page")
  const pageFile = join(pageDir, "trajectory.js")
  const before = readFileSync(pageFile, "utf8")
  const listedBefore = readdirSync(pageDir).sort()
  const { call, home } = await simTools()
  await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "feat" })
  const feat = await call("provision", { project: "website", branch: "feat" })
  writeFileSync(join(feat.path, "f.txt"), "f\n")
  await call("checkpoint", { project: "website", branch: "feat", message: "work" })
  expect(readFileSync(pageFile, "utf8")).toBe(before) // the shipped sample is untouched (item 8)
  // the registry review's install-folder rule: a run of mutating calls
  // leaves the page folder exactly as shipped — no live file, no tmp file
  expect(readdirSync(pageDir).sort()).toEqual(listedBefore)
  // 0.7.0 refreshed <root>/trajectory.json after every call; 0.7.1
  // dropped that — the refresh re-walked branch chains per call for a
  // file nothing read (r2 item 3), and nothing writes one now either
  expect(existsSync(join(home, "trajectory.json"))).toBe(false)
  // the trajectory itself is still there, built when asked
  const traj = await new SimBackend(home).trajectory()
  const proj2 = traj.projects.find((p) => p.name === "website")
  expect(proj2.branches.map((x) => x.name).sort()).toEqual(["feat", "main"])
  const featSlice2 = proj2.branches.find((x) => x.name === "feat")
  expect(featSlice2.commits.at(-1).message).toBe("work")
  expect(traj.totals.logicalBytes).toBeGreaterThan(0)
})

test("trajectory() rebuilds read only new commits: a second rebuild reads none", async () => {
  const { call, home } = await simTools()
  await call("provision", { project: "website" })
  const b = new SimBackend(home)
  await b.trajectory() // first build parses every record once
  // guard: summaries are cached per project/id, so a rebuild with
  // nothing new must not touch the store's records again
  let reads = 0
  const orig = b.readCommit.bind(b)
  b.readCommit = (...a) => { reads++; return orig(...a) }
  await b.trajectory()
  expect(reads).toBe(0)
  await call("checkpoint", { project: "website", message: "second" })
  reads = 0
  const t = await b.trajectory()
  const main = t.projects.find((p) => p.name === "website").branches.find((x) => x.name === "main")
  expect(main.commits).toHaveLength(2)
  expect(main.commits[0].message).toMatch(/^Import /)
  expect(main.commits.at(-1).message).toBe("second")
  expect(reads).toBe(1) // only the new checkpoint's record
})

test("calls record the real calling agent on commits and events; the trajectory carries it", async () => {
  const { call, tool, home } = await simTools()
  await call("provision", { project: "website" }) // agent "test" imports main
  await call("fork", { project: "website", branch: "claude", from: "main" })
  const ws = await call("provision", { project: "website", branch: "claude" })
  writeFileSync(join(ws.path, "claude-work.txt"), "claude was here\n")
  // a second agent checkpoints on the branch: the commit names the agent that made it
  await tool.checkpoint.execute(
    { project: "website", branch: "claude", message: "claude: first edit" },
    { agent: "claude", abort: AbortSignal.timeout(5000) })
  const b = new SimBackend(home)
  const traj = await b.trajectory()
  const proj = traj.projects.find((p) => p.name === "website")
  const mainImport = proj.branches.find((x) => x.name === "main").commits[0]
  expect(mainImport.agent).toBe("test") // the importing agent, not a guess from the branch name
  const claudeCommit = proj.branches.find((x) => x.name === "claude").commits.at(-1)
  expect(claudeCommit.agent).toBe("claude")
  // events carry it too
  const events = b.readEvents()
  expect(events.find((e) => e.kind === "provision" && e.branch === "main").agent).toBe("test")
  expect(events.find((e) => e.kind === "checkpoint" && e.branch === "claude").agent).toBe("claude")
})

test("items 9+10: slash branches are distinct, flat, and listed everywhere", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "feat/x" })
  await call("fork", { project: "website", branch: "feat__x" })
  const a = await call("provision", { project: "website", branch: "feat/x" })
  const b = await call("provision", { project: "website", branch: "feat__x" })
  expect(a.path).not.toBe(b.path) // feat/x and feat__x no longer collide on one directory
  writeFileSync(join(a.path, "only-x.txt"), "x\n")
  const cp = await call("checkpoint", { project: "website", branch: "feat/x", message: "x work" })
  expect(cp.added).toBe(1)
  const st = await call("status", {})
  expect(st.projects[0].branches).toEqual(["feat/x", "feat__x", "main"]) // slash branches are listed
  const h = await call("history", { project: "website", branch: "feat/x" })
  expect(h.commits[0].message).toBe("x work")
  const h2 = await call("history", { project: "website", branch: "feat__x" })
  expect(h2.commits[0].message).toContain("Import")
  const traj = await new SimBackend(st.root).trajectory()
  expect(traj.projects[0].branches.map((x) => x.name).sort()).toEqual(["feat/x", "feat__x", "main"])
})

// ---- the round-2 review's findings, one regression test each ------------------

test("r2 item 1: the source guard compares real paths — a symlink to a refused directory is refused", async () => {
  const cfg = mkTmp("magpie-config-")
  writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify({ token: "secret" }))
  // (a) a symlink whose target is the refused directory: resolve()
  // spellings differ, real paths do not
  const link = join(mkTmp("layerfs-links-"), "cfglink")
  symlinkSync(cfg, link)
  expect(() => checkSourceDir(link, { configDir: cfg })).toThrow("refusing to import")
  // a symlink PARENT of the source is seen through the same way
  const inner = join(mkTmp("layerfs-outer-"), "proj")
  mkdirSync(inner)
  const parentLink = join(mkTmp("layerfs-links-"), "parentlink")
  symlinkSync(dirname(inner), parentLink)
  expect(() => checkSourceDir(join(parentLink, "proj"), { configDir: dirname(inner) })).toThrow("refusing to import")
  // and end to end: provision through the symlink is refused, nothing imported
  const home = mkTmp("layerfs-home-")
  process.env.MAGPIE_LAYERFS_HOME = home
  process.env.MAGPIE_LAYERFS_BACKEND = "sim"
  const { tool } = await LayerfsTools({ directory: cfg }, {})
  const call = (name, args) => tool[name].execute(args, { agent: "test", abort: AbortSignal.timeout(5000) })
  await expect(call("provision", { project: "website", source: link })).rejects.toThrow("refusing to import")
  const st = await call("status", {})
  expect(st.projects).toEqual([])
})

test("r2 item 1: the source guard folds case — a case-variant spelling of a refused root is refused", () => {
  const mixed = mkTmp("Layerfs-Case-")
  // the same directory, named by a differently-cased spelling: on a
  // case-insensitive volume that spelling IS the directory; the
  // guard's case-folded realpath comparison refuses it everywhere,
  // including here, where the volume is case-sensitive and the
  // lowercase spelling does not even exist as a path
  const lowerSpelling = join(dirname(mixed), basename(mixed).toLowerCase())
  expect(lowerSpelling).not.toBe(mixed)
  expect(() => checkSourceDir(mixed, { configDir: lowerSpelling })).toThrow("refusing to import")
  // the review's "~/.Config/Magpie" shape: an upper-case spelling of
  // the source itself — refused as the config dir where the volume
  // folds case, "not a directory" where it does not; never imported
  const variant = join(dirname(mixed), basename(mixed).toUpperCase())
  expect(() => checkSourceDir(variant, { configDir: mixed })).toThrow(/refusing to import|not a directory/)
  // a refused root that does not exist at all must not make the guard throw the wrong error
  const ok = mkTmp("layerfs-oksrc-")
  expect(checkSourceDir(ok, { configDir: join(mkTmp("layerfs-gone-"), "nope") })).toBe(ok)
})

test("r2 item 2: project a branch b--c and project a--b branch c never share a workspace", async () => {
  const { call } = await simTools() // its wrapper supplies the (ignored) source branch provisions require
  const dirA = mkTmp("layerfs-srcA-")
  writeFileSync(join(dirA, "a.txt"), "from A\n")
  const dirB = mkTmp("layerfs-srcB-")
  writeFileSync(join(dirB, "b.txt"), "from B\n")
  await call("provision", { project: "a", source: dirA })
  await call("fork", { project: "a", branch: "b--c" })
  const pa = await call("provision", { project: "a", branch: "b--c" })
  await call("provision", { project: "a--b", source: dirB })
  await call("fork", { project: "a--b", branch: "c" })
  const pb = await call("provision", { project: "a--b", branch: "c" })
  // pre-fix both were workspaces/a--b--c, and pb answered a's checkout
  expect(pb.path).not.toBe(pa.path)
  expect(pb.reused).toBe(false)
  expect(readFileSync(join(pb.path, "b.txt"), "utf8")).toBe("from B\n")
  const st = await call("status", {})
  expect(st.workspaces).toBe(4) // a/main, a/b--c, a--b/main, a--b/c — counted across project dirs
  writeFileSync(join(pb.path, "b2.txt"), "more B\n")
  const cp = await call("checkpoint", { project: "a--b", branch: "c", message: "B work" })
  expect(cp.added).toBe(1)
  expect(cp.deleted).toBe(0) // pre-fix this committed a's files into a--b (added 1, deleted 1)
  const ha = await call("history", { project: "a", branch: "b--c" })
  expect(ha.commits).toHaveLength(1) // a's branch untouched by a--b's checkpoint
})

test("r2 item 2: branches Main and main are distinct, on disk as in the model", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  await call("fork", { project: "website", branch: "Main" })
  const lower = await call("provision", { project: "website", branch: "main" })
  const upper = await call("provision", { project: "website", branch: "Main" })
  // %4Dain vs main: distinct files even on a case-insensitive volume —
  // pre-fix they shared branches/main.json and one workspace
  expect(upper.path).not.toBe(lower.path)
  writeFileSync(join(upper.path, "upper.txt"), "upper\n")
  await call("checkpoint", { project: "website", branch: "Main", message: "upper work" })
  const mainHist = await call("history", { project: "website", branch: "main" })
  expect(mainHist.commits).toHaveLength(1) // a checkpoint on Main did not move main's head
  const st = await call("status", {})
  expect(st.projects[0].branches).toEqual(["Main", "main"])
})

test("r2 item 6: exec's stdin is closed — a command that reads it finishes at once", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const t0 = Date.now()
  const r = await call("exec", { project: "website", command: "cat", timeoutMs: 5000 })
  expect(r.timedOut).toBeUndefined()
  expect(r.exitCode).toBe(0)
  expect(Date.now() - t0).toBeLessThan(3000) // pre-fix: an open stdin pipe held it to the full timeout
})

test("r2 item 6: background children cannot hold an exec call open, and a timeout kills the group", async () => {
  const { call } = await simTools()
  await call("provision", { project: "website" })
  const t0 = Date.now()
  const r = await call("exec", { project: "website", command: "sleep 6 & echo started", timeoutMs: 1000 })
  expect(r.stdout).toContain("started")
  expect(Date.now() - t0).toBeLessThan(4000) // pre-fix: ~6011 ms, waiting for 'close' on the held pipe
  const t1 = Date.now()
  const r2 = await call("exec", { project: "website", command: "sleep 30", timeoutMs: 1000 })
  expect(r2.timedOut).toBe(true)
  expect(Date.now() - t1).toBeLessThan(4000) // the group kill lands; no orphaned sleep outlives the call
})

test("r2 item 7: storedBytes grows by the commit record's size, not just the changed blobs", async () => {
  const { call, home } = await simTools()
  const ws = await call("provision", { project: "website" })
  const before = await call("status", {})
  writeFileSync(join(ws.path, "tiny.txt"), "x") // a 1-byte change on the imported tree
  const cp = await call("checkpoint", { project: "website", message: "tiny" })
  expect(cp.newBytes).toBe(1)
  const after = await call("status", {})
  const recordBytes = statSync(join(home, "projects", "website", "commits", `${cp.commit}.json`)).size
  expect(recordBytes).toBeGreaterThan(0)
  // pre-fix the growth was 1 (the blob alone); the manifest record is counted now
  expect(after.storedBytes - before.storedBytes).toBe(recordBytes + 1)
})

// #360: workspace paths go upstream in tool results, so the default root
// names neither the app nor the host, and an existing ~/.magpie-layerfs
// is moved once with a link left behind.
test("#360: a fresh home gets a default root that does not name magpie", () => {
  const home = mkTmp("lfs-home-")
  const root = defaultRoot(home)
  expect(root).toBe(join(home, DEFAULT_ROOT))
  expect(/magpie/i.test(DEFAULT_ROOT)).toBe(false)
  expect(existsSync(join(home, LEGACY_ROOT))).toBe(false) // nothing made at the old name
})

test("#360: a 0.7.2 root is moved once, its workspaces answer the new path, and the old path still resolves", async () => {
  const home = mkTmp("lfs-home-")
  const legacy = join(home, LEGACY_ROOT)
  const old = new SimBackend(legacy) // what 0.7.2 made at the old default
  const ws = await old.provision("website", "main", fixture())
  writeFileSync(join(ws.path, "kept.txt"), "work in progress\n")

  const root = defaultRoot(home)
  expect(root).toBe(join(home, DEFAULT_ROOT))
  expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
  expect(realpathSync(legacy)).toBe(realpathSync(root))
  expect(readFileSync(join(ws.path, "kept.txt"), "utf8")).toBe("work in progress\n") // old path, via the link

  const b = new SimBackend(root)
  const again = await b.provision("website", "main")
  expect(again.reused).toBe(true)
  expect(again.path).toBe(join(root, "workspaces", "website", "main"))
  expect(readFileSync(join(again.path, "kept.txt"), "utf8")).toBe("work in progress\n")
  const cp = await b.checkpoint("website", "main", "after the move")
  expect(cp.added).toBe(1)

  expect(defaultRoot(home)).toBe(root) // the second call moves nothing
  expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
})

test("#360: a legacy root the user made a link is used where it is", () => {
  const home = mkTmp("lfs-home-")
  const elsewhere = mkTmp("lfs-elsewhere-")
  symlinkSync(elsewhere, join(home, LEGACY_ROOT), "dir")
  expect(defaultRoot(home)).toBe(join(home, LEGACY_ROOT))
  expect(existsSync(join(home, DEFAULT_ROOT))).toBe(false)
})
