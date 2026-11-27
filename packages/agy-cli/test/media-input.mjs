// A user's video or audio reaches Gemini through agy's own view_file: agy's
// ACP prompt carries neither, so the bridge writes each to a file in the
// session's folder and asks the model to read it there. view_file is the
// agent's tool only while the conversation carries one.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { BASE_MODEL_ROWS, baseBody, createBridgeKit, readSse, sleep, tick, usageTotal } from "./testkit.mjs"

const MP4 = Buffer.concat([Buffer.from("000000186674797069736f6d", "hex"), Buffer.from("a video's bytes")])
const MP3 = Buffer.concat([Buffer.from("494433", "hex"), Buffer.from("an audio's bytes")])
const media = (type, bytes, mediaType) => ({ type, source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } })
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

async function withKit(fn, options) {
  const kit = await createBridgeKit(options)
  try {
    kit.defaultPrompt = async (agent) => { await agent.text("ok"); return { stopReason: "end_turn" } }
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

const prompts = (kit) => kit.acpLog.filter((entry) => entry.method === "session/prompt")
const promptText = (entry) => entry.params.prompt.map((part) => part.text ?? "").join("")
const workspaceOf = (kit, entry) => kit.acpSpawns[entry.spawn].cwd
const agentTools = (kit, entry) => /^tools: .*$/m.exec(fs.readFileSync(
  path.join(workspaceOf(kit, entry), ".agents", "agents", "magpie-bridge", "agent.md"), "utf8"))[0]
const reply = async (response) => ({ role: "assistant", content: (await readSse(response)).content.map((block) => ({ type: "text", text: block.text })) })

test("a video and an audio go to agy as files in the session's folder, named by their sha256", async () => {
  await withKit(async (kit) => {
    const first = baseBody({ messages: [{ role: "user", content: [
      media("video", MP4, "video/mp4"), media("audio", MP3, "audio/mpeg"), { type: "text", text: "what is said?" }] }] })
    const answer = await reply(await kit.request(first))
    const sent = prompts(kit).at(-1)
    const attachments = path.join(workspaceOf(kit, sent), "attachments")
    const video = path.join(attachments, `${sha256(MP4)}.mp4`)
    const audio = path.join(attachments, `${sha256(MP3)}.mp3`)
    assert.deepEqual(sent.params.prompt.map((part) => part.type), ["text"])
    const text = promptText(sent)
    assert.ok(text.includes(`[The user attached a video: ${video}. Read it with your file reading tool before answering.]`), text)
    assert.ok(text.includes(`[The user attached an audio file: ${audio}. Read it with your file reading tool before answering.]`), text)
    assert.ok(text.indexOf(video) < text.indexOf(audio) && text.indexOf(audio) < text.indexOf("what is said?"))
    assert.ok(!text.includes(MP4.toString("base64")))
    assert.deepEqual(fs.readFileSync(video), MP4)
    assert.deepEqual(fs.readFileSync(audio), MP3)

    // the history sends the video again: the same file, and the turn says only what is new
    const next = { ...first, messages: [...first.messages, answer, { role: "user", content: "and the number?" }] }
    await readSse(await kit.request(next))
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptText(prompts(kit).at(-1)).includes("attached"), false)
    assert.deepEqual(fs.readdirSync(attachments).sort(), [path.basename(video), path.basename(audio)].sort())
  })
})

test("a file's extension comes from its media type, else mp4 for a video and mp3 for an audio", async () => {
  await withKit(async (kit) => {
    const cases = [["video", "video/quicktime", "mov"], ["audio", "audio/x-wav", "wav"], ["video", "video/webm; codecs=vp9", "webm"],
      ["video", undefined, "mp4"], ["audio", "application/octet-stream", "mp3"]]
      .map(([type, mediaType, ext], i) => ({ type, mediaType, ext, bytes: Buffer.from(`clip ${i}`) }))
    await readSse(await kit.request(baseBody({ messages: [{ role: "user", content: [
      ...cases.map(({ type, bytes, mediaType }) => media(type, bytes, mediaType)), { type: "text", text: "compare them" }] }] })))
    const attachments = path.join(workspaceOf(kit, prompts(kit).at(-1)), "attachments")
    assert.deepEqual(fs.readdirSync(attachments).sort(), cases.map(({ bytes, ext }) => `${sha256(bytes)}.${ext}`).sort())
  })
})

test("view_file is agy's tool only in a conversation that carries a video or audio", async () => {
  await withKit(async (kit) => {
    const opening = baseBody({ messages: [{ role: "user", content: "hello" }] })
    const answer = await reply(await kit.request(opening))
    assert.equal(agentTools(kit, prompts(kit).at(-1)), "tools: []")

    // the conversation's first video: an agy whose agent has view_file, in
    // a new session; a resumed one keeps the tools it was opened with
    const withVideo = { ...opening, messages: [...opening.messages, answer,
      { role: "user", content: [media("video", MP4, "video/mp4"), { type: "text", text: "what is in it?" }] }] }
    await readSse(await kit.request(withVideo))
    assert.equal(kit.acpSpawns.length, 2)
    assert.equal(agentTools(kit, prompts(kit).at(-1)), "tools: [view_file]")
    assert.match(promptText(prompts(kit).at(-1)), /hello[\s\S]*The user attached a video/)

    // a request with no video never runs in an agy that has view_file
    const stateless = (content) => baseBody({ stream: false, tools: [], messages: [{ role: "user", content }] })
    const described = await kit.request(stateless([media("audio", MP3, "audio/mpeg"), { type: "text", text: "transcribe" }]))
    assert.equal(described.status, 200, await described.clone().text())
    assert.equal(agentTools(kit, prompts(kit).at(-1)), "tools: [view_file]")
    const describedIn = prompts(kit).at(-1).spawn
    const plain = await kit.request(stateless("write a title"))
    assert.equal(plain.status, 200, await plain.clone().text())
    assert.equal(agentTools(kit, prompts(kit).at(-1)), "tools: []")
    const again = await kit.request(stateless([media("video", MP4, "video/mp4"), { type: "text", text: "describe it" }]))
    assert.equal(again.status, 200, await again.clone().text())
    assert.equal(agentTools(kit, prompts(kit).at(-1)), "tools: [view_file]")
    // nor in one whose folder holds another conversation's clip
    assert.notEqual(prompts(kit).at(-1).spawn, describedIn)
  }, { sessionResume: true })
})

// view_file reads unasked what is under an --add-dir folder and in agy's
// temp folder: a video must not open the caller's named folder, or /tmp
// with every other session's workspace in it, to the model
test("an agy for a video gets no --add-dir, and its temp folder is its workspace", async () => {
  await withKit(async (kit) => {
    const dir = path.join(kit.tmp, "project")
    fs.mkdirSync(dir)
    const ask = async (content) => {
      await readSse(await kit.request(baseBody({ messages: [{ role: "user", content }] }), { headers: { "x-magpie-work-dir": dir } }))
      return kit.acpSpawns[prompts(kit).at(-1).spawn]
    }
    const plain = await ask("hello")
    const video = await ask([media("video", MP4, "video/mp4"), { type: "text", text: "what is in it?" }])
    assert.notEqual(plain, video)
    assert.equal(plain.args[plain.args.indexOf("--add-dir") + 1], dir)
    assert.equal(video.args.includes("--add-dir"), false)
    assert.deepEqual([video.env.TMPDIR, video.env.TMP, video.env.TEMP], [video.cwd, video.cwd, video.cwd])
    assert.notEqual(plain.env.TMPDIR, plain.cwd)
  })
})

test("a flattened opening that grows by a video sends the new one as a file too", async () => {
  await withKit(async (kit) => {
    const opening = "Please look at the clip and say what happens.\nstep one"
    const clip = Buffer.concat([MP4, Buffer.from(" and more")])
    const first = baseBody({ messages: [{ role: "user", content: [media("video", MP4, "video/mp4"), { type: "text", text: opening }] }] })
    const answer = (await reply(await kit.request(first))).content[0].text
    await readSse(await kit.request(baseBody({ messages: [{ role: "user", content: [media("video", MP4, "video/mp4"),
      { type: "text", text: `${opening}\n\nassistant: ${answer}\n\nstep two, a second clip` }, media("video", clip, "video/mp4")] }] })))
    // the same agy goes on with the opening's new part alone
    assert.equal(kit.acpSpawns.length, 1)
    const sent = prompts(kit).at(-1)
    const file = path.join(workspaceOf(kit, sent), "attachments", `${sha256(clip)}.mp4`)
    assert.equal(promptText(sent), `step two, a second clip[The user attached a video: ${file}. Read it with your file reading tool before answering.]`)
  })
})

test("a video conversation's files go with its agy, and its parked session resumes with view_file and the file again", async () => {
  await withKit(async (kit) => {
    const opening = baseBody({ messages: [{ role: "user", content: [media("video", MP4, "video/mp4"), { type: "text", text: "what is in it?" }] }] })
    const answer = await reply(await kit.request(opening))
    const first = prompts(kit).at(-1)
    const video = path.join(workspaceOf(kit, first), "attachments", `${sha256(MP4)}.mp4`)
    for (const proc of [...kit.module.__agyTestAllProcs]) await proc.stop()
    assert.equal(fs.existsSync(path.dirname(video)), false)

    await readSse(await kit.request({ ...opening, messages: [...opening.messages, answer, { role: "user", content: "and the colour?" }] }))
    assert.deepEqual(kit.acpLog.filter((entry) => entry.method === "session/resume").map((entry) => entry.params.sessionId), [first.sessionId])
    assert.equal(agentTools(kit, prompts(kit).at(-1)), "tools: [view_file]")
    assert.deepEqual(fs.readFileSync(video), MP4)
  }, { sessionResume: true })
})

test("a session parked by a host from before video resumes for a conversation with none", async () => {
  await withKit(async (kit) => {
    const opening = baseBody({ messages: [{ role: "user", content: "hello" }] })
    const answer = await reply(await kit.request(opening))
    const first = prompts(kit).at(-1)
    for (const proc of [...kit.module.__agyTestAllProcs]) await proc.stop()
    // the old host parked the conversation's last turn: its entry has no media
    const file = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "sessions.json")
    const state = JSON.parse(fs.readFileSync(file, "utf8"))
    for (const entry of state.entries) { delete entry.media; entry.at++ }
    fs.writeFileSync(file, JSON.stringify(state))

    await readSse(await kit.request({ ...opening, messages: [...opening.messages, answer, { role: "user", content: "and then?" }] }))
    assert.deepEqual(kit.acpLog.filter((entry) => entry.method === "session/resume").map((entry) => entry.params.sessionId), [first.sessionId])
  }, { sessionResume: true })
})

test("a spare agy, warmed without view_file, waits for a conversation with no video", async () => {
  await withKit(async (kit) => {
    await readSse(await kit.request(baseBody({ system: "one", messages: [{ role: "user", content: "hello" }] })))
    // spawn 1 is the spare
    for (let i = 0; i < 2000 && kit.acpSpawns.length < 2; i++) await sleep(5)
    assert.equal(kit.acpSpawns.length, 2)

    await readSse(await kit.request(baseBody({ system: "two", messages: [{ role: "user", content: [media("video", MP4, "video/mp4"), { type: "text", text: "what is in it?" }] }] })))
    assert.equal(prompts(kit).at(-1).spawn, 2)
    assert.equal(agentTools(kit, prompts(kit).at(-1)), "tools: [view_file]")
    await readSse(await kit.request(baseBody({ system: "three", messages: [{ role: "user", content: "hi" }] })))
    assert.equal(prompts(kit).at(-1).spawn, 1)
  }, { env: { AGY_BRIDGE_SPARE: "1" } })
})

test("a video by URL is refused before agy, and a video counts as an image does, in count_tokens and in a turn's usage", async () => {
  await withKit(async (kit) => {
    const byUrl = await kit.request(baseBody({ stream: false, messages: [{ role: "user", content: [
      { type: "video", source: { type: "url", url: "https://example.com/clip.mp4" } }, { type: "text", text: "what is in it?" }] }] }))
    assert.equal(byUrl.status, 400)
    assert.match(await byUrl.text(), /a video source other than base64/)
    assert.equal(kit.acpSpawns.length, 0)

    const big = Buffer.alloc(300_000, 7)
    const body = (type, mediaType) => baseBody({ tools: [], messages: [{ role: "user", content: [media(type, big, mediaType), { type: "text", text: "hi" }] }] })
    const counted = await kit.countTokens(body("video", "video/mp4"))
    assert.equal(counted, await kit.countTokens(body("image", "image/png")))
    // the note in the video's place is no history cut from the prompt
    assert.equal(usageTotal((await readSse(await kit.request(body("video", "video/mp4")))).usage), counted)
  })
})

// claude-haiku stands in for Gemini Flash, but agy runs Haiku itself when its session offers it
test("a video to a model other than Gemini is refused before agy", async () => {
  await withKit(async (kit) => {
    for (const model of ["claude-opus-5-5", "claude-haiku-4-5"]) {
      const response = await kit.request(baseBody({ model: `agy-cli/${model}`, stream: false, messages: [{ role: "user", content: [
        media("video", MP4, "video/mp4"), { type: "text", text: "what is in it?" }] }] }))
      assert.equal(response.status, 400)
      assert.equal(response.headers.get("x-should-retry"), "false")
      const body = await response.json()
      assert.equal(body.error.type, "invalid_request_error")
      assert.equal(body.error.message, `agy bridge: video or audio input to ${model} is not supported. Choose a Gemini model`)
    }
    assert.equal(kit.acpSpawns.length, 0)
  })
})

test("Gemini models take video and audio; Claude and GPT-OSS don't", async () => {
  await withKit(async (kit) => {
    await kit.models()
    // the probe session says what agy offers
    for (let i = 0; i < 20 && kit.children.size; i++) await sleep(10)
    await tick()
    const models = await kit.models()
    assert.deepEqual(models["gemini-4-argon"].capabilities.input, { text: true, image: true, video: true, audio: true })
    assert.deepEqual(models["gemini-3.8-flash"].capabilities.input, { text: true, image: true, video: true, audio: true })
    assert.deepEqual(models["claude-opus-5-5"].capabilities.input, { text: true, image: true })
    assert.equal(models["gpt-oss-120b"].capabilities.input, undefined)
  }, { offeredModels: BASE_MODEL_ROWS })
})
