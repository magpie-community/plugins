// plugins#1527 (Pisces233): an image whose base64 is valid but whose bytes
// are no image reached Gemini, which answered 400 "Unable to process input
// image" as the reply's text. An image whose bytes are another of the four
// types than it was labelled (a JPEG sent as image/png) goes as what it is.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { MESSAGES_URL, baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

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

test("retained image references need the exact live account and session before a tool can be answered", async () => {
  await withKit(async (kit) => {
    const header = { "x-magpie-session": "history-owner" }
    const body = baseBody({ messages: [{ role: "user", content: [image(PNG), { type: "text", text: "read the file" }] }] })
    let delivered = 0
    kit.defaultPrompt = async (agent) => {
      await agent.tool("Read", { path: "/repo/file" })
      delivered++
      await agent.text("continued the pending call")
      return { stopReason: "end_turn" }
    }
    const response = await kit.request(body, { headers: header })
    const lease = response.headers.get("x-magpie-agy-history-lease")
    assert.ok(lease)
    const first = await readSse(response)
    assert.equal(first.stopReason, "tool_use")
    assert.deepEqual(promptImages(kit).map(part => part.data), [PNG])
    const full = continueWithToolResults(body, first, () => "result")
    const key = "0123456789abcdef0123456789abcdef"
    const ref = Symbol.for("magpie.agy.imageHistory")
    const sum = createHash("sha256").update(PNG).digest("hex")
    const sparse = structuredClone(full)
    const src = sparse.messages[0].content[0].source
    src.data = Buffer.from(key + ":" + sum).toString("base64")
    for (const [session, token, count] of [
      ["someone-else", lease, "1"],
      ["history-owner", "expired-lease", "1"],
      ["history-owner", lease, "2"],
    ]) {
      const failed = await kit.request(sparse, { headers: { "x-magpie-session": session }, [ref]: [token, key, count] })
      assert.equal(failed.status, 409)
      assert.equal(failed.headers.get("x-magpie-agy-history-missing"), "1")
    }
    const other = await kit.plugin.auth.loader(async () => ({ type: "oauth", metadata: { agyHome: "accountb1" } }))
    const crossAccount = await other.fetch(MESSAGES_URL, {
      method: "POST", headers: header, body: JSON.stringify(sparse), [ref]: [lease, key, "1"],
    })
    assert.equal(crossAccount.status, 409)
    assert.equal(crossAccount.headers.get("x-magpie-agy-history-missing"), "1")
    const corrupt = structuredClone(sparse)
    corrupt.messages[0].content[0].source.data = Buffer.from(key + ":" + "f".repeat(64)).toString("base64")
    assert.equal((await kit.request(corrupt, { headers: header, [ref]: [lease, key, "1"] })).status, 409)
    assert.equal(delivered, 0)
    const continued = await readSse(await kit.request(sparse, { headers: header, [ref]: [lease, key, "1"] }))
    assert.equal(continued.stopReason, "end_turn")
    assert.match(JSON.stringify(continued.content), /continued the pending call/)
    assert.equal(delivered, 1)
    assert.equal(kit.acpLog.filter(entry => entry.method === "session/prompt").length, 1)
  })
})

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
