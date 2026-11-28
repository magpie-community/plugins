// Every model's window is Devin's own word on it. Since 2026-11 Devin
// leaves the config's max_context_tokens (18) out for all but two of its
// models and says the window in model_info (23) alone, so SWE-2.1 and
// every SWE-2 variant went to the client with a context of 0, magpie's
// Ollama /api/show told 32768, and Hermes turned SWE-2.1 away under its
// 64K floor (@noting_ever on X). model-configs-1127.bin is thirteen
// configs cut from that day's real GetCliModelConfigs reply, bytes as
// Devin sent them.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { _internal } from "./index.mjs"

const { parseConfigFamilies, parseFamilies, listed, runtimeModel, configModel } = _internal
const configs = () => new Uint8Array(readFileSync(join(import.meta.dir, "testdata", "model-configs-1127.bin")))
const variants = (fams) => Object.fromEntries(fams.flatMap((f) => f.models).map((m) => [m.id, m]))

test("a config with no context of its own takes model_info's window", () => {
  const ms = variants(parseConfigFamilies(configs()))
  for (const id of ["swe-2-1", "swe-2-1-low", "swe-2-1-medium", "swe-2-1-high", "swe-2-1-xhigh", "swe-2-1-max"]) {
    expect([id, ms[id].context, ms[id].output]).toEqual([id, 262144, 65536])
  }
  for (const id of ["swe-2-high", "swe-2-medium", "swe-2-max"]) expect([id, ms[id].context, ms[id].output]).toEqual([id, 262000, 128000])
  expect(ms["claude-opus-5-5-medium"].context).toBe(1000000)
  // the two Devin still gives its own context keep it
  expect(ms["swe-2-flash-medium"].context).toBe(262144)
  expect(ms["swe-1-6-slow"].context).toBe(200000)
  // and no config in the reply is left without one
  for (const m of Object.values(ms)) expect([m.id, m.context > 0, m.output > 0]).toEqual([m.id, true, true])
})

test("every entry offered, families and their tiers too, says its window", () => {
  const out = listed(parseConfigFamilies(configs()))
  const by = Object.fromEntries(out.map((m) => [m.id, m]))
  expect(by["swe-2-1"].context).toBe(262144)
  expect(by["swe-2"].context).toBe(262000)
  for (const m of out) {
    expect([m.id, m.context > 0]).toEqual([m.id, true])
    expect(runtimeModel(m).limit).toEqual({ context: m.context, output: m.output })
    expect(configModel(m).limit).toEqual({ context: m.context, output: m.output })
  }
})

test("the CLI's list, which names no window now, takes SNAPSHOT's for an id it has; an id it hasn't stays unknown", () => {
  const cli = JSON.stringify({
    families: [
      { family_uid: "swe-2-1", family_label: "SWE-2.1", aliases: [], variants: [{ model_uid: "swe-2-1-medium", label: "SWE-2.1 Medium", max_output_tokens: 65536 }] },
      { family_uid: "swe-2", family_label: "SWE-2", aliases: ["swe"], variants: [{ model_uid: "swe-2-high", label: "SWE-2 High", max_output_tokens: 128000 }] },
      { family_uid: "swe-2-flash", family_label: "SWE-2 Flash", aliases: [], variants: [{ model_uid: "swe-2-flash-medium", label: "SWE-2 Flash Medium", max_context_tokens: 262144, max_output_tokens: 131072 }] },
      { family_uid: "swe-9", family_label: "SWE-9", aliases: [], variants: [{ model_uid: "swe-9-medium", label: "SWE-9 Medium" }] },
    ],
  })
  const ms = variants(parseFamilies(cli))
  expect([ms["swe-2-1-medium"].context, ms["swe-2-1-medium"].output]).toEqual([262144, 65536])
  expect(ms["swe-2-high"].context).toBe(262000)
  expect(ms["swe-2-flash-medium"].context).toBe(262144)
  expect([ms["swe-9-medium"].context, ms["swe-9-medium"].output]).toEqual([0, 0])
})
