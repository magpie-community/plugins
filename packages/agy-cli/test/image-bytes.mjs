// plugins#1527 (Pisces233): an image whose base64 is valid but whose bytes
// are no image reached Gemini, which answered 400 "Unable to process input
// image" as the reply's text. An image whose bytes are another of the four
// types than it was labelled (a JPEG sent as image/png) goes as what it is.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

const b64 = (hex, tail = "") => Buffer.concat([Buffer.from(hex, "hex"), Buffer.from(tail)]).toString("base64")
const JPEG = b64("ffd8ffe000104a4649460001", "jpeg body")
const PNG = b64("89504e470d0a1a0a0000000d49484452", "png body")
const TEXT = Buffer.from("hello, a text file labelled image/png").toString("base64")
const image = (data, mediaType = "image/png") => ({ type: "image", source: { type: "base64", media_type: mediaType, data } })

async function withKit(fn) {
  const kit = await createBridgeKit({ promptImages: true })
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

const promptImages = (kit) => (kit.acpLog.filter((entry) => entry.method === "session/prompt").at(-1)?.params?.prompt || [])
  .filter((part) => part.type === "image")

test("a user's JPEG labelled image/png goes as image/jpeg", async () => {
  await withKit(async (kit) => {
    kit.defaultPrompt = async (agent) => { await agent.text("a cat"); return { stopReason: "end_turn" } }
    const response = await kit.request(baseBody({ stream: false, messages: [{ role: "user", content: [image(JPEG), { type: "text", text: "what is it" }] }] }))
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(promptImages(kit).map((part) => [part.mimeType, part.data]), [["image/jpeg", JPEG]])
  })
})

test("a user's image whose bytes are no image is refused before agy", async () => {
  await withKit(async (kit) => {
    for (const data of [TEXT, "AAAA"]) {
      const response = await kit.request(baseBody({ stream: false, messages: [{ role: "user", content: [image(data), { type: "text", text: "what is it" }] }] }))
      const text = await response.text()
      assert.equal(response.status, 400, text)
      assert.match(text, /not an image/)
    }
    assert.equal(kit.acpLog.filter((entry) => entry.method === "session/prompt").length, 0)
  })
})

test("a tool's images go to agy as their bytes say, and one that is no image becomes a note", async () => {
  await withKit(async (kit) => {
    let reply
    kit.defaultPrompt = async (agent) => {
      if (reply) { await agent.text("done"); return { stopReason: "end_turn" } }
      reply = await agent.tool("Read", { path: "/repo/shot.png" })
      await agent.text("seen")
      return { stopReason: "end_turn" }
    }
    const body = baseBody({ messages: [{ role: "user", content: "look at shot.png" }] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    const next = continueWithToolResults(body, first, () => [image(JPEG), image(PNG, "image/jpeg"), image(TEXT), image("AAAA", "image/webp")])
    const result = await readSse(await kit.request(next))
    assert.ok(!result.error, JSON.stringify(result.error))
    // agy takes a tool's images in the next prompt (IMAGE_FOLLOWS)
    const sent = kit.acpLog.filter((entry) => entry.method === "session/prompt").flatMap((entry) => entry.params.prompt || [])
    assert.deepEqual(sent.filter((part) => part.type === "image").map((part) => part.mimeType), ["image/jpeg", "image/png"])
    const content = reply.result.content
    const notes = content.filter((part) => part.type === "text" && /could not be read/.test(part.text)).map((part) => part.text)
    assert.equal(notes.length, 2, JSON.stringify(content))
    assert.match(notes[0], /image\/png/)
    assert.match(notes[1], /image\/webp/)
  })
})

test("a -preview flash id goes to the account's flash model; an -image one does not", async () => {
  await withKit(async (kit) => {
    kit.defaultPrompt = async (agent) => { await agent.text("ok"); return { stopReason: "end_turn" } }
    const preview = await kit.request(baseBody({ stream: false, model: "agy-cli/gemini-3.1-flash-lite-preview" }))
    assert.equal(preview.status, 200, await preview.clone().text())
    const flash = kit.setModels.at(-1)
    assert.match(flash ?? "", /^gemini-[0-9.]+-flash-(?:low|high)$/)
    const before = kit.setModels.length
    await (await kit.request(baseBody({ stream: false, model: "agy-cli/gemini-3.1-flash-image" }))).text()
    assert.ok(!kit.setModels.slice(before).includes(flash), JSON.stringify(kit.setModels.slice(before)))
  })
})

test("a user image is validated and hashed once per parsed block within a turn and on continuation", async () => {
  const largePng = b64("89504e470d0a1a0a0000000d49484452", "x".repeat(2048))
  const kit = await createBridgeKit({
    promptImages: true,
    sessionResume: true,
    agentVersion: "1.5.17",
    indexTransform: (source) => {
      const prelude =
        "const __imgCounts = { imageContent: 0, imageDigest: 0 };\n" +
        "export function __resetImageCounts() { __imgCounts.imageContent = 0; __imgCounts.imageDigest = 0; }\n" +
        "export function __getImageCounts() { return { ...__imgCounts }; }\n"
      return prelude + source
        .replace("function imageContent(block) {", "function imageContent(block) { __imgCounts.imageContent++;")
        .replace("function digest(value) {", `function digest(value) { if (value === ${JSON.stringify(largePng)}) __imgCounts.imageDigest++;`)
    },
  })
  try {
    kit.defaultPrompt = async (agent) => { await agent.text("ok"); return { stopReason: "end_turn" } }
    const firstBody = baseBody({ messages: [{ role: "user", content: [image(largePng), { type: "text", text: "describe" }] }] })
    kit.module.__resetImageCounts()
    const first = await readSse(await kit.request(firstBody))
    assert.equal(first.stopReason, "end_turn")
    assert.deepEqual(kit.module.__getImageCounts(), { imageContent: 1, imageDigest: 1 })

    const secondBody = JSON.parse(JSON.stringify({
      ...firstBody,
      messages: [
        ...firstBody.messages,
        { role: "assistant", content: first.content },
        { role: "user", content: "follow up" },
      ],
    }))
    kit.module.__resetImageCounts()
    const second = await readSse(await kit.request(secondBody))
    assert.equal(second.stopReason, "end_turn")
    assert.deepEqual(kit.module.__getImageCounts(), { imageContent: 1, imageDigest: 1 })
    assert.equal(kit.acpLog.filter((entry) => entry.method === "session/prompt").length, 2)
  } finally {
    await kit.dispose()
  }
})

test("cached user image parsing and digests invalidate on mutation and isolate callers", async () => {
  const kit = await createBridgeKit({
    promptImages: true,
    indexTransform: (source) => source + "\nexport { parseUserImage, userImageDigest }\n",
  })
  try {
    const { parseUserImage, userImageDigest } = kit.module
    const sha = (data) => createHash("sha256").update(data).digest("hex")
    const block = image(PNG)

    const first = parseUserImage(block)
    assert.deepEqual(first, { type: "image", data: PNG, mimeType: "image/png" })
    assert.equal(userImageDigest(block, first.data), sha(PNG))

    first.mimeType = "mutated"
    assert.equal(parseUserImage(block).mimeType, "image/png")

    block.source.data = JPEG
    const swapped = parseUserImage(block)
    assert.deepEqual(swapped, { type: "image", data: JPEG, mimeType: "image/jpeg" })
    assert.equal(userImageDigest(block, swapped.data), sha(JPEG))

    block.source.media_type = "image/bmp"
    assert.throws(() => parseUserImage(block), /PNG, JPEG, GIF or WebP/)

    block.source.media_type = "image/jpeg"
    block.source.type = "url"
    assert.throws(() => parseUserImage(block), /other than base64/)

    block.source.type = "base64"
    block.source.data = TEXT
    assert.throws(() => parseUserImage(block), /not an image/)
    assert.throws(() => parseUserImage(block), /not an image/)

    block.source.data = PNG
    assert.equal(parseUserImage(block).mimeType, "image/png")
    assert.equal(userImageDigest(block, PNG), sha(PNG))
  } finally {
    await kit.dispose()
  }
})
