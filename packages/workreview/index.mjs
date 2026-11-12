// Host part of the Work Review agent plugin.
//
// The agent descriptor (and its connect) runs in magpie's moejs sandbox and
// can only see a fixed bridge file. Work Review keeps config.json in a
// different place on every platform, so this Bun module resolves the real
// path, keeps it in step with the bridge, and puts the user's own settings
// back when magpie disconnects.
//
// It opens no network listeners and never sends a request.

import fs from "node:fs"
import { bridgeDir, bridgePath, resolveConfigPath, statePath } from "./lib/paths.mjs"
import { syncOnce } from "./lib/sync.mjs"

const POLL_MS = 30_000

let started = false
let watcher = null
let timer = null
let poll = null
let lastStatus = ""

function log(message) {
  console.error(`[magpie-workreview] ${message}`)
}

function sync(env) {
  try {
    const status = syncOnce({
      bridgePath: bridgePath(),
      statePath: statePath(),
      configPath: resolveConfigPath({ env }),
      log,
    })
    if (status !== lastStatus) {
      if (status === "applied" || status === "restored") log(`config.json ${status}`)
      lastStatus = status
    }
  } catch (error) {
    log(error.message)
  }
}

// The bridge is also how magpie decides the agent is installed (its presence,
// beside magpie's own backup in state.json), so it exists only once Work
// Review's config.json does.
function ensureBridge(env) {
  if (!fs.existsSync(resolveConfigPath({ env }))) return false
  fs.mkdirSync(bridgeDir(), { recursive: true })
  if (!fs.existsSync(bridgePath())) fs.writeFileSync(bridgePath(), "{}\n", { flag: "wx" })
  return true
}

function watch(env) {
  if (watcher) return
  const dir = bridgeDir()
  try {
    watcher = fs.watch(dir, (_event, name) => {
      if (name && name !== "agent.json" && name !== "state.json") return
      clearTimeout(timer)
      timer = setTimeout(() => sync(env), 120)
      timer.unref?.()
    })
    watcher.on("error", (error) => log(`watch: ${error.message}`))
    watcher.unref?.()
  } catch (error) {
    log(`watch: ${error.message}`)
  }
}

function start(env = process.env) {
  if (started) return
  started = true
  if (ensureBridge(env)) {
    watch(env)
    sync(env)
  }
  // Work Review may be installed after magpie started: pick it up, and stop
  // looking once the bridge exists.
  poll = setInterval(() => {
    if (!ensureBridge(env)) return
    clearInterval(poll)
    poll = null
    watch(env)
    sync(env)
  }, POLL_MS)
  poll.unref?.()
}

export default {
  id: "workreview-agent",
  server(input = {}, options = {}, env = process.env) {
    start(env)
    return {}
  },
}
