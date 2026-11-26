import { watch, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { sync, link_path, uebox_dir } from "./lib/sync.mjs"

let started = false

function start() {
  if (started) return
  started = true
  let timer = null
  const run = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        sync({ log: (m) => console.log(m) })
      } catch (e) {
        console.log(`uebox: sync failed: ${e && e.message ? e.message : e}`)
      }
    }, 400)
  }
  const watchDir = (dir, name) => {
    if (!existsSync(dir)) return
    try {
      watch(dir, (_, file) => { if (!file || file === name) run() }).on("error", () => {})
    } catch {}
  }
  watchDir(dirname(link_path()), "uebox-link.json")
  watchDir(uebox_dir(), "models.json")
  setInterval(run, 5000).unref?.()
  run()
}

export const UEBoxLinkPlugin = async () => {
  start()
  return {}
}
