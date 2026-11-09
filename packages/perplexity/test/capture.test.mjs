import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { answerDelta, endOfAnswer } from "../pplx.mjs"

// Two real `perplexity_ask` captures (see fixtures/perplexity-ask.json): the
// second turn continues the first, and both list their sources.
const CAPTURE = JSON.parse(
  readFileSync(new URL("./fixtures/perplexity-ask.json", import.meta.url), "utf8")
)

function newState() {
  return { full: "", emitted: "", thinkingSeen: new Set(), answerUsage: null, sources: 0 }
}

function replay(turn) {
  const state = newState()
  let text = ""
  for (const line of turn.lines) text += answerDelta(JSON.parse(line), state).delta
  return { text, state }
}

test("a real answer replays to text with every citation marker removed", () => {
  const { text, state } = replay(CAPTURE.turns[0])
  assert.equal(state.sources, 20, "the stream listed 20 sources")
  assert.match(text, /^At its most recent meeting/)
  assert.match(text, /Federal Open Market Committee/)
  assert.doesNotMatch(text, /\[\d+\]/, "no citation markers survive")
  assert.ok(text.length > 2000, `answer was ${text.length} chars`)
})

test("a follow-up turn replays too", () => {
  const { text, state } = replay(CAPTURE.turns[1])
  assert.ok(state.sources >= 1)
  assert.ok(text.length > 1000, `answer was ${text.length} chars`)
  assert.doesNotMatch(text, /\[\d+\]/)
})

test("fragments split mid-marker keep the rest of the answer", () => {
  const state = newState()
  answerDelta(
    {
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: { progress: "DONE", web_results: [{ url: "https://a" }, { url: "https://b" }] },
        },
      ],
    },
    state,
  )
  let text = ""
  const fragments = ["The Fed held rates in September.[", "1] That was the last move."]
  for (const fragment of fragments) {
    text += answerDelta(
      { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [fragment] } }] },
      state,
    ).delta
  }
  text += answerDelta(
    {
      blocks: [
        {
          intended_usage: "ask_text",
          markdown_block: { progress: "DONE", chunks: [fragments.join("")] },
        },
      ],
    },
    state,
  ).delta
  assert.equal(text, "The Fed held rates in September. That was the last move.")
})

test("a marker split as \"[1\" + \"]\" also survives", () => {
  const state = newState()
  answerDelta(
    { blocks: [{ intended_usage: "web_results", web_result_block: { web_results: [{ url: "https://a" }] } }] },
    state,
  )
  let text = ""
  for (const part of ["Rates rose.[1", "] That is all."]) {
    text += answerDelta(
      { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [part] } }] },
      state,
    ).delta
  }
  text += answerDelta(
    {
      blocks: [
        {
          intended_usage: "ask_text",
          markdown_block: { progress: "DONE", chunks: ["Rates rose.[1] That is all."] },
        },
      ],
    },
    state,
  ).delta
  assert.equal(text, "Rates rose. That is all.")
})

test("a citation chain split as \"[1]\" + \"[2]\" keeps both", () => {
  const state = newState()
  answerDelta(
    {
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: { web_results: [{ url: "https://a" }, { url: "https://b" }] },
        },
      ],
    },
    state,
  )
  let text = ""
  for (const part of ["The Fed held rates in September.[1]", "[2] Nothing changed."]) {
    text += answerDelta(
      { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [part] } }] },
      state,
    ).delta
  }
  text += answerDelta(
    {
      blocks: [
        {
          intended_usage: "ask_text",
          markdown_block: { progress: "DONE", chunks: ["The Fed held rates in September.[1][2] Nothing changed."] },
        },
      ],
    },
    state,
  ).delta
  assert.equal(text, "The Fed held rates in September. Nothing changed.")
})

test("a code fence split across fragments is held back and re-emitted whole", () => {
  const state = newState()
  let text = ""
  for (const part of ["Try this `a", "rr[1]` now."]) {
    text += answerDelta(
      { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [part] } }] },
      state,
    ).delta
  }
  text += answerDelta(
    {
      blocks: [
        {
          intended_usage: "ask_text",
          markdown_block: { progress: "DONE", chunks: ["Try this `arr[1]` now."] },
        },
      ],
    },
    state,
  ).delta
  assert.equal(text, "Try this `arr[1]` now.")
})

test("an answer with no sources keeps its brackets", () => {
  const state = newState()
  const text = answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["Use arr[1] with [2]."] } },
      ],
    },
    state,
  ).delta
  assert.equal(text, "Use arr[1] with [2].")
  assert.equal(state.sources, 0)
})

test("a rewritten final text sends the rest of the answer, not nothing", () => {
  const state = newState()
  let text = ""
  text += answerDelta(
    { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["Hello there"] } }] },
    state,
  ).delta
  text += answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["Hello, there. And more."] } },
      ],
    },
    state,
  ).delta
  assert.match(text, /And more\.$/, "the tail is delivered")
})

test("a citation run in comma form is held for the next fragment", () => {
  const state = newState()
  answerDelta(
    {
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: { web_results: [{ url: "https://a" }, { url: "https://b" }, { url: "https://c" }] },
        },
      ],
    },
    state,
  )
  let text = ""
  for (const part of ["Rates held.[1, 2]", "[3] Next."]) {
    text += answerDelta(
      { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [part] } }] },
      state,
    ).delta
  }
  text += endOfAnswer(state)
  assert.equal(text, "Rates held. Next.")
})

test("an unmatched backtick is held only to the end of its line", () => {
  const state = newState()
  const first = answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["Press the ` key."] } },
      ],
    },
    state,
  )
  // Still inside the line: an inline span could begin here, so it waits.
  assert.equal(first.delta, "Press the ")

  // The newline proves it is prose, not code, so the rest is released.
  const second = answerDelta(
    {
      blocks: [
        {
          intended_usage: "ask_text",
          markdown_block: { progress: "IN_PROGRESS", chunks: ["\nThen carry on."] },
        },
      ],
    },
    state,
  )
  assert.equal(second.delta, "` key.\nThen carry on", "the stream continues before the answer ends")
  assert.equal(first.delta + second.delta + endOfAnswer(state), "Press the ` key.\nThen carry on.")
})

test("an answer with no sources keeps its brackets", () => {
  const state = newState()
  const text = answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["Use arr[1] with [2]."] } },
      ],
    },
    state,
  ).delta
  assert.equal(text, "Use arr[1] with [2].")
  assert.equal(state.sources, 0)
})

test("a rewritten final text sends the rest of the answer, not nothing", () => {
  const state = newState()
  let text = ""
  text += answerDelta(
    { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["Hello there"] } }] },
    state,
  ).delta
  text += answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["Hello, there. And more."] } },
      ],
    },
    state,
  ).delta
  assert.match(text, /And more\.$/, "the tail is delivered")
})

test("a citation run in comma form is held for the next fragment", () => {
  const state = newState()
  answerDelta(
    {
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: { web_results: [{ url: "https://a" }, { url: "https://b" }, { url: "https://c" }] },
        },
      ],
    },
    state,
  )
  let text = ""
  for (const part of ["Rates held.[1, 2]", "[3] Next."]) {
    text += answerDelta(
      { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [part] } }] },
      state,
    ).delta
  }
  text += endOfAnswer(state)
  assert.equal(text, "Rates held. Next.")
})

test("an answer with no sources keeps its brackets", () => {
  const state = newState()
  const text = answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["Use arr[1] with [2]."] } },
      ],
    },
    state,
  ).delta
  assert.equal(text, "Use arr[1] with [2].")
  assert.equal(state.sources, 0)
})

test("a rewritten final text sends the rest of the answer, not nothing", () => {
  const state = newState()
  let text = ""
  text += answerDelta(
    { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["Hello there"] } }] },
    state,
  ).delta
  text += answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["Hello, there. And more."] } },
      ],
    },
    state,
  ).delta
  assert.match(text, /And more\.$/, "the tail is delivered")
})

test("a citation run in comma form is held for the next fragment", () => {
  const state = newState()
  answerDelta(
    {
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: { web_results: [{ url: "https://a" }, { url: "https://b" }, { url: "https://c" }] },
        },
      ],
    },
    state,
  )
  let text = ""
  for (const part of ["Rates held.[1, 2]", "[3] Next."]) {
    text += answerDelta(
      { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [part] } }] },
      state,
    ).delta
  }
  text += endOfAnswer(state)
  assert.equal(text, "Rates held. Next.")
})


test("an answer with no sources keeps its brackets", () => {
  const state = newState()
  const text = answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["Use arr[1] with [2]."] } },
      ],
    },
    state,
  ).delta
  assert.equal(text, "Use arr[1] with [2].")
  assert.equal(state.sources, 0)
})

test("a rewritten final text sends the rest of the answer, not nothing", () => {
  const state = newState()
  let text = ""
  text += answerDelta(
    { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["Hello there"] } }] },
    state,
  ).delta
  text += answerDelta(
    {
      blocks: [
        { intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["Hello, there. And more."] } },
      ],
    },
    state,
  ).delta
  assert.match(text, /And more\.$/, "the tail is delivered")
})

test("a citation run in comma form is held for the next fragment", () => {
  const state = newState()
  answerDelta(
    {
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: { web_results: [{ url: "https://a" }, { url: "https://b" }, { url: "https://c" }] },
        },
      ],
    },
    state,
  )
  let text = ""
  for (const part of ["Rates held.[1, 2]", "[3] Next."]) {
    text += answerDelta(
      { blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [part] } }] },
      state,
    ).delta
  }
  text += endOfAnswer(state)
  assert.equal(text, "Rates held. Next.")
})
