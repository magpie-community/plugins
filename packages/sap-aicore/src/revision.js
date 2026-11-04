import { readFile } from "node:fs/promises"

const ROOT = new URL("..", import.meta.url)

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))
    return typeof pkg.version === "string" ? pkg.version : null
  } catch {
    return null
  }
}

let cached

/** Package version only, computed once without Git or child processes. */
export function pluginRevision() {
  cached ??= readVersion().then(version => version ?? "unknown")
  return cached
}
