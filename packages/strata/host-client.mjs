import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const [modulePath, directory, base] = process.argv.slice(2)
const { StrataPlugin } = await import(pathToFileURL(modulePath).href)
const hooks = await StrataPlugin({ directory, client: { app: { log: async () => {} } } })
const loader = await hooks.auth.loader(async () => JSON.parse(readFileSync(join(directory, "plugin-auth.json"), "utf8")).strata)
const response = await loader.fetch(base + "/v1/chat/completions", {
  method: "POST", headers: { "X-Test": "child-host" }, body: '{"model":"fixture-model","messages":[]}',
})
console.log(await response.text())
