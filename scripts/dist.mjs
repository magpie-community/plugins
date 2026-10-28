// Packs every package's version onto the `dist` branch, where magpie
// installs it from when npm doesn't have it: a new package (npm's trusted
// publishing can't create one, and its first version waits for an owner's
// 2FA), or a version npm refused. Merging is all a plugin needs to reach
// magpie.
//   node scripts/dist.mjs <folder> [folder holding the built page files]
// The branch holds tgz/<npm pack's file name> and index.json:
//   {version: 1, packages: {<name>: {latest, readme,
//     versions: {<version>: {file, integrity, time, manifest}}}}}
// integrity is the tarball's sha512, as npm writes it; magpie installs a
// tarball only when it matches. A version packed once is never packed
// again, so a file magpie checked stays what it checked; a package taken
// out of the repo stays in the index for those who installed it.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const out = resolve(process.argv[2] ?? "")
if (!process.argv[2] || !existsSync(out)) {
  console.error("usage: node scripts/dist.mjs <folder with the dist branch checked out>")
  process.exit(2)
}
const root = resolve(import.meta.dirname, "..")
// A package that ships files it builds (a page bundle) gets them from the test
// job, which has no write permission and an exact toolchain; this job only
// copies them in and packs. Nothing here runs a package's own scripts.
const builtRoot = process.argv[3] && existsSync(resolve(process.argv[3])) ? resolve(process.argv[3]) : ""
const tgz = join(out, "tgz")
mkdirSync(tgz, { recursive: true })

const indexFile = join(out, "index.json")
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : { version: 1, packages: {} }
const README_MOST = 200 << 10

const added = []
for (const dir of readdirSync(join(root, "packages")).sort()) {
  const pj = join(root, "packages", dir, "package.json")
  if (!existsSync(pj)) continue
  const manifest = JSON.parse(readFileSync(pj, "utf8"))
  if (manifest.private) continue
  const { name, version } = manifest
  const entry = (index.packages[name] ??= { versions: {} })
  const had = entry.versions[version]
  if (!had || !existsSync(join(out, had.file))) {
    if (builtRoot) {
      const built = join(builtRoot, "packages", dir, "page")
      if (existsSync(built)) {
        const target = join(root, "packages", dir, "page")
        rmSync(target, { recursive: true, force: true })
        cpSync(built, target, { recursive: true })
      }
    }
    // a package's own scripts never run here: this job can push
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tgz], { cwd: join(root, "packages", dir), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }))
    const integrity = "sha512-" + createHash("sha512").update(readFileSync(join(tgz, packed.filename))).digest("base64")
    entry.versions[version] = { file: "tgz/" + packed.filename, integrity, time: new Date().toISOString(), manifest }
    added.push(`${name}@${version}`)
  }
  entry.latest = version
  const readme = join(root, "packages", dir, "README.md")
  entry.readme = existsSync(readme) ? readFileSync(readme, "utf8").slice(0, README_MOST) : ""
}

const sorted = { version: 1, packages: Object.fromEntries(Object.entries(index.packages).sort(([a], [b]) => a.localeCompare(b))) }
writeFileSync(indexFile, JSON.stringify(sorted, null, 2) + "\n")
console.log(added.length ? "packed: " + added.join(" ") : "every version is packed already")
