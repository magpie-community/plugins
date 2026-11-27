import os from "node:os"
import path from "node:path"
import { applyMedia, connection, mediaPaths, prepareAgentPath, syncMedia } from "./media-sync.mjs"
import { syncMcpStore } from "./mcp-store.mjs"
import { syncSkills } from "./skill-sync.mjs"

const instance = Symbol.for("magpie.minimax-design.media.v1")

export default async function MiniMaxDesignMediaPlugin(_input, options = {}) {
  if (globalThis[instance]) return {}
  const paths = mediaPaths()
  let running = false
  let lastConnection
  let lastRefresh = 0
  const errors = new Map()
  const status = { path: "pending", skills: "pending", mcp: "pending", media: "pending" }
  let mediaModels = 0
  let config
  async function run(name, sync) {
    try {
      const result = await sync()
      if (result?.pending) {
        const message = "MCP changes pending: quit MiniMax Design once to save them locally."
        if (message !== errors.get(name)) console.error(`[minimax-design:${name}] ${message}`)
        errors.set(name, message)
        status[name] = "waiting_for_design_to_quit"
        return result
      }
      errors.delete(name)
      if (name !== "media") status[name] = name === "path" && !result ? "not_initialized" : "synced"
      return result
    } catch (error) {
      const message = error.code === "EEXIST" ? "Design is updating its media store; waiting." : error.message
      if (message !== errors.get(name)) console.error(`[minimax-design:${name}] ${message}`)
      errors.set(name, message)
      status[name] = error.code === "EEXIST" && name === "media" ? "waiting_for_design_store" : "error"
    }
  }
  async function tick() {
    if (running) return
    running = true
    try {
      if (!await run("path", () => prepareAgentPath(paths))) return
      await run("skills", () => syncSkills({
        staging: path.join(path.dirname(paths.control), "library-skills"),
        target: path.join(os.homedir(), "Movies/Hub/skills"),
      }))
      await run("mcp", () => syncMcpStore(paths))
      const current = await run("media", async () => {
        const gateway = JSON.stringify(connection(paths))
        if (gateway === lastConnection && Date.now() - lastRefresh < 60000) return
        const result = await syncMedia(paths, options, config?.provider)
        lastConnection = gateway
        lastRefresh = Date.now()
        return result
      })
      if (current) {
        status.media = current.connected ? "synced" : "disconnected"
        mediaModels = current.models
      }
    } finally { running = false }
  }
  const timer = setInterval(tick, 5000)
  timer.unref()
  globalThis[instance] = timer
  process.once("exit", () => {
    try { if (!connection(paths)) applyMedia(paths, null, []) }
    catch { console.error("[minimax-design] Media cleanup pending; ownership record retained.") }
  })
  await tick()
  return {
    config(value) { config = value; lastRefresh = 0 },
    tool: {
      status: {
        description: "Read MiniMax Design's Magpie media and Library sync status.",
        args: { type: "object", properties: {}, additionalProperties: false },
        execute() { return { ...status, mediaModels } },
      },
    },
  }
}
