#!/usr/bin/env node
import { syncBridge } from "./bridge.mjs"

if (!process.argv[2] || process.argv[2] === "sync") {
  try { console.log(`Deepzora bridge: ${syncBridge()}`) } catch {
    console.error("Deepzora bridge could not synchronize. Check JSON/TOML syntax, reserved provider/credential conflicts, file permissions and .magpie-bridge recovery files. Source contents and keys are omitted.")
    process.exitCode = 1
  }
} else {
  console.error("Usage: magpie-deepzora sync")
  process.exitCode = 2
}
