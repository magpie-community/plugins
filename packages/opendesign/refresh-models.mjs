// Regenerates models.mjs — the models the provider offers before anyone has
// signed in — from amr-link's live catalog, which is the account's own list
// (it is what the plugin reads for a signed-in account too).
//
//   bun refresh-models.mjs                    # key from magpie's sign-in
//   OPENDESIGN_KEY=sk-amr-… bun refresh-models.mjs
//
// The key is the account's runtime key: magpie keeps it in plugin-auth.json
// after `magpie plugin login opendesign`, and it is never printed or written
// anywhere but the Authorization header. A name already in models.mjs is
// kept — the catalog carries ids, not names.
//
// magpie runs a plugin host per command, so `magpie plugin login` has to have
// finished before this reads the key it saved.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// the seed this writes, beside the script: the package root here, and the
// package root when npm installs it
const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, "models.mjs")
const API = "https://amr-link.open-design.ai/v1"

if (!existsSync(TARGET)) {
  console.error("no models.mjs beside this script")
  process.exit(1)
}

const magpieKey = () => {
  const dir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  try {
    const auth = JSON.parse(readFileSync(join(dir, "magpie", "plugin-auth.json"), "utf8")).opendesign
    return auth?.access || auth?.key || ""
  } catch {
    return ""
  }
}

const key = (process.env.OPENDESIGN_KEY || "").trim() || magpieKey()
if (!key) {
  console.error("No key: sign in with `magpie plugin login opendesign`, or set OPENDESIGN_KEY=sk-amr-…")
  process.exit(1)
}

const res = await fetch(`${API}/models`, { headers: { authorization: `Bearer ${key}` } })
if (!res.ok) {
  console.error(`amr-link answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  process.exit(1)
}
const body = await res.json()
const catalog = (body?.data ?? []).filter((m) => typeof m?.id === "string" && m.id.trim())
if (!catalog.length) {
  console.error("amr-link listed no models")
  process.exit(1)
}

// names already chosen are kept, and so are the measured reasoning levels:
// the catalog has ids only, and says nothing of efforts
let before = {}
try {
  ;({ MODELS: before } = await import(pathToFileURL(TARGET).href))
} catch {}

// input is the catalog's kinds and the seed's together, as the plugin serves
// them (withSeed in index.mjs, #829): a catalog entry that leaves image out
// doesn't take it from a model the seed declares it for. A kind kept that way
// is printed, so removing it is a choice made in models.mjs, not a refresh's.
const kinds = (l) => (Array.isArray(l) ? l.filter((x) => typeof x === "string" && x !== "text") : [])
const input = (id, m) => {
  const said = kinds(m?.architecture?.input_modalities)
  const kept = kinds(before[id]?.input).filter((x) => !said.includes(x))
  if (kept.length) console.log(`${id}: kept ${kept.join(", ")} from models.mjs; the catalog doesn't list it`)
  return [...new Set([...kinds(before[id]?.input), ...said])]
}
const positive = (n) => Number.isFinite(n) && n > 0
const lines = []
for (const m of catalog) {
  const id = m.id.trim()
  const meta = m.metadata ?? {}
  const facts = []
  // what the catalog leaves out is the seed's, as the plugin serves it
  const was = before[id] ?? {}
  const context = positive(Number(meta.context_limit)) ? Number(meta.context_limit) : Number(was.context)
  const output = positive(Number(meta.context_budget)) ? Number(meta.context_budget) : Number(was.output)
  if (positive(context)) facts.push(`context: ${context}`)
  if (positive(output)) facts.push(`output: ${output}`)
  const extra = input(id, m)
  if (extra.length) facts.push(`input: [${extra.map((x) => JSON.stringify(x)).join(", ")}]`)
  const cost = typeof meta.cost === "string" && meta.cost.trim() ? meta.cost : was.cost
  const capability = typeof meta.capability === "string" && meta.capability.trim() ? meta.capability : was.capability
  if (typeof cost === "string") facts.push(`cost: ${JSON.stringify(cost)}`)
  if (typeof capability === "string") facts.push(`capability: ${JSON.stringify(capability)}`)
  const efforts = before[id]?.efforts
  if (Array.isArray(efforts)) facts.push(`efforts: [${efforts.map((x) => JSON.stringify(x)).join(", ")}]`)
  const name = before[id]?.name ?? id
  lines.push(`  ${JSON.stringify(id)}: { name: ${JSON.stringify(name)}${facts.length ? ", " + facts.join(", ") : ""} },`)
}

const header = `// The models an account is offered before anyone has signed in — the seed
// magpie and OpenCode read for the provider. Regenerate with
// \`bun refresh-models.mjs\` (beside this seed): it
// reads amr-link's catalog at the signed-in account's key, which is the same
// list a signed-in account is given again on every listing.
//
// name: what the model is called; context/output: its token limits; input:
// the non-text modalities it takes; cost and capability: the vendor's own
// words, which the plugin turns into magpie's thinking flag (the rate is
// rates.mjs's, the plan's own deduction multiplier); efforts: the reasoning
// levels amr-link was seen to take and think at, measured, not read (#137),
// so a refresh keeps them.

export const MODELS = {
${lines.join("\n")}
}
`
writeFileSync(TARGET, header)
console.log(`${TARGET}: ${lines.length} models`)
