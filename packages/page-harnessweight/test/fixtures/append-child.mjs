// A second plugin host in miniature: appends rows to a shared tools log.
//   node append-child.mjs <file> <tag> <count> <maxBytes> <padBytes>
//   node append-child.mjs --hold <file>   take the lock, print LOCKED, wait
import { createToolsWriter } from "../../harnessweight.hooks.mjs"
import { open } from "node:fs/promises"

const args = process.argv.slice(2)
if (args[0] === "--hold") {
  // Take the main lock the way the writer does and keep it until killed.
  const handle = await open(args[1] + ".lock", "wx")
  await handle.writeFile(JSON.stringify({ pid: process.pid, token: "held-by-child", at: Date.now() }))
  await handle.close()
  process.stdout.write("LOCKED\n")
  setInterval(() => {}, 1 << 30)
} else {
  const [file, tag, count, maxBytes, pad] = args
  // A longer wait than the 100 ms default: this test checks that no row is
  // lost under contention, not that contention skips samples.
  const append = createToolsWriter({ maxBytes: Number(maxBytes), lockTimeoutMs: 5000, warn: () => {} })
  for (let i = 0; i < Number(count); i++) {
    await append(file, { t: Date.now(), agent: tag, id: `${tag}-${i}`, pad: "x".repeat(Number(pad)) })
  }
}
