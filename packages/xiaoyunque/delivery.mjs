import { createWriteStream } from "node:fs"
import { link, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { fingerprint, VendorError } from "./api.mjs"

export async function downloadResult(result, directory, fetchImpl, signal) {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new VendorError("download_dir 须为本地绝对目录。")
  const files = []
  if (result.status !== "succeeded") return files
  await mkdir(directory, { recursive: true })
  const prefix = fingerprint(`${result.task.thread}:${result.task.run}`)
  const extensions = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/webm": "webm",
  }
  for (const kind of ["images", "videos"]) {
    for (const [index, media] of result[kind].entries()) {
      signal?.throwIfAborted()
      const url = new URL(media.url)
      if (url.protocol !== "https:" || url.username || url.password) throw new VendorError("产物下载地址无效。")
      const response = await fetchImpl(url, { signal, redirect: "error" })
      if (!response.ok) {
        await response.body?.cancel()
        throw new VendorError(`产物下载失败（HTTP ${response.status}），请继续查询原任务。`)
      }
      const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
      const extension = extensions[mime]
      if (!extension || !mime.startsWith(kind === "images" ? "image/" : "video/")) {
        await response.body?.cancel()
        throw new VendorError("产物下载未返回支持的媒体类型。")
      }
      const output = join(directory, `${prefix}-${kind}-${index + 1}.${extension}`)
      const temporary = await mkdtemp(join(directory, ".xyq-download-"))
      try {
        const staging = join(temporary, "media")
        await pipeline(response.body, createWriteStream(staging, { flags: "wx", mode: 0o600 }), { signal })
        if ((await stat(staging)).size === 0) throw new VendorError("产物下载返回空文件，未保存。")
        try {
          await link(staging, output)
        } catch (error) {
          if (error.code === "EEXIST") throw new VendorError(`文件已存在，未覆盖：${output}。请使用新的 download_dir。`)
          throw error
        }
        media.local_path = output
        files.push({ kind: kind === "images" ? "image" : "video", index, path: output })
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  }
  return files
}
