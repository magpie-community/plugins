// The original host runs authorize -> callback -> save, then settles by identity or secret.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
export function authHost(directory) {
  const file = join(directory, "plugin-auth.json")
  let auth
  return {
    client: { auth: { set: async () => { throw new Error("Plugin must leave saving to the host") } } },
    getAuth: async () => auth,
    async login(hooks, inputs, fail = false) {
      const authorization = await hooks.auth.methods[0].authorize(inputs)
      if (authorization.url !== "" || authorization.method !== "auto") throw new Error("Unexpected authorization contract")
      const result = await authorization.callback()
      if (result.type !== "success" || typeof result.key !== "string") throw new Error("Unsuccessful callback")
      if (fail) throw new Error("save denied")
      const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
      const record = { type: "api", key: result.key, metadata: { ...result.metadata } }
      let at = "strata", index = 1
      while (all[at]) at = "strata#" + index++
      all[at] = record
      const who = record.metadata?.email ?? ""
      for (const [key, old] of Object.entries(all)) {
        if (key === at || (key !== "strata" && !key.startsWith("strata#"))) continue
        const prior = old.accountId ?? old.metadata?.email ?? old.email ?? ""
        if ((who && prior === who) || (!who && !prior && old.key === record.key)) {
          all[key] = record
          delete all[at]
          break
        }
      }
      writeFileSync(file + ".tmp", JSON.stringify(all))
      renameSync(file + ".tmp", file)
      auth = record
      return record
    },
  }
}
