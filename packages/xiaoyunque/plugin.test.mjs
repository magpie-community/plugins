import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pluginEntry, { createService, XiaoyunquePlugin } from "./index.mjs"
import { credentials, createAPI, fingerprint } from "./api.mjs"
import { decodeTask, describeModel, encodeTask, modelRows, normalizeRequest, parseRun } from "./media.mjs"
import { createTools } from "./tools.mjs"

const auth = { type: "api", key: "fake-test-key-never-real", metadata: { uid: "user-one", teamId: "0" } }
const image = { key: "internal-image-key", name: "测试图片", kind: "image", supported_ratio_list: [2, 3, 6], image_total_limit: 3, parameter_config: { dimensions: [
  { key: "resolution", option_list: [{ value: "1K" }, { value: "2K" }, { value: "4K", disabled: true }] },
  { key: "effort", option_list: [{ value: "low" }, { value: "high" }] },
] } }
const video = { key: "test-video", name: "测试视频", kind: "video", supported_ratio_list: [0, 2, 3, 6], parameter_config: { dimensions: [
  { key: "duration", range_config: { min_value: 4, max_value: 30, step: 1 } },
  { key: "resolution", option_list: [{ value: "720p" }, { value: "1080p" }] },
  { key: "seed", option_list: [{ value: "random" }, { value: "fixed" }] },
] } }
const imageData = "data:image/png;base64,aW1hZ2U="
const envelope = (data, status = 200) => Response.json({ ret: "0", data }, { status })
const runData = (state, content = [], extra = {}) => ({ thread: { run_list: [{ run_id: "run-one", state, ...extra, entry_list: [{ artifact: { content } }] }] } })
const picture = { sub_type: "biz/x_data_image", data: { image: { url: "https://media.example/image.png" } } }
const movie = { sub_type: "biz/x_data_video", data: JSON.stringify({ video: { download_url: "https://media.example/video.mp4", draft: true, draft_task_id: "draft-original" } }) }

async function fixture(context, custom = {}) {
  const directory = await mkdtemp(join(tmpdir(), "xyq-test-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    calls.push({ url, init })
    if (custom.fetch) return custom.fetch(url, init, calls)
    const path = url.pathname
    if (path.endsWith("get_available_model_list")) {
      const body = JSON.parse(init.body)
      return envelope({ scene: body.scene, config: { models: body.scene === "web_image_agent" ? [image] : [custom.video ?? video] } })
    }
    if (path.endsWith("upload_file")) return envelope({ pippit_asset_id: `asset-${calls.length}` })
    if (path.endsWith("submit_run")) return envelope({ run: { thread_id: "thread-one", run_id: "run-one" }, web_thread_link: "https://xyq.jianying.com/thread-one" })
    if (path.endsWith("get_thread")) return envelope(runData(3, custom.content ?? [picture]))
    if (path.endsWith("get_credit_balance")) return envelope({ total_remain_amount: "123" })
    if (path.endsWith("get_lite_team_list")) return envelope({ team_info_list: [{ team_id: "123", team_name: "工作空间" }], has_more: false })
    if (url.hostname === "media.example") return new Response(url.pathname.endsWith(".png") ? "fake-image" : "fake-video", {
      headers: { "content-type": url.pathname.endsWith(".png") ? "image/png" : "video/mp4" },
    })
    throw new Error(`unexpected request ${url}`)
  }
  return { directory, calls, fetchImpl, service: createService({ directory, fetchImpl, pollMs: 1 }) }
}

test("model discovery gives media output and official image names without internal enumeration", () => {
  const models = modelRows([image, video])
  assert.deepEqual(Object.keys(models), ["测试图片", "test-video"])
  assert.equal(models["测试图片"].api.id, "测试图片")
  assert.equal(models["测试图片"].capabilities.output.text, false)
  assert.equal(models["test-video"].capabilities.output.video, true)
  assert.equal(models[image.name].supported_parameters.quality.title, "推理强度")
  assert.ok(!JSON.stringify(describeModel(image)).includes("internal-image-key"))
})

test("native catalogue publishes reference budgets and only transferable video modes", () => {
  const models = modelRows([image, {
    ...video, image_total_limit: 30, total_limit: 12,
    is_support_first_frame_image: true, is_support_last_frame_image: true,
    creation_mode_config: { modes: [
      { key: "reference_generation", enabled: true },
      { key: "first_last_frame", enabled: true, ratio_policy: { value_mode: "smart" } },
      { key: "video_edit", enabled: true },
    ] },
  }])
  assert.deepEqual(models[image.name].supported_parameters.input_references, { type: "range", min: 0, max: 3 })
  assert.equal(models[video.key].supported_parameters.input_references.max, 30)
  assert.equal(models[video.key].capabilities.total_limit, 12)
  assert.deepEqual(models[video.key].media_request, {
    reference_modes: ["first-last-frame", "reference"], frame_ratio: "auto",
  })
  const disabled = modelRows([{ ...video, image_total_limit: 9,
    is_support_first_frame_image: false, is_support_last_frame_image: false,
    creation_mode_config: { modes: [{ key: "reference_generation", enabled: false }] },
  }])[video.key]
  assert.equal(disabled.supported_parameters.input_references.max, 0)
  assert.deepEqual(disabled.media_request.reference_modes, [])
})

test("dimension ratio enums override legacy lists and unknown custom ratios stay hidden", () => {
  const row = modelRows([{ ...image, parameter_config: { dimensions: [
    ...image.parameter_config.dimensions,
    { key: "ratio", option_list: [{ value: "6" }, { value: "13" }, { value: "2", disabled: true }, { value: "999" }, { value: "1" }] },
  ] } }])[image.name]
  assert.deepEqual(row.supported_parameters.aspect_ratio.values, ["1:1", "21:9"])
})

test("media modalities distinguish unknown, explicit limits and mode restrictions without UI caps", () => {
  const rows = modelRows([
    { key: "unknown-image", name: "未知限额图片", kind: "image" },
    { key: "unknown-video", name: "未知限额视频", kind: "video", audio_total_limit: null },
    { key: "total-only", name: "仅总限额", kind: "video", total_limit: 20 },
    { key: "large", name: "大参考集", kind: "video", image_total_limit: 30, total_limit: 50, video_total_limit: 10, audio_total_limit: 0 },
    { key: "text", name: "文生模式", kind: "video", creation_mode_config: { modes: [{ key: "text_to_video", enabled: true }] } },
    { key: "frames", name: "首帧模式", kind: "video", is_support_first_frame_image: true, is_support_last_frame_image: false,
      creation_mode_config: { modes: [{ key: "first_last_frame", enabled: true }] } },
    { key: "edit", name: "编辑模式", kind: "video", creation_mode_config: { modes: [
      { key: "video_edit", enabled: true, validation_policy: { required_video_count: 1, forbidden_input_types: ["image", "audio"] } },
    ] } },
    { key: "future", name: "未适配模式", kind: "video", image_total_limit: 8,
      creation_mode_config: { modes: [{ key: "new_mode", enabled: true }] } },
    { key: "edit-ref", name: "编辑时图片输入", kind: "video", image_total_limit: 8,
      creation_mode_config: { modes: [{ key: "video_edit", enabled: true }] } },
  ])
  assert.deepEqual(rows["未知限额图片"].capabilities.input, { text: true, video: false, audio: false, pdf: false })
  assert.equal(rows["未知限额图片"].capabilities.attachment, undefined)
  for (const id of ["unknown-video", "total-only"]) {
    assert.equal(rows[id].supported_parameters.input_references, undefined)
    assert.equal(rows[id].capabilities.input.image, undefined)
    assert.equal(rows[id].capabilities.input.audio, undefined)
    assert.equal(rows[id].media_request.reference_modes, undefined)
  }
  assert.equal(rows.large.supported_parameters.input_references.max, 30)
  assert.equal(rows.large.capabilities.total_limit, 50)
  assert.deepEqual(rows.large.capabilities.input, { text: true, image: true, video: true, audio: false, pdf: false })
  assert.equal(rows.text.capabilities.attachment, false)
  assert.deepEqual(rows.text.supported_parameters.input_references, { type: "range", min: 0, max: 0 })
  assert.deepEqual(rows.frames.media_request.reference_modes, ["first-frame"])
  assert.equal(rows.frames.capabilities.input.audio, false)
  assert.equal(rows.frames.supported_parameters.input_references, undefined)
  assert.equal(rows.edit.capabilities.input.video, true)
  assert.deepEqual(rows.edit.media_request.reference_modes, [])
  assert.equal(rows.future.capabilities.input.image, undefined)
  assert.equal(rows.future.supported_parameters.input_references, undefined)
  assert.equal(rows.future.capabilities.image_total_limit, 8)
  assert.equal(rows["edit-ref"].capabilities.input.image, true)
  assert.deepEqual(rows["edit-ref"].media_request.reference_modes, [])
  const limited = describeModel({ ...video, image_total_limit: 2, video_total_limit: 0, audio_total_limit: 0,
    creation_mode_config: { modes: [{ key: "reference_generation", enabled: true }] },
  })
  assert.deepEqual(limited.creation_modes[0].request.input_fields, ["reference_images"])
})

test("defaults and raw combination constraints remain model-specific without adding request defaults", () => {
  const model = { ...image, name: "任意新名称", default_ratio: 6, parameter_config: {
    need_available_combinations: true, combination_dimension_keys: ["resolution", "effort"],
    default_combination: { resolution: "2k", effort: "HIGH" },
    available_combinations: [{ option_values: { resolution: "2K", effort: "high" } }],
    dimensions: [
      { key: "resolution", default_value: "1K", option_list: [{ value: "1K", disabled: true }, { value: "2k" }] },
      { key: "effort", default_value: "low", option_list: [{ value: "low" }, { value: "HIGH" }] },
    ],
  } }
  const row = modelRows([model])[model.name]
  assert.equal(row.supported_parameters.aspect_ratio.default, "1:1")
  assert.equal(row.supported_parameters.resolution.default, "2K")
  assert.equal(row.supported_parameters.quality.default, "high")
  assert.deepEqual(row.capabilities.parameter_config, model.parameter_config)
  assert.deepEqual(normalizeRequest("image", { prompt: "x", size: "auto", quality: "auto" }, model).params, {})
  const duration = modelRows([{ ...video, parameter_config: { dimensions: [
    { key: "duration", default_value: "6", option_list: [], range_config: { min_value: 4, max_value: 30, step: 1 } },
  ] } }])[video.key].supported_parameters.seconds
  assert.deepEqual(duration, { type: "range", min: 4, max: 30, step: 1, default: 6 })
  const invalidDefault = modelRows([{ ...model, parameter_config: { dimensions: [
    { key: "resolution", default_value: "4K", option_list: [{ value: "2K" }, { value: "4K", disabled: true }] },
  ] } }])[model.name]
  assert.equal(invalidDefault.supported_parameters.resolution.default, undefined)
})

test("active parameter conditions use known defaults only and disabled values remain rejected", () => {
  const model = { ...image, parameter_config: { dimensions: [
    { key: "resolution", option_list: [{ value: "1K" }, { value: "2K" }], default_value: "2K" },
    { key: "effort", option_list: [{ value: "high" }], default_value: "high", active_when_any: [{ resolution: ["2K"] }] },
  ] } }
  assert.deepEqual(normalizeRequest("image", { prompt: "x", quality: "high" }, model).params, { effort: "high" })
  assert.equal(modelRows([model])[model.name].supported_parameters.quality.default, undefined)
  assert.throws(() => normalizeRequest("image", { prompt: "x", resolution: "1K", quality: "high" }, model), /不适用/)
  const empty = { ...image, parameter_config: { dimensions: [{ key: "resolution", option_list: [] }] } }
  assert.throws(() => normalizeRequest("image", { prompt: "x", resolution: "2K" }, empty), /不支持/)
  assert.equal(modelRows([empty])[empty.name].supported_parameters.resolution, undefined)
})

test("image catalogue to standard HTTP request maps renamed models and preserves response format", async (context) => {
  const source = { ...image, name: "全新图片名称", key: "private-new-image", image_total_limit: 30 }
  const setup = await fixture(context)
  const service = createService({ directory: setup.directory, pollMs: 1, fetchImpl: (url, init) => {
    if (String(url).endsWith("get_available_model_list")) return Promise.resolve(envelope({
      scene: "web_image_agent", config: { models: [source] },
    }))
    return setup.fetchImpl(url, init)
  } })
  const catalog = modelRows(await service.api.models(auth, "image"))
  const referenceCount = 17
  const response = await service.native(auth, "https://xyq.jianying.com/v1/images/edits", {
    method: "POST", body: JSON.stringify({
      model: Object.keys(catalog)[0], prompt: "标准调用", size: "1536x864", quality: "high",
      n: 1, image: Array(referenceCount).fill(imageData), response_format: "url",
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, [{ url: picture.data.image.url }])
  assert.equal(setup.calls.filter((call) => call.url.hostname === "media.example").length, 0)
  const submitted = JSON.parse(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  assert.deepEqual(submitted.general_agent_settings, {
    image_model: source.key, ratio: 2, image_effort: "high", generate_image_count: 1,
  })
  assert.equal(submitted.asset_ids.length, referenceCount)
  assert.equal(catalog[source.name].supported_parameters.input_references.max, 30)
})

test("standard video first frame and ratio dimensions map without a model-name branch", async (context) => {
  const model = { ...video, key: "new-video-name", is_support_first_frame_image: true, is_support_last_frame_image: false,
    image_total_limit: 1, video_total_limit: 0, audio_total_limit: 0,
    supported_ratio_list: [6], parameter_config: { dimensions: [
      ...video.parameter_config.dimensions,
      { key: "ratio", default_value: "2", option_list: [{ value: "2" }, { value: "3", disabled: true }] },
    ] },
  }
  const setup = await fixture(context, { video: model, content: [movie] })
  const row = modelRows(await setup.service.api.models(auth, "video"))[model.key]
  const response = await setup.service.native(auth, "https://xyq.jianying.com/v1/videos", {
    method: "POST", body: JSON.stringify({ model: row.id, prompt: "动作", seconds: 4, size: "1280x720", image: imageData }),
  })
  assert.equal(response.status, 200)
  const started = await response.json()
  assert.equal(started.status, "queued")
  const submitted = JSON.parse(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body).video_part_tool_param
  assert.equal(submitted.duration_sec, 4)
  assert.equal(submitted.ratio, "16:9")
  assert.equal(submitted.resolution, "720p")
  assert.equal(submitted.generate_type, 1)
  assert.equal(submitted.images.length, 1)
  assert.equal(row.supported_parameters.aspect_ratio.default, "16:9")
  assert.throws(() => normalizeRequest("video", { prompt: "x", size: "9:16" }, model), /不支持 ratio/)
  const completed = await setup.service.native(auth, `https://xyq.jianying.com/v1/videos/${started.id}`)
  assert.equal((await completed.json()).status, "completed")
})

test("reference type and combined budgets fail before upload without conflating missing limits", async (context) => {
  const model = { ...video, image_total_limit: 30, video_total_limit: 10, audio_total_limit: 0, total_limit: 2,
    creation_mode_config: { modes: [
      { key: "reference_generation", enabled: true, validation_policy: { forbidden_input_types: ["image"] } },
      { key: "first_last_frame", enabled: true },
    ] },
  }
  const setup = await fixture(context, { video: model })
  for (const input of [
    { reference_audios: ["https://media.example/a.wav"] },
    { reference_images: [imageData] },
    { reference_videos: Array(3).fill("https://media.example/v.mp4") },
  ]) await assert.rejects(setup.service.start(auth, "video", { model: model.key, prompt: "x", ...input }), /参考|素材/)
  assert.equal(setup.calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
  const unknown = { ...video, audio_total_limit: null, total_limit: null }
  assert.equal(normalizeRequest("video", { prompt: "x", reference_audios: ["https://media.example/a.wav"] }, unknown).audios.length, 1)
})

test("unmapped explicit fields fail before uploads and image response formats are honored", async (context) => {
  const setup = await fixture(context)
  for (const [kind, extra] of [
    ["image", { background: "opaque" }], ["image", { user: "tracking-id" }],
    ["image", { account: "other-account" }], ["image", { custom_style: "art" }],
    ["image", { output_format: "" }], ["image", { size: "" }], ["image", { response_format: "" }],
    ["image", { quality: null }], ["video", { seconds: 4, duration: null }],
    ["video", { response_format: "url" }], ["video", { quality: "high" }],
  ]) {
    const response = await setup.service.native(auth, `https://xyq.jianying.com/v1/${kind === "image" ? "images/generations" : "videos"}`, {
      method: "POST", body: JSON.stringify({ model: kind === "image" ? image.name : video.key, prompt: "x", reference_images: [imageData], ...extra }),
    })
    assert.equal(response.status, 400)
    assert.ok((await response.json()).error.message)
  }
  assert.equal(setup.calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
  const response = await setup.service.native(auth, "https://xyq.jianying.com/v1/images/generations", {
    method: "POST", body: JSON.stringify({ model: image.name, prompt: "x", background: "auto", response_format: "b64_json" }),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.data[0].media_type, "image/png")
  assert.ok(result.data[0].b64_json)
  assert.deepEqual(normalizeRequest("image", { prompt: "x", size: "16:9@2K", ratio: "1:1", resolution: "1K" }, image).params,
    { ratio: 6, resolution: "1K" })
  assert.match(normalizeRequest("image", { prompt: "x", size: "16:9@2K", ratio: "1:1" }, image).adaptation.message, /ratio 覆盖/)
  assert.match(normalizeRequest("video", { prompt: "x", seconds: 4, duration: 5 }, video).adaptation.message, /seconds 由 duration 覆盖/)
})

test("provider hook and config publish the same catalogue and loader accepts standard media requests", async (context) => {
  const setup = await fixture(context, { content: [picture, movie] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = setup.fetchImpl
  let hooks
  try {
    hooks = await XiaoyunquePlugin({ directory: setup.directory })
  } finally {
    globalThis.fetch = originalFetch
  }
  const config = {}
  await hooks.config(config)
  const rows = await hooks.provider.models({}, { auth })
  assert.deepEqual(config.provider.xiaoyunque.models, rows)
  const loader = await hooks.auth.loader(async () => auth)
  const request = await loader.fetch(`${loader.baseURL}/videos`, {
    method: "POST", body: JSON.stringify({
      model: rows[video.key].api.id, prompt: "动作", seconds: "4", size: "1280x720",
      input_reference: { image_url: imageData },
    }),
  })
  assert.equal(request.status, 200)
  assert.equal((await request.json()).object, "video")
  const submitted = JSON.parse(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  assert.equal(submitted.video_part_tool_param.duration_sec, 4)
  assert.equal(submitted.video_part_tool_param.generate_type, 1)
  assert.equal(submitted.video_part_tool_param.images.length, 1)
  assert.equal(rows[video.key].capabilities.input.audio, undefined)
  assert.equal(rows[image.name].capabilities.output.image, true)
  assert.deepEqual(config.provider.xiaoyunque.models[image.name].modalities.output, ["image"])
})

test("conditional combinations are enforced before upload on standard native requests", async (context) => {
  const model = { ...video, parameter_config: {
    ...video.parameter_config, need_available_combinations: true,
    combination_dimension_keys: ["resolution", "duration"],
    available_combinations: [
      { option_values: { resolution: "720p", duration: "4" } },
      { option_values: { resolution: "1080p", duration: "4" }, disabled: true },
    ],
  } }
  const setup = await fixture(context, { video: model })
  const response = await setup.service.native(auth, "https://xyq.jianying.com/v1/videos", {
    method: "POST", body: JSON.stringify({ model: model.key, prompt: "x", seconds: 4, size: "1920x1080", input_reference: imageData }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error.message, /组合/)
  assert.equal(setup.calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
  const valid = await setup.service.native(auth, "https://xyq.jianying.com/v1/videos", {
    method: "POST", body: JSON.stringify({ model: model.key, prompt: "x", seconds: 4, size: "1280x720", input_reference: imageData }),
  })
  assert.equal(valid.status, 200)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("model descriptions preserve explicit capabilities without inventing unknown support", () => {
  const description = describeModel({
    ...video, supports_seed: false, is_support_first_frame_image: true, is_support_last_frame_image: false,
  })
  assert.deepEqual(description.capabilities, {
    supports_seed: false, is_support_first_frame_image: true, is_support_last_frame_image: false,
  })
  assert.deepEqual(describeModel(video).capabilities, {})
})

test("tools without saved credentials explain how to sign in", async (context) => {
  const setup = await fixture(context)
  await assert.rejects(createTools(setup.service).models.execute({ kind: "image" }, {}), /请在 Magpie 供应商页登录小云雀/)
  assert.equal(setup.calls.length, 0)
})

test("native image delivery rejects empty or non-image content and preserves the paid task", async (context) => {
  for (const response of [
    () => new Response("", { headers: { "content-type": "image/png" } }),
    () => new Response("<html>unavailable</html>", { headers: { "content-type": "text/html" } }),
  ]) {
    const setup = await fixture(context)
    const service = createService({ directory: setup.directory, fetchImpl: (url, init) =>
      new URL(url).hostname === "media.example" ? Promise.resolve(response()) : setup.fetchImpl(url, init) })
    const result = await service.native(auth, "https://xyq.jianying.com/v1/images/generations", {
      method: "POST", body: JSON.stringify({ model: image.name, prompt: "x" }),
    })
    assert.equal(result.status, 409)
    const body = await result.json()
    assert.match(body.error.message, /空文件|媒体类型/)
    assert.equal(decodeTask(body.error.task_id).kind, "image")
    assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
  }
})

test("source task upgrade restores original account and team after default account changes", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const setup = await fixture(context, { video: model, content: [movie] })
  const original = await setup.service.start(auth, "video", { model: model.key, team_id: "123", prompt: "样片" })
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({
    xiaoyunque: auth,
    "xiaoyunque#two": { ...auth, key: "other-secret", metadata: { uid: "other-user" } },
  }))
  await writeFile(join(setup.directory, "logins.json"), JSON.stringify([
    { agent: "plugin:xiaoyunque", home: "xiaoyunque", on: true },
    { agent: "plugin:xiaoyunque", home: "xiaoyunque#two", on: true, first: true },
  ]))
  const tools = createTools(createService({ directory: setup.directory, fetchImpl: setup.fetchImpl }))
  const upgraded = await tools.generate.execute({ source_task_id: original.id, prompt: "通用提示词" }, {})
  assert.equal(upgraded.account, "xiaoyunque")
  assert.equal(upgraded.team_id, "123")
  const submitted = setup.calls.filter((call) => call.url.pathname.endsWith("submit_run"))
  assert.equal(submitted.length, 2)
  assert.equal(submitted[1].init.headers.authorization, `Bearer ${auth.key}`)
  assert.equal(submitted[1].init.headers["X-Team-Id"], "123")
  assert.deepEqual(JSON.parse(submitted[1].init.body).video_part_tool_param, {
    model: model.key, prompt: "", draft_task_id: "draft-original",
  })
  for (const extra of [{ account: "xiaoyunque#two" }, { team_id: "0" }, { model: video.key }, { kind: "image" }, { draft_task_id: "raw" }]) {
    await assert.rejects(tools.generate.execute({ source_task_id: original.id, ...extra }, {}))
  }
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 2)
})

test("source upgrade rejects incomplete or final videos and requires a choice for multiple previews", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const setup = await fixture(context, { video: model })
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const original = await setup.service.start(auth, "video", { model: model.key, prompt: "样片" })
  let response = runData(1)
  const service = createService({ directory: setup.directory, fetchImpl: (url, init) =>
    String(url).endsWith("get_thread") ? Promise.resolve(envelope(response)) : setup.fetchImpl(url, init) })
  const tools = createTools(service)
  await assert.rejects(tools.generate.execute({ source_task_id: original.id }, {}), /尚未成功/)
  response = runData(3, [{ sub_type: "biz/x_data_video", data: { video: { download_url: "https://media.example/video.mp4", draft: true } } }])
  await assert.rejects(tools.generate.execute({ source_task_id: original.id }, {}), /缺少/)
  response = runData(3, [{ sub_type: "biz/x_data_video", data: { video: { download_url: "https://media.example/video.mp4", draft: false, draft_task_id: "original" } } }])
  await assert.rejects(tools.generate.execute({ source_task_id: original.id }, {}), /不是可升级/)
  response = runData(3, [movie, { sub_type: "biz/x_data_video", data: { video: { download_url: "https://media.example/video.mp4", draft: true, draft_task_id: "second" } } }])
  await assert.rejects(tools.generate.execute({ source_task_id: original.id }, {}), /多个视频/)
  await assert.rejects(tools.generate.execute({ source_task_id: original.id, video_index: 2 }, {}), /所选视频/)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
  await tools.generate.execute({ source_task_id: original.id, video_index: 1 }, {})
  assert.equal(JSON.parse(setup.calls.at(-1).init.body).video_part_tool_param.draft_task_id, "second")
})

test("result waits for the same task and downloads images and videos without credentials or overwrites", async (context) => {
  const setup = await fixture(context)
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x" })
  let reads = 0
  const service = createService({ directory: setup.directory, pollMs: 1, fetchImpl: (url, init) =>
    String(url).endsWith("get_thread") ?
      Promise.resolve(envelope(++reads === 1 ? runData(1) : runData(3, [picture, movie]))) : setup.fetchImpl(url, init) })
  const tools = createTools(service)
  const output = join(setup.directory, "downloads")
  const result = await tools.result.execute({ id: started.id, wait_seconds: 1, download_dir: output }, {})
  assert.equal(result.status, "succeeded")
  assert.equal(result.timed_out, false)
  assert.equal(reads, 2)
  assert.equal(result.files.length, 2)
  assert.equal(await readFile(result.images[0].local_path, "utf8"), "fake-image")
  assert.equal(await readFile(result.videos[0].local_path, "utf8"), "fake-video")
  for (const call of setup.calls.filter((call) => call.url.hostname === "media.example")) assert.equal(call.init.headers, undefined)
  const duplicate = await tools.result.execute({ id: started.id, download_dir: output }, {})
  assert.match(duplicate.download_error, /已存在.*不.*重新生成/)
  assert.equal(duplicate.status, "succeeded")
  assert.equal(duplicate.id, started.id)
  assert.equal((await readdir(output)).length, 2)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("result waiting expires without resubmission and cancellation stops polling", async (context) => {
  const setup = await fixture(context)
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x" })
  let reads = 0
  const service = createService({ directory: setup.directory, pollMs: 2000, fetchImpl: (url, init) =>
    String(url).endsWith("get_thread") ? (reads++, Promise.resolve(envelope(runData(1)))) : setup.fetchImpl(url, init) })
  const result = await service.collect(auth, started.id, { wait_seconds: 1 })
  assert.equal(result.timed_out, true)
  assert.equal(result.status, "running")
  const controller = new AbortController()
  const pending = service.collect(auth, started.id, { wait_seconds: 1 }, controller.signal)
  setTimeout(() => controller.abort(new Error("cancel")), 10)
  await assert.rejects(pending, /cancel|abort/i)
  assert.ok(reads <= 3)
  await assert.rejects(service.collect(auth, started.id, { wait_seconds: 41 }), /0–40/)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("interrupted download cleans partial files and preserves already delivered files and task", async (context) => {
  const setup = await fixture(context, { content: [picture, movie] })
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x" })
  const service = createService({ directory: setup.directory, fetchImpl: (url, init) => {
    if (String(url).endsWith("video.mp4")) return Promise.resolve(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error("broken stream")) },
    }), { headers: { "content-type": "video/mp4" } }))
    return setup.fetchImpl(url, init)
  } })
  const directory = join(setup.directory, "partial")
  const result = await service.collect(auth, started.id, { download_dir: directory })
  assert.match(result.download_error, /下载中断.*不要重新生成/)
  assert.equal(result.id, started.id)
  assert.equal(result.files.length, 1)
  assert.equal((await readdir(directory)).length, 1)
  assert.equal(result.videos[0].local_path, undefined)
})

test("metadata retains only actual finite values and never invents zero consumption", () => {
  const detailed = {
    sub_type: "biz/x_data_video",
    data: { video: { download_url: "https://media.example/video.mp4", width: 1920, metadata: { height: 1080, duration_ms: 4000 } } },
  }
  const result = parseRun(runData(3, [detailed, { sub_type: "biz/x_data_predict_info", data: { predict_duration: 90000 } }],
    { credit_consumption: { actual_deduct_credits: 16 } }), "run-one")
  assert.deepEqual(result.videos[0], { url: "https://media.example/video.mp4", width: 1920, height: 1080, duration_ms: 4000 })
  assert.deepEqual(result.credit_consumption, { actual_deduct_credits: 16 })
  assert.deepEqual(parseRun(runData(3, [movie], {
    credit_consumption: { actual_deduct_credits: "16", returned_credits: "0" },
  }), "run-one").credit_consumption, { actual_deduct_credits: 16, returned_credits: 0 })
  assert.equal(result.predict_duration_ms, 90000)
  assert.equal(parseRun(runData(3, [movie]), "run-one").credit_consumption, undefined)
  assert.equal(parseRun(runData(3, [movie], { credit_consumption: { actual_deduct_credits: null } }), "run-one").credit_consumption, undefined)
  for (const invalid of ["", " ", "-1", "NaN", true, {}, Infinity]) {
    assert.equal(parseRun(runData(3, [movie], { credit_consumption: { actual_deduct_credits: invalid } }), "run-one").credit_consumption, undefined)
  }
})

test("download errors retain the completed task without files or resubmission", async (context) => {
  const setup = await fixture(context, { content: [picture] })
  const started = await setup.service.start(auth, "image", { model: image.name, prompt: "x" })
  let response
  const service = createService({ directory: setup.directory, fetchImpl: (url, init) =>
    new URL(url).hostname === "media.example" ? Promise.resolve(response) : setup.fetchImpl(url, init) })
  for (const [name, failedResponse, error] of [
    ["http", new Response("unavailable", { status: 503 }), /HTTP 503/],
    ["mime", new Response("html", { headers: { "content-type": "text/html" } }), /媒体类型/],
    ["mismatch", new Response("video", { headers: { "content-type": "video/mp4" } }), /媒体类型/],
    ["empty", new Response("", { headers: { "content-type": "image/png" } }), /空文件/],
  ]) {
    response = failedResponse
    const directory = join(setup.directory, name)
    const result = await service.collect(auth, started.id, { download_dir: directory })
    assert.equal(result.status, "succeeded")
    assert.equal(result.id, started.id)
    assert.match(result.download_error, error)
    assert.deepEqual(result.files, [])
    assert.deepEqual(await readdir(directory), [])
  }
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("generate rejects missing type or model before reading local reference files", async (context) => {
  const setup = await fixture(context)
  const tools = createTools(setup.service)
  for (const args of [
    { model: video.key },
    { kind: "invalid", model: video.key },
    { kind: "video" },
    { kind: "video", model: "" },
  ]) {
    await assert.rejects(tools.generate.execute({
      ...args, reference_images: [join(setup.directory, "missing.png")],
    }, {}), /kind.*model/)
  }
  assert.equal(setup.calls.length, 0)
})

test("result stops waiting at failure and refuses waiting or download without an id", async (context) => {
  const setup = await fixture(context)
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x" })
  let reads = 0
  const service = createService({ directory: setup.directory, pollMs: 1, fetchImpl: (url, init) =>
    String(url).endsWith("get_thread") ?
      Promise.resolve(envelope(++reads === 1 ? runData(1) : runData(4, [], { error_message: "generation failed" }))) : setup.fetchImpl(url, init) })
  const result = await service.collect(auth, started.id, { wait_seconds: 1, download_dir: join(setup.directory, "failed") })
  assert.equal(result.status, "failed")
  assert.equal(result.timed_out, false)
  assert.equal(result.files, undefined)
  assert.equal(reads, 2)
  const tools = createTools(service)
  await assert.rejects(tools.result.execute({ wait_seconds: 1 }, {}), /指定原任务/)
  await assert.rejects(tools.result.execute({ download_dir: "/tmp" }, {}), /指定原任务/)
  await assert.rejects(tools.result.execute({ id: started.id, download_dir: "relative" }, {}), /绝对目录/)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("disabled models are neither advertised nor submitted", async (context) => {
  const disabled = { ...video, disabled: true }
  assert.deepEqual(modelRows([disabled]), {})
  assert.equal(describeModel(disabled).disabled, true)
  const { service, calls } = await fixture(context, { video: disabled })
  await assert.rejects(service.start(auth, "video", { model: video.key, prompt: "x", reference_images: [imageData] }), /未开放/)
  assert.equal(calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
})

test("non-media text cannot prevent recovery of a finished video", () => {
  const result = parseRun(runData(3, [{ sub_type: "text/plain", data: "视频已完成" }, movie]), "run-one")
  assert.equal(result.videos[0].draftTaskId, "draft-original")
})

test("artifact failure reason is not hidden by the generic failure message", () => {
  const result = parseRun(runData(4, [{ sub_type: "biz/x_data_video", data: { error_message: "素材审核失败" } }]), "run-one")
  assert.equal(result.error, "素材审核失败")
})

test("unknown video state is not reported as a terminal generation failure", async (context) => {
  const setup = await fixture(context)
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x" })
  const service = createService({ directory: setup.directory, fetchImpl: (url, init) =>
    String(url).endsWith("get_thread") ? Promise.resolve(envelope(runData(9))) : setup.fetchImpl(url, init) })
  const response = await service.native(auth, `https://xyq.jianying.com/v1/videos/${encodeURIComponent(started.id)}`)
  assert.equal(response.status, 409)
  const output = await response.json()
  assert.match(output.error.message, /未知.*查询原任务/)
  assert.equal(output.status, undefined)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("task error details and API log identifiers redact the credential", async (context) => {
  const { service } = await fixture(context, { content: [
    { sub_type: "biz/x_data_video", data: { error_message: `失败 ${auth.key}` } }, movie,
  ] })
  const started = await service.start(auth, "video", { model: video.key, prompt: "x" })
  const result = await service.result(auth, started.id)
  assert.equal(result.error.includes(auth.key), false)
  const api = createAPI({ fetchImpl: async () => Response.json({ ret: "1", errmsg: "错误", log_id: auth.key }) })
  await assert.rejects(api.post(auth, "/api/biz/v1/skill/get_credit_balance", {}), (error) => !error.message.includes(auth.key))
})

test("null submission envelope is an unknown outcome and never retried", async (context) => {
  const setup = await fixture(context)
  let submissions = 0
  const service = createService({ directory: setup.directory, fetchImpl: (url, init) => {
    if (new URL(url).pathname.endsWith("submit_run")) {
      submissions++
      return Promise.resolve(Response.json(null))
    }
    return setup.fetchImpl(url, init)
  } })
  await assert.rejects(service.start(auth, "video", { model: video.key, prompt: "x" }),
    (error) => error.status === 409 && /未知/.test(error.message))
  assert.equal(submissions, 1)
})

test("native video download rejects non-video responses and preserves the original task", async (context) => {
  const setup = await fixture(context, { content: [movie] })
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x" })
  for (const mime of ["text/html", "application/json", null]) {
    const service = createService({ directory: setup.directory, fetchImpl: (url, init) => {
      if (new URL(url).hostname === "media.example") return Promise.resolve(new Response("not a video", {
        headers: mime ? { "content-type": mime } : {},
      }))
      return setup.fetchImpl(url, init)
    } })
    const response = await service.native(auth, `https://xyq.jianying.com/v1/videos/${encodeURIComponent(started.id)}/content`)
    assert.equal(response.status, 502)
    assert.match((await response.json()).error.message, /视频.*类型.*原任务/)
    assert.equal((await service.result(auth, started.id)).status, "succeeded")
  }
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("multipart repeated video reference fields preserve every file in order", async (context) => {
  for (const field of ["reference_images", "reference_images[]"]) {
    const { service, calls } = await fixture(context)
    const form = new FormData()
    form.set("model", video.key)
    form.set("prompt", "参考两张图片")
    form.append(field, new Blob(["first"], { type: "image/png" }), "first.png")
    form.append(field, new Blob(["second"], { type: "image/png" }), "second.png")
    const request = new Request("https://xyq.jianying.com/v1/videos", { method: "POST", body: form })
    const response = await service.native(auth, request.url, {
      method: "POST", headers: request.headers, body: new Uint8Array(await request.arrayBuffer()),
    })
    assert.equal(response.status, 200)
    const uploads = calls.filter((call) => call.url.pathname.endsWith("upload_file"))
    assert.equal(uploads.length, 2)
    assert.deepEqual(await Promise.all(uploads.map((call) => call.init.body.get("file").text())), ["first", "second"])
    const sent = JSON.parse(calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
    assert.equal(sent.video_part_tool_param.images.length, 2)
  }
})

test("parameters keep independent resolution/effort and omit unspecified defaults", () => {
  assert.deepEqual(normalizeRequest("image", { prompt: "原文" }, image).params, {})
  const value = normalizeRequest("image", { prompt: "原文", ratio: "16:9", resolution: "2k", quality: "high", n: "2" }, image)
  assert.deepEqual(value.params, { ratio: 2, resolution: "2K", effort: "high", n: 2 })
  assert.throws(() => normalizeRequest("image", { prompt: "x", resolution: "4K" }, image), /不支持/)
  assert.throws(() => normalizeRequest("image", { prompt: "x", mask: imageData }, image), /mask/)
  assert.throws(() => normalizeRequest("image", { prompt: "x", background: "transparent" }, image), /透明/)
  assert.throws(() => normalizeRequest("image", { prompt: "x", resolution: "2K", quality: "high", effort: "low" }, image), /只填写一项/)
})

test("Magpie's standard image sizes become the matching aspect ratio", () => {
  assert.deepEqual(normalizeRequest("image", { prompt: "x", size: "1024x1024" }, image).params, { ratio: 6 })
  assert.deepEqual(normalizeRequest("image", { prompt: "x", size: "1024x576" }, image).params, { ratio: 2 })
  assert.deepEqual(normalizeRequest("image", { prompt: "x", size: "576x1024" }, image).params, { ratio: 3 })
  assert.throws(() => normalizeRequest("image", { prompt: "x", size: "1000x977" }, image), /比例/)
})

test("discovered models declare native canvas settings and decode independent ratio and resolution", () => {
  const models = modelRows([image, video])
  assert.deepEqual(models[image.name].supported_parameters.resolution.values, ["1K", "2K"])
  assert.equal(models[image.name].media_request.size, "aspect-resolution")
  assert.deepEqual(models[video.key].supported_parameters.seconds, { type: "range", min: 4, max: 30, step: 1 })
  assert.deepEqual(normalizeRequest("image", { prompt: "x", size: "16:9@2K" }, image).params,
    { ratio: 2, resolution: "2K" })
  assert.deepEqual(normalizeRequest("image", { prompt: "x", size: "auto@2K" }, image).params, { resolution: "2K" })
  assert.throws(() => normalizeRequest("image", { prompt: "x", size: "16:9@4K" }, image), /不支持/)
})

test("generate exposes standard size quality and first-frame image and uses existing image conversion", async (context) => {
  const setup = await fixture(context)
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const tools = createTools(setup.service)
  for (const field of ["size", "quality", "image"]) assert.equal(tools.generate.args.properties[field].type, "string")
  await tools.generate.execute({ kind: "image", model: image.name, prompt: "x", size: "1024x1024", quality: "high" }, {})
  const submitted = JSON.parse(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  assert.equal(submitted.general_agent_settings.ratio, 6)
  assert.equal(submitted.general_agent_settings.image_effort, "high")
  assert.deepEqual(normalizeRequest("image", { prompt: "x", quality: "auto" }, image).params, {})
  const reference = join(setup.directory, "reference.png")
  await writeFile(reference, "image-reference")
  await tools.generate.execute({ kind: "image", model: image.name, prompt: "x", image: reference }, {})
  assert.equal(await setup.calls.find((call) => call.url.pathname.endsWith("upload_file")).init.body.get("file").text(), "image-reference")
  await assert.rejects(tools.generate.execute({
    kind: "image", model: image.name, prompt: "x", quality: "high", effort: "low",
  }, {}), /只填写一项/)
})

test("generate accepts a local standard image as first frame and preserves advanced size overrides", async (context) => {
  const setup = await fixture(context)
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const first = join(setup.directory, "first.png")
  await writeFile(first, "first-frame")
  await createTools(setup.service).generate.execute({
    kind: "video", model: video.key, prompt: "x", image: first, size: "1280x720", ratio: "9:16", resolution: "1080p",
  }, {})
  const upload = setup.calls.find((call) => call.url.pathname.endsWith("upload_file"))
  assert.equal(await upload.init.body.get("file").text(), "first-frame")
  const submitted = JSON.parse(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  assert.equal(submitted.video_part_tool_param.generate_type, 1)
  assert.equal(submitted.video_part_tool_param.ratio, "9:16")
  assert.equal(submitted.video_part_tool_param.resolution, "1080p")
})

test("first frame aliases conflict before local reads while Draft upgrade ignores them", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const setup = await fixture(context, { video: model })
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const tools = createTools(setup.service)
  await assert.rejects(tools.generate.execute({
    kind: "video", model: model.key, prompt: "x", image: "/missing/first.png", input_reference: "/missing/other.png",
  }, {}), /只填写一项/)
  assert.equal(setup.calls.length, 0)
  await tools.generate.execute({
    kind: "video", model: model.key, draft_task_id: "original",
    image: "/missing/first.png", input_reference: "/missing/other.png", size: "1280x720",
  }, {})
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("upload_file")).length, 0)
  const submitted = JSON.parse(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  assert.deepEqual(submitted.video_part_tool_param, { model: model.key, prompt: "", draft_task_id: "original" })
})

test("explicit video parameters override generic defaults and still validate against the model", () => {
  const input = normalizeRequest("video", {
    prompt: "原提示词", size: "1920x1080", ratio: "9:16", resolution: "720p", seconds: 10, duration: 4,
  }, video)
  assert.deepEqual(input.params, { ratio: "9:16", resolution: "720p", seconds: 4 })
  assert.equal(input.prompt, "原提示词")
  assert.equal(normalizeRequest("video", { prompt: "x", size: "1280x720", ratio: "1:1" }, video).params.resolution, "720p")
  assert.throws(() => normalizeRequest("video", { prompt: "x", seconds: 4, duration: 31 }, video), /范围/)
  assert.throws(() => normalizeRequest("video", { prompt: "x", size: "1280x720", resolution: "8K" }, video), /不支持/)
})

test("generate prefers standard seconds usage and exposes duration as an optional advanced alias", async (context) => {
  const setup = await fixture(context)
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const tools = createTools(setup.service)
  assert.equal(tools.generate.args.properties.duration.type, "integer")
  for (const parameters of [{ seconds: 6 }, { duration: 5 }, { seconds: 6, duration: 4 }]) {
    await tools.generate.execute({ kind: "video", model: video.key, prompt: "x", ...parameters }, {})
    const submitted = JSON.parse(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).at(-1).init.body)
    assert.equal(submitted.video_part_tool_param.duration_sec, parameters.duration ?? parameters.seconds)
  }
  const count = setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length
  await assert.rejects(tools.generate.execute({
    kind: "video", model: video.key, prompt: "x", duration: 31,
  }, {}), /范围/)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, count)
})

test("multipart video restores draft booleans and JSON media arrays while preserving text", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const setup = await fixture(context, { video: model })
  const form = new FormData()
  form.set("model", model.key)
  form.set("prompt", "12345")
  form.set("draft", "true")
  form.set("reference_images", JSON.stringify([imageData, imageData]))
  form.append("reference_audios[]", new Blob(["sound"], { type: "audio/mpeg" }), "sound.mp3")
  const request = new Request("https://xyq.jianying.com/v1/videos", { method: "POST", body: form })
  const response = await setup.service.native(auth, request.url, {
    method: "POST", headers: request.headers, body: new Uint8Array(await request.arrayBuffer()),
  })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const submitted = JSON.parse(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body).video_part_tool_param
  assert.equal(submitted.prompt, "12345")
  assert.equal(submitted.draft, true)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("upload_file")).length, 3)
})

test("native video queries retain parsed media and server consumption metadata", async (context) => {
  const setup = await fixture(context)
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x" })
  const details = runData(3, [{
    sub_type: "biz/x_data_video", data: { video: {
      download_url: "https://media.example/video.mp4", metadata: { width: 1280, height: 720, duration_ms: 4000 },
    } },
  }, { sub_type: "biz/x_data_predict_info", data: { predict_duration: 12000 } }], {
    credit_consumption: { actual_deduct_credits: "16" },
  })
  const service = createService({ directory: setup.directory, fetchImpl: (url, init) =>
    String(url).endsWith("get_thread") ? Promise.resolve(envelope(details)) : setup.fetchImpl(url, init) })
  const response = await service.native(auth, `https://xyq.jianying.com/v1/videos/${started.id}`)
  const result = await response.json()
  assert.equal(result.status, "completed")
  assert.deepEqual(result.videos, [{ url: "https://media.example/video.mp4", width: 1280, height: 720, duration_ms: 4000 }])
  assert.deepEqual(result.credit_consumption, { actual_deduct_credits: 16 })
  assert.equal(result.predict_duration_ms, 12000)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("30 second videos and numeric seed use server duration not seed UI enum", () => {
  const normalized = normalizeRequest("video", { prompt: "原文", seconds: 30, resolution: "1080p", seed: 42 }, video)
  assert.equal(normalized.params.seconds, 30)
  assert.equal(normalized.params.seed, 42)
  assert.throws(() => normalizeRequest("video", { prompt: "x", seconds: 31 }, video), /范围/)
})

test("Mini Lite missing ratio is refused before upload or submission", async (context) => {
  const model = { ...video, key: "Seedance_2.0_mini_lite" }
  assert.throws(() => normalizeRequest("video", { prompt: "x", seconds: 4 }, model), /需要视频比例/)
  assert.equal(normalizeRequest("video", { prompt: "x", seconds: 4, size: "16:9" }, model).params.ratio, "16:9")
  assert.throws(() => normalizeRequest("video", { draft_task_id: "original", draft: false }, model), /不能切换模型/)
  normalizeRequest("video", { prompt: "x", input_reference: imageData }, model)
  const setup = await fixture(context)
  const service = createService({ directory: setup.directory, fetchImpl: (url, init) =>
    String(url).endsWith("get_available_model_list") ?
      Promise.resolve(envelope({ scene: "web_turbo_video_generator", config: { models: [model] } })) : setup.fetchImpl(url, init) })
  await assert.rejects(service.start(auth, "video", { model: model.key, prompt: "x", reference_images: [imageData] }), /需要视频比例/)
  assert.equal(setup.calls.length, 0)
})

test("creation mode rejects incompatible media, disabled edit, and forced ratio", () => {
  const model = { ...video, creation_mode_config: { modes: [
    { key: "first_last_frame", enabled: true, ratio_policy: { value_mode: "smart" } },
    { key: "video_edit", enabled: false },
  ] } }
  assert.throws(() => normalizeRequest("video", { prompt: "x", input_reference: imageData, last_frame: imageData, ratio: "16:9" }, model), /比例/)
  assert.throws(() => normalizeRequest("video", { prompt: "x", task_type: "edit", reference_videos: ["https://media.example/in.mp4"] }, model), /开放/)
  assert.throws(() => normalizeRequest("video", { prompt: "x", last_frame: imageData }, model), /首帧/)
})

test("model modes expose supported request fields without guessing unknown modes", () => {
  const model = { ...video, creation_mode_config: { modes: [
    { key: "reference_generation", enabled: true },
    { key: "first_last_frame", enabled: true },
    { key: "video_edit", enabled: false },
    { key: "video_extend", enabled: true },
    { key: "future_mode", enabled: true },
  ] } }
  const modes = describeModel(model).creation_modes
  assert.deepEqual(modes[0].request, {
    parameters: { task_type: "reference" }, input_fields: ["reference_images", "reference_videos", "reference_audios"],
  })
  assert.deepEqual(modes[1].request, {
    parameters: { generate_type: 1 }, input_fields: ["input_reference", "last_frame"],
  })
  assert.deepEqual(modes[2].request, {
    parameters: { task_type: "edit" }, input_fields: ["reference_videos"],
  })
  assert.equal(modes[2].enabled, false)
  assert.equal(modes[4].request, undefined)
  const imageModes = describeModel({ ...image, creation_mode_config: model.creation_mode_config }).creation_modes
  assert.equal(imageModes[0].request, undefined)
})

test("explicit unsupported seed fails before upload while omitted seed stays absent", async (context) => {
  const seedDisabled = { ...video, parameter_config: { dimensions: video.parameter_config.dimensions.filter((dimension) => dimension.key !== "seed") } }
  for (const model of [{ ...video, supports_seed: false }]) {
    const setup = await fixture(context, { video: model })
    await assert.rejects(setup.service.start(auth, "video", {
      model: model.key, prompt: "x", seed: 42, reference_images: [imageData],
    }), /不支持 seed/)
    assert.equal(setup.calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
  }
  assert.deepEqual(normalizeRequest("video", { prompt: "x" }, seedDisabled).params, {})
  assert.equal(normalizeRequest("video", { prompt: "x", seed: 42 }, seedDisabled).params.seed, 42)
  const setup = await fixture(context, { video: seedDisabled })
  await setup.service.start(auth, "video", { model: seedDisabled.key, prompt: "x", ratio: "16:9" })
  const submitted = JSON.parse(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  assert.equal(submitted.video_part_tool_param.seed, undefined)
})

test("first and last frame capability checks cover both named and generic inputs before upload", async (context) => {
  const firstOnly = { ...video, is_support_first_frame_image: true, is_support_last_frame_image: false }
  const noFirst = { ...video, is_support_first_frame_image: false, is_support_last_frame_image: true }
  for (const [model, input] of [
    [firstOnly, { input_reference: imageData, last_frame: imageData }],
    [noFirst, { input_reference: imageData }],
    [firstOnly, { generate_type: 1, reference_images: [imageData, imageData] }],
    [noFirst, { generate_type: 1, reference_images: [imageData] }],
  ]) {
    const setup = await fixture(context, { video: model })
    await assert.rejects(setup.service.start(auth, "video", { model: model.key, prompt: "x", ...input }), /不支持/)
    assert.equal(setup.calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
  }
  assert.deepEqual(normalizeRequest("video", { prompt: "x", input_reference: imageData }, firstOnly).params, { generate_type: 1 })
  const bothFrames = { ...firstOnly, is_support_last_frame_image: true }
  assert.equal(normalizeRequest("video", { prompt: "x", input_reference: imageData, last_frame: imageData }, bothFrames).images.length, 2)
})

test("missing capability fields remain unknown and seed UI choices do not reject numeric seeds", () => {
  const unknown = { ...video, parameter_config: undefined }
  const input = { prompt: "x", seed: 42, input_reference: imageData, last_frame: imageData }
  assert.equal(normalizeRequest("video", input, unknown).params.seed, 42)
  assert.equal(normalizeRequest("video", input, { ...unknown, supports_seed: true }).images.length, 2)
  assert.equal(normalizeRequest("video", input, video).params.seed, 42)
  assert.ok(describeModel(video).parameters.some((dimension) => dimension.key === "seed"))
})

test("conflicting video modes fail before upload or submission while explicit reference remains reference", async (context) => {
  const model = { ...video, creation_mode_config: { modes: [
    { key: "reference_generation", enabled: true },
    { key: "first_last_frame", enabled: true },
    { key: "video_edit", enabled: true },
    { key: "video_extend", enabled: true },
    { key: "text_to_video", enabled: false },
  ] } }
  const { service, calls } = await fixture(context, { video: model })
  for (const input of [
    { input_reference: imageData, task_type: "edit" },
    { generate_type: 1, reference_images: [imageData], task_type: "extend" },
    { input_reference: imageData, task_type: "reference" },
    { input_reference: imageData, generate_type: 0 },
  ]) {
    await assert.rejects(service.start(auth, "video", { model: model.key, prompt: "x", ...input }), /冲突/)
  }
  assert.equal(calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
  await service.start(auth, "video", { model: model.key, prompt: "x", task_type: "reference" })
  const submitted = JSON.parse(calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  assert.equal(submitted.video_part_tool_param.task_type, "reference")
})

test("combinations validate only explicit fields and reject disabled options", () => {
  const model = { ...image, parameter_config: { ...image.parameter_config, need_available_combinations: true, combination_dimension_keys: ["resolution", "effort"], available_combinations: [{ option_values: { resolution: "2K", effort: "high" } }] } }
  normalizeRequest("image", { prompt: "x", resolution: "2K" }, model)
  assert.throws(() => normalizeRequest("image", { prompt: "x", resolution: "1K", effort: "high" }, model), /组合/)
})

test("task status distinguishes running/failed/canceled/unknown and JSON-string media", () => {
  for (const [state, status] of [[1, "running"], [4, "failed"], [5, "canceled"], [6, "unknown"], [9, "unknown"]]) assert.equal(parseRun(runData(state), "run-one").status, status)
  assert.equal(parseRun(runData(3, [movie]), "run-one").videos[0].draftTaskId, "draft-original")
  assert.throws(() => parseRun(runData(3), "run-one"), /产物/)
  assert.throws(() => parseRun(runData(1), "wrong"), /run_id/)
})

test("image submission uploads before generation, preserves order, and records recoverable task", async (context) => {
  const { service, calls, directory } = await fixture(context)
  const started = await service.start(auth, "image", { model: image.name, prompt: "不扩写", reference_images: [imageData, "https://media.example/ref.png"], resolution: "2K", effort: "high" })
  const submit = calls.find((call) => call.url.pathname.endsWith("submit_run"))
  const body = JSON.parse(submit.init.body)
  assert.equal(body.general_agent_settings.image_model, image.key)
  assert.equal(body.general_agent_settings.image_effort, "high")
  assert.equal(body.general_agent_settings.resolution, "2K")
  assert.equal(body.message, "不扩写")
  assert.equal(body.asset_ids.length, 2)
  assert.equal(decodeTask(started.id).team, "0")
  const files = await readdir(join(directory, "xiaoyunque", "tasks"))
  assert.equal(files.length, 1)
  assert.ok(!(await readFile(join(directory, "xiaoyunque", "tasks", files[0]), "utf8")).includes(auth.key))
})

test("any reference upload error stops submission and lists failures", async (context) => {
  const { service, calls } = await fixture(context)
  await assert.rejects(service.start(auth, "image", { model: image.name, prompt: "x", reference_images: ["bad-one", "bad-two"] }), /images 1.*images 2/)
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 0)
})

test("multipart native edits use image bytes and return image result", async (context) => {
  const { service, calls } = await fixture(context)
  const form = new FormData()
  form.set("model", image.name)
  form.set("prompt", "修改")
  form.append("image[]", new Blob(["one"], { type: "image/png" }), "one.png")
  form.append("image[]", new Blob(["two"], { type: "image/png" }), "two.png")
  const request = new Request("https://xyq.jianying.com/v1/images/edits", { method: "POST", body: form })
  const headers = new Headers(request.headers)
  const body = new Uint8Array(await request.arrayBuffer())
  const response = await service.native(auth, request.url, { method: "POST", body, headers })
  assert.equal(response.status, 200, await response.clone().text())
  const output = (await response.json()).data[0]
  assert.equal(Buffer.from(output.b64_json, "base64").toString(), "fake-image")
  assert.equal(output.media_type, "image/png")
  assert.equal(calls.at(-1).init.headers, undefined)
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("upload_file")).length, 2)
})

test("video roundtrip keeps account, team, draft id and downloads without credentials", async (context) => {
  const { service, calls } = await fixture(context, { content: [movie] })
  const started = await service.native(auth, "https://xyq.jianying.com/v1/videos", { method: "POST", body: JSON.stringify({ model: video.key, prompt: "x", seconds: 30, seed: 12 }) })
  const object = await started.json()
  assert.equal(object.status, "queued")
  const read = await service.native(auth, `https://xyq.jianying.com/v1/videos/${encodeURIComponent(object.id)}`)
  assert.equal((await read.json()).draft_task_id, "draft-original")
  const response = await service.native(auth, `https://xyq.jianying.com/v1/videos/${encodeURIComponent(object.id)}/content`)
  assert.equal(await response.text(), "fake-video")
  assert.equal(calls.at(-1).init.headers, undefined)
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("restart and same UID key rotation recover original task, other account is refused", async (context) => {
  const setup = await fixture(context)
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x" })
  const restarted = createService({ directory: setup.directory, fetchImpl: setup.fetchImpl })
  assert.equal((await restarted.result({ ...auth, key: "rotated-key" }, started.id)).status, "succeeded")
  await assert.rejects(restarted.result({ ...auth, metadata: { uid: "other-user" } }, started.id), /原小云雀账号/)
})

test("post-submit polling error returns non-replayable 409 with original task id", async (context) => {
  const setup = await fixture(context)
  const service = createService({ directory: setup.directory, fetchImpl: async (url, init) =>
    String(url).endsWith("get_thread") ? Response.json({ ret: "1", errmsg: "temporary failure" }, { status: 503 }) : setup.fetchImpl(url, init) })
  const response = await service.native(auth, "https://xyq.jianying.com/v1/images/generations", { method: "POST", body: JSON.stringify({ model: image.name, prompt: "x" }) })
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.ok(body.error.task_id.startsWith("xyq1_"))
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("image download failure preserves the paid task and never sends its key to the CDN", async (context) => {
  const setup = await fixture(context)
  let downloadHeaders
  const service = createService({ directory: setup.directory, fetchImpl: async (url, init) => {
    if (new URL(url).hostname === "media.example") {
      downloadHeaders = init.headers
      return new Response("unavailable", { status: 503 })
    }
    return setup.fetchImpl(url, init)
  } })
  const response = await service.native(auth, "https://xyq.jianying.com/v1/images/generations", {
    method: "POST", body: JSON.stringify({ model: image.name, prompt: "x" }),
  })
  const output = await response.json()
  assert.equal(response.status, 409)
  assert.match(output.error.message, /原图片下载失败/)
  assert.ok(output.error.task_id.startsWith("xyq1_"))
  assert.equal(downloadHeaders, undefined)
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("unknown submit outcome is not retried", async (context) => {
  const setup = await fixture(context)
  let submissions = 0
  const service = createService({ directory: setup.directory, fetchImpl: async (url, init) => {
    if (new URL(url).pathname.endsWith("submit_run")) { submissions++; throw new Error("connection lost") }
    return setup.fetchImpl(url, init)
  } })
  await assert.rejects(service.start(auth, "image", { model: image.name, prompt: "x" }), (error) => error.status === 409 && /未知/.test(error.message))
  assert.equal(submissions, 1)
})

test("failed catalog refresh does not silently use earlier catalog", async (context) => {
  const setup = await fixture(context)
  let refused = false
  const api = createAPI({ directory: setup.directory, fetchImpl: (url, init) => refused ? Promise.resolve(Response.json({ ret: "1", errmsg: "no catalog" })) : setup.fetchImpl(url, init) })
  await api.models(auth, "image")
  refused = true
  await assert.rejects(api.models(auth, "image", { refresh: true }), /no catalog/)
  await assert.rejects(api.models(auth, "image"), /no catalog/)
})

test("errors redact account secret and distinguish zero credit", async (context) => {
  const setup = await fixture(context)
  const api = createAPI({ fetchImpl: async () => Response.json({ ret: "1", errmsg: `积分不足 ${auth.key}` }) })
  await assert.rejects(api.post(auth, "/api/biz/v1/skill/get_credit_balance", {}), (error) => error.status === 402 && !error.message.includes(auth.key))
  assert.throws(() => credentials({ ...auth, metadata: { expiresAt: 1 } }), /过期/)
  assert.equal(credentials(auth).account, fingerprint("uid:user-one"))
  assert.equal(decodeTask(encodeTask({ kind: "image", thread: "t", run: "r", model: "m", team: "0", account: credentials(auth).account })).model, "m")
  assert.throws(() => decodeTask("xyq1_bad"), /任务/)
})

test("plugin offers browser and Access Key login, native loader, models, credits and three tools", async (context) => {
  assert.equal(pluginEntry.server, XiaoyunquePlugin)
  const { directory } = await fixture(context)
  const hooks = await XiaoyunquePlugin({ directory })
  const config = {}
  await hooks.config(config)
  assert.equal(config.provider.xiaoyunque.name, "小云雀")
  assert.deepEqual(hooks.auth.methods.map((method) => method.type), ["oauth", "api"])
  assert.equal(hooks.auth.methods[1].authorize, undefined)
  assert.deepEqual(await hooks.auth.loader(async () => undefined), {})
  assert.deepEqual(await hooks.provider.models({}, {}), {})
  assert.deepEqual(Object.keys(hooks.tool), ["models", "generate", "result"])
  await writeFile(join(directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const selected = await createAPI({ directory }).accountAuth()
  assert.equal(selected.account, "xiaoyunque")
})

test("manual Access Key credentials use personal space and bind tasks to that key", async (context) => {
  const setup = await fixture(context)
  const manual = { type: "api", key: "fake-manual-key" }
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: manual }))
  const started = await setup.service.start(manual, "video", { model: video.key, prompt: "x" })
  assert.equal(started.task.team, "0")
  assert.equal((await setup.service.result(manual, started.id)).status, "succeeded")
  await assert.rejects(setup.service.result({ type: "api", key: "another-key" }, started.id), /原小云雀账号/)
  assert.equal((await setup.service.api.accountAuth()).account, "xiaoyunque")
  assert.equal(setup.calls.find((call) => call.url.pathname.endsWith("submit_run")).init.headers.authorization, "Bearer fake-manual-key")
})

test("team task stays on original space through restart, records recover without id", async (context) => {
  const setup = await fixture(context, { content: [movie] })
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const started = await setup.service.start(auth, "video", { model: video.key, prompt: "x", team_id: "123" })
  await setup.service.result(auth, started.id)
  const business = setup.calls.filter((call) => /submit_run|get_thread/.test(call.url.pathname))
  assert.ok(business.every((call) => call.init.headers["X-Team-Id"] === "123"))
  const recent = await setup.service.api.recent(auth)
  assert.equal(recent[0].run, "run-one")
  assert.equal(recent[0].team, "123")
  assert.equal((await setup.service.api.recent({ ...auth, metadata: { uid: "different" } })).length, 0)
})

test("unknown team is refused before upload or paid submission", async (context) => {
  const { service, calls } = await fixture(context)
  await assert.rejects(service.start(auth, "image", { model: image.name, prompt: "x", team_id: "999", reference_images: [imageData] }), /团队/)
  assert.equal(calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
})

test("draft conversion does not invent prompt or new references", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft", creation_mode_config: { modes: [{ key: "reference_generation", enabled: false }] } }
  const { service, calls } = await fixture(context, { video: model })
  await service.start(auth, "video", { model: model.key, draft_task_id: "original-draft" })
  const sent = JSON.parse(calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  assert.deepEqual(sent.video_part_tool_param, { model: model.key, prompt: "", draft_task_id: "original-draft" })
  assert.equal(sent.message, "")
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("upload_file")).length, 0)
})

test("Draft preview and upgrade keep distinct parameter contracts", () => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const preview = normalizeRequest("video", { prompt: "样片", draft: true, seconds: 4, ratio: "16:9" }, model)
  assert.equal(preview.params.draft, true)
  for (const extra of [{ prompt: "改提示词" }, { seconds: 4 }, { ratio: "16:9" }, { resolution: "1080p" }, { seed: 1 }, { draft: true }, { reference_images: [imageData] }]) {
    const request = normalizeRequest("video", { draft_task_id: "original", ...extra }, model)
    assert.deepEqual(request.params, { draft_task_id: "original" })
    assert.deepEqual(request.adaptation.ignored_parameters, Object.keys(extra))
  }
  const automatic = normalizeRequest("video", { prompt: "样片", size: "1280x720", resolution: "1080p" }, model)
  assert.deepEqual(automatic.params, { ratio: "16:9", draft: true })
  assert.deepEqual(automatic.adaptation.ignored_parameters, ["resolution"])
  assert.throws(() => normalizeRequest("video", { prompt: "样片", draft: true }, video), /必须使用/)
  assert.throws(() => normalizeRequest("video", { prompt: "样片", draft: false }, model), /draft_task_id/)
  assert.throws(() => normalizeRequest("video", { draft_task_id: "   " }, model), /原始样片/)
  const upgrade = normalizeRequest("video", { draft_task_id: "original" }, model)
  assert.deepEqual(upgrade.params, { draft_task_id: "original" })
  assert.equal(normalizeRequest("video", { draft_task_id: "original", draft: false }, model).params.draft, undefined)
  assert.throws(() => normalizeRequest("video", { draft_task_id: "original", typo: 1 }, model), /不支持参数/)
})

test("Draft upgrade ignores creative inputs without uploading and reports their names", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const { service, calls } = await fixture(context, { video: model })
  for (const extra of [
    { prompt: "修改" }, { seconds: 4 }, { duration: 4 }, { size: "16:9" }, { ratio: "16:9" },
    { resolution: "1080p" }, { seed: 0 }, { generate_type: 0 }, { task_type: "reference" },
    { draft: true }, { input_reference: imageData }, { reference_images: [imageData] },
    { reference_videos: ["https://media.example/ref.mp4"] }, { reference_audios: ["https://media.example/ref.mp3"] },
  ]) {
    const started = await service.start(auth, "video", { model: model.key, draft_task_id: "original", ...extra })
    assert.deepEqual(started.task.adaptation.ignored_parameters, Object.keys(extra))
    assert.deepEqual(JSON.parse(calls.at(-1).init.body).video_part_tool_param, {
      model: model.key, prompt: "", draft_task_id: "original",
    })
  }
  assert.equal(calls.filter((call) => /upload_file/.test(call.url.pathname)).length, 0)
  const other = await fixture(context)
  await assert.rejects(other.service.start(auth, "video", { model: video.key, draft_task_id: "original" }), /不能切换模型/)
  assert.equal(other.calls.filter((call) => /upload_file|submit_run/.test(call.url.pathname)).length, 0)
})

test("Draft tools preview, recover raw id after restart, and upgrade only on a new call", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const setup = await fixture(context, { video: model, content: [movie] })
  await writeFile(join(setup.directory, "plugin-auth.json"), JSON.stringify({ xiaoyunque: auth }))
  const tools = createTools(setup.service)
  const preview = await tools.generate.execute({
    kind: "video", model: model.key, prompt: "样片原文", seconds: 4, ratio: "16:9",
  }, { directory: setup.directory })
  const submitted = () => setup.calls.filter((call) => call.url.pathname.endsWith("submit_run"))
  assert.deepEqual(JSON.parse(submitted()[0].init.body).video_part_tool_param, {
    model: model.key, prompt: "样片原文", ratio: "16:9", duration_sec: 4, draft: true,
  })
  const restarted = createTools(createService({ directory: setup.directory, fetchImpl: setup.fetchImpl }))
  const tasks = await restarted.result.execute({}, {})
  assert.equal(tasks.tasks[0].id, preview.id)
  const result = await restarted.result.execute({ id: tasks.tasks[0].id }, {})
  assert.equal(result.videos[0].draft, true)
  assert.equal(result.videos[0].draftTaskId, "draft-original")
  assert.equal(submitted().length, 1)
  const upgraded = await restarted.generate.execute({
    kind: "video", model: model.key, draft_task_id: result.videos[0].draftTaskId,
    prompt: "通用入口提示词", seconds: 10, reference_images: ["/does-not-exist/ignored.png"],
  }, { directory: setup.directory })
  assert.equal(submitted().length, 2)
  assert.deepEqual(JSON.parse(submitted()[1].init.body).video_part_tool_param, {
    model: model.key, prompt: "", draft_task_id: "draft-original",
  })
  assert.deepEqual(upgraded.adaptation.ignored_parameters, ["prompt", "seconds", "reference_images"])
  const queried = await restarted.result.execute({ id: upgraded.id }, {})
  assert.deepEqual(queried.adaptation, upgraded.adaptation)
})

test("native Draft accepts standard fields and keeps upgrade payload minimal", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const { service, calls } = await fixture(context, { video: model, content: [movie] })
  const nativeStart = (body) => service.native(auth, "https://xyq.jianying.com/v1/videos", {
    method: "POST", body: JSON.stringify({ model: model.key, ...body }),
  })
  const preview = await nativeStart({ prompt: "x", seconds: "4", size: "1280x720" })
  assert.equal(preview.status, 200)
  const task = await preview.json()
  assert.equal(task.adaptation.stage, "draft_preview")
  assert.deepEqual(JSON.parse(calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body).video_part_tool_param, {
    model: model.key, prompt: "x", duration_sec: 4, ratio: "16:9", draft: true,
  })
  const recovered = await service.native(auth, `https://xyq.jianying.com/v1/videos/${encodeURIComponent(task.id)}`)
  const result = await recovered.json()
  assert.equal(result.draft_task_id, "draft-original")
  assert.equal(result.draft, true)
  const upgrade = await nativeStart({ draft_task_id: result.draft_task_id, prompt: "升级样片", seconds: "8", size: "1920x1080" })
  assert.equal(upgrade.status, 200)
  const upgradeTask = await upgrade.json()
  assert.deepEqual(upgradeTask.adaptation.ignored_parameters, ["prompt", "seconds", "size"])
  const upgradeRead = await service.native(auth, `https://xyq.jianying.com/v1/videos/${encodeURIComponent(upgradeTask.id)}`)
  assert.deepEqual((await upgradeRead.json()).adaptation, upgradeTask.adaptation)
  const submissions = calls.filter((call) => call.url.pathname.endsWith("submit_run"))
  assert.equal(submissions.length, 2)
  assert.deepEqual(JSON.parse(submissions[1].init.body).video_part_tool_param, {
    model: model.key, prompt: "", draft_task_id: "draft-original",
  })
})

test("video image and audio uploads all finish before one submission", async (context) => {
  const { service, calls } = await fixture(context)
  await service.start(auth, "video", { model: video.key, prompt: "x", reference_images: [imageData], reference_videos: ["https://media.example/ref.mp4"], reference_audios: ["data:audio/mpeg;base64,YXVkaW8="] })
  const sent = JSON.parse(calls.find((call) => call.url.pathname.endsWith("submit_run")).init.body)
  for (const kind of ["images", "videos", "audios"]) assert.equal(sent.video_part_tool_param[kind].length, 1)
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("multipart Draft upgrade accepts generic fields without uploading attached media", async (context) => {
  const model = { ...video, key: "Seedance_2.5_draft" }
  const { service, calls } = await fixture(context, { video: model })
  const form = new FormData()
  for (const [key, value] of Object.entries({
    model: model.key, draft_task_id: "draft-original", prompt: "升级样片",
    seconds: "8", size: "1920x1080", resolution: "1080p", draft: "true",
  })) form.set(key, value)
  form.set("input_reference", new Blob(["unused"], { type: "image/png" }), "unused.png")
  const request = new Request("https://xyq.jianying.com/v1/videos", { method: "POST", body: form })
  const response = await service.native(auth, request.url, {
    method: "POST", headers: request.headers, body: new Uint8Array(await request.arrayBuffer()),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).adaptation.stage, "draft_upgrade")
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("upload_file")).length, 0)
  const submissions = calls.filter((call) => call.url.pathname.endsWith("submit_run"))
  assert.equal(submissions.length, 1)
  assert.deepEqual(JSON.parse(submissions[0].init.body).video_part_tool_param, {
    model: model.key, prompt: "", draft_task_id: "draft-original",
  })
})

test("model cache is isolated across credentials even when UID stays the same", async (context) => {
  const { service, calls } = await fixture(context)
  await service.api.models(auth, "image")
  await service.api.models(auth, "image")
  await service.api.models({ ...auth, key: "new-secret" }, "image")
  assert.equal(calls.length, 2)
})

test("text-specific video mode remains available without reference_generation entry", () => {
  const model = { ...video, creation_mode_config: { modes: [{ key: "text_to_video", enabled: true }] } }
  assert.equal(normalizeRequest("video", { prompt: "x", seconds: 10, ratio: "16:9" }, model).params.seconds, 10)
})

test("multiple accounts follow Magpie enabled and pinned account and support aliases", async (context) => {
  const { service, directory } = await fixture(context)
  await writeFile(join(directory, "plugin-auth.json"), JSON.stringify({
    xiaoyunque: { ...auth, metadata: { ...auth.metadata, email: "工作账号" } },
    "xiaoyunque#two": { ...auth, key: "second", metadata: { uid: "second-user", email: "个人账号" } },
  }))
  await writeFile(join(directory, "logins.json"), JSON.stringify([
    { agent: "plugin:xiaoyunque", home: "xiaoyunque", user: "工作账号", on: true },
    { agent: "plugin:xiaoyunque", home: "xiaoyunque#two", user: "个人账号", first: true, on: true },
  ]))
  await writeFile(join(directory, "providers.json"), JSON.stringify({ providers: [{ id: "xiaoyunque", accountNames: { "个人账号": "创作号" } }] }))
  assert.equal((await service.api.accountAuth()).account, "xiaoyunque#two")
  assert.equal((await service.api.accountAuth("个人账号")).account, "xiaoyunque#two")
  assert.equal((await service.api.accountAuth("创作号")).account, "xiaoyunque#two")
  assert.equal((await service.api.accountAuth(undefined, credentials(auth).account)).account, "xiaoyunque")
  await writeFile(join(directory, "logins.json"), JSON.stringify([
    { agent: "plugin:xiaoyunque", home: "xiaoyunque", user: "工作账号", on: false },
    { agent: "plugin:xiaoyunque", home: "xiaoyunque#two", user: "个人账号", first: true, on: true },
  ]))
  await assert.rejects(service.api.accountAuth("xiaoyunque"), /关闭/)
  await assert.rejects(service.api.accountAuth(undefined, credentials(auth).account), /关闭/)
  await writeFile(join(directory, "providers.json"), JSON.stringify({ providers: [{ id: "xiaoyunque", off: true }] }))
  await assert.rejects(service.api.accountAuth(), /供应商已关闭/)
})

test("model discovery uses personal identity even when generation defaults to a team", async (context) => {
  const { service, calls } = await fixture(context)
  const teamAuth = { ...auth, metadata: { ...auth.metadata, teamId: "123" } }
  await service.start(teamAuth, "video", { model: video.key, prompt: "x" })
  assert.equal(calls.find((call) => call.url.pathname.endsWith("get_available_model_list")).init.headers["X-Team-Id"], undefined)
  assert.equal(calls.find((call) => call.url.pathname.endsWith("submit_run")).init.headers["X-Team-Id"], "123")
})

test("native image failure keeps the vendor reason and recoverable task without resubmission", async (context) => {
  const setup = await fixture(context)
  const service = createService({ directory: setup.directory, fetchImpl: (url, init) =>
    String(url).endsWith("get_thread") ? Promise.resolve(envelope(runData(4, [], { error_message: "素材审核未通过" }))) : setup.fetchImpl(url, init) })
  const response = await service.native(auth, "https://xyq.jianying.com/v1/images/generations", {
    method: "POST", body: JSON.stringify({ model: image.name, prompt: "x" }),
  })
  const body = await response.json()
  assert.equal(response.status, 409)
  assert.match(body.error.message, /素材审核未通过/)
  assert.ok(body.error.task_id.startsWith("xyq1_"))
  assert.equal(setup.calls.filter((call) => call.url.pathname.endsWith("submit_run")).length, 1)
})

test("result tool recovers the original account after another account is pinned", async (context) => {
  const { service, directory } = await fixture(context)
  const started = await service.start(auth, "image", { model: image.name, prompt: "x" })
  await writeFile(join(directory, "plugin-auth.json"), JSON.stringify({
    "xiaoyunque#expired": { ...auth, metadata: { uid: "expired-user", expiresAt: 1 } },
    xiaoyunque: auth,
    "xiaoyunque#two": { ...auth, metadata: { uid: "second-user" } },
  }))
  await writeFile(join(directory, "logins.json"), JSON.stringify([
    { agent: "plugin:xiaoyunque", home: "xiaoyunque", user: "原账号", on: true },
    { agent: "plugin:xiaoyunque", home: "xiaoyunque#two", user: "新账号", first: true, on: true },
  ]))
  const result = await createTools(service).result.execute({ id: started.id }, {})
  assert.equal(result.status, "succeeded")
  assert.equal(result.images[0].url, picture.data.image.url)
  await assert.rejects(createTools(service).result.execute({ id: started.id, account: "xiaoyunque#two" }, {}), /原小云雀账号/)
})
