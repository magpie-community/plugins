import { open, realpath, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { failure } from "./acp.mjs"
import { baseURL } from "./catalog.mjs"
import { invokeBuiltin } from "./native-tools.mjs"

export const imageId = "droid-image"
const imageSDK = "@ai-sdk/openai-compatible"
const name = "Factory Droid Image"
export const imageModel = { name, api: { id: imageId, url: baseURL, npm: imageSDK },
  capabilities: { input: { text: true, image: true }, output: { text: false, image: true }, attachment: true, toolcall: false } }

const maxRef = 5 * 1024 * 1024
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function format(buffer) {
  if (buffer.subarray(0, 8).equals(png)) return "png"
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "jpg"
}

async function reference(value) {
  let bytes
  if (value instanceof Blob && value.size <= maxRef) bytes = Buffer.from(await value.arrayBuffer())
  if (typeof value === "string" && value.length <= Math.ceil(maxRef / 3) * 4 + 40) {
    const match = /^data:image\/(?:png|jpeg);base64,([\w+/]+=*)$/i.exec(value)
    if (match) bytes = Buffer.from(match[1], "base64")
  }
  const ext = bytes && format(bytes)
  if (!ext || bytes.length > maxRef) throw failure(400, "Each reference must be a PNG or JPEG upload of at most 5 MB.")
  return { ext, bytes }
}

async function drawing(key, signal, prompt, refs) {
  const start = Date.now()
  const update = await invokeBuiltin({ name: "GenerateImage", key, signal,
    prompt: "Call GenerateImage once to produce a raster image for this request: " + JSON.stringify(prompt),
    async setup(cwd) {
      const dir = await realpath(cwd)
      const paths = await Promise.all(refs.map(async ({ ext, bytes }, i) => {
        const path = join(dir, "reference-" + (i + 1) + "." + ext)
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
        return path
      }))
      await writeFile(join(dir, "references.json"), JSON.stringify(paths), { mode: 0o600 })
      return [{ type: "text", text: "\nPass exactly these absolute paths in references, in this order: " + JSON.stringify(paths) }]
    } })
  const saved = [...(update.rawOutput?.text ?? "").matchAll(/^Saved to:[ \t]+(.+)$/gm)].at(-1)?.[1]?.trim()
  if (!saved) throw failure(502, "Droid returned no generated image.")
  const dir = await realpath(join(process.env.FACTORY_HOME_OVERRIDE || homedir(), ".factory", "generated-images"))
  if (dirname(await realpath(saved)) !== dir) throw failure(502, "Droid returned an unexpected image path.")
  const file = await open(saved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = await file.stat()
    if (!st.isFile() || st.size > 32 * 1024 * 1024 || st.mtimeMs < start - 1000) throw failure(502, "Invalid generated image file.")
    const bytes = await file.readFile()
    if (!format(bytes)) throw failure(502, "Droid returned an unsupported image format.")
    return { b64_json: bytes.toString("base64") }
  } finally { await file.close() }
}

export async function imageResponse(req, edit, key, signal) {
  let fields, uploads
  try {
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await req.formData()
      fields = Object.fromEntries(form)
      uploads = [...form.getAll("image"), ...form.getAll("image[]")]
    } else {
      fields = await req.json()
      uploads = fields.image ?? fields.images ?? []
      if (!Array.isArray(uploads)) uploads = [uploads]
    }
  } catch { throw failure(400, "Invalid image request.") }
  if (typeof fields?.model !== "string" || fields.model.split("/").at(-1) !== imageId || typeof fields.prompt !== "string" || !fields.prompt.trim()) throw failure(400, "A droid-image model and prompt are required.")
  if (fields.mask != null || (fields.response_format && fields.response_format !== "b64_json")) throw failure(400, "Droid supports unmasked images returned as b64_json.")
  if (uploads.length > 4 || (edit ? !uploads.length : uploads.length)) throw failure(400, "Supply 1 to 4 reference images on the edits endpoint.")
  const n = Number(fields.n ?? 1)
  if (!Number.isInteger(n) || n < 1 || n > 4) throw failure(400, "n must be between 1 and 4.")
  const refs = await Promise.all(uploads.map(reference))
  const prompt = fields.size && fields.size !== "auto" ? fields.prompt + "\nRequested dimensions: " + fields.size : fields.prompt
  const data = []
  for (let i = 0; i < n; i++) data.push(await drawing(key, signal, prompt, refs))
  return Response.json({ created: Math.floor(Date.now() / 1000), data })
}
