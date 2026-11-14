import { readFile, realpath, stat } from "node:fs/promises"
import { extname, isAbsolute, resolve } from "node:path"
import { decodeTask, describeModel, encodeTask } from "./media.mjs"

const string = (description) => ({ type: "string", description })
const array = (description) => ({ type: "array", items: { type: "string" }, description })
const base = {
  account: string("可选 Magpie 小云雀账号 ID 或备注；默认跟随供应商页置顶的启用账号，查询任务自动使用原账号。"),
  team_id: string("明确选择个人 0 或所属团队 ID，默认使用供应商账号空间。"),
}
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false })

export function createTools(service) {
  return {
    models: {
      description: "查看小云雀当前账号可用模型、完整生成参数、创作模式及所属空间；creation_modes 的 request 提供已适配模式的参数与输入字段，须结合 enabled、素材限制和比例／时长政策使用。",
      args: schema({ ...base, kind: { type: "string", enum: ["image", "video"] }, model: string("可选，准确图片名称或视频模型 ID。"), refresh: { type: "boolean" } }, ["kind"]),
      async execute(args, context) {
        const { auth, account, accounts } = await service.api.accountAuth(args.account)
        if (!["image", "video"].includes(args.kind)) throw new Error("kind 须为 image 或 video。")
        const models = await service.api.models(auth, args.kind, { signal: context.abort, refresh: args.refresh })
        const filtered = args.model ? models.filter((model) => (args.kind === "image" ? model.name : model.key) === args.model) : models
        if (args.model && !filtered.length) throw new Error("当前账号没有该模型，请查询模型列表。")
        return { account, accounts, models: filtered.map(describeModel), spaces: await service.api.spaces(auth, context.abort) }
      },
    },
    generate: {
      description: "提交一次小云雀图片或视频生成，立即返回任务 ID 和官方页面；使用 result 查询，禁止通过再次生成恢复任务。选择 Seedance_2.5_draft 自动生成样片；先展示样片，用户明确要求升级后才用 source_task_id 或原 draft_task_id 另行提交计费。升级兼容通用创作参数但沿用原样片设置，返回 adaptation 说明。参考素材可用 HTTPS、data URL 或用户指定的本地绝对路径。",
      args: schema({
        ...base, kind: { type: "string", enum: ["image", "video"] }, model: string("使用 models 工具返回的完整图片名称或视频 ID。"),
        prompt: string("用户原始生成提示词；样片转成片可省略。"), ratio: string("例如 16:9、9:16、1:1 或 adaptive；Seedance 2.0 Mini 体验版普通生成必须填写。"),
        size: string("通用尺寸或比例，例如 1024x1024、1280x720、16:9；显式 ratio/resolution 优先。"),
        quality: string("图片通用质量，映射到模型 effort；auto 使用默认值，与显式 effort 只选一项。"),
        resolution: string("使用模型当前支持的分辨率；Draft 两阶段接受但忽略，服务端固定样片 480p、成片 1080p。"), effort: string("可选图片推理强度，使用 models 返回的 effort 选项；省略时使用服务端默认值。"),
        n: { type: "integer", minimum: 1, maximum: 4 },
        seconds: { type: "integer", minimum: 1, description: "通用视频时长，单位秒；通常使用此字段。" },
        duration: { type: "integer", minimum: 1, description: "可选高级时长别名，单位秒；显式填写时优先于 seconds，通常只填一项。不支持 -1，自动时长请省略。" },
        reference_images: array("参考图片，按输入顺序。"),
        image: string("视频首帧，与 input_reference 只选一项；图片生成时作为单张参考图片。"),
        input_reference: string("视频首帧，自动进入首尾帧模式，不与 task_type 的 reference/edit/extend 混用。"), last_frame: string("视频尾帧，需要首帧。"),
        reference_videos: array("参考视频。"), reference_audios: array("参考音频。"),
        generate_type: { type: "integer", enum: [0, 1] },
        task_type: { type: "string", enum: ["reference", "edit", "extend"] },
        seed: { type: "integer", description: "可选，按当前模型能力填写；未提供时保持缺省。" }, draft: { type: "boolean", description: "选择 Seedance_2.5_draft 自动生成样片，可省略；提供 draft_task_id 时以升级为准。" },
        draft_task_id: string("result 返回 videos[].draftTaskId。升级继续使用 Seedance_2.5_draft；附带的 prompt、时长、比例、分辨率、seed 或素材被忽略，不重新读取或上传素材；另行计费。"),
        source_task_id: string("升级已有样片时提供原 generate 返回的任务 ID，自动恢复原账号、团队、模型和真实 Draft ID；用户先预览并明确要求升级后使用。与 draft_task_id 二选一；此时 kind/model 可省略。"),
        video_index: { type: "integer", minimum: 0, description: "source_task_id 返回多个视频时必填，选择 videos 数组下标，从 0 开始。" },
      }),
      async execute(args, context) {
        const source = args.source_task_id === undefined ? undefined : decodeTask(args.source_task_id)
        if (!source && (!["image", "video"].includes(args.kind) || typeof args.model !== "string" || !args.model.trim())) {
          throw new Error("普通生成须填写 kind（image 或 video）和完整 model。")
        }
        if (source && (source.kind !== "video" || source.model !== "Seedance_2.5_draft")) throw new Error("原任务不是 Draft 视频样片。")
        if (source && args.draft_task_id !== undefined) throw new Error("source_task_id 和 draft_task_id 请只填写一项。")
        if (args.video_index !== undefined && (!source || !Number.isInteger(args.video_index) || args.video_index < 0)) throw new Error("video_index 须为原任务的视频下标。")
        if (source && ((args.kind !== undefined && args.kind !== source.kind) ||
            (args.model !== undefined && args.model !== source.model) ||
            (args.team_id !== undefined && args.team_id !== source.team))) throw new Error("样片升级须沿用原任务类型、模型和团队。")
        const kind = args.kind ?? source?.kind
        const upgrading = source !== undefined || (kind === "video" && args.draft_task_id !== undefined)
        if (kind === "video" && !upgrading && args.image !== undefined && args.input_reference !== undefined) {
          throw new Error("image 和 input_reference 均表示首帧，请只填写一项。")
        }
        const { auth, account } = await service.api.accountAuth(args.account, source?.account)
        const { kind: _kind, account: _account, source_task_id, video_index, ...body } = args
        if (kind === "video" && !upgrading && body.image !== undefined) {
          body.input_reference = body.image
          delete body.image
        }
        if (source) {
          const original = await service.result(auth, source_task_id, context.abort)
          if (original.status !== "succeeded") throw new Error("原样片尚未成功，请继续查询原任务。")
          if (original.videos.length !== 1 && video_index === undefined) throw new Error("原任务有多个视频，请提供 video_index 选择样片。")
          const selected = original.videos[video_index ?? 0]
          if (!selected || selected.draft === false || source.adaptation?.stage === "draft_upgrade" || !selected.draftTaskId) {
            throw new Error("所选视频不是可升级样片或缺少原始 Draft ID，请查询原任务，不猜测 ID。")
          }
          body.model = source.model
          body.team_id = source.team
          body.draft_task_id = selected.draftTaskId
        }
        const converted = upgrading ? body : await localMedia(body, context.directory)
        const started = await service.start(auth, kind, converted, context.abort)
        return { account, id: started.id, status: "submitted", team_id: started.task.team, web_thread_link: started.task.web,
          ...(started.task.adaptation ? { adaptation: started.task.adaptation } : {}) }
      },
    },
    result: {
      description: "查询原小云雀任务并返回图片或视频、样片标识及服务端结果信息；可限时等待并下载到本地目录，不覆盖已有文件，失败不重新生成。省略 id 查看最近 20 个任务以恢复中断工作。",
      args: schema({
        id: string("generate 返回的任务 ID；省略则列出最近任务。"), account: base.account,
        wait_seconds: { type: "integer", minimum: 0, maximum: 40, description: "可选等待秒数，默认立即查询；超时后仍使用原任务 ID 继续查询，不重新生成。" },
        download_dir: string("可选本地绝对目录；成功后保存图片和视频，不覆盖已有文件。下载失败仍返回原任务和已保存文件。"),
      }),
      async execute(args, context) {
        if (args.id === undefined && (args.wait_seconds !== undefined || args.download_dir !== undefined)) throw new Error("等待或下载请指定原任务 id。")
        if (args.download_dir !== undefined && (typeof args.download_dir !== "string" || !isAbsolute(args.download_dir))) throw new Error("download_dir 须为本地绝对目录。")
        const task = args.id === undefined ? undefined : decodeTask(args.id)
        const { auth } = await service.api.accountAuth(args.account, task?.account)
        if (args.id === undefined) return { tasks: (await service.api.recent(auth)).map((task) => ({
          id: encodeTask(task), kind: task.kind, model: task.model, created_at: task.created, team_id: task.team, web_thread_link: task.web,
        })) }
        const result = await service.collect(auth, args.id, args, context.abort)
        return {
          id: result.id, status: result.status, ...(result.error ? { error: result.error } : {}),
          images: result.images, videos: result.videos, team_id: task.team, web_thread_link: result.web_thread_link,
          ...(task.adaptation ? { adaptation: task.adaptation } : {}),
          ...(result.timed_out !== undefined ? { timed_out: result.timed_out } : {}),
          ...(result.files ? { files: result.files } : {}),
          ...(result.download_error ? { download_error: result.download_error } : {}),
          ...(result.credit_consumption ? { credit_consumption: result.credit_consumption } : {}),
          ...(result.predict_duration_ms !== undefined ? { predict_duration_ms: result.predict_duration_ms } : {}),
        }
      },
    },
  }
}

async function localMedia(body, directory) {
  const mimes = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  }
  async function convert(source) {
    if (typeof source !== "string") throw new Error("参考媒体须为字符串。")
    if (/^(https:|data:)/.test(source)) return source
    if (!isAbsolute(source)) throw new Error("本地参考素材请提供完整绝对路径。")
    const path = await realpath(resolve(directory, source))
    const details = await stat(path)
    if (!details.isFile() || details.size <= 0 || details.size >= 500_000_000) throw new Error("参考媒体须为小于 500 MB 的文件。")
    const mime = mimes[extname(path).toLowerCase()]
    if (!mime) throw new Error("不支持该参考媒体文件格式。")
    return `data:${mime};base64,${(await readFile(path)).toString("base64")}`
  }
  const converted = { ...body }
  for (const key of ["reference_images", "reference_videos", "reference_audios"]) {
    if (converted[key]) converted[key] = await Promise.all(converted[key].map(convert))
  }
  for (const key of ["image", "input_reference", "last_frame"]) if (converted[key]) converted[key] = await convert(converted[key])
  return converted
}
