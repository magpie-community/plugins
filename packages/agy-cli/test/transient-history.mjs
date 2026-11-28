import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { pathToFileURL } from "node:url"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-transient-history-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) =>
  `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source +
  "\nexport { droppedHoistedToolImages, droppedOneRequestReminder, sameHistoryUpToImages };\n")
const { droppedHoistedToolImages, droppedOneRequestReminder, sameHistoryUpToImages } =
  await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

function captureStderr() {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = function write(chunk, ...rest) {
    const text = String(chunk)
    if (text.startsWith("[agy-bridge] ")) {
      lines.push(JSON.parse(text.slice("[agy-bridge] ".length)))
      return true
    }
    return original.call(this, chunk, ...rest)
  }
  return { lines, restore: () => { process.stderr.write = original } }
}

const image = () => ({
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  },
})
const text = (value) => ({ type: "text", text: value })
const result = (id = "call-1", content = "ok") => ({ type: "tool_result", tool_use_id: id, content })
const user = (content) => ({ role: "user", content })
const assistant = (content) => ({ role: "assistant", content })

test("transient history helpers accept only the exact one-request shapes", () => {
  const withHoisted = [
    user("look"),
    assistant([{ type: "tool_use", id: "call-1", name: "Read", input: {} }]),
    user([result(), image(), text("caption")]),
  ]
  const withoutHoisted = withHoisted.map((message, index) => index === 2
    ? user([result()])
    : message)
  assert.equal(droppedHoistedToolImages(withHoisted, withoutHoisted), true)
  assert.equal(droppedHoistedToolImages(withHoisted, [
    withHoisted[0],
    withHoisted[1],
    user([result(), text("caption")]),
  ]), false)
  assert.equal(droppedHoistedToolImages(withHoisted, [
    withHoisted[0],
    withHoisted[1],
    user([result(), image()]),
  ]), false)
  assert.equal(droppedHoistedToolImages(withHoisted, [
    user("changed"),
    withHoisted[1],
    user([result()]),
  ]), false)

  // OMP's 7 -> 1 (#1447): three images, each with its caption, after one result
  assert.equal(droppedHoistedToolImages(
    [withHoisted[0], withHoisted[1], user([result(), image(), text("a"), image(), text("b"), image(), text("c")])],
    withoutHoisted,
  ), true)
  // an image without a caption, and images after each of two results
  assert.equal(droppedHoistedToolImages(
    [withHoisted[0], withHoisted[1], user([result(), image()])],
    withoutHoisted,
  ), true)
  assert.equal(droppedHoistedToolImages(
    [user("look"), assistant([{ type: "tool_use", id: "call-1", name: "Read", input: {} }, { type: "tool_use", id: "call-2", name: "Read", input: {} }]),
      user([result("call-1"), image(), text("a"), result("call-2", "two"), image(), text("b")])],
    [user("look"), assistant([{ type: "tool_use", id: "call-1", name: "Read", input: {} }, { type: "tool_use", id: "call-2", name: "Read", input: {} }]),
      user([result("call-1"), result("call-2", "two")])],
  ), true)
  // text after a result with no image, a user's own image, or a changed result
  assert.equal(droppedHoistedToolImages(
    [withHoisted[0], withHoisted[1], user([result(), text("note")])],
    withoutHoisted,
  ), false)
  assert.equal(droppedHoistedToolImages(
    [user([text("look"), image()]), withHoisted[1], user([result()])],
    [user("look"), withHoisted[1], user([result()])],
  ), false)
  assert.equal(droppedHoistedToolImages(withHoisted, [withHoisted[0], withHoisted[1], user([result("call-1", "other")])]), false)

  // plugins#1556 (shinnamu), shape 1: the image dropped and the caption folded
  // back into the tool_result's content (3 -> 1), the reporter's literal rows
  const call = assistant([{ type: "tool_use", id: "tu_1", name: "Read", input: {} }])
  const saved = text("Displayed image saved to: /tmp/x.jpg")
  const closed = text("[system] last tab closed.")
  const folding = [user("look"), call, user([result("tu_1", [saved]), image(), closed])]
  assert.equal(droppedHoistedToolImages(folding, [user("look"), call, user([result("tu_1", [saved, closed])])]), true)
  // the caption folded as it was, or in two parts
  assert.equal(droppedHoistedToolImages(folding, [user("look"), call,
    user([result("tu_1", [saved, text("[system] last "), text("tab closed.\n")])])]), true)
  // other text folded in, the result's own text changed, text folded with no
  // caption to fold, text folded and the image kept, or a fold after a result
  // with no hoisted image
  assert.equal(droppedHoistedToolImages(folding, [user("look"), call,
    user([result("tu_1", [saved, text("[system] all tabs closed.")])])]), false)
  assert.equal(droppedHoistedToolImages(folding, [user("look"), call,
    user([result("tu_1", [text("Displayed image saved to: /tmp/y.jpg"), closed])])]), false)
  assert.equal(droppedHoistedToolImages(
    [user("look"), call, user([result("tu_1", [saved]), image()])],
    [user("look"), call, user([result("tu_1", [saved, closed])])]), false)
  assert.equal(droppedHoistedToolImages(folding, [user("look"), call,
    user([result("tu_1", [saved, closed]), image()])]), false)
  assert.equal(droppedHoistedToolImages(
    [user("look"), call, user([result("tu_1", [saved]), closed])],
    [user("look"), call, user([result("tu_1", [saved, closed])])]), false)

  // shape 2: magpie's gateway left the hoisted image out under a size cap
  // (body_cap.go imageLeftOut) and the client dropped the caption (3 -> 2)
  const leftOut = text("[An earlier image was left out here to keep this request under its size limit.]")
  const slimming = [user("look"), call, user([result("tu_1", [text("ok")]), image(), text("caption")])]
  assert.equal(droppedHoistedToolImages(slimming, [user("look"), call, user([result("tu_1", [text("ok")]), leftOut])]), true)
  // magpie's other placeholders for an image it left out
  for (const said of [
    "[An earlier image was omitted here to keep this request within the model's image limit.]",
    "[This image is omitted here; the same image appears again later in this conversation.]",
  ]) {
    assert.equal(droppedHoistedToolImages(slimming, [user("look"), call, user([result("tu_1", [text("ok")]), text(said)])]), true)
  }
  // one placeholder for each of three images, and an older image left out on
  // the same request (oldest first)
  assert.equal(droppedHoistedToolImages(
    [user("look"), call, user([result("tu_1"), image(), text("a"), image(), text("b"), image(), text("c")])],
    [user("look"), call, user([result("tu_1"), leftOut, leftOut, leftOut])]), true)
  assert.equal(droppedHoistedToolImages(
    [user([text("look"), image()]), call, user([result("tu_1", [text("ok")]), image(), text("caption")])],
    [user([text("look"), leftOut]), call, user([result("tu_1", [text("ok")]), leftOut])]), true)
  // a placeholder where there was no image, one too few or too many, the
  // caption changed beside it, the user's own text dropped beside it, or a
  // placeholder put back as an image
  assert.equal(droppedHoistedToolImages(
    [user("look"), call, user([result("tu_1", [text("ok")]), text("caption")])],
    [user("look"), call, user([result("tu_1", [text("ok")]), leftOut])]), false)
  assert.equal(droppedHoistedToolImages(
    [user("look"), call, user([result("tu_1"), image(), text("a"), image(), text("b")])],
    [user("look"), call, user([result("tu_1"), leftOut])]), false)
  assert.equal(droppedHoistedToolImages(slimming, [user("look"), call,
    user([result("tu_1", [text("ok")]), leftOut, leftOut])]), false)
  assert.equal(droppedHoistedToolImages(slimming, [user("look"), call,
    user([result("tu_1", [text("ok")]), leftOut, text("edited caption")])]), false)
  assert.equal(droppedHoistedToolImages(
    [user([text("look"), text("and keep this")]), call, user([result("tu_1", [text("ok")]), image(), text("caption")])],
    [user([text("look"), leftOut]), call, user([result("tu_1", [text("ok")]), leftOut])]), false)
  assert.equal(droppedHoistedToolImages(
    [user([text("look"), leftOut]), call, user([result("tu_1", [text("ok")]), image(), text("caption")])],
    [user([text("look"), image()]), call, user([result("tu_1", [text("ok")])])]), false)
  // magpie leaving the image out with the caption kept is the same history
  // already (sameHistoryUpToImages), as body_cap.go swaps the image in place
  assert.equal(sameHistoryUpToImages(slimming, [user("look"), call, user([result("tu_1", [text("ok")]), leftOut, text("caption")])]), true)
  assert.equal(sameHistoryUpToImages(slimming, [user("look"), call, user([result("tu_1", [text("ok")]), leftOut])]), false)

  const withReminder = [user([text("continue"), text("<system-reminder>hook</system-reminder>")])]
  assert.equal(droppedOneRequestReminder(
    [user([text("continue\n\n<system-reminder>\nhook\n</system-reminder>")])],
    [user([text("continue")])],
  ), true)
  assert.equal(droppedOneRequestReminder(
    [user([text("continue <system-reminder>a</system-reminder>b</system-reminder>")])],
    [user([text("continue")])],
  ), false)
  assert.equal(droppedOneRequestReminder(
    [user([text("continue"), text("<system-reminder>a</system-reminders>")])],
    [user([text("continue")])],
  ), false)
  assert.equal(droppedOneRequestReminder(withReminder, [user([text("continue")])]), true)
  assert.equal(droppedOneRequestReminder(
    [user([text("continue"), text("<system_message>hook</system_message>")])],
    [user([text("continue")])],
  ), true)
  assert.equal(droppedOneRequestReminder(
    [user([text("İ continue"), text("<system-reminder>hook</system-reminder>")])],
    [user([text("İ continue")])],
  ), true)
  assert.equal(droppedOneRequestReminder(
    [user([text("continue"), text("<system-reminder>one</system-reminder><system_message>two</system_message>")])],
    [user([text("continue")])],
  ), true)
  assert.equal(droppedOneRequestReminder(withReminder, [user([text("continue"), text("added")])]), false)
  assert.equal(droppedOneRequestReminder(
    [user([text("continue"), text("<system-reminder>hook</system-reminder>after")])],
    [user([text("continue")])],
  ), false)
  assert.equal(droppedOneRequestReminder(
    [user([text("continue"), text("<system-reminder>hook")])],
    [user([text("continue")])],
  ), false)
  assert.equal(droppedOneRequestReminder(
    [user([text("first"), text("<system-reminder>hook</system-reminder>")]), assistant([text("reply")]), user([text("next")])],
    [user([text("first")]), assistant([text("reply")]), user([text("next")])],
  ), false)
})

test("ordinary text removed from a plain user turn still starts a new session", async () => {
  const stderr = captureStderr()
  const kit = await createBridgeKit({})
  try {
    kit.defaultPrompt = async (agent) => {
      await agent.text(`reply ${agent.index}`)
      return { stopReason: "end_turn" }
    }
    const opening = { role: "user", content: "start the task" }
    const first = await readSse(await kit.request(baseBody({ messages: [opening] })))
    const firstReply = {
      role: "assistant",
      content: [{ type: "text", text: first.content.map((block) => block.text || "").join("") }],
    }
    const withOrdinaryText = await readSse(await kit.request(baseBody({ messages: [
      opening,
      firstReply,
      { role: "user", content: [{ type: "text", text: "continue the task" }, { type: "text", text: "ordinary extra text" }] },
    ] })))
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: withOrdinaryText.content.map((block) => block.text || "").join("") }],
    }
    await readSse(await kit.request(baseBody({ messages: [
      opening,
      firstReply,
      { role: "user", content: [{ type: "text", text: "continue the task" }] },
      assistant,
      { role: "user", content: "next step" },
    ] })))
    const sessions = stderr.lines.filter((row) => row.action === "session_new")
    assert.deepEqual(sessions.map((row) => row.reason), ["no_live", "history"], JSON.stringify(sessions))
  } finally {
    await kit.dispose()
    stderr.restore()
  }
})

for (const [name, stored] of [
  // 3 -> 1
  ["dropped", (result) => [result]],
  // 3 -> 1, the caption folded back into the result (plugins#1556 shape 1)
  ["folded back", (result, caption) => [{ ...result, content: [{ type: "text", text: result.content }, caption] }]],
  // 3 -> 2, magpie's placeholder for the image, the caption gone (shape 2)
  ["left out by magpie", (result) => [result, text("[An earlier image was left out here to keep this request under its size limit.]")]],
]) test(`a hoisted tool image and caption ${name} keep the live ACP session`, async () => {
  const stderr = captureStderr()
  const kit = await createBridgeKit({ promptImages: true })
  try {
    kit.defaultPrompt = async (agent) => {
      if (agent.index === 0) {
        await agent.tool("Read", { path: "/repo/screenshot.png" })
        return { stopReason: "tool_use" }
      }
      await agent.text("the screenshot is attached")
      return { stopReason: "end_turn" }
    }

    const openingText = "inspect the screenshot"
    const opening = { role: "user", content: openingText }
    const first = await readSse(await kit.request(baseBody({ messages: [opening] })))
    const call = first.content.find((block) => block.type === "tool_use")
    assert.ok(call)
    const assistantCall = { role: "assistant", content: [call] }
    const result = { type: "tool_result", tool_use_id: call.id, content: "saved /repo/screenshot.png" }
    const caption = { type: "text", text: "Screenshot: settings panel" }
    const hoisted = [
      opening,
      assistantCall,
      {
        role: "user",
        content: [
          result,
          image(),
          caption,
        ],
      },
    ]
    const second = await readSse(await kit.request(baseBody({ messages: hoisted })))
    assert.equal(second.stopReason, "end_turn")
    const assistantReply = {
      role: "assistant",
      content: second.content.map((block) => block.type === "text"
        ? { type: "text", text: block.text }
        : block),
    }
    const canonical = [
      opening,
      assistantCall,
      { role: "user", content: stored(result, caption) },
      assistantReply,
      { role: "user", content: "what changed?" },
    ]
    const third = await readSse(await kit.request(baseBody({ messages: canonical })))
    assert.equal(third.stopReason, "end_turn")
    const drops = stderr.lines.filter((row) => row.action === "drop_live")
    assert.deepEqual(drops, [], JSON.stringify(drops))
    assert.equal(kit.acpLog.filter((entry) => entry.method === "session/new").length, 1, JSON.stringify(stderr.lines))
  } finally {
    await kit.dispose()
    stderr.restore()
  }
})

for (const [name, tag] of [
  ["system-reminder", "system-reminder"],
  ["system_message", "system_message"],
]) {
  test(`a dropped one-request <${tag}> gateway block keeps the live ACP session`, async () => {
    const stderr = captureStderr()
    const kit = await createBridgeKit({})
    try {
      kit.defaultPrompt = async (agent) => {
        await agent.text(`reply ${agent.index}`)
        return { stopReason: "end_turn" }
      }

      const opening = { role: "user", content: "start the task" }
      const first = await readSse(await kit.request(baseBody({ messages: [opening] })))
      const firstReply = {
        role: "assistant",
        content: [{ type: "text", text: first.content.map((block) => block.text || "").join("") }],
      }
      const prompt = { type: "text", text: "continue the task" }
      const hook = {
        type: "text",
        text: `<${tag}>\nHook context for ${name}\n</${tag}>`,
      }
      const second = await readSse(await kit.request(baseBody({ messages: [
        opening,
        firstReply,
        { role: "user", content: [prompt, hook] },
      ] })))
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: second.content.map((block) => block.text || "").join("") }],
      }
      const third = await readSse(await kit.request(baseBody({ messages: [
        opening,
        firstReply,
        { role: "user", content: [prompt] },
        assistant,
        { role: "user", content: "next step" },
      ] })))
      assert.equal(third.stopReason, "end_turn")
      const drops = stderr.lines.filter((row) => row.action === "drop_live")
      assert.deepEqual(drops, [], JSON.stringify(drops))
      assert.equal(kit.acpLog.filter((entry) => entry.method === "session/new").length, 1, JSON.stringify(stderr.lines))
    } finally {
      await kit.dispose()
      stderr.restore()
    }
  })
}
