import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const ROOT = new URL("..", import.meta.url)
const exec = promisify(execFile)

async function readVersion() {
  try {
    const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))
    return typeof pkg.version === "string" ? pkg.version : null
  } catch {
    return null
  }
}

async function gitDescribe() {
  try {
    const metadata = await stat(new URL(".git", ROOT))
    if (!metadata.isDirectory() && !metadata.isFile()) return null
    // Git must identify this checkout, not an environment-selected repository.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CEILING_DIRECTORIES: fileURLToPath(new URL("..", ROOT)),
    }
    const { stdout } = await exec("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: fileURLToPath(ROOT), env, encoding: "utf8", timeout: 2000,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

let cached

/** Package version plus this checkout's Git revision, computed once. */
export function pluginRevision() {
  cached ??= Promise.all([readVersion(), gitDescribe()]).then(([version, describe]) => {
    version ??= "unknown"
    return describe ? `${version} (${describe})` : version
  })
  return cached
}
