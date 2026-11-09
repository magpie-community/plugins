import { resolvePaths, startRuntime } from "./runtime.mjs"

const instance = Symbol.for("magpie.nanobot.adapter.v1")

// Magpie treats every exported function in main as a plugin. Keep helpers in
// their own modules, and never terminate or take signals from its shared host.
export default async function NanobotAgent(input, options = {}) {
  if (!globalThis[instance]) {
    const runtime = startRuntime(resolvePaths(options), {
      onStatus(status) {
        const level = status.state === "conflict" ? "warn" : "info"
        const message = `nanobot adapter: ${status.state}; MCP changes require a nanobot restart. Run magpie-nanobot status for details.`
        try { void input?.client?.app?.log?.({ body: { service: "nanobot-agent", level, message } })?.catch?.(() => {}) } catch {}
      },
    })
    globalThis[instance] = runtime
    process.once("exit", () => {
      try { runtime.stop() } catch { console.error("nanobot restoration paused; retain the adapter recovery files and run magpie-nanobot restore.") }
    })
  }
  return {}
}
