// Builds the files a package declares it ships built, for scripts/dist.mjs to
// pack. It runs in a job that cannot push, with the version each package.json
// pins -- no npx, nothing that floats -- and each package's own build script
// has to be one it names in `scripts.build:page`.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const built = []
for (const dir of readdirSync(join(root, "packages")).sort()) {
  const pj = join(root, "packages", dir, "package.json")
  if (!existsSync(pj)) continue
  const manifest = JSON.parse(readFileSync(pj, "utf8"))
  if (!manifest.scripts?.["build:page"]) continue
  const pin = manifest.devDependencies?.esbuild
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
    console.error(`${dir}: build:page needs an exact esbuild pin in devDependencies (it has ${pin ?? "nothing"})`)
    process.exit(1)
  }
  const cwd = join(root, "packages", dir)
  execFileSync("npm", ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", `esbuild@${pin}`], { cwd, stdio: ["ignore", "inherit", "inherit"] })
  execFileSync("npm", ["run", "--silent", "build:page"], { cwd, stdio: ["ignore", "inherit", "inherit"] })
  built.push(dir)
}
console.log(built.length ? `built page files: ${built.join(" ")}` : "no package builds page files")