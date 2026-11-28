import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const version = "1.3.14"
if (process.versions.bun !== version) throw new Error(`Reproducible build requires Bun ${version}; received ${process.versions.bun ?? "Node"}`)
const build = spawnSync(process.execPath, ["build", "src/server.ts", "--target=node", "--format=esm", "--outfile=dist/index.mjs"], {
  cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "inherit",
})
process.exit(build.status ?? 1)
