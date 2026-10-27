// The images a tool returned go to Devin with the result that returned
// them, as magpie's built-in sends them (internal/gateway/devin.go,
// buildDevin: a tool message's images, inlineImages(p.Images)). A chat's
// tool message holds text alone, so magpie's gateway hands the plugin those
// images in the user message after the results (buildChat's seeLater); the
// plugin sent them to Devin as a user message of their own, where the
// built-in sent them as the tool's.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { _internal } from "./index.mjs"

const dec = new TextDecoder()

// sent is each message sent: its role, text, the call it answers and its
// images (data and type).
const sent = (b) =>
  _internal
    .fields(b)
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const m = { role: 0, text: "", answers: "", images: [] }
      for (const g of _internal.fields(f.data)) {
        if (g.num === 2) m.role = g.n
        else if (g.num === 3) m.text = dec.decode(g.data)
        else if (g.num === 7) m.answers = dec.decode(g.data)
        else if (g.num === 10) m.images.push(_internal.fields(g.data).map((h) => dec.decode(h.data)))
      }
      return m
    })

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

// magpie's buildChat bodies, as it wrote them (origin/main b03031738,
// buildChat for a Devin model): Codex's view_image turn
// (tool_images_1861_test.go, codexViewImage), and two Read results, the
// first with text and two images, then the user's own image and words
const read = (name) => JSON.parse(readFileSync(join(import.meta.dir, "testdata", name), "utf8"))
const viewImage = read("chat-tool-image.json")

test("a tool's image goes to Devin with its result, not in a user message of its own", () => {
  const got = sent(_internal.build(viewImage, "swe-2", "k"))
  expect(got.map((m) => m.role)).toEqual([1, 2, 4])
  const tool = got[2]
  expect(tool.answers).toBe("call_view1")
  // nothing but the image came back, as the built-in says it
  expect(tool.text).toBe("(no output)")
  expect(tool.images).toEqual([[PNG, "image/png"]])
})

test("each result keeps its own images and the user's own words and images stay theirs", () => {
  const chat = read("chat-tool-images-two.json")
  const got = sent(_internal.build(chat, "swe-2", "k"))
  expect(got.map((m) => [m.role, m.answers, m.text, m.images])).toEqual([
    [1, "", "shot", []],
    [2, "", "", []],
    [4, "toolu_1", "two pics", [["AAAA", "image/png"], ["BBBB", "image/jpeg"]]],
    [4, "toolu_2", "plain", []],
    [1, "", "what are these?", [["CCCC", "image/gif"]]],
  ])
})

test("a tool message's own images go with it, and an image Devin can't take (a URL) is left out", () => {
  const chat = {
    messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }] },
      {
        role: "tool",
        tool_call_id: "c1",
        content: [
          { type: "text", text: "done" },
          { type: "image_url", image_url: { url: "data:image/webp;base64,DDDD" } },
          { type: "image_url", image_url: { url: "https://example.com/x.png" } },
        ],
      },
    ],
  }
  const got = sent(_internal.build(chat, "swe-2", "k"))
  expect(got[2]).toEqual({ role: 4, text: "done", answers: "c1", images: [["DDDD", "image/webp"]] })
})

test("a user's own words that look like the heading but answer no result just sent stay the user's", () => {
  const chat = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "text only" },
      {
        role: "user",
        content: [
          { type: "text", text: "[From the result of read (tool call c9):]" },
          { type: "image_url", image_url: { url: "data:image/png;base64,EEEE" } },
        ],
      },
    ],
  }
  const got = sent(_internal.build(chat, "swe-2", "k"))
  expect(got[2]).toEqual({ role: 4, text: "text only", answers: "c1", images: [] })
  expect(got[3]).toEqual({ role: 1, text: "[From the result of read (tool call c9):]", answers: "", images: [["EEEE", "image/png"]] })
})
