// What a tagged repository is, and the file it loads, as magpie reads them
// (internal/plugin/github.go readTagged). Kept apart from tagged.mjs, which
// reaches GitHub when loaded, so they can be tested.

// READ names this way of reading: tagged.json carries it, and a file read
// another way is read again whole, not only the repositories pushed to.
// 2: an agent plugin with a module of its own is an agent, and hooks are
// read (#1200).
export const READ = 2

export const named = (e) => !!e && (typeof e !== "object" || Object.keys(e).length > 0)

export const pkgEntry = (exports, main) => {
  const pick = (v) => {
    if (typeof v === "string") return v
    if (v && typeof v === "object") {
      if ("." in v) return pick(v["."])
      for (const k of ["bun", "import", "default", "node", "require"]) {
        const s = pick(v[k])
        if (s) return s
      }
    }
    return ""
  }
  return pick(exports) || main || "index.js"
}

// runs is whether Bun loads a module of the package's own (main, exports)
export const runs = (pj) => !!pj.main || named(pj.exports)

const said = (v) => String(v ?? "").trim() !== ""

// kindOf is the kind magpie shows, or "" for a provider
export function kindOf(pj) {
  const mg = pj.magpie ?? {}
  const r = runs(pj)
  if (!r && said(mg.middleware)) return "middleware"
  // a package that adds an agent is an agent plugin, its module (main)
  // only what keeps the agent working, not a provider (#737, #1200)
  if (said(mg.agent)) return "agent"
  if (!r && said(mg.page?.file)) return "page"
  if (!r && said(mg.hooks)) return "hooks"
  return ""
}

// entryOf is the file the installed plugin loads, which the repository must
// have: its own module when it has one, else the file its kind declares.
// git is whether it is installed from the repository rather than from npm.
export function entryOf(pj, kind, git) {
  const mg = pj.magpie ?? {}
  if (!runs(pj)) {
    if (kind === "middleware") return mg.middleware
    if (kind === "agent") return mg.agent
    if (kind === "page") return mg.page?.file
    if (kind === "hooks") return mg.hooks
  }
  return git ? pkgEntry(pj.exports, pj.main) : pkgEntry(null, "")
}
