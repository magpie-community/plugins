import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const disabled = () => process.env.OUTPUT_STRATEGY_NO_PUBLISH === "1" || process.env.COMPRESS_CORE_NO_PUBLISH === "1"
const pageDir = () => process.env.OUTPUT_STRATEGY_PAGE_DIR || fileURLToPath(new URL("./page/", import.meta.url))

export async function publishPageScript(name, global, value) {
  if (disabled()) return false
  const temporary = join(pageDir(), `.${name}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await mkdir(pageDir(), { recursive: true })
    await writeFile(temporary, `globalThis.${global} = ${JSON.stringify(value)}\n`, "utf8")
    await rename(temporary, join(pageDir(), name))
    return true
  } catch {
    try { await rm(temporary, { force: true }) } catch {}
    return false
  }
}
