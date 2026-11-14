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
  return { capability, submit: (params = {}, images = []) => adapter.buildSubmit({ type, model: ref, prompt: "test",
    params: Object.fromEntries(Object.entries(params).map(([key, value]) => {
      if (key === "ratio") return ["aspect_ratio", value]
      if (key === "seconds") return ["duration", String(value)]
      if (key === "referenceMode") return ["image_mode", { "首帧": "first-last-frame", "首尾帧": "first-last-frame", "主体参考": "reference" }[value] ?? value]
      return [key, value]
    })), images }) }
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
  assert.deepEqual(capability.params[0].enum, ["自动", "768P", "1080P"])
  assert.equal(submit({ resolution: "1080P", duration: "6" }).body.size, "1080P")
  assert.equal(submit({ resolution: "1080P", duration: "6" }).body.seconds, "6")
  assert.throws(() => submit({ resolution: "1080P", duration: "10" }), /只支持 6/)
  assert.throws(() => submit({ preset: "1080P · 6秒" }), /不支持参数/)
  assert.throws(() => submit({}, [image, image]), /数量/)
})

test("H3 automatically selects first frame or subjects, Max selects ordered frames", async () => {
  const h3 = await configured("minimax-code/MiniMax-H3", "video")
  assert.equal(h3.submit({}, [image]).body.input_reference, image.dataUrl)
  assert.equal(h3.submit({}, [image, image]).body.reference_images.length, 2)
  assert.equal(h3.submit({ referenceMode: "首尾帧" }, [image, image]).body.last_frame, image.dataUrl)
  assert.equal(h3.submit({ referenceMode: "首尾帧" }, [image]).body.input_reference, image.dataUrl)
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
  assert.equal(qwen.submit({ aspect_ratio: "16:9" }).body.size, "1664x928")
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
    assert.equal(url, "https://openrouter.ai/api/v1/images/models/bytedance-seed/seedream-5-5/endpoints")
    assert.equal(options.headers, undefined)
    return { ok: true, json: async () => ({ endpoints: [10, 6].map((max) => ({ supported_parameters: {
      aspect_ratio: { type: "enum", values: ["16:9", "4:5", "1:1", "auto"] },
      resolution: { type: "enum", values: ["1K", "1.5K", "2K"] }, input_references: { type: "range", min: 0, max },
    } })) }) }
  }
  try {
    const [model] = await enrichMediaParameters([{ ref: "openrouter/bytedance-seed/seedream-5-5", owner: "openrouter", type: "image", images: true, imageOnly: true }])
    const capability = mediaCapability(model)
    assert.equal(capability.references.max, 6)
    assert.equal(capability.source, "openrouter-endpoints")
    assert.deepEqual(capability.params.map((parameter) => parameter.key), ["aspect_ratio", "resolution"])
    assert.deepEqual(capability.params[1].enum, ["自动", "2K"])
    await enrichMediaParameters([{ ...model, parameters: { size: { type: "enum", values: ["1024x1024"] } } }])
    assert.equal(calls, 2)
    globalThis.fetch = async () => ({ ok: false, status: 503 })
    await assert.rejects(enrichMediaParameters([{ ...model, parameters: undefined }]), /503/)
  } finally { globalThis.fetch = original }
})

test("OpenRouter chat image routes expose ratios without ineffective pixel resolution presets", async () => {
  for (const upstream of ["google/gemini-3-pro-image-preview", "openai/gpt-5-image", "vendor/new-image"]) {
    const { capability, submit } = await configured(`openrouter/${upstream}`, "image", {
      owner: "openrouter", parameters: { aspect_ratio: { type: "enum", values: ["16:9", "1:1"] },
        resolution: { type: "enum", values: ["2K"] } },
    })
    assert.deepEqual(capability.params[0].enum, ["自动", "16:9", "1:1"])
    assert.equal(submit({ aspect_ratio: "16:9" }).body.size, "16:9")
    assert.throws(() => submit({ aspect_ratio: "16:9", resolution: "2K" }), /不支持参数/)
  }
})

test("video count metadata cannot promise reference modes the adapter cannot submit", async () => {
  const parameters = { input_references: { type: "range", min: 0, max: 4 } }
  const unknown = await configured("custom/video", "video", { parameters })
  assert.deepEqual(mediaSpec(unknown.capability).references.image, { min: 0, max: 1 })
  assert.equal(unknown.submit({}, [image]).body.input_reference, image.dataUrl)
  assert.throws(() => unknown.submit({}, [image, image]), /数量/)
  const known = await configured("minimax-code/MiniMax-H3-Max", "video", { images: false, parameters })
  assert.equal(known.capability.references.max, 2)
  assert.equal(known.submit({}, [image, image]).body.last_frame, image.dataUrl)
  assert.throws(() => mediaCapability({ ref: "custom/video", type: "video", images: true,
    parameters: { input_references: { type: "range", min: 2, max: 4 } } }), /verified gateway mapping/)
})

test("reference schemas survive incomplete modalities independently of provider or model names", async () => {
  const model = await configured("renamed-source/new-image-model", "image", {
    images: false, parameters: { input_references: { type: "range", min: 0, max: 4 } },
  })
  assert.equal(model.capability.references.max, 4)
  const request = model.submit({}, Array(4).fill(image))
  assert.equal(request.path, "/images/edits")
  assert.deepEqual(request.body.images, Array(4).fill({ image_url: image.dataUrl }))
  assert.throws(() => model.submit({}, Array(5).fill(image)), /数量/)
  const disabled = await configured("renamed-source/new-image-model", "image", {
    images: false, parameters: { input_references: { type: "range", min: 0, max: 0 } },
  })
  assert.throws(() => disabled.submit({}, [image]), /数量/)
  const unknown = await configured("unverified/gpt-image-2.6-flare", "image", { images: false })
  assert.equal(unknown.capability.references.max, 0)
  const metadata = await configured("custom/image", "image", {
    images: false, parameters: { input_references: { type: "range", min: 1, max: 4 } },
  })
  assert.equal(metadata.submit({}, Array(4).fill(image)).body.images.length, 4)
})

test("Gemini source models preserve four references through the standard Magpie image API", async () => {
  const model = { ref: "existing-provider/image-model",
    requestModel: "replacement-provider/new-image-model", type: "image", images: false,
    parameters: { input_references: { type: "range", min: 0, max: 4 } } }
  const capability = { ...mediaCapability(model), requestModel: model.requestModel }
  const generated = source.replace("const capability = null", () => `const capability = ${JSON.stringify(capability)}`)
  const adapter = await import(`data:text/javascript;base64,${Buffer.from(generated).toString("base64")}`)
  const images = Array.from({ length: 4 }, (_, index) => ({ dataUrl: `data:image/png;base64,fixture${index}` }))
  const request = adapter.buildSubmit({ type: "image", model: model.ref, prompt: "test", params: {}, images })
  assert.equal(request.path, "/images/edits")
  assert.equal(request.body.model, model.requestModel)
  assert.deepEqual(request.body.images, images.map((image) => ({ image_url: image.dataUrl })))
  assert.deepEqual(adapter.parseSubmit({ body: { data: [{ b64_json: "AA==" }] } }, {}),
    { outputs: [{ base64: "AA==" }] })
})

test("native canvas keys and exact pixel choices work for unrelated models without empty controls", async () => {
  const unknown = await configured("another-provider/new-image", "image")
  assert.deepEqual(unknown.capability.params, [])
  const pixel = await configured("another-provider/new-image", "image", {
    parameters: { size: { type: "enum", values: ["1024x1024", "2048x2048", "1664x928"] } },
  })
  assert.deepEqual(pixel.capability.params.map((parameter) => parameter.key), ["aspect_ratio", "resolution"])
  assert.equal(pixel.submit({ aspect_ratio: "16:9" }).body.size, "1664x928")
  assert.equal(pixel.submit({ aspect_ratio: "1:1", resolution: "2048px" }).body.size, "2048x2048")
  assert.throws(() => pixel.submit({ aspect_ratio: "16:9", resolution: "2048px" }), /组合/)
  const custom = await configured("unrelated-source/new-image", "image", {
    mediaRequest: { size: "aspect-resolution" },
    parameters: { aspect_ratio: { type: "enum", values: ["16:9", "1:1"] },
      resolution: { type: "enum", values: ["1.5K", "3K"] } },
  })
  assert.equal(custom.submit({ aspect_ratio: "16:9", resolution: "1.5K" }).body.size, "16:9@1.5K")
  assert.equal(custom.submit({ resolution: "3K" }).body.size, "auto@3K")
  assert.equal(custom.submit().body.size, undefined)
  const video = await configured("unrelated-source/new-video", "video", {
    parameters: { seconds: { type: "range", min: 4, max: 12, step: 2 },
      resolution: { type: "enum", values: ["720p", "4k"] } },
  })
  assert.deepEqual(video.capability.params.find((parameter) => parameter.key === "duration").enum, ["4", "6", "8", "10", "12"])
  assert.equal(video.submit({ duration: "8", resolution: "4k" }).body.seconds, "8")
  assert.equal(video.submit({ duration: "8", resolution: "4k" }).body.resolution, "4k")
  assert.throws(() => video.submit({ duration: "7" }), /不支持参数/)
})

test("remote and direct OpenRouter discover one shared schema and preserve explicit limits", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: true, json: async () => ({ endpoints: [{ supported_parameters: {
      aspect_ratio: { type: "enum", values: ["1:1", "4:5", "16:9"] },
      resolution: { type: "enum", values: ["2K", "4K"] },
      input_references: { type: "range", min: 0, max: 10 },
    } }] }) }
  }
  try {
    const models = await enrichMediaParameters(["openrouter/new-vendor/new-image",
      "remote-magpie/openrouter/new-vendor/new-image"].map((ref) => ({
      ref, type: "image", imageOnly: true,
      parameters: { input_references: { type: "range", min: 0, max: 2 } },
    })))
    assert.equal(calls, 1)
    for (const model of models) {
      const { capability, submit } = await configured(model.ref, "image", model)
      assert.equal(capability.references.max, 2)
      assert.equal(submit({ aspect_ratio: "16:9", resolution: "4K" }).body.size, "4096x2304")
      assert.throws(() => submit({ aspect_ratio: "4:5", resolution: "2K" }), /无法同时传递/)
      assert.throws(() => submit({ resolution: "2K" }), /同时选择比例/)
    }
  } finally { globalThis.fetch = original }
})

test("declared quality, background and sound reach generic routes without inventing built-in model options", async () => {
  const imageSettings = {
    quality: { type: "enum", values: ["low", "medium", "high", "xhigh", "max"] },
    background: { type: "enum", values: ["auto", "transparent", "opaque"] },
  }
  const custom = await configured("new-source/future-image", "image", { parameters: imageSettings })
  assert.deepEqual(custom.capability.params.map((parameter) => parameter.title), ["画质", "背景"])
  assert.equal(custom.submit({ quality: "xhigh", background: "transparent" }).body.quality, "xhigh")
  assert.equal(custom.submit({ quality: "max", background: "opaque" }, [image]).body.background, "opaque")
  assert.equal(custom.submit({ background: "自动", quality: "自动" }).body.background, undefined)
  assert.throws(() => custom.submit({ quality: "extreme" }), /不支持参数/)
  const composite = await configured("new-source/combined-image", "image", {
    mediaRequest: { size: "aspect-resolution" },
    parameters: { ...imageSettings, resolution: { type: "enum", values: ["2K"] } },
  })
  assert.equal(composite.submit({ resolution: "2K", quality: "high" }).body.size, "auto@2K")
  assert.equal(composite.submit({ resolution: "2K", quality: "high" }).body.quality, "high")
  const native = await configured("minimax-code/MiniMax-Image", "image", { parameters: imageSettings })
  assert.ok(!native.capability.params.some((parameter) => ["quality", "background"].includes(parameter.key)))
  assert.equal(native.submit({ resolution: "2K" }).body.quality, "medium")
  const video = await configured("new-source/future-video", "video", {
    parameters: { generate_audio: { type: "boolean", default: true } },
  })
  assert.deepEqual(video.capability.params[0], { key: "generate_audio", title: "声音", type: "boolean", default: true })
  assert.equal(video.submit({ generate_audio: false }).body.generate_audio, false)
  assert.equal(video.submit({ generate_audio: true }).body.generate_audio, true)
  assert.throws(() => video.submit({ generate_audio: "false" }), /不支持参数/)
  assert.throws(() => mediaCapability({ ref: "unknown/video", type: "video",
    parameters: { generate_audio: { type: "boolean", default: "true" } } }), /schema/)
  const undeclared = await configured("new-source/other-video", "video")
  assert.throws(() => undeclared.submit({ generate_audio: true }), /不支持参数/)
})

test("duration string enums require positive whole seconds before building native controls", async () => {
  const video = await configured("unknown/new-video", "video", {
    parameters: { seconds: { type: "enum", values: ["4", "8"] } },
  })
  assert.equal(video.submit({ duration: "8" }).body.seconds, "8")
  for (const values of [["later"], ["0"], ["4.5"], ["4", "auto"]]) {
    assert.throws(() => mediaCapability({ ref: "unknown/new-video", type: "video",
      parameters: { seconds: { type: "enum", values } } }), /schema/)
  }
})
