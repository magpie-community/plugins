import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { agent } from "../cowork.agent.js"
import { adoptSeeded, backupNeeded, codelyHome, entry, loadSeeded, opt, plan, provider, readTitleFile, seedFile, unplan, unreachableNote, PROVIDER_ID } from "../seed.mjs"

const SEED = fileURLToPath(new URL("../seed.mjs", import.meta.url))

const GLM = {
  id: "group/auto-glm-5-3-flash",
  display_name: "GLM-5.3-Flash",
  magpie_label: "GLM-5.3-Flash · routing group",
  context_length: 1000000,
  modalities: { input: ["text", "image"] },
}
const TEXT = { id: "workbuddy/deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash", context_length: 262144, modalities: { input: ["text"] } }
const V1 = "http://127.0.0.1:3425/v1"

// spawnSync would block the event loop the catalog server runs on, so gateway
// tests use the async spawn.
const runSeed = (args, env = process.env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SEED, ...args], { env })
  let stdout = "", stderr = ""
  child.stdout.on("data", (d) => (stdout += d))
  child.stderr.on("data", (d) => (stderr += d))
  child.on("close", (status) => resolve({ status, stdout, stderr }))
})

const catalogServer = async (t, models) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ data: models }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

test("Cowork is pointed at the field it starts a session on", () => {
  assert.equal(agent.id, "cowork")
  assert.equal(agent.config, "~/.codely/ide-settings.json")
  assert.equal(agent.format, "json")
  assert.equal(agent.model, "defaultChatModelTitle")
  assert.equal(agent.dir, "~/.codely")
})

test("carries the vendor's own icon, in the agent and in the package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.ok(agent.icon.startsWith("data:image/png;base64,"), "a PNG inlined, so it renders before the repo exists")
  assert.equal(pkg.magpie.icon, agent.icon)
  assert.ok(pkg.files.includes("icon.png"), "the same icon shipped as a file")
})

test("a catalog model becomes the shape Cowork's own store uses", () => {
  assert.deepEqual(entry(GLM), {
    id: `${PROVIDER_ID}:group/auto-glm-5-3-flash`,
    model: "group/auto-glm-5-3-flash",
    providerId: PROVIDER_ID,
    displayName: "group/auto-glm-5-3-flash",
    authType: "openai",
    roles: ["model"],
    wireApi: "chat",
    contextLength: 1000000,
    supportsMultimodal: true,
  })
  assert.equal(entry(TEXT).supportsMultimodal, false)
  assert.equal(entry(GLM).displayName, entry(GLM).model, "the picker title is the one string magpie can write")
})

test("the store keeps its own models and gets one entry per new catalog model", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", name: "the user's own", baseUrl: "https://example.test/v1" }],
    customModels: [{ id: "custom-provider:mine", model: "mine", providerId: "custom-provider" }],
    migratedFromOldFormat: true,
  }
  const { next, added } = plan(store, [GLM, TEXT], V1)
  assert.equal(next.migratedFromOldFormat, true)
  assert.equal(next.customModels[0].id, "custom-provider:mine")
  assert.deepEqual(added, [GLM.id, TEXT.id])
  assert.ok(Array.isArray(next.customModels))
  assert.equal(next.customModels.length, 3)
  assert.equal(next.customModelProviders.length, 2)
  assert.deepEqual(next.customModelProviders[1], provider(V1))
})

test("a model Cowork already has is not added twice, by any provider", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", name: "x", baseUrl: V1 }],
    customModels: [{ id: "custom-provider:glm", model: GLM.id, providerId: "custom-provider" }],
  }
  const { next, added } = plan(store, [GLM], V1)
  assert.deepEqual(added, [])
  assert.equal(next.customModels.length, 1)
})

test("an entry under the user's own provider keeps its name, and the tool names the title to pass", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", name: "magpie", baseUrl: V1 }],
    customModels: [{ id: `custom-provider:${GLM.id}`, model: GLM.id, providerId: "custom-provider", displayName: "GLM-5.3-Flash · routing group" }],
  }
  const seeded = new Set([`custom-provider:${GLM.id}`])
  const { next, added, relabeled, unreachable, changed } = plan(store, [GLM], V1, seeded)
  assert.deepEqual(added, [], "no duplicate entry for a model Cowork can already reach")
  assert.equal(relabeled, 0, "a name under their provider stays theirs, even if a record lists it")
  assert.equal(next.customModels[0].displayName, "GLM-5.3-Flash · routing group")
  assert.equal(next.customModels[0].id, `custom-provider:${GLM.id}`, "its id stays, sessions may name it")
  assert.deepEqual(unreachable, [{ id: GLM.id, name: "GLM-5.3-Flash · routing group" }], "said out loud instead of a silent fallback")
  assert.equal(changed, true, "magpie's own provider is still missing")
})

test("a model whose entry is already titled by its id is reachable under any provider", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", baseUrl: V1 }],
    customModels: [{ id: `custom-provider:${GLM.id}`, model: GLM.id, providerId: "custom-provider", displayName: GLM.id }],
  }
  const { unreachable, relabeled, added } = plan(store, [GLM], V1, new Set())
  assert.deepEqual(unreachable, [])
  assert.equal(relabeled, 0)
  assert.deepEqual(added, [], "and still no second entry for the same model")
})

test("a recorded entry of ours renamed in Cowork is relabelled, not scolded", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: V1 }],
    customModels: [{ id: `${PROVIDER_ID}:${GLM.id}`, model: GLM.id, providerId: PROVIDER_ID, displayName: "My Name" }],
  }
  const { unreachable, relabeled } = plan(store, [GLM], V1, new Set([`${PROVIDER_ID}:${GLM.id}`]), { selected: "My Name" })
  assert.equal(relabeled, 1)
  assert.deepEqual(unreachable, [], "the same run puts the id back, so the id selects it afterwards")
})

test("an unrecorded entry the user added under magpie keeps its name and is named in the note", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: V1 }],
    customModels: [{ id: `${PROVIDER_ID}:${GLM.id}`, model: GLM.id, providerId: PROVIDER_ID, displayName: "My Name" }],
  }
  const { next, relabeled, unreachable } = plan(store, [GLM], V1, new Set())
  assert.equal(relabeled, 0)
  assert.equal(next.customModels[0].displayName, "My Name")
  assert.deepEqual(unreachable, [{ id: GLM.id, name: "My Name" }])
})

test("the note gives the title to pass for models the id can't select, and stays quiet when none", () => {
  assert.equal(unreachableNote([]), "")
  const rows = [
    { id: "a/one", name: "One" },
    { id: "a/two", name: "Two" },
    { id: "a/three", name: "Three" },
    { id: "a/four", name: "Four" },
  ]
  const n = unreachableNote(rows)
  assert.match(n, /listed under names that aren't the model id/, n)
  assert.ok(n.includes('`magpie cowork "One"` (a/one)') && n.includes('`magpie cowork "Three"` (a/three)'), n)
  assert.ok(!n.includes("Four"), "three rows is enough to go on")
  assert.match(n, /, …/, "and it says there are more")
  assert.equal(unreachableNote([rows[0]]).includes("…"), false, "no ellipsis for one")
  assert.match(n, /won't select those \(Cowork matches the name it shows, not the id\)/, "says why the id is not the title")
})

test("a name magpie can't take on its command line is answered with pick it in Cowork", () => {
  const n = unreachableNote([
    { id: "a/one", name: "One" },
    { id: "b/two", name: "a/two" },
    { id: "c/three", name: "default" },
    { id: "d/four", name: "-x" },
  ])
  assert.ok(n.includes('`magpie cowork "One"` (a/one)'), n)
  for (const name of ["a/two", "default", "-x"]) {
    assert.ok(!n.includes(`magpie cowork "${name}"`), `no command that magpie would misread: ${n}`)
  }
  assert.match(n, /pick these in Cowork instead/, n)
  assert.match(n, /a slash or leading dash makes magpie read the name as a reference or a flag/, n)
})

test("an entry the user named themselves is never renamed, and magpie's write follows it", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", baseUrl: V1 }],
    customModels: [{ id: `custom-provider:${GLM.id}`, model: GLM.id, providerId: "custom-provider", displayName: "My Two" }],
  }
  const { next, relabeled, renamed } = plan(store, [GLM], V1, new Set(), { selected: "My Two" })
  assert.equal(relabeled, 0)
  assert.equal(renamed, null)
  assert.equal(next.customModels[0].displayName, "My Two")
})

test("renaming the entry Cowork is on moves the selection with it", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: V1, name: "magpie", apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [{ id: `${PROVIDER_ID}:${GLM.id}`, model: GLM.id, providerId: PROVIDER_ID, displayName: "GLM-5.3-Flash · routing group" }],
  }
  const { renamed } = plan(store, [GLM], V1, new Set([`${PROVIDER_ID}:${GLM.id}`]), { selected: "GLM-5.3-Flash · routing group" })
  assert.equal(renamed, GLM.id)
})

test("a model the user wired to their own endpoint keeps its own name", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", baseUrl: "https://their.own.test/v1" }],
    customModels: [{ id: `custom-provider:${GLM.id}`, model: GLM.id, providerId: "custom-provider", displayName: "mine" }],
  }
  const { next, relabeled, changed } = plan(store, [GLM], V1)
  assert.equal(relabeled, 0)
  assert.equal(changed, true, "magpie's own provider is still missing")
  assert.equal(next.customModels[0].displayName, "mine")
})

test("a recorded model magpie no longer offers is dropped with --prune, and nothing else moves", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, name: "magpie", baseUrl: V1, apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [
      { id: "custom-provider:mine", model: "mine", providerId: "custom-provider" },
      { id: `${PROVIDER_ID}:gone`, model: "gone", providerId: PROVIDER_ID },
      { id: `${PROVIDER_ID}:${TEXT.id}`, model: TEXT.id, providerId: PROVIDER_ID },
    ],
  }
  const seeded = new Set([`${PROVIDER_ID}:gone`, `${PROVIDER_ID}:${TEXT.id}`])
  const { next, added, pruned } = plan(store, [TEXT], V1, seeded, { prune: true })
  assert.deepEqual(pruned, [`${PROVIDER_ID}:gone`])
  assert.deepEqual(added, [])
  assert.deepEqual(next.customModels.map((m) => m.id), ["custom-provider:mine", `${PROVIDER_ID}:${TEXT.id}`])
  assert.equal(seeded.has(`${PROVIDER_ID}:gone`), true, "the set handed in is not edited")
})

test("a catalog shorter than the record holds its pruning until --prune", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: V1, name: "magpie", apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [
      { id: `${PROVIDER_ID}:gone`, model: "gone", providerId: PROVIDER_ID, displayName: "gone" },
      { id: `${PROVIDER_ID}:${TEXT.id}`, model: TEXT.id, providerId: PROVIDER_ID, displayName: TEXT.id },
    ],
  }
  const seeded = new Set([`${PROVIDER_ID}:gone`, `${PROVIDER_ID}:${TEXT.id}`])
  const held = plan(store, [TEXT], V1, seeded)
  assert.deepEqual(held.pruned, [], "an account resting or magpie still starting must not empty the picker")
  assert.deepEqual(held.held, [`${PROVIDER_ID}:gone`])
  assert.equal(held.changed, false)
  assert.equal(held.drift, true, "--check still shows the difference from the catalog")
  const dropped = plan(store, [TEXT], V1, seeded, { prune: true })
  assert.deepEqual(dropped.pruned, [`${PROVIDER_ID}:gone`])
  assert.deepEqual(dropped.held, [])
})

test("a recorded entry missing from the catalog is held even when the lengths match", () => {
  // the old guard compared catalog.length with the record size, so this pair
  // looked like no shrink at all and the missing entry was deleted unasked
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: V1, name: "magpie", apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [
      { id: `${PROVIDER_ID}:a/one`, model: "a/one", providerId: PROVIDER_ID, displayName: "a/one" },
      { id: `${PROVIDER_ID}:a/two`, model: "a/two", providerId: PROVIDER_ID, displayName: "a/two" },
      { id: `${PROVIDER_ID}:a/three`, model: "a/three", providerId: PROVIDER_ID, displayName: "a/three" },
    ],
  }
  const seeded = new Set([`${PROVIDER_ID}:a/one`, `${PROVIDER_ID}:a/three`])
  const catalog = [{ id: "a/one" }, { id: "a/two" }]
  const p = plan(store, catalog, V1, seeded)
  assert.deepEqual(p.added, [], "nothing new, so the only question is the missing entry")
  assert.deepEqual(p.pruned, [])
  assert.deepEqual(p.held, [`${PROVIDER_ID}:a/three`])
  assert.equal(p.changed, false)
  assert.equal(p.drift, true)
  assert.deepEqual(plan(store, catalog, V1, seeded, { prune: true }).pruned, [`${PROVIDER_ID}:a/three`])
})

test("a short catalog never drops the selected entry", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: V1, name: "magpie", apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [{ id: `${PROVIDER_ID}:a/three`, model: "a/three", providerId: PROVIDER_ID, displayName: "a/three" }],
  }
  const seeded = new Set([`${PROVIDER_ID}:a/three`])
  for (const prune of [false, true]) {
    const p = plan(store, [{ id: "a/one" }], V1, seeded, { prune, selected: "a/three" })
    assert.deepEqual(p.pruned, [], `prune=${prune}: the catalog is short, the selection must survive`)
    assert.ok(p.next.customModels.some((m) => m.id === `${PROVIDER_ID}:a/three`), `prune=${prune}`)
  }
})

test("the model Cowork is on is never pruned, even with --prune", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: V1, name: "magpie", apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [
      { id: `${PROVIDER_ID}:gone`, model: "gone", providerId: PROVIDER_ID, displayName: "gone" },
      { id: `${PROVIDER_ID}:${TEXT.id}`, model: TEXT.id, providerId: PROVIDER_ID, displayName: TEXT.id },
    ],
  }
  const seeded = new Set([`${PROVIDER_ID}:gone`])
  const { pruned, next } = plan(store, [TEXT], V1, seeded, { prune: true, selected: "gone" })
  assert.deepEqual(pruned, [])
  assert.ok(next.customModels.some((m) => m.id === `${PROVIDER_ID}:gone`), "deleting it would drop the live session silently")
})

test("a model the user added and named under magpie's own provider keeps that name", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, name: "magpie", baseUrl: V1, apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [{ id: `${PROVIDER_ID}:mine`, model: "mine", providerId: PROVIDER_ID, displayName: "My Fave" }],
  }
  const { relabeled, next } = plan(store, [GLM], V1, new Set())
  assert.equal(relabeled, 0, "it is under our provider, but we never wrote it")
  assert.equal(next.customModels.find((m) => m.model === "mine").displayName, "My Fave")
})

test("a model the user added under magpie's own provider survives a shorter catalog", () => {
  const own = { id: "magpie:my-own", model: "my-own", providerId: PROVIDER_ID, displayName: "my-own" }
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, name: "magpie", baseUrl: V1, apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [own, { id: `${PROVIDER_ID}:${TEXT.id}`, model: TEXT.id, providerId: PROVIDER_ID, displayName: TEXT.id }],
  }
  const seeded = new Set([`${PROVIDER_ID}:${TEXT.id}`])
  const { next, pruned, changed } = plan(store, [], V1, seeded, { prune: true })
  assert.deepEqual(pruned, [`${PROVIDER_ID}:${TEXT.id}`], "what we wrote and magpie dropped")
  assert.ok(next.customModels.some((m) => m.id === "magpie:my-own"), "what they added under it stays")
  assert.equal(changed, true)
  const out = unplan(next, seeded)
  assert.ok(out.next.customModels.some((m) => m.id === "magpie:my-own"))
  assert.ok(out.next.customModelProviders.some((p) => p.id === PROVIDER_ID), "the provider stays while their model still uses it")
  assert.deepEqual(out.leftBehind, ["magpie:my-own"])
})

test("a store Cowork has not filled in yet still comes out with lists", () => {
  const { next } = plan({ customModels: [], customModelProviders: [] }, [GLM], V1)
  assert.ok(Array.isArray(next.customModels))
  assert.ok(Array.isArray(next.customModelProviders))
  assert.equal(next.customModels.length, 1)
})

test("seeding twice writes nothing the second time", () => {
  const once = plan({}, [GLM, TEXT], V1)
  assert.equal(once.changed, true)
  assert.deepEqual(once.seeded, [`${PROVIDER_ID}:${GLM.id}`, `${PROVIDER_ID}:${TEXT.id}`])
  const twice = plan(once.next, [GLM, TEXT], V1, new Set(once.seeded))
  assert.equal(twice.changed, false)
  assert.deepEqual(twice.added, [])
  assert.deepEqual(twice.pruned, [])
})

test("a provider that is missing or points elsewhere is drift of its own", () => {
  const first = plan({}, [GLM], V1)
  assert.equal(first.provider, "add")
  assert.equal(first.drift, true)
  const moved = plan(first.next, [GLM], "http://127.0.0.1:9999/v1", new Set(first.seeded))
  assert.deepEqual(moved.added, [])
  assert.equal(moved.provider, "repoint")
  assert.equal(moved.changed, true)
  assert.equal(moved.drift, true)
  const settled = plan(first.next, [GLM], V1, new Set(first.seeded))
  assert.equal(settled.provider, null)
  assert.equal(settled.changed, false)
  assert.equal(settled.drift, false)
})

test("a selection that can't be read is not an empty selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-title-"))
  try {
    const title = join(dir, "ide-settings.json")
    assert.deepEqual(readTitleFile(title), { ok: true, value: null }, "no file is no selection")
    writeFileSync(title, "{ not json")
    assert.deepEqual(readTitleFile(title), { ok: false, value: null })
    writeFileSync(title, "[]")
    assert.deepEqual(readTitleFile(title), { ok: false, value: null }, "a list is not a settings object")
    writeFileSync(title, JSON.stringify({ defaultChatModelTitle: 7 }))
    assert.deepEqual(readTitleFile(title), { ok: false, value: null }, "a selection that isn't a string can't match an entry")
    writeFileSync(title, JSON.stringify({ defaultChatModelTitle: "x" }))
    assert.deepEqual(readTitleFile(title), { ok: true, value: "x" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("plan does not edit the store it was given", () => {
  const store = { customModelProviders: [], customModels: [{ id: "a", model: "a", providerId: "custom-provider" }] }
  const before = JSON.stringify(store)
  plan(store, [GLM], V1)
  assert.equal(JSON.stringify(store), before)
})

test("a flag with nothing after it is not read as its value", () => {
  assert.equal(opt(["--check"], "gateway", V1), V1)
  assert.equal(opt(["--gateway", "http://127.0.0.1:9999", "--check"], "gateway", V1), "http://127.0.0.1:9999")
  assert.equal(opt(["--gateway", "--check"], "gateway", V1), V1)
  assert.equal(opt([], "store", "~/.codely/settings.json"), "~/.codely/settings.json")
})

const OWN = { id: "custom-provider:mine", model: "mine", providerId: "custom-provider" }
const OWN_STORE = {
  customModelProviders: [{ id: "custom-provider", name: "the user's own", baseUrl: "https://example.test/v1" }],
  customModels: [OWN],
  migratedFromOldFormat: true,
}

test("what the package put in, it can take out again", () => {
  const p = plan(OWN_STORE, [GLM, TEXT], V1)
  assert.equal(p.next.customModels.length, 3)
  const { next, removed, changed } = unplan(p.next, new Set(p.seeded))
  assert.deepEqual(removed, [`${PROVIDER_ID}:${GLM.id}`, `${PROVIDER_ID}:${TEXT.id}`])
  assert.equal(changed, true)
  assert.deepEqual(next.customModels, OWN_STORE.customModels)
  assert.deepEqual(next.customModelProviders, OWN_STORE.customModelProviders)
  assert.equal(next.migratedFromOldFormat, true)
})

test("taking magpie out of a store it never touched changes nothing", () => {
  const { next, removed, changed } = unplan(OWN_STORE)
  assert.equal(changed, false)
  assert.deepEqual(removed, [])
  assert.deepEqual(next.customModels, OWN_STORE.customModels)
})

test("the backup is only ever taken from a store magpie has not written yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-backup-"))
  try {
    const store = join(dir, "settings.json"), bak = `${store}.pre-magpie`
    assert.equal(backupNeeded(store, bak), false, "no store, nothing to keep")
    writeFileSync(store, "{}")
    assert.equal(backupNeeded(store, bak), true, "first write keeps the original")
    writeFileSync(bak, "{}")
    assert.equal(backupNeeded(store, bak), false, "a second write must not replace the original with a seeded store")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--remove takes out what the sidecar recorded and nothing the user added", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-remove-"))
  try {
    const store = join(dir, "settings.json")
    const p = plan(OWN_STORE, [GLM, TEXT], V1)
    p.next.customModels.push({ id: "magpie:my-own", model: "my-own", providerId: PROVIDER_ID, displayName: "my-own" })
    writeFileSync(store, JSON.stringify(p.next))
    writeFileSync(seedFile(store), JSON.stringify(p.seeded))

    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    const after = JSON.parse(readFileSync(store, "utf8"))
    assert.deepEqual(after.customModels.map((m) => m.id), ["custom-provider:mine", "magpie:my-own"])
    assert.ok(after.customModelProviders.some((x) => x.id === PROVIDER_ID), "their model still uses that provider")
    assert.match(r.stdout, /left 1 you added under it yourself/)
    assert.equal(existsSync(`${store}.pre-magpie`), true)
    assert.deepEqual(JSON.parse(readFileSync(seedFile(store), "utf8")), [], "an empty record, not no record")

    const again = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(again.status, 0)
    assert.match(again.stdout, /nothing of magpie's to remove/)
    assert.ok(JSON.parse(readFileSync(store, "utf8")).customModels.some((m) => m.id === "magpie:my-own"),
      "a second run must not eat what the first one left")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--remove refuses a store whose record is missing instead of guessing from the backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-adopt-"))
  try {
    const store = join(dir, "settings.json")
    writeFileSync(store, JSON.stringify(plan(OWN_STORE, [GLM, TEXT], V1).next))
    const before = readFileSync(store, "utf8")
    writeFileSync(`${store}.pre-magpie`, "{}")
    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /run `node seed\.mjs` once/)
    assert.equal(readFileSync(store, "utf8"), before, "nothing was written")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("seed rebuilds a missing record from entries shaped like ours, and --remove keeps the rest", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-adopt-seed-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, "settings.json")
  const gateway = await catalogServer(t, [GLM, TEXT])
  // the store's provider already points at this gateway, so the only thing the
  // run has to do is rebuild the record
  const mixed = plan(OWN_STORE, [GLM], `${gateway}/v1`).next
  mixed.customModels.push(
    { id: `${PROVIDER_ID}:mine`, model: "mine", providerId: PROVIDER_ID, displayName: "My Fave" },
    { id: `${PROVIDER_ID}:pretty`, model: TEXT.id, providerId: PROVIDER_ID, displayName: "Pretty" },
  )
  writeFileSync(store, JSON.stringify(mixed))
  writeFileSync(`${store}.pre-magpie`, "{}")
  const seed = await runSeed(["--store", store, "--gateway", gateway])
  assert.equal(seed.status, 0, seed.stderr)
  assert.match(seed.stdout, /adopting the 1 entries under "magpie" titled by their model id/)
  assert.deepEqual(JSON.parse(readFileSync(seedFile(store), "utf8")), [`${PROVIDER_ID}:${GLM.id}`],
    "ours only, not the entry the user named")
  const out = await runSeed(["--store", store, "--remove"])
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(JSON.parse(readFileSync(store, "utf8")).customModels.map((m) => m.id).sort(),
    ["custom-provider:mine", `${PROVIDER_ID}:mine`, `${PROVIDER_ID}:pretty`].sort())
})

test("relabelling the entry Cowork is on moves the saved title with it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-relabel-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, "settings.json")
  const gateway = await catalogServer(t, [GLM])
  const id = `${PROVIDER_ID}:${GLM.id}`
  writeFileSync(store, JSON.stringify({
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: `${gateway}/v1`, name: "magpie", apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [{ id, model: GLM.id, providerId: PROVIDER_ID, displayName: "Pretty Label" }],
  }))
  writeFileSync(seedFile(store), JSON.stringify([id]))
  writeFileSync(join(dir, "ide-settings.json"), JSON.stringify({ defaultChatModelTitle: "Pretty Label", other: true }))
  const r = await runSeed(["--store", store, "--gateway", gateway])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(readFileSync(store, "utf8")).customModels[0].displayName, GLM.id)
  const ide = JSON.parse(readFileSync(join(dir, "ide-settings.json"), "utf8"))
  assert.equal(ide.defaultChatModelTitle, GLM.id, "the selection follows the renamed entry")
  assert.equal(ide.other, true, "everything else in ide-settings.json is kept")
  assert.match(r.stdout, /selection now says/)
})

test("a user's own entry under magpie survives a real seed run and a real --remove", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-own-magpie-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, "settings.json")
  const gateway = await catalogServer(t, [GLM])
  const own = { id: "magpie:my-own", model: "my-own", providerId: PROVIDER_ID, displayName: "My Own" }
  writeFileSync(store, JSON.stringify({
    customModelProviders: [
      { id: "custom-provider", name: "their own", baseUrl: "https://their.own.test/v1" },
      { id: PROVIDER_ID, name: "magpie", baseUrl: `${gateway}/v1`, apiKey: "magpie-cowork", authType: "openai" },
    ],
    customModels: [{ id: "custom-provider:mine", model: "mine", providerId: "custom-provider" }, own],
  }))
  writeFileSync(join(dir, "ide-settings.json"), JSON.stringify({ defaultChatModelTitle: "My Own" }))

  const seeded = await runSeed(["--store", store, "--gateway", gateway])
  assert.equal(seeded.status, 0, seeded.stderr)
  let after = JSON.parse(readFileSync(store, "utf8"))
  assert.ok(after.customModels.some((m) => m.id === "magpie:my-own" && m.displayName === "My Own"),
    "the next seed run must not drop what they added under magpie and named themselves")
  assert.ok(after.customModels.some((m) => m.id === `${PROVIDER_ID}:${GLM.id}`))
  assert.deepEqual(JSON.parse(readFileSync(seedFile(store), "utf8")), [`${PROVIDER_ID}:${GLM.id}`],
    "the record names only what this run wrote")

  const removed = await runSeed(["--remove", "--store", store])
  assert.equal(removed.status, 0, removed.stderr)
  after = JSON.parse(readFileSync(store, "utf8"))
  assert.deepEqual(after.customModels.map((m) => m.id), ["custom-provider:mine", "magpie:my-own"])
  assert.ok(after.customModelProviders.some((p) => p.id === PROVIDER_ID), "their entry still uses the provider")
  assert.match(removed.stdout, /left 1 you added under it yourself/)
  assert.equal(JSON.parse(readFileSync(join(dir, "ide-settings.json"), "utf8")).defaultChatModelTitle, "My Own")
})

test("a real run against a short catalog keeps the selected entry, with or without --prune", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-short-catalog-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, "settings.json")
  const gateway = await catalogServer(t, [{ id: "a/one" }])
  const id = `${PROVIDER_ID}:a/three`
  writeFileSync(store, JSON.stringify({
    customModelProviders: [{ id: PROVIDER_ID, name: "magpie", baseUrl: `${gateway}/v1`, apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [{ id, model: "a/three", providerId: PROVIDER_ID, displayName: "a/three" }],
  }))
  writeFileSync(seedFile(store), JSON.stringify([id]))
  writeFileSync(join(dir, "ide-settings.json"), JSON.stringify({ defaultChatModelTitle: "a/three" }))

  for (const extra of [[], ["--prune"]]) {
    const r = await runSeed(["--store", store, "--gateway", gateway, ...extra])
    assert.equal(r.status, 0, r.stderr)
    const after = JSON.parse(readFileSync(store, "utf8"))
    assert.ok(after.customModels.some((m) => m.id === id), `extra=${extra}: the model Cowork is on must stay`)
    assert.equal(JSON.parse(readFileSync(join(dir, "ide-settings.json"), "utf8")).defaultChatModelTitle, "a/three")
  }
})

test("--remove says when it takes out the model Cowork is on", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-remove-sel-"))
  try {
    const store = join(dir, "settings.json")
    const p = plan(OWN_STORE, [GLM], V1)
    writeFileSync(store, JSON.stringify(p.next))
    writeFileSync(seedFile(store), JSON.stringify(p.seeded))
    writeFileSync(join(dir, "ide-settings.json"), JSON.stringify({ defaultChatModelTitle: GLM.id }))
    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /which just went away/, r.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a store whose lists were written as objects stops before anything is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-shape-"))
  try {
    for (const field of ["customModels", "customModelProviders"]) {
      const store = join(dir, `${field}.json`)
      const other = field === "customModels" ? "customModelProviders" : "customModels"
      writeFileSync(store, JSON.stringify({ [field]: { 0: { id: "x" } }, [other]: [] }))
      const before = readFileSync(store, "utf8")
      const r = spawnSync(process.execPath, [SEED, "--check", "--store", store], { encoding: "utf8" })
      assert.equal(r.status, 2)
      assert.match(r.stderr, new RegExp(`${field} is not a list`))
      assert.equal(readFileSync(store, "utf8"), before)
    }
    const nul = join(dir, "null.json")
    writeFileSync(nul, "null")
    const r = spawnSync(process.execPath, [SEED, "--check", "--store", nul], { encoding: "utf8" })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /isn't a settings object/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--check exits 1 while a recorded entry is held back, and 1 again once --prune would drop it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-check-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = join(dir, "settings.json")
  const gateway = await catalogServer(t, [GLM])
  writeFileSync(store, JSON.stringify({
    customModelProviders: [{ id: PROVIDER_ID, baseUrl: `${gateway}/v1`, name: "magpie", apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [
      { id: `${PROVIDER_ID}:${GLM.id}`, model: GLM.id, providerId: PROVIDER_ID, displayName: GLM.id },
      { id: `${PROVIDER_ID}:gone`, model: "gone", providerId: PROVIDER_ID, displayName: "gone" },
    ],
  }))
  writeFileSync(seedFile(store), JSON.stringify([`${PROVIDER_ID}:${GLM.id}`, `${PROVIDER_ID}:gone`]))
  const r = await runSeed(["--store", store, "--check", "--gateway", gateway])
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stdout, /drift: -1 to drop \(1 held until --prune\)/)
  const pruned = await runSeed(["--store", store, "--check", "--gateway", gateway, "--prune"])
  assert.equal(pruned.status, 1)
  assert.match(pruned.stdout, /drift: -1 to drop\s*$/)
})

test("an unreadable selection stops before the catalog is fetched", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-title-cli-"))
  try {
    const store = join(dir, "settings.json")
    writeFileSync(store, "{}")
    writeFileSync(join(dir, "ide-settings.json"), "{ not json")
    const r = spawnSync(process.execPath, [SEED, "--check", "--store", store, "--gateway", "http://127.0.0.1:9"], { encoding: "utf8" })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /selection can't be read/)
    assert.doesNotMatch(r.stderr, /is magpie running/, "it stopped before going to the gateway")
    assert.equal(readFileSync(store, "utf8"), "{}")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("with no record and no backup, a store we never wrote is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-noadopt-"))
  try {
    const store = join(dir, "settings.json")
    writeFileSync(store, JSON.stringify({
      customModelProviders: [{ id: PROVIDER_ID, name: "my-magpie", baseUrl: V1, apiKey: "k", authType: "openai" }],
      customModels: [
        { id: "magpie:a/two", model: "a/two", providerId: PROVIDER_ID, displayName: "My Two" },
        { id: "magpie:my-local", model: "my-local", providerId: PROVIDER_ID, displayName: "My Local" },
      ],
    }))
    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /nothing of magpie's to remove/)
    assert.equal(JSON.parse(readFileSync(store, "utf8")).customModels.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a user provider pointed at magpie's address is never touched, seeded or pruned", () => {
  const store = {
    customModelProviders: [{ id: "my-magpie", name: "my-magpie", baseUrl: V1, apiKey: "k", authType: "openai" }],
    customModels: [
      { id: "my-magpie:a/two", model: "a/two", providerId: "my-magpie", displayName: "My Two" },
      { id: "my-magpie:my-local", model: "my-local", providerId: "my-magpie", displayName: "My Local" },
    ],
  }
  const first = plan(store, [{ id: "a/two" }, { id: "a/three" }], V1, new Set(), { selected: "My Two" })
  assert.deepEqual(first.pruned, [])
  assert.equal(first.relabeled, 0, "their names are theirs")
  assert.deepEqual(first.next.customModels.slice(0, 2).map((m) => m.displayName), ["My Two", "My Local"])
  assert.deepEqual(first.added, ["a/three"], "only the model missing from the store is appended, under our provider")
  const short = plan(first.next, [{ id: "a/one" }], V1, new Set(first.seeded), { selected: "My Two", prune: true })
  assert.deepEqual(short.pruned, [`${PROVIDER_ID}:a/three`], "what we wrote and magpie dropped, and nothing of theirs")
  assert.deepEqual(short.next.customModels.map((m) => m.id).sort(),
    [`${PROVIDER_ID}:a/one`, "my-magpie:a/two", "my-magpie:my-local"], "a/one is the new seed, their two are untouched")
})

test("a record that names entries under someone else's provider cannot destroy them", () => {
  // the pre-release version recorded entries it had claimed by address; a store
  // carrying that record must still keep them through --prune and --remove
  const theirs = { id: "custom-provider:a/gone", model: "a/gone", providerId: "custom-provider", displayName: "Pretty" }
  const store = {
    customModelProviders: [{ id: "custom-provider", baseUrl: V1 }, { id: PROVIDER_ID, baseUrl: V1, apiKey: "magpie-cowork" }],
    customModels: [
      theirs,
      { id: `${PROVIDER_ID}:a/two`, model: "a/two", providerId: PROVIDER_ID, displayName: "a/two" },
      { id: `${PROVIDER_ID}:a/retired`, model: "a/retired", providerId: PROVIDER_ID, displayName: "a/retired" },
    ],
  }
  const seeded = new Set(["custom-provider:a/gone", `${PROVIDER_ID}:a/two`, `${PROVIDER_ID}:a/retired`])
  const p = plan(store, [{ id: "a/two" }], V1, seeded, { prune: true })
  assert.deepEqual(p.pruned, [`${PROVIDER_ID}:a/retired`], "only our own retired entry goes")
  assert.equal(p.relabeled, 0, "their name is not ours to rewrite just because an old record listed it")
  assert.deepEqual(p.next.customModels.filter((m) => m.providerId === "custom-provider").map((m) => m.displayName), ["Pretty"])
  const { next, removed, changed } = unplan(store, seeded)
  assert.deepEqual(removed.sort(), [`${PROVIDER_ID}:a/retired`, `${PROVIDER_ID}:a/two`], "ours, both of them")
  assert.deepEqual(next.customModels, [theirs], "--remove leaves theirs alone")
  assert.equal(changed, true)
})

test("adoption claims only entries shaped like ours, under our provider, still in the catalog", () => {
  const store = {
    customModelProviders: [{ id: "my-magpie", baseUrl: V1 }, { id: PROVIDER_ID, baseUrl: V1 }],
    customModels: [
      { id: "my-magpie:a/two", model: "a/two", providerId: "my-magpie", displayName: "a/two" },
      { id: "my-magpie:my-local", model: "my-local", providerId: "my-magpie", displayName: "my-local" },
      { id: `${PROVIDER_ID}:a/two`, model: "a/two", providerId: PROVIDER_ID, displayName: "a/two" },
      { id: `${PROVIDER_ID}:pretty`, model: "a/pretty", providerId: PROVIDER_ID, displayName: "Pretty Name" },
      { id: `${PROVIDER_ID}:retired`, model: "retired", providerId: PROVIDER_ID, displayName: "retired" },
      { id: `${PROVIDER_ID}:unlabeled`, model: "a/unlabeled", providerId: PROVIDER_ID },
    ],
  }
  assert.deepEqual([...adoptSeeded(store, [{ id: "a/two" }, { id: "a/pretty" }])], ["magpie:a/two"],
    "not a provider that merely points at magpie, not a name the user chose, not a model magpie dropped, not an entry with no title")
})

test("an unreadable record stops instead of guessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-record-"))
  try {
    const store = join(dir, "settings.json")
    writeFileSync(store, "{}")
    writeFileSync(seedFile(store), "{ not a list")
    assert.equal(loadSeeded(seedFile(store)), null)
    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /refusing to guess/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const withHome = (dir, extra = {}) => {
  const env = { ...process.env, ...extra, USERPROFILE: dir, HOME: dir }
  if (!("CODELY_CLI_HOME" in extra)) delete env.CODELY_CLI_HOME
  return env
}

test("the home Cowork's ide-settings.json sits in is the one seeded", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-home-"))
  try {
    const moved = join(dir, "moved"), cli = join(dir, ".codely-cli"), def = join(dir, ".codely")
    for (const d of [moved, cli, def]) mkdirSync(d, { recursive: true })
    writeFileSync(join(moved, "ide-settings.json"), "{}")
    assert.equal(codelyHome({ CODELY_CLI_HOME: moved }, dir), moved, "a moved home wins")
    assert.equal(codelyHome({ CODELY_CLI_HOME: `~/moved` }, dir), moved, "written with a ~ it still resolves")
    writeFileSync(join(def, "ide-settings.json"), "{}")
    assert.equal(codelyHome({ CODELY_CLI_HOME: cli }, dir), def, "the terminal CLI's own home is not Cowork's")
    assert.equal(codelyHome({}, dir), def)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("with no marker anywhere the default home is still the answer, uncreated", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-home2-"))
  try {
    const def = join(dir, ".codely")
    assert.equal(codelyHome({ CODELY_CLI_HOME: join(dir, "gone") }, dir), def)
    assert.equal(existsSync(def), false, "answering a question must not create the directory")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a home Cowork has not run in stops instead of writing a store nothing reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-nohome-"))
  try {
    const r = spawnSync(process.execPath, [SEED, "--check"], { encoding: "utf8", env: withHome(dir) })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /has not run in/)
    assert.equal(existsSync(join(dir, ".codely")), false, "and the run creates nothing")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a home Cowork created but never filled in is a store we may write", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-first-"))
  try {
    mkdirSync(join(dir, ".codely"))
    writeFileSync(join(dir, ".codely", "ide-settings.json"), "{}")
    const r = spawnSync(process.execPath, [SEED, "--remove"], { encoding: "utf8", env: withHome(dir) })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /nothing of magpie's to remove/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("CODELY_CLI_HOME moves the store and the record it reads with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-moved-"))
  try {
    const moved = join(dir, "D")
    mkdirSync(moved)
    const store = join(moved, "settings.json")
    const p = plan(OWN_STORE, [GLM], V1)
    writeFileSync(store, JSON.stringify(p.next))
    writeFileSync(join(moved, "ide-settings.json"), JSON.stringify({ defaultChatModelTitle: GLM.id }))
    writeFileSync(seedFile(store), JSON.stringify(p.seeded))

    const r = spawnSync(process.execPath, [SEED, "--remove"], { encoding: "utf8", env: { ...withHome(dir), CODELY_CLI_HOME: moved } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /took magpie out of/, r.stdout)
    assert.ok(r.stdout.includes(store), `it names the store it took out: ${r.stdout}`)
    assert.ok(r.stdout.includes(`store: ${store}`), "it says which store it worked on before it says anything else")
    assert.deepEqual(JSON.parse(readFileSync(store, "utf8")).customModels, OWN_STORE.customModels)
    assert.equal(existsSync(join(dir, ".codely")), false, "the default home is left alone")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
