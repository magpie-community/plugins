import { setTimeout as wait } from "node:timers/promises"
import { beginLogin } from "./auth.mjs"
import { createAPI, credentials, PROVIDER, VendorError } from "./api.mjs"
import { buildSubmission, decodeTask, encodeTask, modelRows, normalizeRequest, parseRun } from "./media.mjs"
import { createTools } from "./tools.mjs"
import { downloadResult } from "./delivery.mjs"

const BASE = "https://xyq.jianying.com/v1"
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export function createService({ directory, fetchImpl = globalThis.fetch, pollMs = 3000, imageTimeoutMs = 300_000, now = Date.now, maxTasks = 200 } = {}) {
  const api = createAPI({ directory, fetchImpl, now, maxTasks })
  async function resolveTeam(auth, teamId, identity, signal) {
    const team = teamId !== undefined ? teamId : identity.teamId
    if (team !== identity.teamId) {
      const spaces = await api.spaces(auth, signal)
      if (!spaces.some((space) => String(space.team_id) === team)) throw new VendorError("当前账号不属于所选团队。", 400)
    }
    return team
  }
  async function submitTask(auth, { kind, model, team, identity, path, body, adaptation }, signal) {
    await api.ensureWatermarkOff(auth, signal)
    signal?.throwIfAborted()
    let submitted
    try {
      submitted = await api.post(auth, path, body, { signal, teamId: team })
    } catch (error) {
      if (error.status >= 500) throw new VendorError("小云雀提交结果未知。请先在小云雀网页核对任务，禁止自动重新提交。", 409)
      throw error
    }
    if (!submitted.run?.thread_id || !submitted.run?.run_id) throw new VendorError("小云雀已响应提交，但未返回完整任务标识。请到网页核对，禁止重新提交。", 409)
    const task = {
      kind, thread: submitted.run.thread_id, run: submitted.run.run_id,
      model, team, account: identity.account, created: Math.floor(now() / 1000),
      ...(submitted.web_thread_link ? { web: submitted.web_thread_link } : {}),
      ...(adaptation ? { adaptation } : {}),
    }
    const id = encodeTask(task)
    try {
      await api.remember(task)
    } catch {
      throw new VendorError(`小云雀任务已提交，本地记录写入失败。请保存任务 ID 并仅查询：${id}`, 409)
    }
    return { id, task }
  }
  async function start(auth, kind, body, signal) {
    if (!["image", "video"].includes(kind)) throw new VendorError("生成类型须为 image 或 video。")
    const identity = credentials(auth)
    const models = await api.models(auth, kind, { signal })
    const model = models.find((entry) => (kind === "image" ? entry.name : entry.key) === body.model)
    if (!model) throw new VendorError("请从当前小云雀模型列表选择完整模型名称。", 400)
    if (model.disabled === true) throw new VendorError("当前账号尚未开放该模型，请选择可用模型。", 400)
    const input = normalizeRequest(kind, body, model)
    const team = await resolveTeam(auth, body.team_id, identity, signal)
    const assets = { images: [], videos: [], audios: [] }
    for (const [key, type] of [["images", "image"], ["videos", "video"], ["audios", "audio"]]) {
      const results = []
      for (let offset = 0; offset < input[key].length; offset += 10) {
        results.push(...await Promise.allSettled(input[key].slice(offset, offset + 10).map((source, index) =>
          api.upload(auth, source, type, { teamId: team, signal, index: offset + index }))))
      }
      assets[key] = results
    }
    const failures = Object.entries(assets).flatMap(([kind, results]) =>
      results.flatMap((result, index) => result.status === "rejected" ? [`${kind} ${index + 1}: ${result.reason.message}`] : []))
    if (failures.length) throw new VendorError(`素材上传未全部成功，尚未提交生成：${failures.join("；")}`, 400)
    for (const key of ["images", "videos", "audios"]) assets[key] = assets[key].map((result) => result.value)
    const bodyToSubmit = buildSubmission(kind, input, model, assets)
    const attribution = { scene_lv1: "ai_agent", scene_lv2: "front_tool", tool_id: "instant_video", tab_name: "other", edit_type: "instant_video", enter_from: "skill" }
    const path = "/api/biz/v1/skill/submit_run" + (kind === "video" ? `?babi_param=${encodeURIComponent(JSON.stringify(attribution))}` : "")
    return submitTask(auth, { kind, model: body.model, team, identity, path, body: bodyToSubmit, adaptation: input.adaptation }, signal)
  }
  async function processVideo(auth, body, signal) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new VendorError("视频处理请求必须是对象。")
    const actions = { super_resolution: "video_super_resolution", erase_subtitle: "erase_video_subtitle" }
    const toolName = actions[body.action]
    if (!toolName) throw new VendorError("action 须为 super_resolution 或 erase_subtitle。")
    if (!body.video) throw new VendorError("请提供待处理的视频。")
    let payload
    let message
    if (body.action === "super_resolution") {
      if (typeof body.output_resolution !== "string" || !body.output_resolution.trim()) throw new VendorError("视频超分须提供 output_resolution（如 720p、1080p、2k、4k）。")
      const output_resolution = body.output_resolution.trim().toLowerCase()
      const tool_version = body.tool_version !== undefined ? String(body.tool_version).trim() : ""
      if (body.tool_version !== undefined && (typeof body.tool_version !== "string" || !tool_version)) throw new VendorError("tool_version 须为有效字符串。")
      payload = { output_resolution, ...(tool_version ? { tool_version } : {}) }
      message = "提升视频清晰度"
    } else {
      if (body.output_resolution !== undefined || body.tool_version !== undefined) throw new VendorError("擦除字幕不支持 output_resolution 或 tool_version。")
      message = "擦除视频字幕"
    }
    const identity = credentials(auth)
    const team = await resolveTeam(auth, body.team_id, identity, signal)
    const assetId = await api.upload(auth, body.video, "video", { teamId: team, signal, index: 0 })
    const videoRef = { pippit_asset_id: assetId }
    const tool_param = body.action === "super_resolution"
      ? { video_super_resolution_tool_param: { ...payload, video: videoRef } }
      : { erase_video_subtitle_tool_param: { video: videoRef } }
    return submitTask(auth, {
      kind: "video",
      model: toolName,
      team,
      identity,
      path: "/api/biz/v1/skill/submit_run",
      body: {
        agent_name: "pippit_video_part_agent",
        call_source: "pippit_cli",
        message,
        platform: "magpie",
        video_part_tool_param: { mini_tool_param: { tool_name: toolName, tool_param } },
      },
    }, signal)
  }
  async function result(auth, id, signal) {
    const task = decodeTask(id)
    const identity = credentials(auth)
    if (identity.account !== task.account) throw new VendorError("请使用提交该任务的原小云雀账号查询。", 403)
    let data
    let queryError
    try {
      data = await api.post(auth, "/api/biz/v1/skill/get_thread", { thread_id: task.thread, run_id: task.run }, { signal, teamId: task.team })
    } catch (error) {
      if (!(error instanceof VendorError) || !error.data) throw error
      data = error.data
      queryError = error
    }
    let parsed
    try {
      parsed = parseRun(data, task.run, queryError?.message)
    } catch (error) {
      if (queryError) throw queryError
      throw error
    }
    if (parsed.error) parsed.error = String(parsed.error).split(identity.key).join("[已隐藏密钥]")
    return { ...parsed, task, id, ...(task.web ? { web_thread_link: task.web } : {}) }
  }
  async function imageData(images, signal) {
    return Promise.all(images.map(async (image) => {
      const url = new URL(image.url)
      if (url.protocol !== "https:" || url.username || url.password) throw new VendorError("小云雀返回了无效的图片下载地址。", 502)
      const response = await fetchImpl(url, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55_000)]) : AbortSignal.timeout(55_000),
        redirect: "error",
      })
      if (!response.ok) throw new VendorError(`原图片下载失败（HTTP ${response.status}），请继续查询原任务。`, response.status)
      const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
      if (!mime?.startsWith("image/")) {
        await response.body?.cancel()
        throw new VendorError("原图片下载未返回图片媒体类型，请继续查询原任务。", 502)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length) throw new VendorError("原图片下载返回空文件，请继续查询原任务。", 502)
      return { b64_json: bytes.toString("base64"), media_type: mime }
    }))
  }
  async function collect(auth, id, { wait_seconds = 0, download_dir } = {}, signal) {
    if (!Number.isInteger(wait_seconds) || wait_seconds < 0 || wait_seconds > 40) {
      throw new VendorError("wait_seconds 须为 0–40 的整数。")
    }
    const budget = AbortSignal.timeout(48_000)
    const bounded = signal ? AbortSignal.any([signal, budget]) : budget
    const until = Date.now() + wait_seconds * 1000
    let current = await result(auth, id, bounded)
    if (wait_seconds > 0) {
      const remaining = Math.max(1, until - Date.now())
      const deadline = AbortSignal.timeout(remaining)
      const polling = AbortSignal.any([bounded, deadline])
      try {
        while (current.status === "running" && Date.now() < until) {
          await wait(Math.min(pollMs, until - Date.now()), undefined, { signal: polling })
          current = await result(auth, id, polling)
        }
      } catch (error) {
        bounded.throwIfAborted()
        if (!deadline.aborted) throw error
      }
      current.timed_out = current.status === "running"
    }
    if (download_dir !== undefined && current.status === "succeeded") {
      try {
        current.files = await downloadResult(current, download_dir, fetchImpl, bounded)
      } catch (error) {
        current.files = ["images", "videos"].flatMap((kind) => current[kind].flatMap((media, index) =>
          media.local_path ? [{ kind: kind === "images" ? "image" : "video", index, path: media.local_path }] : []))
        current.download_error = error instanceof VendorError ? error.message : "下载中断或文件无法保存。"
        current.download_error += " 原任务已生成，请仅查询原任务或更换保存目录，不要重新生成。"
      }
    }
    return current
  }
  async function native(auth, input, init = {}) {
    const url = new URL(input)
    const path = url.pathname
    const method = init.method ?? "GET"
    let active
    try {
      if (method === "POST" && ["/v1/images/generations", "/v1/images/edits", "/v1/videos"].includes(path)) {
        const kind = path === "/v1/videos" ? "video" : "image"
        let body
        const contentType = new Headers(init.headers).get("content-type") ?? ""
        if (contentType.startsWith("multipart/form-data")) {
          const form = await new Response(init.body, { headers: { "content-type": contentType } }).formData()
          body = {}
          for (const [key, value] of form) {
            let source = typeof value === "string" ? value :
              `data:${value.type};base64,${Buffer.from(await value.arrayBuffer()).toString("base64")}`
            const field = key.replace(/\[\]$/, "")
            if (["image", "images", "reference_images", "reference_videos", "reference_audios"].includes(field)) {
              if (typeof value === "string" && value.trimStart().startsWith("[")) source = JSON.parse(value)
              const target = field === "image" && kind === "image" ? "images" : field
              body[target] ??= []
              body[target].push(...(Array.isArray(source) ? source : [source]))
            } else {
              if (key === "draft" && typeof value === "string") source = JSON.parse(value)
              body[key] = source
            }
          }
        } else body = JSON.parse(typeof init.body === "string" ? init.body : Buffer.from(init.body).toString("utf8"))
        active = await start(auth, kind, body, init.signal)
        if (kind === "video") return json(videoObject(active.task, active.id, "queued"))
        const deadline = AbortSignal.timeout(imageTimeoutMs)
        const polling = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
        let current
        try {
          while (true) {
            polling.throwIfAborted()
            current = await result(auth, active.id, polling)
            if (current.status !== "running") break
            await wait(pollMs, undefined, { signal: polling })
          }
        } catch (error) {
          if (deadline.aborted && !init.signal?.aborted) throw new VendorError("图片生成等待超时。", 409)
          throw error
        }
        if (current.status === "succeeded") {
          if (!current.images.length) throw new Error("任务没有返回图片产物。")
          const data = body.response_format === "url"
            ? current.images.map((image) => ({ url: image.url }))
            : await imageData(current.images, init.signal)
          return json({
            created: active.task.created, data,
            ...(active.task.adaptation ? { adaptation: active.task.adaptation } : {}),
          })
        }
        throw new Error(current.error || `任务状态为 ${current.status}，请在小云雀网页处理。`)
      }
      const route = /^\/v1\/videos\/([^/]+)(\/content)?$/.exec(path)
      if (method === "GET" && route) {
        const id = decodeURIComponent(route[1])
        const current = await result(auth, id, init.signal)
        if (current.task.kind !== "video") throw new VendorError("该任务不是视频。")
        if (current.status === "unknown") throw new VendorError("小云雀返回未知任务状态，请继续查询原任务，不要重新生成。", 409)
        if (route[2]) {
          if (current.status !== "succeeded" || !current.videos.length) throw new VendorError("原视频任务尚未生成可下载内容。", 409)
          const download = new URL(current.videos[0].url)
          if (download.protocol !== "https:" || download.username || download.password) throw new VendorError("小云雀返回了无效的媒体下载地址。", 502)
          const timeout = AbortSignal.timeout(48_000)
          const response = await fetchImpl(download, { signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout, redirect: "error" })
          if (!response.ok) throw new VendorError(`原视频下载失败（HTTP ${response.status}），可继续查询原任务。`, response.status)
          const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
          if (!mime?.startsWith("video/")) {
            await response.body?.cancel()
            throw new VendorError("原视频下载未返回视频媒体类型，请继续查询原任务。", 502)
          }
          return new Response(response.body, { headers: { "content-type": mime } })
        }
        const status = current.status === "succeeded" ? "completed" : current.status === "running" ? "in_progress" : "failed"
        return json({
          ...videoObject(current.task, id, status),
          ...(current.error || status === "failed" ? { error: { code: "xiaoyunque_task", message: current.error || `小云雀任务状态 ${current.status}` } } : {}),
          ...(current.videos[0]?.draftTaskId ? { draft_task_id: current.videos[0].draftTaskId } : {}),
          ...(typeof current.videos[0]?.draft === "boolean" ? { draft: current.videos[0].draft } : {}),
          videos: current.videos,
          ...(current.credit_consumption ? { credit_consumption: current.credit_consumption } : {}),
          ...(current.predict_duration_ms !== undefined ? { predict_duration_ms: current.predict_duration_ms } : {}),
        })
      }
      return json({ error: { message: "小云雀供应商提供图片和视频生成，请使用媒体入口。", type: "invalid_request_error" } }, 400)
    } catch (error) {
      if (active) return json({
        error: { type: "xiaoyunque_task_pending", message: `${error.message} 原任务已提交，请仅查询原任务。任务 ID：${active.id}`, task_id: active.id, web_thread_link: active.task.web },
      }, 409)
      return json({ error: { type: "xiaoyunque_error", message: error.message } }, error.status ?? 400)
    }
  }
  return { api, start, processVideo, result, collect, imageData, native }
}

function videoObject(task, id, status) {
  return {
    id, object: "video", model: task.model, status, created_at: task.created,
    ...(status === "completed" ? { progress: 100 } : {}),
    ...(task.web ? { web_thread_link: task.web } : {}),
    ...(task.adaptation ? { adaptation: task.adaptation } : {}),
  }
}

export async function XiaoyunquePlugin(input) {
  const service = createService({ directory: input.directory })
  let sharedConfig
  async function loadModels(auth, signal) {
    const catalogs = await Promise.all(["image", "video"].map((kind) => service.api.models(auth, kind, { signal })))
    const models = modelRows(catalogs.flat())
    if (sharedConfig) sharedConfig.provider[PROVIDER].models = models
    return models
  }
  return {
    async config(config) {
      sharedConfig = config
      config.provider ??= {}
      config.provider[PROVIDER] ??= { name: "小云雀", npm: "@ai-sdk/openai-compatible", api: BASE, models: {} }
    },
    auth: {
      provider: PROVIDER,
      methods: [
        { type: "oauth", label: "登录小云雀", authorize: (_inputs, { signal } = {}) => beginLogin({ directory: input.directory, signal }) },
        { type: "api", label: "Access Key", placeholder: "粘贴小云雀 API 页面创建的 Access Key" },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        await loadModels(auth)
        return { baseURL: BASE, apiKey: credentials(auth).key, fetch: async (url, init) => service.native(await getAuth(), url, init) }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        const data = await service.api.post(auth, "/api/biz/v1/skill/get_credit_balance", {})
        if (typeof data.total_remain_amount !== "string" || !/^\d+$/.test(data.total_remain_amount)) throw new Error("小云雀没有返回有效积分余额。")
        const balance = Number(data.total_remain_amount)
        if (!Number.isSafeInteger(balance)) throw new Error("小云雀积分数值超出可表示范围。")
        return {
          user: auth.metadata?.email, balance: `${data.total_remain_amount} 积分`,
          windows: [{ name: "积分", balance, unit: "credits", display: `${data.total_remain_amount} 积分` }],
        }
      },
    },
    provider: {
      id: PROVIDER,
      async models(_provider, { auth, signal } = {}) {
        if (!auth) return {}
        return loadModels(auth, signal)
      },
    },
    tool: createTools(service),
  }
}

export default { server: XiaoyunquePlugin }
