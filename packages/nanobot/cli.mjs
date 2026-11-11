#!/usr/bin/env node
import path from "node:path"
import { pathsFor, reconcile, inspect } from "./bridge.mjs"
import { resolvePaths } from "./runtime.mjs"

const args = process.argv.slice(2)
const action = args.shift() || "status"
const options = {}
let invalid = false
while (args.length) {
  const flag = args.shift()
  if (!["--config", "--state-dir"].includes(flag) || !args.length) { invalid = true; break }
  options[flag === "--config" ? "configPath" : "stateDir"] = path.resolve(args.shift())
}
if (invalid || !["status", "sync", "restore"].includes(action)) {
  console.error("Usage: magpie-nanobot <status|sync|restore> [--config <absolute config.json>] [--state-dir <adapter directory>]")
  process.exitCode = 2
} else {
  try {
    const p = options.stateDir ? pathsFor(options) : resolvePaths(options)
    const result = action === "status" ? inspect(p) : reconcile(p, action === "restore" ? { restore: true, pause: true } : {})
    console.log(JSON.stringify(result, null, 2))
    if (result.state === "conflict") process.exitCode = 1
  } catch {
    console.error("nanobot adapter could not complete the operation. Check target path, JSON syntax, file permissions and recovery records. Configuration contents and keys are omitted.")
    process.exitCode = 1
  }
}
