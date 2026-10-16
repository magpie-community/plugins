// A tool's images reach the model (yetone/magpie#1861). Codex's view_image
// answers with a function_call_output whose output is
//   [{"type":"input_image","image_url":"data:image/png;base64,…","detail":"high"}]
// (codex-rs 0.162 protocol/src/models.rs, FunctionCallOutputContentItem),
// which magpie hands the plugin as an Anthropic tool_result holding an image
// block. Kiro's tool results carry text alone, so the image goes with the
// message that answers the call, as magpie's built-in sends it (#369).
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { buildKiro } = _internal

// a 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const JPG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="

// the body magpie's gateway writes for a Codex turn whose view_image call
// came back with an image and nothing else (its tool_result has no text block)
const viewImage = (content) => ({
  model: "claude-sonnet-4.5",
  system: [{ type: "text", text: "You are Codex." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "使用computer use截图当前屏幕看下" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_view1", name: "view_image", input: { path: "/tmp/magpie_icon.png" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_view1", content, cache_control: { type: "ephemeral" } }] },
  ],
  tools: [{ name: "view_image", description: "View a local image", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
})

const sent = (r) => JSON.parse(buildKiro(r, "claude-sonnet-4.5", "", 0)).conversationState

test("a tool's image goes with the message that answers its call", () => {
  const s = sent(viewImage([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]))
  const u = s.currentMessage.userInputMessage
  expect(u.images).toEqual([{ format: "png", source: { bytes: PNG } }])
  expect(u.userInputMessageContext.toolResults).toEqual([{ toolUseId: "call_view1", status: "success", content: [{ text: "(no output)" }] }])
})

test("a tool's text and images both go, every image in order", () => {
  const s = sent(
    viewImage([
      { type: "text", text: "Screenshot of Finder" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPG } },
    ]),
  )
  const u = s.currentMessage.userInputMessage
  expect(u.userInputMessageContext.toolResults[0].content).toEqual([{ text: "Screenshot of Finder" }])
  expect(u.images.map((i) => i.format)).toEqual(["png", "jpeg"])
})

test("an image named only by a URL has no bytes to send and is left out", () => {
  const s = sent(viewImage([{ type: "image", source: { type: "url", url: "https://example.invalid/a.png" } }]))
  expect(s.currentMessage.userInputMessage.images).toBeUndefined()
})

test("only the latest tool image is sent again, as Kiro's own agent sends only the latest", () => {
  const r = viewImage([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }])
  r.messages.push(
    { role: "assistant", content: [{ type: "tool_use", id: "call_view2", name: "view_image", input: { path: "/tmp/b.jpg" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_view2", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPG } }] }] },
  )
  const s = sent(r)
  expect(s.currentMessage.userInputMessage.images).toEqual([{ format: "jpeg", source: { bytes: JPG } }])
  for (const e of s.history) expect(e.userInputMessage?.images).toBeUndefined()
})
