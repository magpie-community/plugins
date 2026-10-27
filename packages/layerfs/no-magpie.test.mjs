// What these tools put in front of the model goes on to whatever vendor
// the agent uses (#358): the tool list (descriptions and argument schemas)
// and the errors a call answers name neither magpie nor its settings.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LayerfsTools } from "./index.mjs"
import { createBackend } from "./layerfs.mjs"

const envSnapshot = { ...process.env }
const dirs = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }
// The cleanup's time grows with the machine's disk load, not with the
// suite: on a loaded box removing every dir took over bun's default 5s
// hook bar (#362), so the hook carries its own.
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k]
  Object.assign(process.env, envSnapshot)
}, 120_000)

const named = (s) => /magpie/i.test(String(s))
const message = async (p) => { try { await p; return "" } catch (e) { return String(e?.message ?? e) } }

test("no tool description or argument names magpie", async () => {
  const { tool } = await LayerfsTools({})
  const sent = Object.entries(tool).map(([name, t]) => ({ name, description: t.description, args: t.args }))
  expect(sent.length).toBe(8)
  expect(named(JSON.stringify(sent))).toBe(false)
})

test("the errors a call answers name neither magpie nor its settings", async () => {
  process.env.MAGPIE_LAYERFS_HOME = mk("lfs-home-")
  process.env.MAGPIE_LAYERFS_BACKEND = "sim"
  delete process.env.MAGPIE_LAYERFS_EXEC
  const cfg = mk("app-config-")
  const { tool } = await LayerfsTools({ directory: cfg }, { exec: false })
  const call = (name, args) => tool[name].execute(args, { agent: "test", abort: AbortSignal.timeout(5000) })

  const errors = [
    await message(call("exec", { project: "website", command: "true" })),
    await message(call("provision", { project: "website", source: cfg })),
    await message(createBackend({ MAGPIE_LAYERFS_BACKEND: "native" })),
    await message(createBackend({ MAGPIE_LAYERFS_BACKEND: "other" })),
  ]
  for (const e of errors) {
    expect(e).not.toBe("")
    expect(named(e)).toBe(false)
  }
})
