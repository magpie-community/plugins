// Every mutation of the package has to turn a test red. If one stays green,
// that test was never checking anything.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRATCH = join(dirname(SRC), ".mut-cowork")

const MUTATIONS = [
  {
    file: "seed.mjs",
    from: "if (taken.has(m.id)) continue",
    to: "if (false) continue",
    why: "adds a catalog model Cowork already has, so two entries share one title",
  },
  {
    file: "seed.mjs",
    from: "const droppable = models.filter((m) => m && m.providerId === PROVIDER_ID && seeded.has(m.id) && !ids.has(m.model) &&",
    to: "const droppable = models.filter((m) => m && seeded.has(m.id) && !ids.has(m.model) &&",
    why: "prunes a model under the user's own provider because a stale record named it",
  },
  {
    file: "seed.mjs",
    from: "const droppable = models.filter((m) => m && m.providerId === PROVIDER_ID && seeded.has(m.id) && !ids.has(m.model) &&",
    to: "const droppable = models.filter((m) => m && m.providerId === PROVIDER_ID && !ids.has(m.model) &&",
    why: "prunes every magpie entry missing from the catalog, including ones the user added",
  },
  {
    file: "seed.mjs",
    from: "const pruned = opts.prune ? droppable.map((m) => m.id) : []",
    to: "const pruned = droppable.map((m) => m.id)",
    why: "a catalog that is short for a moment empties the picker without --prune",
  },
  {
    file: "seed.mjs",
    from: "m.id !== selected && m.model !== selected && m.displayName !== selected",
    to: "true",
    why: "prunes the model Cowork is on right now, which falls back silently",
  },
  {
    file: "seed.mjs",
    from: "if (!m || m.providerId !== PROVIDER_ID || !seeded.has(m.id) || m.displayName === m.model) return m",
    to: "return m",
    why: "leaves a pretty label as the picker title, so the string magpie writes matches nothing",
  },
  {
    file: "seed.mjs",
    from: "if (!m || m.providerId !== PROVIDER_ID || !seeded.has(m.id) || m.displayName === m.model) return m",
    to: "if (!m || m.displayName === m.model) return m",
    why: "renames entries the user named, dangling their saved selection",
  },
  {
    file: "seed.mjs",
    from: "if (!m || m.providerId !== PROVIDER_ID || !seeded.has(m.id) || m.displayName === m.model) return m",
    to: "if (!m || m.providerId !== PROVIDER_ID || m.displayName === m.model) return m",
    why: "renames an entry of theirs that an old record still lists",
  },
  {
    file: "seed.mjs",
    from: "if (at === -1) providers.push(provider(baseUrl))",
    to: "if (false) providers.push(provider(baseUrl))",
    why: "never adds the provider that points Cowork at magpie",
  },
  {
    file: "seed.mjs",
    from: "supportsMultimodal: !!(m.modalities && (m.modalities.input || []).includes(\"image\")),",
    to: "supportsMultimodal: false,",
    why: "tells Cowork no magpie model takes images",
  },
  {
    file: "seed.mjs",
    from: "roles: [\"model\"],",
    to: "roles: [],",
    why: "drops the role Cowork's own store gives every usable model",
  },
  {
    file: "seed.mjs",
    from: "return v && !v.startsWith(\"--\") ? v : dflt",
    to: "return v ? v : dflt",
    why: "reads the next flag as --gateway's value, so it fetches --check/v1/models",
  },
  {
    file: "seed.mjs",
    from: "const ours = (m) => m && m.providerId === PROVIDER_ID && seeded.has(m.id)",
    to: "const ours = (m) => m && seeded.has(m.id)",
    why: "--remove eats what the user made in Cowork, because the record predates the fix",
  },
  {
    file: "seed.mjs",
    from: "return existsSync(storePath) && !existsSync(bakPath)",
    to: "return existsSync(storePath)",
    why: "a second run overwrites the original store with an already-seeded one",
  },
  {
    file: "seed.mjs",
    from: "displayName: m.id,",
    to: "displayName: m.magpie_label || m.id,",
    why: "same, for the entries the package adds itself",
  },
  {
    file: "cowork.agent.js",
    from: "icon: \"data:image/png;base64,",
    to: "icon: \"data:image/jpeg;base64,",
    why: "ships the icon under a mime the Agents page won't render",
  },
  {
    file: "cowork.agent.js",
    from: "model: \"defaultChatModelTitle\",",
    to: "model: \"chatModelTitle\",",
    why: "writes a field name Cowork never reads",
  },
  {
    file: "seed.mjs",
    from: "const candidates = env.CODELY_CLI_HOME ? [at(env.CODELY_CLI_HOME), join(home, \".codely\")] : [join(home, \".codely\")]",
    to: "const candidates = [join(home, \".codely\")]",
    why: "seeds the old place after the user moved Cowork's home, so nothing ever sees the models",
  },
  {
    file: "seed.mjs",
    from: "return candidates.find((d) => existsSync(join(d, \"ide-settings.json\"))) || candidates[candidates.length - 1]",
    to: "return candidates[0]",
    why: "takes the terminal CLI's own home for Cowork's, because a stale CODELY_CLI_HOME points there",
  },
  {
    file: "seed.mjs",
    from: "if (!storeFlag && (!existsSync(home) || (!existsSync(storePath) && !existsSync(titlePath)))) {",
    to: "if (false) {",
    why: "invents a Cowork home and still prints a success line",
  },
  {
    file: "seed.mjs",
    from: "(!existsSync(storePath) && !existsSync(titlePath))",
    to: "(!existsSync(storePath) || !existsSync(titlePath))",
    why: "refuses the first store in a home Cowork did create",
  },
  {
    file: "seed.mjs",
    from: "const storePath = storeFlag ? expand(storeFlag) : join(home, \"settings.json\")",
    to: "const storePath = storeFlag ? expand(storeFlag) : join(homedir(), \".codely\", \"settings.json\")",
    why: "works out the home and then throws the answer away",
  },
  {
    file: "seed.mjs",
    from: "if (!storeFlag) console.log(`store: ${storePath}`)",
    to: "if (false) console.log(storePath)",
    why: "seeds a home the user never asked for and never says which one it picked",
  },
  {
    file: "seed.mjs",
    from: "return here.length > 0 && !here.some((x) => (x.displayName ?? x.model) === m.id || (x.providerId === PROVIDER_ID && seeded.has(x.id)))",
    to: "return false",
    why: "a switch to a model only under the user's provider falls back in silence again",
  },
  {
    file: "seed.mjs",
    from: "return here.length > 0 && !here.some((x) => (x.displayName ?? x.model) === m.id || (x.providerId === PROVIDER_ID && seeded.has(x.id)))",
    to: "return here.length > 0 && !here.some((x) => (x.displayName ?? x.model) === m.id)",
    why: "scolds an entry the same run puts back on its id",
  },
  {
    file: "seed.mjs",
    from: "if (!rows.length) return \"\"",
    to: "return \"\"",
    why: "works the list out and then never tells anyone",
  },
  {
    file: "seed.mjs",
    from: ".filter((m) => m && m.providerId === PROVIDER_ID && m.displayName === m.model && ids.has(m.model))",
    to: ".filter((m) => m && m.providerId === PROVIDER_ID && ids.has(m.model))",
    why: "adoption claims an entry the user renamed, so --remove would take it out",
  },
  {
    file: "seed.mjs",
    from: ".filter((m) => m && m.providerId === PROVIDER_ID && m.displayName === m.model && ids.has(m.model))",
    to: ".filter((m) => m && m.providerId === PROVIDER_ID && m.displayName === m.model)",
    why: "adoption claims a model magpie no longer offers, making a stale entry ours to prune",
  },
  {
    file: "seed.mjs",
    from: "} catch {\n    return { ok: false, value: null }",
    to: "} catch {\n    return { ok: true, value: null }",
    why: "an unreadable selection looks like no selection, so it can be renamed or pruned",
  },
  {
    file: "seed.mjs",
    from: "if (!ide || typeof ide !== \"object\" || Array.isArray(ide)) return { ok: false, value: null }",
    to: "if (false) return { ok: false, value: null }",
    why: "a selection file that is a list or scalar is read as no selection",
  },
  {
    file: "seed.mjs",
    from: "if (title != null && typeof title !== \"string\") return { ok: false, value: null }",
    to: "if (false) return { ok: false, value: null }",
    why: "a non-string title is compared against entry names and never matches",
  },
  {
    file: "seed.mjs",
    from: "if (!store || typeof store !== \"object\" || Array.isArray(store)) {",
    to: "if (false) {",
    why: "a store JSON that isn't an object crashes or is spread into a new file",
  },
  {
    file: "seed.mjs",
    from: "const cliable = (name) => Boolean(name) && name !== \"default\" && !name.startsWith(\"-\") && !name.includes(\"/\")",
    to: "const cliable = (name) => Boolean(name) && name !== \"default\" && !name.startsWith(\"-\")",
    why: "suggests a provider/model name as a bare argument, which magpie reads as a reference",
  },
  {
    file: "seed.mjs",
    from: "const cliable = (name) => Boolean(name) && name !== \"default\" && !name.startsWith(\"-\") && !name.includes(\"/\")",
    to: "const cliable = (name) => Boolean(name) && !name.startsWith(\"-\") && !name.includes(\"/\")",
    why: "suggests \"default\" as a model name, which resets the agent",
  },
  {
    file: "seed.mjs",
    from: "const cliable = (name) => Boolean(name) && name !== \"default\" && !name.startsWith(\"-\") && !name.includes(\"/\")",
    to: "const cliable = (name) => Boolean(name) && name !== \"default\" && !name.includes(\"/\")",
    why: "suggests a name with a leading dash, which magpie reads as a flag",
  },
  {
    file: "seed.mjs",
    from: "const drift = added.length > 0 || droppable.length > 0 || relabeled > 0 || providerMissing || providerMoved",
    to: "const drift = added.length > 0 || relabeled > 0 || providerMissing || providerMoved",
    why: "--check calls a store in step while --prune would still drop entries from it",
  },
  {
    file: "seed.mjs",
    from: "process.exit(drift ? 1 : 0)",
    to: "process.exit(changed ? 1 : 0)",
    why: "--check exits 0 while a recorded entry is missing from the catalog",
  },
  {
    file: "seed.mjs",
    from: "const before = at === -1 ? null : providers[at]",
    to: "const before = null",
    why: "a provider that points at an old gateway is reported as in step",
  },
  {
    file: "seed.mjs",
    from: "const selected = readTitle()\n  if (!selected.ok) {",
    to: "const selected = readTitle()\n  if (false) {",
    why: "writes the store while Cowork's selection can't be read",
  },
  {
    file: "seed.mjs",
    from: "if (adopt) {\n      console.error(`no ${listPath}",
    to: "if (false) {\n      console.error(`no ${listPath}",
    why: "--remove guesses from a missing record instead of refusing",
  },
  {
    file: "seed.mjs",
    from: "if (adopted) writeList(nextSeeded)",
    to: "if (false) writeList(nextSeeded)",
    why: "a rebuilt record is never saved, so a later --remove refuses forever",
  },
  {
    file: "seed.mjs",
    from: "if (!Array.isArray(store.customModels) && \"customModels\" in store) {",
    to: "if (false) {",
    why: "writes over a customModels Cowork (or another agent) mangled into an object",
  },
  {
    file: "seed.mjs",
    from: "if (!Array.isArray(store.customModelProviders) && \"customModelProviders\" in store) {",
    to: "if (false) {",
    why: "replaces a mangled provider list and drops providers the user made",
  },
  {
    file: "seed.mjs",
    from: "} else if (selected.value && gone.some((m) => [m.displayName, m.model, m.id].includes(selected.value))) {",
    to: "} else if (false) {",
    why: "--remove takes out the model Cowork is on without saying why it will fall back",
  },
  {
    file: "seed.mjs",
    from: "const held = droppable.filter((m) => !pruned.includes(m.id)).map((m) => m.id)",
    to: "const held = []",
    why: "records that --prune would drop something but never says so",
  },
  {
    file: "seed.mjs",
    from: "if (seeded === null && existsSync(listPath)) {",
    to: "if (false) {",
    why: "guesses after an unreadable record instead of stopping",
  },
  {
    file: "seed.mjs",
    from: "if (adopt) {\n    seeded = adoptSeeded(store, catalog)",
    to: "if (false) {\n    seeded = adoptSeeded(store, catalog)",
    why: "skips rebuilding a missing record, so its entries are never managed again",
  },
  {
    file: "seed.mjs",
    from: "if (m.displayName === selected) renamed = m.model",
    to: "if (false) renamed = m.model",
    why: "renames the entry Cowork is on and leaves the selection pointing at the old name",
  },
]

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
for (const f of ["package.json", "cowork.agent.js", "seed.mjs", "test"]) {
  cpSync(join(SRC, f), join(SCRATCH, f), { recursive: true })
}

let loose = 0
for (const m of MUTATIONS) {
  const p = join(SCRATCH, m.file)
  const original = readFileSync(p, "utf8")
  if (!original.includes(m.from)) {
    console.log(`ANCHOR GONE  ${m.file}: ${m.from}`)
    loose++
    continue
  }
  writeFileSync(p, original.replace(m.from, m.to), "utf8")
  const r = spawnSync(process.execPath, ["--test"], { cwd: SCRATCH, encoding: "utf8" })
  const red = r.status !== 0
  if (!red) loose++
  console.log(`${red ? "RED " : "GREEN (no guard!)"} ${m.file}: ${m.why}`)
  writeFileSync(p, original, "utf8")
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(loose ? `\n${loose} mutation(s) survived` : "\nall mutations caught")
process.exit(loose ? 1 : 0)
