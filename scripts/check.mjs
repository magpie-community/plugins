// Loads every package's plugin the way OpenCode (and magpie) do and checks
// the shape of what it returns: an auth hook with a provider, a loader and
// methods OpenCode knows, or, for a plugin of tools alone, its tools. A
// package that serves models is also loaded the way OpenCode 2.x loads it
// (exports["."], a default {id, setup}; plugins#657), and its main the way
// OpenCode 1.x does (every export a plugin). It signs in to nothing and
// sends no request. It checks registry.json first,
// as magpie's Plugins page reads it (scripts/registry.mjs).
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { agentKindProblems, registryProblems } from "./registry.mjs"

const root = resolve(import.meta.dir, "..", "packages")
const only = process.argv[2]
let failed = 0
{
  const file = resolve(import.meta.dir, "..", "registry.json")
  const source = existsSync(file) ? readFileSync(file, "utf8") : null
  const pkgs = readdirSync(root).map((n) => join(root, n, "package.json")).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8")))
  const problems = source === null ? ["registry.json is missing"] : [...registryProblems(source), ...agentKindProblems(source, pkgs)]
  if (problems.length) failed++
  console.log(problems.length ? `✗ registry.json\n  ${problems.join("\n  ")}` : "✓ registry.json")
}
for (const name of readdirSync(root)) {
  if (only && name !== only) continue
  const dir = join(root, name)
  const pj = join(dir, "package.json")
  if (!existsSync(pj)) continue
  const pkg = JSON.parse(readFileSync(pj, "utf8"))
  // gateway middleware and routings, agents, pages and asynchronous hooks
  // (magpie.hooks, Bun's own import) have no OpenCode plugin; their own
  // tests check them
  if (pkg.magpie?.middleware || pkg.magpie?.gateway || pkg.magpie?.agent || pkg.magpie?.hooks) continue
  if (pkg.magpie?.page && !pkg.main && !pkg.exports) continue
  const problems = []
  try {
    const mod = await import(pathToFileURL(join(dir, pkg.main ?? "index.mjs")).href)
    // as magpie's host takes them: every exported function, and the
    // OpenCode v1 form, a default export of { id, server }
    const fns = Object.values(mod).filter((v) => typeof v === "function")
    const v1 = typeof mod.default?.server === "function" ? mod.default.server : null
    if (!fns.length && !v1) problems.push("exports no plugin function")
    // a page's v1 server is its host part, a local service the page
    // navigates to: no provider, no tools. It isn't started here (it would
    // take a port and write config); the package's own tests start it.
    if (v1 && !pkg.magpie?.page) fns.push(v1)
    // OpenCode 1.x refuses a main with anything but plugins among its
    // exports, unless its default is the {id, server} form
    if (!v1 && !(mod.default && typeof mod.default === "object" && ("id" in mod.default || "server" in mod.default || "tui" in mod.default)))
      for (const [k, v] of Object.entries(mod))
        if (typeof v !== "function" && typeof v?.server !== "function") problems.push(`main exports ${k}, which OpenCode 1.x takes for a plugin and refuses`)
    let servesModels = false
    const client = { app: { log: async () => {} }, auth: { set: async () => {} }, tui: { showToast: async () => {} }, config: { get: async () => ({ data: {} }) } }
    for (const fn of fns) {
      const hooks = await fn({ client, directory: process.cwd(), worktree: process.cwd(), $: undefined, project: {} })
      // Tools may also have an auth hook for their own API, without serving
      // chat models. Check their tools as well as their sign-in methods.
      if (hooks?.tool) {
        const tools = Object.entries(hooks.tool)
        if (!tools.length) problems.push(`${fn.name}: no tools`)
        for (const [n, t] of tools) {
          if (!/^[A-Za-z0-9_-]{1,48}$/.test(n)) problems.push(`${fn.name}: tool name ${n}`)
          if (typeof t?.execute !== "function") problems.push(`${fn.name}: ${n} has no execute`)
          if (typeof t?.description !== "string" || !t.description) problems.push(`${fn.name}: ${n} has no description`)
          if (!t?.args || typeof t.args !== "object") problems.push(`${fn.name}: ${n} has no args`)
        }
        if (!hooks.auth) continue
      }
      const auth = hooks?.auth
      if (!auth) { problems.push(`${fn.name}: no auth hook`); continue }
      if (typeof auth.provider !== "string" || !auth.provider) problems.push(`${fn.name}: auth.provider`)
      let needsLoader = !hooks.tool
      if (!Array.isArray(auth.methods) || !auth.methods.length) problems.push(`${fn.name}: auth.methods`)
      for (const m of auth.methods ?? []) {
        if (!["oauth", "api"].includes(m.type)) problems.push(`${fn.name}: method type ${m.type}`)
        if (m.type === "oauth" && typeof m.authorize !== "function") problems.push(`${fn.name}: ${m.label} has no authorize`)
      }
      if (hooks.config) {
        const cfg = { provider: {} }
        await hooks.config(cfg)
        const p = cfg.provider[auth.provider]
        const signInOnly = hooks.tool && p?.models && !Object.keys(p.models).length && !p.npm
        const usageOnly = typeof auth.usage === "function" && p?.models && !Object.keys(p.models).length && !p.npm && !p.api
        if (p && !signInOnly && !usageOnly) {
          needsLoader = true
          servesModels = true
          // Account-scoped catalogs may be empty before sign-in. Do not call
          // their models hook here: this check must stay credential/network-free.
          const dynamicModels = hooks.provider?.id === auth.provider && typeof hooks.provider.models === "function"
          if (!p.npm || (!Object.keys(p.models ?? {}).length && !dynamicModels)) problems.push(`${fn.name}: config gives ${auth.provider} no npm or models`)
        }
      }
      if ((needsLoader || auth.loader !== undefined) && typeof auth.loader !== "function") problems.push(`${fn.name}: auth.loader`)
      // a provider OpenCode has built in, served by the plugin's loader
      if (!hooks.config && typeof auth.loader === "function") servesModels = true
    }
    if (servesModels) problems.push(...(await opencode2Problems(dir, pkg)))
  } catch (e) {
    problems.push(String(e?.stack ?? e))
  }
  if (problems.length) failed++
  console.log(problems.length ? `✗ ${name}\n  ${problems.join("\n  ")}` : `✓ ${name}`)
}
process.exit(failed ? 1 : 0)

// opencode2Problems loads a package as OpenCode 2.x does: its exports["."]
// (a bare string exports is the same), else main, and wants the default to
// be {id, setup}. The adapter it ships is scripts/opencode2.mjs, byte for
// byte.
async function opencode2Problems(dir, pkg) {
  const e = pkg.exports
  const entry = typeof e === "string" ? e : e && typeof e === "object" ? (e["."]?.import ?? e["."]?.default ?? e["."]) : (pkg.main ?? "index.mjs")
  if (typeof entry !== "string") return ["OpenCode 2.x: exports[\".\"] is not a file"]
  const out = []
  const mod = await import(pathToFileURL(join(dir, entry)).href)
  const d = mod.default
  if (!d || typeof d !== "object" || typeof d.id !== "string" || !d.id || (typeof d.setup !== "function" && typeof d.effect !== "function"))
    out.push(`OpenCode 2.x: ${entry} has no default {id, setup} (plugins#657)`)
  const canon = resolve(import.meta.dir, "opencode2.mjs")
  const copy = join(dir, "opencode2.mjs")
  if (existsSync(copy) && existsSync(canon) && readFileSync(copy, "utf8") !== readFileSync(canon, "utf8"))
    out.push("opencode2.mjs differs from scripts/opencode2.mjs: copy it again")
  for (const f of [entry, existsSync(copy) ? "opencode2.mjs" : null, pkg.main].filter(Boolean)) {
    const name = f.replace(/^\.\//, "")
    if (Array.isArray(pkg.files) && !pkg.files.some((g) => g === name || name.startsWith(g.replace(/\/?$/, "/"))))
      out.push(`${name} is not in files`)
  }
  return out
}
