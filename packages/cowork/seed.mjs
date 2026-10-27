#!/usr/bin/env node
// One-time wiring for Cowork: copy magpie's model catalog into the store Cowork
// reads its models from (~/.codely/settings.json). Cowork picks a model by the
// name it shows in its list, so the entries written here are named by the magpie
// model id — that is the string `magpie cowork <model>` puts in ide-settings.json.
// What this package wrote is recorded in a sidecar next to the store: an entry's
// `providerId` being "magpie" is not the same question, because a user can add
// their own model under that provider in Cowork and nothing entitles us to prune it.
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { pathToFileURL } from "node:url"

export const PROVIDER_ID = "magpie"

export function expand(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p
}

// Cowork's home is movable — Settings has a "Codely Home Location" picker that
// writes CODELY_CLI_HOME after copying the data — and the terminal `codely` keeps
// its own home (~/.codely-cli) whose models live in a different file with a
// different shape. ide-settings.json is what marks the desktop app's home, so a
// stale CODELY_CLI_HOME pointing at some other directory cannot move a seed into
// a store nothing reads.
export function codelyHome(env = process.env, home = homedir()) {
  const at = (p) => (p === "~" ? home : /^~[\\/]/.test(p) ? join(home, p.slice(1)) : p)
  const candidates = env.CODELY_CLI_HOME ? [at(env.CODELY_CLI_HOME), join(home, ".codely")] : [join(home, ".codely")]
  return candidates.find((d) => existsSync(join(d, "ide-settings.json"))) || candidates[candidates.length - 1]
}

// The backup records the store once, before this script first writes it; a later
// run must not replace it with an already-seeded store.
export function backupNeeded(storePath, bakPath) {
  return existsSync(storePath) && !existsSync(bakPath)
}

// --gateway <url> --store <path>; a flag with no value after it takes the default,
// so `--check` on its own is never read as a value.
export function opt(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return dflt
  const v = argv[i + 1]
  return v && !v.startsWith("--") ? v : dflt
}

export function provider(baseUrl) {
  return {
    id: PROVIDER_ID,
    name: "magpie",
    baseUrl,
    apiKey: "magpie-cowork",
    authType: "openai",
  }
}

export function entry(m) {
  return {
    id: `${PROVIDER_ID}:${m.id}`,
    model: m.id,
    providerId: PROVIDER_ID,
    // Cowork's picker shows this and stores it as the session's model title, and
    // the title is the one string magpie's agent plugin can write — so it has to
    // be the model id, not a prettier label, or the switch lands on nothing.
    displayName: m.id,
    authType: "openai",
    roles: ["model"],
    wireApi: "chat",
    contextLength: m.context_length || 8192,
    supportsMultimodal: !!(m.modalities && (m.modalities.input || []).includes("image")),
  }
}

export function seedFile(storePath) {
  return `${storePath}.magpie-seeded`
}

// null: no sidecar to read. An unreadable one is an error the caller refuses on,
// because guessing is exactly what drops someone's own model.
export function loadSeeded(path) {
  if (!existsSync(path)) return null
  try {
    const ids = JSON.parse(readFileSync(path, "utf8"))
    return Array.isArray(ids) ? new Set(ids) : null
  } catch {
    return null
  }
}

// A store written by an older version of this script, before the record existed,
// is adopted once: only entries under our own provider, titled by their model id
// (the shape this script writes) and still offered by magpie. A provider that
// merely points at magpie's address, or an entry the user named themselves, is
// not ours to claim.
export function adoptSeeded(store, catalog) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const ids = new Set(catalog.map((m) => m.id))
  return new Set(models
    .filter((m) => m && m.providerId === PROVIDER_ID && m.displayName === m.model && ids.has(m.model))
    .map((m) => m.id))
}

// null means "no selection", not "could not read it": renaming or pruning while
// the title is unreadable would leave Cowork pointing at nothing.
export function readTitleFile(path) {
  if (!existsSync(path)) return { ok: true, value: null }
  try {
    const ide = JSON.parse(readFileSync(path, "utf8"))
    if (!ide || typeof ide !== "object" || Array.isArray(ide)) return { ok: false, value: null }
    const title = ide.defaultChatModelTitle
    if (title != null && typeof title !== "string") return { ok: false, value: null }
    return { ok: true, value: title ?? null }
  } catch {
    return { ok: false, value: null }
  }
}

// A value magpie's CLI can write as-is. A slash makes it a provider/model
// reference, a leading dash makes it a flag, and "default" resets the agent.
const cliable = (name) => Boolean(name) && name !== "default" && !name.startsWith("-") && !name.includes("/")

// The only words that tell a user their switch will fall back in silence, so they
// are worth a test of their own.
export function unreachableNote(rows) {
  if (!rows.length) return ""
  const byName = rows.filter((r) => cliable(r.name))
  const inCowork = rows.filter((r) => !cliable(r.name))
  const parts = [`${rows.length} catalog models are listed under names that aren't the model id —
  \`magpie cowork <model id>\` won't select those (Cowork matches the name it shows, not the id)`]
  if (byName.length) {
    const shown = byName.slice(0, 3).map((r) => `\`magpie cowork ${JSON.stringify(r.name)}\` (${r.id})`).join(", ")
    parts.push(`pass the name instead: ${shown}${byName.length > 3 ? ", …" : ""}`)
  }
  if (inCowork.length) {
    const shown = inCowork.slice(0, 3).map((r) => `${r.id} (${JSON.stringify(r.name)})`).join(", ")
    parts.push(`pick these in Cowork instead — a slash or leading dash makes magpie read the name as a reference or a flag, and "default" resets the agent: ${shown}${inCowork.length > 3 ? ", …" : ""}`)
  }
  return parts.join(";\n  ")
}

// store: Cowork's settings.json object. catalog: magpie's /v1/models data.
// seeded: the entry ids this package wrote, from the record. opts.selected is the
// model Cowork is on right now, opts.prune allows a shrinking catalog to remove
// recorded entries. Nothing passed in is mutated.
export function plan(store, catalog, baseUrl, seeded = new Set(), opts = {}) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const providers = Array.isArray(store.customModelProviders) ? store.customModelProviders.slice() : []
  const ids = new Set(catalog.map((m) => m.id))
  const taken = new Set(models.map((m) => m && m.model))
  const selected = opts.selected ?? null

  // An entry that magpie no longer lists is often a catalog that is momentarily
  // short — an account resting, magpie starting — and deleting it empties
  // Cowork's picker. Nothing missing is deleted unless --prune says so; the entry
  // Cowork is on is never deleted, even then.
  // A record left by the pre-release commits also named entries under the user's
  // own provider, because that version claimed models by address. Whatever the
  // record says, an entry that is not under our provider is not ours to delete.
  const droppable = models.filter((m) => m && m.providerId === PROVIDER_ID && seeded.has(m.id) && !ids.has(m.model) &&
    m.id !== selected && m.model !== selected && m.displayName !== selected)
  const pruned = opts.prune ? droppable.map((m) => m.id) : []
  const held = droppable.filter((m) => !pruned.includes(m.id)).map((m) => m.id)

  // A catalog model whose entry is shown under another name is not selected by
  // `magpie cowork <model id>`: that writes the id, and Cowork looks up the name
  // it displays. Say which they are and the name to pass instead, rather than
  // letting the switch fall back in silence.
  const unreachable = catalog.filter((m) => {
    const here = models.filter((x) => x && x.model === m.id)
    return here.length > 0 && !here.some((x) => (x.displayName ?? x.model) === m.id || (x.providerId === PROVIDER_ID && seeded.has(x.id)))
  }).map((m) => ({
    id: m.id,
    name: models.find((x) => x && x.model === m.id && x.displayName && x.displayName !== m.id)?.displayName ?? m.id,
  }))

  let relabeled = 0
  let renamed = null
  const dropped = new Set(pruned)
  const kept = models
    .filter((m) => !(m && dropped.has(m.id)))
    .map((m) => {
      // only entries we wrote, and only ones we recorded: a name the user chose in
      // Cowork is theirs, and renaming it would leave their selection pointing nowhere
      if (!m || m.providerId !== PROVIDER_ID || !seeded.has(m.id) || m.displayName === m.model) return m
      relabeled++
      if (m.displayName === selected) renamed = m.model
      return { ...m, displayName: m.model }
    })
  const added = []
  for (const m of catalog) {
    if (taken.has(m.id)) continue
    added.push(m.id)
    kept.push(entry(m))
  }

  const at = providers.findIndex((p) => p && p.id === PROVIDER_ID)
  const before = at === -1 ? null : providers[at]
  if (at === -1) providers.push(provider(baseUrl))
  else providers[at] = provider(baseUrl)

  const nextSeeded = new Set([...seeded].filter((id) => !pruned.includes(id)))
  for (const m of catalog) if (added.includes(m.id)) nextSeeded.add(`${PROVIDER_ID}:${m.id}`)
  const providerMissing = at === -1
  const providerMoved = before !== null && before.baseUrl !== baseUrl
  const changed = added.length > 0 || pruned.length > 0 || relabeled > 0 || providerMissing || providerMoved
  // --check reports drift even when a normal run would write nothing: entries
  // held back for --prune are still a difference from the catalog.
  const drift = added.length > 0 || droppable.length > 0 || relabeled > 0 || providerMissing || providerMoved
  return {
    next: { ...store, customModels: kept, customModelProviders: providers },
    added, pruned, held, relabeled, renamed, unreachable, seeded: [...nextSeeded], changed, drift,
    provider: providerMissing ? "add" : providerMoved ? "repoint" : null,
  }
}

// The other way: take out exactly the recorded ids that are under our provider,
// and the provider only once nothing is left under it.
export function unplan(store, seeded = new Set()) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const providers = Array.isArray(store.customModelProviders) ? store.customModelProviders : []
  const ours = (m) => m && m.providerId === PROVIDER_ID && seeded.has(m.id)
  const removed = models.filter(ours).map((m) => m.id)
  const left = models.filter((m) => !ours(m))
  const stillOurs = left.some((m) => m && m.providerId === PROVIDER_ID)
  const nextProviders = stillOurs ? providers : providers.filter((p) => !(p && p.id === PROVIDER_ID))
  return {
    next: { ...store, customModels: left, customModelProviders: nextProviders },
    removed,
    leftBehind: left.filter((m) => m && m.providerId === PROVIDER_ID).map((m) => m.id),
    changed: removed.length > 0 || nextProviders.length !== providers.length,
  }
}

// Importing this file (the tests) must touch nothing: only `node seed.mjs` runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(`--${n}`)
  if (flag("help")) {
    console.log("usage: node seed.mjs [--gateway http://127.0.0.1:3425] [--store <home>/settings.json] [--check | --remove | --prune]")
    console.log("without --store the home is CODELY_CLI_HOME when it holds an ide-settings.json, else ~/.codely")
    process.exit(0)
  }

  const gateway = opt(argv, "gateway", "http://127.0.0.1:3425").replace(/\/$/, "")
  const storeFlag = opt(argv, "store", null)
  const home = codelyHome()
  const storePath = storeFlag ? expand(storeFlag) : join(home, "settings.json")
  const listPath = seedFile(storePath)
  const bakPath = `${storePath}.pre-magpie`
  const titlePath = join(dirname(storePath), "ide-settings.json")

  // A home Cowork has never run in is not one we get to guess: the store would
  // land where nothing reads it, or be overwritten on first launch, and the run
  // would still look like a success. --store is the user answering the question.
  if (!storeFlag && (!existsSync(home) || (!existsSync(storePath) && !existsSync(titlePath)))) {
    console.error(`Cowork has not run in ${home} — open it once, then re-run, or pass --store <home>/settings.json`)
    process.exit(2)
  }
  if (!storeFlag && home !== join(homedir(), ".codely")) {
    console.log(`Cowork's home is ${home}, not the default ~/.codely`)
    console.log("the plugin's own path is fixed at ~/.codely/ide-settings.json and cannot follow a moved home, so `magpie cowork <model>` won't reach Cowork — pick the model in Cowork instead")
  }
  // Naming the store is the only way a wrong guess at the home is noticed at all.
  if (!storeFlag) console.log(`store: ${storePath}`)

  const readStore = () => {
    if (!existsSync(storePath)) return {}
    let store
    try {
      store = JSON.parse(readFileSync(storePath, "utf8"))
    } catch {
      console.error(`${storePath} isn't readable JSON — Cowork may be writing it right now; try again, or restore ${bakPath}`)
      process.exit(2)
    }
    if (!store || typeof store !== "object" || Array.isArray(store)) {
      console.error(`${storePath} isn't a settings object — Cowork may be writing it right now; try again, or restore ${bakPath}`)
      process.exit(2)
    }
    if (!Array.isArray(store.customModels) && "customModels" in store) {
      console.error(`${storePath}'s customModels is not a list; a magpie agent may have written it oddly — restore ${bakPath} if you have it, or fix the file by hand. Nothing was written.`)
      process.exit(2)
    }
    if (!Array.isArray(store.customModelProviders) && "customModelProviders" in store) {
      console.error(`${storePath}'s customModelProviders is not a list; refusing to replace it and drop providers you made — restore ${bakPath} if you have it, or fix the file by hand. Nothing was written.`)
      process.exit(2)
    }
    return store
  }
  const writeList = (ids) => {
    writeFileSync(`${listPath}.tmp`, `${JSON.stringify(ids, null, 1)}\n`, "utf8")
    renameSync(`${listPath}.tmp`, listPath)
  }
  const writeStore = (next, seeded) => {
    if (backupNeeded(storePath, bakPath)) {
      copyFileSync(storePath, bakPath)
      console.log(`a copy of the store from before this run: ${bakPath}`)
    }
    // Cowork writes this file too, so land each new one in a single move
    writeFileSync(`${storePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    renameSync(`${storePath}.tmp`, storePath)
    // an empty record is kept: "nothing of ours" and "no record, guess" are
    // different answers, and only the first one is safe to act on
    writeList(seeded)
  }
  const readTitle = () => readTitleFile(titlePath)
  const heldNote = (n) => `${n} recorded entries aren't in the catalog right now; pass --prune to drop them`
  const writeTitle = (t) => {
    let ide = {}
    try {
      ide = JSON.parse(readFileSync(titlePath, "utf8"))
    } catch {
      console.error(`${titlePath} isn't readable JSON; leaving Cowork's selection alone — re-pick it once in Cowork`)
      return false
    }
    if (!ide || typeof ide !== "object" || Array.isArray(ide)) {
      console.error(`${titlePath} isn't a settings object; leaving Cowork's selection alone — re-pick it once in Cowork`)
      return false
    }
    ide.defaultChatModelTitle = t
    writeFileSync(`${titlePath}.tmp`, `${JSON.stringify(ide, null, 2)}\n`, "utf8")
    renameSync(`${titlePath}.tmp`, titlePath)
    return true
  }

  const store = readStore()
  let seeded = loadSeeded(listPath)
  if (seeded === null && existsSync(listPath)) {
    console.error(`${listPath} isn't a readable list of entry ids; refusing to guess which entries magpie wrote`)
    process.exit(2)
  }
  // No record, but a store magpie has written before: seed may rebuild the
  // record once it sees the catalog, because adoption needs to know which models
  // magpie still offers. --remove has no such evidence, so it refuses instead.
  const adopt = seeded === null && existsSync(bakPath)

  if (flag("remove")) {
    if (adopt) {
      console.error(`no ${listPath}, so this run can't tell which entries magpie wrote — run \`node seed.mjs\` once (magpie running) to rebuild it, then --remove. Nothing was written.`)
      process.exit(2)
    }
    const { next, removed, leftBehind, changed } = unplan(store, seeded ?? new Set())
    if (flag("check")) {
      console.log(changed ? `still seeded: ${removed.length} of magpie's models in ${storePath}` : "nothing of magpie's left in the store")
      process.exit(changed ? 1 : 0)
    }
    if (!changed) {
      console.log(`nothing of magpie's to remove${leftBehind.length ? ` (${leftBehind.length} entries under "${PROVIDER_ID}" weren't written by this script and stay)` : ""}`)
      process.exit(0)
    }
    const selected = readTitle()
    const gone = (Array.isArray(store.customModels) ? store.customModels : [])
      .filter((m) => m && removed.includes(m.id))
    writeStore(next, [])
    console.log(`took magpie out of ${storePath}: ${removed.length} models${leftBehind.length ? `, left ${leftBehind.length} you added under it yourself` : ""}`)
    if (!selected.ok) {
      console.log(`${titlePath} isn't readable JSON; if Cowork falls back after this, pick a model in it once`)
    } else if (selected.value && gone.some((m) => [m.displayName, m.model, m.id].includes(selected.value))) {
      console.log(`Cowork was on ${JSON.stringify(selected.value)}, which just went away — pick a model in Cowork or it falls back in silence`)
    }
    process.exit(0)
  }

  // A title that can't be read is not "no selection": renaming or pruning while
  // Cowork is on something would leave the app pointing at a name that's gone.
  const selected = readTitle()
  if (!selected.ok) {
    console.error(`${titlePath} isn't readable JSON; refusing to change the store while Cowork's selection can't be read — re-pick it once in Cowork, or restore the file. Nothing was written.`)
    process.exit(2)
  }

  const res = await fetch(`${gateway}/v1/models`)
  if (!res.ok) {
    console.error(`magpie's catalog came back ${res.status} from ${gateway}/v1/models — is magpie running?`)
    process.exit(2)
  }
  const catalog = (await res.json()).data
  if (!Array.isArray(catalog) || !catalog.length) {
    console.error("magpie's catalog is empty")
    process.exit(2)
  }
  let adopted = false
  if (adopt) {
    seeded = adoptSeeded(store, catalog)
    adopted = true
    console.log(seeded.size
      ? `no ${listPath}: adopting the ${seeded.size} entries under "${PROVIDER_ID}" titled by their model id`
      : `no ${listPath}: nothing under "${PROVIDER_ID}" is titled by a catalog model id, so nothing is adopted`)
  }
  if (seeded === null) seeded = new Set()

  const { next, added, pruned, held, relabeled, renamed, unreachable, provider, seeded: nextSeeded, changed, drift } =
    plan(store, catalog, `${gateway}/v1`, seeded, { prune: flag("prune"), selected: selected.value })

  if (unreachable.length) console.log(unreachableNote(unreachable))

  if (flag("check")) {
    if (drift) {
      const parts = []
      if (added.length) parts.push(`+${added.length} to add`)
      if (pruned.length + held.length) parts.push(`-${pruned.length + held.length} to drop${held.length ? ` (${held.length} held until --prune)` : ""}`)
      if (relabeled) parts.push(`~${relabeled} to relabel`)
      if (provider) parts.push(`provider to ${provider}`)
      console.log(`drift: ${parts.join(", ")}`)
    } else {
      console.log(`in step: ${catalog.length} catalog models, ${next.customModels.length} in Cowork, nothing to write`)
    }
    process.exit(drift ? 1 : 0)
  }
  if (!changed) {
    console.log(`in step: nothing to write (${next.customModels.length} models in Cowork)`)
    if (adopted) writeList(nextSeeded)
    if (held.length) console.log(heldNote(held.length))
    process.exit(0)
  }

  writeStore(next, nextSeeded)
  if (renamed && writeTitle(renamed)) {
    console.log(`Cowork was on the entry we just renamed; its selection now says ${renamed}`)
  }
  console.log(`wrote ${storePath}: +${added.length} magpie models, -${pruned.length} stale, ~${relabeled} relabelled, ${next.customModels.length} total`)
  if (held.length) console.log(heldNote(held.length))
}
