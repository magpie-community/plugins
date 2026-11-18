// Fails when a package's shipped files changed since <base> while its
// version stayed the same.
//   bun scripts/bumped.mjs <base-ref>
// A version is packed once: the dist branch keeps the first tarball made of
// it (scripts/dist.mjs), npm refuses to publish it twice, and magpie's
// update compares versions only. So a change shipped under a version that
// is already out never reaches anyone who has that version, and new
// installs from dist get the old code under the new number (plugins#1131:
// astudio 0.2.2's DeepSeek-V4.1-Flash fill-in went out without a bump).
// README.md is left out: magpie reads it from dist's index.json, which is
// written again on every run. Files npm doesn't pack (tests) don't count.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// unbumped lists "<dir>@<version>: files…" for each package whose shipped
// files changed with its version the same. changed: repo paths changed
// since base. versionAt(dir, "base"|"head"): the version, or null when
// the package isn't there. packed(dir): the paths npm packs, relative to
// dir.
export function unbumped(changed, versionAt, packed) {
  const byDir = new Map()
  for (const p of changed) {
    const m = /^(packages\/[^/]+)\/(.+)$/.exec(p)
    if (!m) continue
    if (!byDir.has(m[1])) byDir.set(m[1], [])
    byDir.get(m[1]).push(m[2])
  }
  const out = []
  for (const [dir, files] of byDir) {
    const head = versionAt(dir, "head")
    const base = versionAt(dir, "base")
    if (head === null || base === null || head !== base) continue
    const ships = new Set(packed(dir))
    const hit = files.filter((f) => f !== "README.md" && ships.has(f)).sort()
    if (hit.length) out.push(`${dir}@${head}: ${hit.join(", ")}`)
  }
  return out.sort()
}

if (import.meta.main) {
  const base = process.argv[2]
  if (!base || /^0+$/.test(base)) {
    console.log("no base to compare with")
    process.exit(0)
  }
  const root = resolve(import.meta.dir, "..")
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const changed = git("diff", "--name-only", base, "HEAD", "--", "packages").split("\n").filter(Boolean)
  const versionAt = (dir, at) => {
    try {
      const src = at === "head" ? (existsSync(join(root, dir, "package.json")) ? readFileSync(join(root, dir, "package.json"), "utf8") : null) : git("show", `${base}:${dir}/package.json`)
      return src === null ? null : JSON.parse(src).version ?? null
    } catch {
      return null
    }
  }
  const packed = (dir) => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: join(root, dir), encoding: "utf8" })
    return JSON.parse(out)[0].files.map((f) => f.path)
  }
  const problems = unbumped(changed, versionAt, packed)
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p} changed without a version bump; raise the version in its package.json`)
    process.exit(1)
  }
  console.log(`every package that changed since ${base} has a new version`)
}
