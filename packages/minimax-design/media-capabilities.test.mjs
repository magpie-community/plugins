import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { enrichMediaParameters, mediaCapability, mediaSpec } from "./media-capabilities.mjs"

const source = fs.readFileSync(new URL("./media.adapter.js", import.meta.url), "utf8")
const image = { dataUrl: "data:image/png;base64,AA==" }

async function configured(ref, type, extra = {}) {
  const model = { ref, type, images: true, ...extra }
  const capability = mediaCapability(model)
  const generated = source.replace("const capability = null", () => `const capability = ${JSON.stringify(capability)}`)
  const adapter = await import(`data:text/javascript;base64,${Buffer.from(generated).toString("base64")}`)
  return { capability, submit: (params = {}, images = []) => adapter.buildSubmit({ type, model: ref, prompt: "test", params, images }) }
}

test("known image settings use gateway fields, automatic omits overrides and supports sixteen references", async () => {
  const { submit, capability } = await configured("minimax-code/MiniMax-Image", "image")
  assert.equal(mediaSpec(capability).references.image.max, 16)
  const defaults = submit({ ratio: "自动", resolution: "自动" })
  assert.equal(defaults.body.size, undefined)
  assert.equal(defaults.body.quality, undefined)
  const edit = submit({ ratio: "16:9", resolution: "2K" }, Array(16).fill(image))
  assert.equal(edit.body.size, "16:9")
  assert.equal(edit.body.quality, "medium")
  assert.equal(edit.body.images.length, 16)
  assert.throws(() => submit({}, Array(17).fill(image)), /数量/)
  assert.throws(() => submit({ resolution: "8K" }), /不支持参数/)
})

test("Hailuo exposes only legal duration-resolution pairs and rejects stale parameters", async () => {
  const { submit, capability } = await configured("minimax-code/MiniMax-Hailuo-2.3", "video")
  assert.deepEqual(capability.params[0].enum, ["自动", "768P · 6秒", "768P · 10秒", "1080P · 6秒"])
  assert.equal(submit({ preset: "1080P · 6秒" }).body.size, "1080P")
  assert.equal(submit({ preset: "1080P · 6秒" }).body.seconds, "6")
  assert.throws(() => submit({ preset: "1080P · 10秒" }), /不支持参数/)
  assert.throws(() => submit({ seconds: 10 }), /不支持参数/)
  assert.throws(() => submit({}, [image, image]), /数量/)
})

test("H3 automatically selects first frame or subjects, Max selects ordered frames", async () => {
  const h3 = await configured("minimax-code/MiniMax-H3", "video")
  assert.equal(h3.submit({}, [image]).body.input_reference, image.dataUrl)
  assert.equal(h3.submit({}, [image, image]).body.reference_images.length, 2)
  assert.equal(h3.submit({ referenceMode: "首尾帧" }, [image, image]).body.last_frame, image.dataUrl)
  assert.throws(() => h3.submit({ referenceMode: "首尾帧" }, [image]), /两张/)
  assert.throws(() => h3.submit({ referenceMode: "主体参考" }), /需要参考图/)
  assert.throws(() => h3.submit({ ratio: "16:9" }, [image]), /自动沿用/)
  assert.equal(h3.submit({ seconds: 4, resolution: "2K" }).body.size, "2K")
  assert.throws(() => h3.submit({ seconds: 3 }), /不支持参数/)
  assert.throws(() => h3.submit({ seconds: 6.5 }), /不支持参数/)
  const max = await configured("minimax-code/MiniMax-H3-Max", "video")
  assert.equal(max.submit({}, [image, image]).body.last_frame, image.dataUrl)
  assert.throws(() => max.submit({ referenceMode: "主体参考" }, [image]), /不支持参数/)
})

test("Grok uses pixel size transport and guards duration and reference combinations", async () => {
  const original = await configured("grok/grok-imagine-video", "video")
  assert.equal(original.submit({ ratio: "9:16", resolution: "720p" }).body.size, "720x1280")
  assert.equal(original.submit({}, [image, image]).body.reference_images.length, 2)
  assert.throws(() => original.submit({ seconds: 11 }, [image, image]), /最多支持 10/)
  assert.throws(() => original.submit({ resolution: "1080p" }), /不支持参数/)
  const newer = await configured("remote-magpie/grok/grok-imagine-video-1.5", "video", { owner: "remote-magpie" })
  assert.equal(newer.submit({ ratio: "16:9", resolution: "1080p", seconds: 15 }).body.size, "1920x1080")
  assert.throws(() => newer.submit({ resolution: "1080p", ratio: "16:9" }, [image, image]), /最高支持 720p/)
  assert.throws(() => newer.submit({ resolution: "720p" }, [image]), /同时选择比例/)
  assert.throws(() => newer.submit({}, Array(15).fill(image)), /数量/)
})

test("discovery modalities win over vendor references and aliases do not inherit guessed profiles", async () => {
  const qwen = await configured("qwen-cn/qwen-image-3.0-pro", "image", { images: false })
  assert.equal(qwen.submit({ size: "1664x928" }).body.size, "1664x928")
  assert.throws(() => qwen.submit({ size: "16:9" }), /不支持参数/)
  assert.throws(() => qwen.submit({}, [image]), /数量/)
  const unknown = await configured("remote-magpie/auto/gpt-image-2", "image", { owner: "remote-magpie" })
  assert.equal(unknown.capability.source, "unknown")
  assert.equal(unknown.submit().body.size, undefined)
  const gemini = await configured("rightimage/gemini-nano-banana-2.1", "image")
  assert.equal(gemini.capability.params.length, 0)
  assert.throws(() => gemini.submit({ size: "2048x1152" }), /不支持参数/)
})

test("Magpie parameter enums and limits override verified defaults", async () => {
  const { capability, submit } = await configured("minimax-code/MiniMax-Image", "image", {
    parameters: { aspect_ratio: { type: "enum", values: ["1:1"] }, resolution: { type: "enum", values: ["2K"] },
      input_references: { type: "range", min: 0, max: 3 } },
  })
  assert.equal(capability.source, "magpie")
  assert.throws(() => submit({ ratio: "16:9" }), /不支持参数/)
  assert.equal(submit({ resolution: "2K" }).body.quality, "medium")
  assert.throws(() => submit({}, Array(4).fill(image)), /数量/)
  const custom = await configured("custom/video", "video", { parameters: { seconds: { type: "enum", values: [4, 8] } } })
  assert.equal(custom.submit({ seconds: 8 }).body.seconds, "8")
  assert.throws(() => custom.submit({ seconds: 6 }), /不支持参数/)
  assert.throws(() => mediaCapability({ ref: "custom/image", type: "image", parameters: { size: { type: "enum", values: [] } } }), /schema/)
  const automatic = await configured("grok/grok-imagine-video", "video", {
    parameters: { aspect_ratio: { type: "enum", values: ["auto", "16:9"] } },
  })
  assert.equal(automatic.submit({ ratio: "auto", resolution: "720p" }).body.size, "1280x720")
  assert.throws(() => mediaCapability({ ref: "grok/grok-imagine-video", type: "video",
    parameters: { aspect_ratio: { type: "enum", values: ["0:0"] } } }), /aspect ratio/)
})

test("OpenRouter refresh intersects endpoints, keeps credentials local and projects only faithful options", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, "https://openrouter.ai/api/v1/images/models/vendor/image/endpoints")
    assert.equal(options.headers, undefined)
    return { ok: true, json: async () => ({ endpoints: [10, 6].map((max) => ({ supported_parameters: {
      aspect_ratio: { type: "enum", values: ["16:9", "4:5", "1:1", "auto"] },
      resolution: { type: "enum", values: ["1K", "1.5K", "2K"] }, input_references: { type: "range", min: 0, max },
    } })) }) }
  }
  try {
    const [model] = await enrichMediaParameters([{ ref: "openrouter/vendor/image", owner: "openrouter", type: "image", images: true }])
    const capability = mediaCapability(model)
    assert.equal(capability.references.max, 6)
    assert.equal(capability.source, "openrouter-endpoints")
    assert.equal(capability.presets["16:9 · 2K"].size, "2048x1152")
    assert.equal(capability.presets["4:5 · 2K"], undefined)
    assert.equal(capability.presets["16:9 · 1.5K"], undefined)
    await enrichMediaParameters([{ ...model, parameters: { size: { type: "enum", values: ["1024x1024"] } } }])
    assert.equal(calls, 1)
    globalThis.fetch = async () => ({ ok: false, status: 503 })
    await assert.rejects(enrichMediaParameters([{ ...model, parameters: undefined }]), /503/)
  } finally { globalThis.fetch = original }
})
