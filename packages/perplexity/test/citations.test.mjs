import { test } from "node:test"
import assert from "node:assert/strict"

import { clean, stripCitations } from "../pplx.mjs"

test("citation markers after prose are removed, in every form Perplexity uses", () => {
  assert.equal(stripCitations("Born in 1815[1]."), "Born in 1815.")
  assert.equal(stripCitations("Two sources[1][2] agree."), "Two sources agree.")
  assert.equal(stripCitations("Several sources[1, 3] agree."), "Several sources agree.")
  assert.equal(stripCitations("A range[1–3] of them."), "A range of them.")
  assert.equal(stripCitations("中文回答[1] 带引用。"), "中文回答 带引用。")
})

test("a zero index is an array subscript, never a citation", () => {
  assert.equal(stripCitations("use arr[0] here"), "use arr[0] here")
  assert.equal(stripCitations("obj[0].value"), "obj[0].value")
})

test("a single-letter name before the bracket is a variable, not prose", () => {
  assert.equal(stripCitations("a[1] and x[2]"), "a[1] and x[2]")
})

test("code written in backticks keeps its indexes", () => {
  assert.equal(stripCitations("run `list[12] + foo[3]` next"), "run `list[12] + foo[3]` next")
})

test("anything inside an inline code span or a fenced block is left alone", () => {
  assert.equal(stripCitations("see `arr[0]` please"), "see `arr[0]` please")
  const fenced = "```js\nconst a = arr[0]\n```"
  assert.equal(stripCitations(fenced), fenced)
  // A fence that is still open (streaming) counts as code too.
  assert.equal(stripCitations("```js\nconst a = arr[0]"), "```js\nconst a = arr[0]")
})

test("a citation glued to an English word is still a citation", () => {
  assert.equal(stripCitations("According to reports[1], it grew."), "According to reports, it grew.")
})

test("a bare index in prose is the documented trade-off", () => {
  // Without citations in the payload there is no way to tell this from a
  // citation; code belongs in backticks.
  assert.equal(stripCitations("foo[3]"), "foo")
})

test("clean removes the transport wrappers and keeps the prose", () => {
  const raw = "<grok:render>Hello<grok:end>\n<?xml version=\"1.0\"?><script>bad()</script>world[1]"
  assert.equal(clean(raw), "Hello\nworld")
})

test("clean leaves an empty answer empty", () => {
  assert.equal(clean(""), "")
  assert.equal(clean(undefined), "")
})

test("code survives a full clean", () => {
  const answer = "Here[1]:\n```py\nprint(items[0])\n```\nDone[2]."
  assert.equal(clean(answer), "Here:\n```py\nprint(items[0])\n```\nDone.")
})
