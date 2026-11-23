import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"

// Expose private seams from an isolated copy, without adding production exports.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-image-slim-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { sameHistoryUpToImages };\n")
const { sameHistoryUpToImages } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const U = (content) => ({ role: "user", content })
const A = (content) => ({ role: "assistant", content })
const image = (data = "aW1hZ2VB") => ({ type: "image", source: { type: "base64", media_type: "image/png", data } })
const text = (value) => ({ type: "text", text: value })
const call = (id) => ({ type: "tool_use", id, name: "view_image", input: { path: `/tmp/${id}.png` } })
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content })

// What magpie's image-slim middleware writes where it took out an image the
// model has already seen.
const SLIM = "[1.42 MB image left out here: a view_image result, already seen earlier in this conversation. Rely on what you already said about it. It is the file /tmp/a.png; call view_image on that path if you need to look at it again.]"

test("an earlier image image-slim swapped for its placeholder is the same history", () => {
  const expected = [U("look at it"), A([call("a")]), U([result("a", [text("saved /tmp/a.png"), image()])]), A([text("the button is misaligned")])]
  const slimmed = [expected[0], expected[1], U([result("a", [text("saved /tmp/a.png"), text(SLIM)])]), expected[3]]
  assert.equal(sameHistoryUpToImages(expected, slimmed), true)
  const changed = [expected[0], expected[1], U([result("a", [text("saved /tmp/OTHER.png"), text(SLIM)])]), expected[3]]
  assert.equal(sameHistoryUpToImages(expected, changed), false, "a changed text is still a changed history")
})

test("on Codex image-slim swaps a whole view_image output for its placeholder as a plain string", () => {
  const expected = [U("look at it"), A([call("a")]), U([result("a", [image()])]), A([text("the button is misaligned")])]
  const slimmed = [expected[0], expected[1], U([result("a", SLIM)]), expected[3]]
  assert.equal(sameHistoryUpToImages(expected, slimmed), true)
  const other = [expected[0], expected[1], U([result("a", "some other output")]), expected[3]]
  assert.equal(sameHistoryUpToImages(expected, other), false, "a real string result is still a changed history")
})
