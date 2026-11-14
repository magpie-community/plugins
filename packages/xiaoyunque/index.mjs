import { setTimeout as wait } from "node:timers/promises"
import { beginLogin } from "./auth.mjs"
import { createAPI, credentials, PROVIDER, VendorError } from "./api.mjs"
import { buildSubmission, decodeTask, encodeTask, modelRows, normalizeRequest, parseRun } from "./media.mjs"
import { createTools } from "./tools.mjs"
import { downloadResult } from "./delivery.mjs"

const BASE = "https://xyq.jianying.com/v1"
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export function createService({ directory, fetchImpl = globalThis.fetch, pollMs = 3000, now = Date.now } = {}) {
  const api = createAPI({ directory, fetchImpl, now })
  async function start(auth, kind, body, signal) {
    if (!["image", "video"].includes(kind)) throw new VendorError("生成类型须为 image 或 video。")
    const identity = credentials(auth)
    const models = await api.models(auth, kind, { signal })
    const model = models.find((entry) => (kind === "image" ? entry.name : entry.key) === body.model)
    if (!model) throw new VendorError("请从当前小云雀模型列表选择完整模型名称。", 400)
    if (model.disabled === true) throw new VendorError("当前账号尚未开放该模型，请选择可用模型。", 400)
    const input = normalizeRequest(kind, body, model)
    const team = body.team_id !== undefined ? body.team_id : identity.teamId
    if (team !== identity.teamId) {
      const spaces = await api.spaces(auth, signal)
      if (!spaces.some((space) => String(space.team_id) === team)) throw new VendorError("当前账号不属于所选团队。", 400)
    }
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
    let submitted
    try {
      submitted = await api.post(auth, path, bodyToSubmit, { signal, teamId: team })
    } catch (error) {
      if (error.status >= 500) throw new VendorError("小云雀提交结果未知。请先在小云雀网页核对任务，禁止自动重新提交。", 409)
      throw error
    }
    if (!submitted.run?.thread_id || !submitted.run?.run_id) throw new VendorError("小云雀已响应提交，但未返回完整任务标识。请到网页核对，禁止重新提交。", 409)
    const task = {
      kind, thread: submitted.run.thread_id, run: submitted.run.run_id,
      model: body.model, team, account: identity.account, created: Math.floor(now() / 1000),
      ...(submitted.web_thread_link ? { web: submitted.web_thread_link } : {}),
      ...(input.adaptation ? { adaptation: input.adaptation } : {}),
    }
    const id = encodeTask(task)
    try {
      await api.remember(task)
    } catch {
      throw new VendorError(`小云雀任务已提交，本地记录写入失败。请保存任务 ID 并仅查询：${id}`, 409)
    }
    return { id, task }
  }
  async function result(auth, id, signal) {
    const task = decodeTask(id)
    if (credentials(auth).account !== task.account) throw new VendorError("请使用提交该任务的原小云雀账号查询。", 403)
    const data = await api.post(auth, "/api/biz/v1/skill/get_thread", { thread_id: task.thread, run_id: task.run }, { signal, teamId: task.team })
    const parsed = parseRun(data, task.run)
    if (parsed.error) parsed.error = String(parsed.error).split(credentials(auth).key).join("[已隐藏密钥]")
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
              const target = field === "image" ? "images" : field
              body[target] ??= []
              body[target].push(...(Array.isArray(source) ? source : [source]))
            } else {
              if (key === "draft" && typeof value === "string") source = JSON.parse(value)
              body[key] = source
            }
          }
        } else body = JSON.parse(typeof init.body === "string" ? init.body : Buffer.from(init.body).toString("utf8"))
        const kind = path === "/v1/videos" ? "video" : "image"
        active = await start(auth, kind, body, init.signal)
        if (kind === "video") return json(videoObject(active.task, active.id, "queued"))
        while (true) {
          init.signal?.throwIfAborted()
          const current = await result(auth, active.id, init.signal)
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
          if (current.status !== "running") throw new Error(current.error || `任务状态为 ${current.status}，请在小云雀网页处理。`)
          await wait(pollMs, undefined, { signal: init.signal })
        }
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
  return { api, start, result, collect, imageData, native }
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
        return { baseURL: BASE, apiKey: credentials(auth).key, fetch: (url, init) => service.native(auth, url, init) }
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
