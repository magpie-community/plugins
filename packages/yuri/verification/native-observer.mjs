// Test-only, read-only observer. Load after the packed provider in an isolated
// OpenCode configuration; never change request headers, URL, body or credentials.
import fs from "node:fs"

export default {
  id: "yuri.verification.native-observer",
  async setup(ctx) {
    const controlFile = process.env.YURI_VERIFY_CONTROL_FILE
    const outputFile = process.env.YURI_VERIFY_OUTPUT_FILE
    if (!controlFile || !outputFile) throw new Error("Isolated verification paths are required")
    const registration = await ctx.session.hook("http.request", event => {
      if (!event.model.providerID.startsWith("magpie-")) return
      const control = JSON.parse(fs.readFileSync(controlFile, "utf8"))
      const base = new URL(control.baseURL)
      const url = new URL(event.request.url)
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/")) return
      const headers = event.request.headers
      const userAgent = headers.get("User-Agent") ?? ""
      const usesAssignedKey = headers.get("Authorization") === `Bearer ${control.gatewayKey}`
      if (!usesAssignedKey || !userAgent.startsWith("opencode/")) {
        throw new Error("Native verification rejected: assigned key or real OpenCode User-Agent was changed")
      }
      fs.appendFileSync(outputFile, JSON.stringify({
        sessionID: event.sessionID,
        providerID: event.model.providerID,
        kind: event.kind,
        path: url.pathname,
        userAgent,
        advisoryAgent: headers.get("X-Magpie-Agent"),
        usesAssignedKey,
      }) + "\n", { mode: 0o600 })
    })
    return () => registration.dispose()
  },
}
