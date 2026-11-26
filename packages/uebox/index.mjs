import { watch, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { sync, link_path, uebox_dir } from "./lib/sync.mjs"
import { syncLibrary, library_staging_dir } from "./lib/library.mjs"

let started = false

function start() {
  if (started) return
  started = true
  let timer = null
  const watched = new Set()

  const watchDir = (dir, filter) => {
    if (!dir || watched.has(dir) || !existsSync(dir)) return
    try {
      const w = watch(dir, (_, file) => {
        if (!filter || !file || filter(file)) run()
      })
      w.on("error", () => {
        watched.delete(dir)
        try {
          w.close()
        } catch {}
      })
      watched.add(dir)
    } catch {}
  }

  const ensureWatchers = () => {
    const staging = library_staging_dir()
    watchDir(dirname(link_path()), (f) => f === "uebox-link.json" || f === "uebox-library")
    watchDir(staging, (f) => f === "instructions.md" || f === "mcp.json" || f === "skills")
    watchDir(join(staging, "skills"))
    watchDir(uebox_dir(), (f) => f === "models.json" || f === "instructions.md" || f === "mcp.json")
  }

  const run = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      ensureWatchers()
      try {
        sync({ log: (m) => console.log(m) })
      } catch (e) {
        console.log(`uebox: sync failed: ${e && e.message ? e.message : e}`)
      }
      try {
        syncLibrary({ log: (m) => console.log(m) })
      } catch (e) {
        console.log(`uebox: library sync failed: ${e && e.message ? e.message : e}`)
      }
    }, 400)
  }

  ensureWatchers()
  setInterval(run, 5000).unref?.()
  run()
}

export const UEBoxLinkPlugin = async () => {
  start()
  return {}
}
