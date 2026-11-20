import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const upstream = process.argv[2]
assert.ok(upstream, "Pass the lib/esm directory of jsonc-parser 3.3.1")
const own = fileURLToPath(new URL("./vendor/", import.meta.url))
function verify(relative = "") {
  for (const entry of readdirSync(join(own, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name)
    if (entry.isDirectory()) verify(name)
    else if (name.endsWith(".js")) {
      const source = readFileSync(join(upstream, name), "utf8").replace(/from '(\.\.?\/[^']+)'/g, (_, spec) => `from '${spec}.js'`)
      assert.equal(readFileSync(join(own, name), "utf8"), source, name)
    }
  }
}
verify()
console.log("Readable jsonc-parser sources match 3.3.1 with only relative .js import fixes")
