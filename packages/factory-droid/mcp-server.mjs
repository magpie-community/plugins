// Droid starts one stdio server per session. Only the caller runs the tool.
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { publish } from "./mailbox.mjs"

const manifest = process.argv[2]
const dir = dirname(manifest)
const tools = JSON.parse(readFileSync(manifest, "utf8"))
let closed = false

async function handle(request) {
  switch (request.method) {
    case "initialize": return { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "magpie", version: "1" } }
    case "ping": return {}
    case "tools/list": return { tools }
    case "tools/call": {
      const { name, arguments: input = {} } = request.params ?? {}
      if (!tools.some(t => t.name === name)) throw Object.assign(new Error("Unknown caller tool"), { code: -32602 })
      const id = randomUUID()
      publish(dir, "call-" + id, { name, input })
      const file = join(dir, "result-" + id)
      while (!closed && existsSync(manifest)) {
        if (existsSync(file)) {
          const result = JSON.parse(readFileSync(file, "utf8"))
          unlinkSync(file)
          return result
        }
        await sleep(75)
      }
      throw new Error("Droid session closed")
    }
    default: throw Object.assign(new Error("Method not found"), { code: -32601 })
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on("close", () => { closed = true })
lines.on("line", async line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request?.id == null) return
  const reply = { jsonrpc: "2.0", id: request.id }
  try { reply.result = await handle(request) }
  catch (error) { reply.error = { code: error.code ?? -32603, message: error.message } }
  if (!closed) process.stdout.write(JSON.stringify(reply) + "\n")
})
