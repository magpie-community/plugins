// Which models take images is what Devin tells its CLI's model picker
// (GetCliModelConfigs), as magpie's built-in asks it (devin_images.go):
// swe-2 was said to take none, models.dev not knowing Devin's own ids, and
// agents dropped its images (面条 on magpie's Discord).
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { DevinAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
const path = process.env.PATH
afterEach(() => {
  globalThis.fetch = real
  if (process.env.PATH !== path) rmSync(process.env.PATH, { recursive: true, force: true })
  process.env.PATH = path
  _internal.forgetSaid()
})

const { PB, parseModelConfigs, listed, familiesOf, SNAPSHOT, SNAPSHOT_IMAGES, withImages, runtimeModel, configModel } = _internal

const sandboxed = () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
}

// withoutCli takes the devin CLI out of reach: the plugin finds it on PATH
// (and in ~/.local/bin, which the sandboxed HOME leaves empty), so a machine
// with the CLI installed would otherwise take the CLI's path
const withoutCli = () => {
  sandboxed()
  process.env.PATH = mkdtempSync(join(tmpdir(), "no-devin-"))
  for (const p of ["/usr/local/bin/devin", "/opt/homebrew/bin/devin"]) if (existsSync(p)) throw new Error(p + " is the devin CLI: these tests need a machine without it there")
}

// configs is a GetCliModelConfigsResponse naming each id, with
// supports_images set where it is true (proto3 leaves a false one out),
// and the id's family as SNAPSHOT has it (model_info's family uid, the
// family metadata's label), as Devin's own response has them
const configs = (said) => {
  const out = new PB()
  for (const [id, images] of Object.entries(said)) {
    const c = new PB().str(1, "label " + id)
    if (images) c.varint(5, 1)
    const fam = SNAPSHOT.find(([, , , vs]) => vs.some(([v]) => v === id))
    if (fam) c.bytes(23, new PB().str(23, fam[0]).done()).bytes(30, new PB().str(1, fam[1]).done())
    out.bytes(1, c.str(22, id).done())
  }
  return out.done()
}

test("GetCliModelConfigs is read for each model's supports_images", () => {
  expect(parseModelConfigs(configs({ "swe-2-high": true, "glm-5-2": false }))).toEqual({ "swe-2-high": true, "glm-5-2": false })
  expect(parseModelConfigs(new Uint8Array())).toBe(null)
})

test("swe-2 and swe-1.7 take images in the list a new account is given, GLM and DeepSeek V4 Flash don't", async () => {
  sandboxed()
  const config = {}
  await (await DevinAuthPlugin()).config(config)
  const ms = config.provider.devin.models
  for (const id of ["swe-2", "swe-1.7", "swe-1.7-lightning", "kimi-k3", "gpt-6-1-sol"]) {
    expect([id, ms[id].attachment, ms[id].modalities.input]).toEqual([id, true, ["text", "image"]])
  }
  for (const id of ["glm-5.2", "deepseek-v4-flash", "inkling"]) {
    expect([id, ms[id].attachment, ms[id].modalities.input]).toEqual([id, false, ["text"]])
  }
})

test("a family takes images when every variant Devin named says so, a variant as it says itself", () => {
  const fs = familiesOf(SNAPSHOT)
  const images = { ...SNAPSHOT_IMAGES, "swe-2-high": true, "swe-2-max": true, "swe-2-medium": false }
  const ms = Object.fromEntries(listed(fs, ["swe-2-medium"], images).map((m) => [m.id, m]))
  // its variants disagree: the family is Devin's word for none of them
  expect(ms["swe-2"].image).toBe(undefined)
  expect(ms["swe-2-medium"].image).toBe(false)
  expect(runtimeModel(ms["swe-2-medium"]).capabilities.input.image).toBe(false)
  expect(ms["swe-1.7"].image).toBe(true)
  expect(configModel(ms["swe-1.7"]).modalities.input).toEqual(["text", "image"])
})

test("an account's list without the CLI takes what Devin says of images now", async () => {
  withoutCli()
  const asked = []
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), headers: init.headers, body: new Uint8Array(init.body) })
    return new Response(configs({ "swe-2-high": true, "swe-2-medium": true, "swe-2-max": true, "glm-5-2": false, "deepseek-v4-flash-high": true, "deepseek-v4-flash-max": true }))
  }
  const hooks = await DevinAuthPlugin()
  const config = {}
  await hooks.config(config)
  const given = Object.fromEntries(
    Object.entries(config.provider.devin.models).map(([id, m]) => [id, { id, capabilities: { attachment: m.attachment, input: { text: true, image: m.modalities.input.includes("image") } } }]),
  )
  // what models.dev would say, before this: no images for swe-2
  given["swe-2"].capabilities = { attachment: false, input: { text: true, image: false } }
  given["not-devins"] = { id: "not-devins", capabilities: { attachment: false, input: { text: true, image: false } } }
  const got = await hooks.provider.models({ models: given }, { auth: { type: "api", key: "devin-key" } })
  expect(asked[0].url).toBe("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs")
  expect(asked[0].headers).toEqual({ "Content-Type": "application/proto", "Connect-Protocol-Version": "1" })
  expect(new TextDecoder().decode(asked[0].body)).toContain("devin-key")
  expect(got["swe-2"].capabilities).toMatchObject({ attachment: true, input: { text: true, image: true } })
  // Devin's word now over the snapshot's
  expect(got["deepseek-v4-flash"].capabilities.input.image).toBe(true)
  expect(got["glm-5.2"].capabilities.input.image).toBe(false)
})

test("when Devin can't be asked, the list takes the snapshot's word", async () => {
  withoutCli()
  globalThis.fetch = async () => new Response("", { status: 503 })
  const given = { "swe-2": { id: "swe-2", capabilities: { attachment: false, input: { text: true, image: false } } } }
  const got = await (await DevinAuthPlugin()).provider.models({ models: given }, { auth: { type: "api", key: "devin-key" } })
  expect(got["swe-2"].capabilities).toEqual({ attachment: true, input: { text: true, image: true } })
  expect(withImages(given, [{ id: "swe-2" }])).toEqual(given)
})
