import { test } from "node:test"
import assert from "node:assert/strict"

import { clean, stripCitations, stableCut } from "../pplx.mjs"

test("a citation run after sentence punctuation is removed", () => {
  assert.equal(stripCitations("Born in 1815.[1]", 3), "Born in 1815.")
  assert.equal(stripCitations("Born in 1815.[1][2][3]", 3), "Born in 1815.")
  assert.equal(stripCitations("Sources agree.[1, 3]", 3), "Sources agree.")
  assert.equal(stripCitations("A range.[1–3]", 3), "A range.")
  assert.equal(stripCitations("中文回答。[1]", 3), "中文回答。")
  assert.equal(stripCitations("Done！[2]", 3), "Done！")
})

test("with no sources listed nothing is stripped", () => {
  assert.equal(stripCitations("Born in 1815.[1]", 0), "Born in 1815.[1]")
  assert.equal(stripCitations("See [1] and [2].", 0), "See [1] and [2].")
})

test("an index outside the source list is not a citation", () => {
  assert.equal(stripCitations("Text.[12]", 3), "Text.[12]")
  assert.equal(stripCitations("Text.[1][12]", 3), "Text.[12]")
})

test("code in prose keeps its subscripts", () => {
  // Letters before the bracket: these are indexes, never citations.
  assert.equal(stripCitations("Read sys.argv[1] or items[2] or matrix[1][2]", 20),
    "Read sys.argv[1] or items[2] or matrix[1][2]")
  assert.equal(stripCitations("use arr[0] here", 20), "use arr[0] here")
  assert.equal(stripCitations("a[1] and x[2]", 20), "a[1] and x[2]")
})

test("a subscript chain is not dragged in by its first marker", () => {
  assert.equal(stripCitations("matrix[1][2] stays", 20), "matrix[1][2] stays")
})

test("a marker inside a code span or a fence is untouchable", () => {
  assert.equal(stripCitations("see `arr[1]` here", 20), "see `arr[1]` here")
  const fenced = "```js\nconst a = arr[1]\n```"
  assert.equal(stripCitations(fenced, 20), fenced)
  // Streamed, still open.
  assert.equal(stripCitations("```js\nconst a = arr[1]", 20), "```js\nconst a = arr[1]")
})

test("code protection holds on its own: jq's .[1] index", () => {
  // Without the code-span split this would be stripped, since it follows a dot.
  assert.equal(stripCitations("run `jq '.[1]' file.json` now", 5), "run `jq '.[1]' file.json` now")
  assert.equal(stripCitations("`.[1]`", 5), "`.[1]`")
})

test("a marker after a non-punctuation, non-letter character is left alone", () => {
  // No sentence ended here, so this is text, not a citation.
  assert.equal(stripCitations("price = 10 * [1]", 20), "price = 10 * [1]")
})

test("clean removes the transport wrappers and keeps the prose", () => {
  const raw = "<grok:render>Hello<grok:end>\n<?xml version=\"1.0\"?><script>bad()</script>world.[1]"
  assert.equal(clean(raw, 4), "Hello\nworld.")
})

test("clean leaves an empty answer empty", () => {
  assert.equal(clean(""), "")
  assert.equal(clean(undefined), "")
})

test("code survives a full clean", () => {
  const answer = "Here.[1]\n```py\nprint(items[1])\n```\nDone.[2]"
  assert.equal(clean(answer, 5), "Here.\n```py\nprint(items[1])\n```\nDone.")
})

test("stableCut holds back an unfinished marker", () => {
  assert.equal(stableCut("Born in 1815["), "Born in 1815")
  assert.equal(stableCut("Born in 1815[1"), "Born in 1815")
  assert.equal(stableCut("Born in 1815[1, "), "Born in 1815")
  assert.equal(stableCut("Born in 1815[1]"), "Born in 1815", "a trailing run may still grow")
  assert.equal(stableCut("Born in 1815[1] x"), "Born in 1815.[1] x".slice(0, 0) + "Born in 1815[1] x")
})

test("stableCut holds back an unfinished code span or fence", () => {
  assert.equal(stableCut("see `arr[0]"), "see ")
  assert.equal(stableCut("see `arr[0]`"), "see `arr[0]`")
  assert.equal(stableCut("```js\nconst a = 1"), "")
  assert.equal(stableCut("text ```\na[1]\n```"), "text ```\na[1]\n```")
})

test("stableCut flushes everything when the answer is final", () => {
  assert.equal(stableCut("Born in 1815[", true), "Born in 1815[")
  assert.equal(stableCut("```js\nconst a = 1", true), "```js\nconst a = 1")
})
