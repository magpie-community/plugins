import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = import.meta.dir
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const html = readFileSync(join(root, "page/index.html"), "utf8")

// Local page assets: src/href without a scheme, protocol-relative prefix or fragment.
// _magpie/ is served by the magpie page host, not shipped in the package.
const assets = [...html.matchAll(/\b(?:src|href)="([^"#]+)"/g)]
  .map((m) => m[1].split("?")[0])
  .filter((p) => !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(p) && !p.startsWith("_magpie/"))

const shipped = (path) => pkg.files.some((entry) => path === entry || path.startsWith(entry.replace(/\/$/, "") + "/"))

test("page/index.html references local assets", () => {
  expect(assets.length).toBeGreaterThan(5)
  expect(assets).toContain("layouts.js")
})

test("every local asset page/index.html loads is published through package.json files", () => {
  for (const asset of assets) {
    const path = "page/" + asset
    expect(existsSync(join(root, path)), `${path} exists`).toBe(true)
    expect(shipped(path), `${path} is listed in package.json files`).toBe(true)
  }
})
