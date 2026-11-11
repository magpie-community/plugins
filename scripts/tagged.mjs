// Builds tagged.json for the `dist` branch: the repositories on GitHub
// tagged with the magpie-plugin topic, read as magpie reads them
// (internal/plugin/github.go, askTagged and readTagged), so magpie can show
// the Plugins page's Discover list without reaching GitHub itself.
//   GITHUB_TOKEN=... node scripts/tagged.mjs <folder with the dist branch checked out>
// tagged.json holds {version: 1, generated, plugins: [Tagged...]}, most
// starred first. A repository whose package.json can't be read this time
// stays as the last file had it; a search that fails writes nothing.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve, posix } from "node:path"

const TOPIC = "magpie-plugin"
const pkgName = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const out = resolve(process.argv[2] ?? "")
if (!process.argv[2] || !existsSync(out)) {
  console.error("usage: node scripts/tagged.mjs <folder with the dist branch checked out>")
  process.exit(2)
}
const file = join(out, "tagged.json")
let last = []
try {
  last = JSON.parse(readFileSync(file, "utf8")).plugins ?? []
} catch {}
const before = new Map(last.map((t) => [t.repo.toLowerCase(), t]))

const ua = { "User-Agent": "magpie-community-tagged" }
const headers = { ...ua, Accept: "application/vnd.github+json" }
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

class NotFound extends Error {}
async function get(url, h = ua) {
  let err
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(30000) })
      if (r.status === 404) throw new NotFound(url)
      if (r.ok) return r
      err = new Error(`${url}: ${r.status}`)
      if (r.status === 403 || r.status === 429) await new Promise((f) => setTimeout(f, 5000 * (i + 1)))
    } catch (e) {
      if (e instanceof NotFound) throw e
      err = e
    }
  }
  throw err
}

// every page of the search; it answers 1000 results at most
const items = []
const listed = new Set()
for (let page = 1; page <= 10; page++) {
  const q = new URLSearchParams({ q: `topic:${TOPIC} archived:false fork:false`, sort: "stars", order: "desc", per_page: "100", page: String(page) })
  const p = await (await get(`https://api.github.com/search/repositories?${q}`, headers)).json()
  for (const it of p.items ?? []) {
    const k = it.full_name.toLowerCase()
    if (!listed.has(k)) {
      listed.add(k)
      items.push(it)
    }
  }
  if ((p.items ?? []).length < 100 || page * 100 >= p.total_count) break
}

const ownIcon = (said) => {
  const ic = typeof said === "string" ? said.trim() : ""
  if (ic.length > 3 << 19) return ""
  const l = ic.toLowerCase()
  return l.startsWith("https://") || l.startsWith("data:image/") ? ic : ""
}
const repoOf = (v) => {
  let s = typeof v === "string" ? v : (v?.url ?? "")
  s = s.replace(/^git\+/, "").replace(/\.git$/, "").replace("git://", "https://").replace("ssh://git@", "https://")
  if (s.startsWith("github:")) s = "https://github.com/" + s.slice(7)
  else if (!s.includes("://") && s.split("/").length === 2) s = "https://github.com/" + s
  const m = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#]+)/.exec(s)
  return m ? `${m[1]}/${m[2]}` : ""
}
const named = (e) => !!e && (typeof e !== "object" || Object.keys(e).length > 0)
const pkgEntry = (exports, main) => {
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

// the repository as magpie lists it, or null when it isn't a plugin magpie
// could install; throws when GitHub or npm didn't answer
async function read(it) {
  const t = {
    spec: "github:" + it.full_name, repo: it.full_name, url: it.html_url, owner: it.owner.login, ownerAvatar: it.owner.avatar_url,
    description: it.description ?? "", stars: it.stargazers_count, pushed: it.pushed_at,
  }
  if (it.license && it.license.spdx_id !== "NOASSERTION") t.license = it.license.spdx_id
  const branch = encodeURIComponent(it.default_branch || "HEAD")
  const raw = (p) => `https://raw.githubusercontent.com/${it.full_name}/${branch}/${p}`
  let pj
  try {
    pj = await (await get(raw("package.json"))).json()
  } catch (e) {
    if (e instanceof NotFound || e instanceof SyntaxError) return null
    throw e
  }
  if (!pj || typeof pj.name !== "string" || !pkgName.test(pj.name)) return null
  t.package = pj.name
  t.version = pj.version ?? ""
  const icon = ownIcon(pj.magpie?.icon)
  if (icon) t.icon = icon
  const mg = pj.magpie ?? {}
  if (!pj.main && !named(pj.exports)) {
    if (String(mg.middleware ?? "").trim()) t.kind = "middleware"
    else if (String(mg.agent ?? "").trim()) t.kind = "agent"
    else if (String(mg.page?.file ?? "").trim()) t.kind = "page"
  }
  // published to npm from this repository: npm's copy is installed
  let npmNames = false
  try {
    const l = await (await get(`https://registry.npmjs.org/${pj.name.replace("/", "%2f")}/latest`)).json()
    if (l.version && repoOf(l.repository).toLowerCase() === it.full_name.toLowerCase()) {
      t.spec = pj.name
      t.version = l.version
      npmNames = !!l.main || named(l.exports)
    }
  } catch (e) {
    if (!(e instanceof NotFound)) throw e
  }
  // installed from the repository, or from an npm copy that names no file,
  // the file it loads must be in the repository
  if (t.spec.startsWith("github:") || !npmNames) {
    let entry = mg.middleware
    if (t.kind === "agent") entry = mg.agent
    else if (t.kind === "page") entry = mg.page?.file
    else if (t.kind !== "middleware") entry = t.spec.startsWith("github:") ? pkgEntry(pj.exports, pj.main) : pkgEntry(null, "")
    if (posix.extname(entry ?? "") !== "") {
      try {
        await get(raw(posix.normalize("/" + entry).replace(/^\//, "")))
      } catch (e) {
        if (e instanceof NotFound) return null
        throw e
      }
    }
  }
  return t
}

const plugins = []
let failed = 0
const queue = items.filter((it) => !it.archived && !it.fork && it.owner.login.toLowerCase() !== "magpie-community" && it.full_name.includes("/"))
async function worker() {
  for (let it; (it = queue.shift()); ) {
    const was = before.get(it.full_name.toLowerCase())
    // read again only when pushed to; stars and the rest are the search's
    if (was && was.pushed === it.pushed_at) {
      plugins.push({ ...was, stars: it.stargazers_count, description: it.description ?? "", ownerAvatar: it.owner.avatar_url })
      continue
    }
    try {
      const t = await read(it)
      if (t) plugins.push(t)
    } catch (e) {
      failed++
      console.error(`${it.full_name}: ${e.message}`)
      if (was) plugins.push(was)
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
plugins.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo))
if (!plugins.length) {
  console.error("no plugin read; keeping the last file")
  process.exit(1)
}
const same = JSON.stringify(last.map((t) => t.repo).sort()) === JSON.stringify(plugins.map((t) => t.repo).sort())
writeFileSync(file, JSON.stringify({ version: 1, generated: new Date().toISOString(), plugins }))
console.log(`${plugins.length} plugins, ${failed} unread${same ? "" : ", list changed"}`)
