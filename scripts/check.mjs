// Loads every package's plugin the way OpenCode (and magpie) do and checks
// the shape of what it returns: an auth hook with a provider, a loader and
// methods OpenCode knows, or, for a plugin of tools alone, its tools. It
// signs in to nothing and sends no request.
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve(import.meta.dir, "..", "packages")
const only = process.argv[2]
let failed = 0
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
        if (p && !signInOnly) {
          needsLoader = true
          if (!p.npm || !p.models || !Object.keys(p.models).length) problems.push(`${fn.name}: config gives ${auth.provider} no npm or models`)
        }
      }
      if ((needsLoader || auth.loader !== undefined) && typeof auth.loader !== "function") problems.push(`${fn.name}: auth.loader`)
    }
  } catch (e) {
    problems.push(String(e?.stack ?? e))
  }
  if (problems.length) failed++
  console.log(problems.length ? `✗ ${name}\n  ${problems.join("\n  ")}` : `✓ ${name}`)
}
process.exit(failed ? 1 : 0)
