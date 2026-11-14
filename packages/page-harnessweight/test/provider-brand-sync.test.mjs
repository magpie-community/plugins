import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProviderBrands } from "../lib/provider-brands.mjs"
import { createHandler } from "../service.mjs"

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>'
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzwoAAAAASUVORK5CYII=", "base64")
const svgKey = "0123456789abcdef.svg"
const pngKey = "abcdef0123456789.png"
const plain = (value) => JSON.parse(JSON.stringify(value))
const uri = (mime, data) => `data:${mime};base64,${Buffer.from(data).toString("base64")}`
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hw-provider-brands-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "icons"))
  return {
    root, brands: createProviderBrands({ directory: root }),
    config: (providers) => writeFile(join(root, "providers.json"), JSON.stringify({ providers })),
    icon: (name, data) => writeFile(join(root, "icons", name), data),
  }
}

test("custom SVG and PNG synchronize only whitelisted display fields and used providers", async (t) => {
  const f = await fixture(t)
  await f.icon(svgKey, svg)
  await f.icon(pngKey, png)
  await f.config([
    { id: "modelgo", name: "My ModelGo", icon: `file:${svgKey}`, key: "SECRET_KEY", baseURL: "SECRET_ENDPOINT", account: { token: "SECRET_TOKEN" }, iconFrom: "SECRET_ORIGIN" },
    { id: "png", icon: `file:${pngKey}` },
    { id: "unused", name: "Must not appear", icon: `file:${svgKey}` },
  ])
  const actual = await f.brands(["modelgo", "png", "unknown"])
  assert.deepEqual(plain(actual), {
    modelgo: { name: "My ModelGo", icon: uri("image/svg+xml", svg) },
    png: { icon: uri("image/png", png) },
  })
  assert.doesNotMatch(JSON.stringify(actual), /SECRET|baseURL|account|iconFrom|unused/)
})

test("updates, deletions and separate portable directories do not serve stale branding", async (t) => {
  const a = await fixture(t), b = await fixture(t)
  await a.icon(svgKey, svg)
  await a.config([{ id: "same", name: "A", icon: `file:${svgKey}` }])
  await b.config([{ id: "same", name: "B" }])
  assert.equal((await a.brands(["same"])).same.name, "A")
  assert.equal((await b.brands(["same"])).same.name, "B")
  const updated = svg.replace("10", "20")
  await a.icon(svgKey, updated)
  await a.config([{ id: "same", name: "Updated", icon: `file:${svgKey}` }])
  assert.deepEqual(plain(await a.brands(["same"])), { same: { name: "Updated", icon: uri("image/svg+xml", updated) } })
  await rm(join(a.root, "icons", svgKey))
  assert.deepEqual(plain(await a.brands(["same"])), { same: { name: "Updated" } })
  await rm(join(a.root, "providers.json"))
  assert.deepEqual(plain(await a.brands(["same"])), {})
})

test("plugin defaults merge with nonempty manual fields and resolve bundled icon keys", async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.root, "plugin-providers.json"), JSON.stringify([
    { id: "p", name: "Plugin", icon: "openai", key: "SECRET" },
    { id: "plugin-only", name: "Plugin only", icon: "deepseek-color" },
  ]))
  await f.config([{ id: "p", name: "Manual", icon: "" }])
  const expected = uri("image/svg+xml", await readFile(new URL("../app/icons/openai.svg", import.meta.url)))
  assert.deepEqual(plain(await f.brands(["p"])), { p: { name: "Manual", icon: expected } })
  assert.match((await f.brands(["plugin-only"]))["plugin-only"].icon, /^data:image\/svg\+xml;base64,/)
  await f.icon(svgKey, svg)
  await f.config([{ id: "p", name: "", icon: `file:${svgKey}` }])
  assert.deepEqual(plain(await f.brands(["p"])), { p: { name: "Plugin", icon: uri("image/svg+xml", svg) } })
})

test("missing, malformed, oversized config and unknown icons fall back without errors", async (t) => {
  const f = await fixture(t)
  assert.deepEqual(plain(await f.brands(["p"])), {})
  for (const content of ["invalid", "null", '{"providers":{}}', " ".repeat(4 * 1024 * 1024 + 1)]) {
    await writeFile(join(f.root, "providers.json"), content)
    assert.deepEqual(plain(await f.brands(["p"])), {})
  }
  for (const icon of ["unknown-key", `file:${svgKey}`, "https://example.com/icon.svg", "../../secrets", "file:../../secret.svg", "file:0123456789ABCDEF.svg"]) {
    await f.config([{ id: "p", icon }])
    assert.deepEqual(plain(await f.brands(["p"])), {})
  }
})

test("oversized icons, symlink escapes and config escapes never become image data", async (t) => {
  const f = await fixture(t), outside = await fixture(t)
  await f.config([{ id: "p", icon: `file:${svgKey}` }])
  await f.icon(svgKey, "x".repeat(1024 * 1024 + 1))
  assert.deepEqual(plain(await f.brands(["p"])), {})
  await f.icon(svgKey, "x".repeat(1024 * 1024))
  assert.ok((await f.brands(["p"])).p.icon)
  await rm(join(f.root, "icons", svgKey))
  await outside.icon(svgKey, svg)
  await symlink(join(outside.root, "icons", svgKey), join(f.root, "icons", svgKey))
  assert.deepEqual(plain(await f.brands(["p"])), {})
  await rm(join(f.root, "icons"), { recursive: true })
  await symlink(join(outside.root, "icons"), join(f.root, "icons"))
  assert.deepEqual(plain(await f.brands(["p"])), {})
  await rm(join(f.root, "providers.json"))
  await outside.config([{ id: "p", name: "Outside" }])
  await symlink(join(outside.root, "providers.json"), join(f.root, "providers.json"))
  assert.deepEqual(plain(await f.brands(["p"])), {})
})

test("custom icons cannot link to credential files inside the selected config root", async (t) => {
  const f = await fixture(t)
  await f.config([{ id: "p", icon: `file:${svgKey}`, key: "SECRET_CREDENTIAL" }])
  await symlink(join(f.root, "providers.json"), join(f.root, "icons", svgKey))
  assert.deepEqual(plain(await f.brands(["p"])), {})
  await rm(join(f.root, "icons"), { recursive: true })
  await mkdir(join(f.root, "other-icons"))
  await writeFile(join(f.root, "other-icons", svgKey), svg)
  await symlink(join(f.root, "other-icons"), join(f.root, "icons"))
  assert.deepEqual(plain(await f.brands(["p"])), {})
})

test("summary API attaches provider branding without leaking config fields", async (t) => {
  const f = await fixture(t)
  await f.icon(svgKey, svg)
  await f.config([{ id: "modelgo", name: "ModelGo custom", icon: `file:${svgKey}`, key: "SECRET" }, { id: "unused", name: "Unused" }])
  await writeFile(join(f.root, "usage.jsonl"), JSON.stringify({ t: new Date().toISOString(), agent: "codex", provider: "modelgo", model: "m", status: 200 }) + "\n")
  const handle = createHandler({ directory: f.root, token: "test", gatewayUrl: "http://127.0.0.1:9", codexDir: join(f.root, "missing-codex") })
  let status, body
  await handle({ url: "/api/summary?k=test", method: "GET", headers: { host: "localhost:3496" } }, {
    setHeader() {}, writeHead(code) { status = code }, end(data) { body = JSON.parse(data) },
  })
  assert.equal(status, 200)
  assert.deepEqual(body.providerView.brands, { modelgo: { name: "ModelGo custom", icon: uri("image/svg+xml", svg) } })
  assert.doesNotMatch(JSON.stringify(body), /SECRET|Unused/)
})
