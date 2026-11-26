import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { discoverConfig } from "./paths.mjs"

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/
const EXCLUDE = /(?:embedding|reranker|ocr|^llm-mock$)/i
const IMAGE_HINT = /(?:image|draw|paint|sketch|生图|绘画|图像)/i

function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function modalities(list, fallback = ["text"]) {
  if (!Array.isArray(list)) return fallback
  const allowed = new Set(["text", "image", "audio", "video", "pdf"])
  const values = [...new Set(list.filter((item) => allowed.has(item)))]
  return values.length ? values : fallback
}

function readJson(path) {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) throw new Error("invalid model catalog size")
  return JSON.parse(readFileSync(path, "utf8"))
}

export function importCatalog(raw, { source = "unknown", env = process.env } = {}) {
  const entries = raw?.provider?.QianfanPersonalQuota?.models
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("missing DuMate model catalog")

  const models = Object.create(null)
  for (const [key, value] of Object.entries(entries)) {
    const id = String(value?.id ?? key)
    if (!VALID_ID.test(key) || !VALID_ID.test(id) || !value || typeof value !== "object") continue
    if (EXCLUDE.test(key) || EXCLUDE.test(id)) continue
    if (key.startsWith("model-") && key !== "model-text") continue

    const input = modalities(value.modalities?.input)
    const output = modalities(value.modalities?.output)
    if (!input.includes("text")) continue
    const context = positive(value.limit?.context) ?? positive(value.limit?.input)
    const maxOutput = positive(value.limit?.output)
    if (!context || !maxOutput) continue

    const name = String(value.name ?? key)
    const kind = IMAGE_HINT.test(`${key} ${id} ${name}`) || output.includes("image") ? "image" : "chat"
    // Magpie recognizes OpenAI-compatible image models from modalities.output
    // containing "image" and not "text" (internal/gateway/draw.go imagesOnly).
    const normalizedInput = kind === "image" && !input.includes("text") ? ["text", ...input] : input
    const normalizedOutput = kind === "image" ? ["image"] : ["text"]
    models[key] = {
      id: key,
      upstreamId: id,
      name: key === id ? name || key : `${name || key} (${id})`,
      object: "model",
      owned_by: "dumate",
      created: 0,
      kind,
      context,
      maxOutput,
      tool_call: kind === "image" ? false : value.tool_call !== false,
      reasoning: kind === "image" ? false : (value.reasoning === true || value.capabilities?.reasoning === true || id === "deepseek-v41-flash"),
      attachment: normalizedInput.some((item) => item !== "text"),
      modalities: { input: normalizedInput, output: normalizedOutput },
    }
  }

  const ids = Object.keys(models)
  if (!ids.length) throw new Error("no usable chat models in DuMate catalog")

  const selected = String(raw?.model ?? "").split("/").at(-1) ?? ""
  const defaultChatModel = env.DUMATE_MODEL || (models[selected]?.kind === "chat" ? selected : undefined)
    || (models["model-text"] ? "model-text" : ids.find((id) => models[id].kind === "chat"))
  const imageIds = ids.filter((id) => models[id].kind === "image")
  const defaultImageModel = env.DUMATE_IMAGE_MODEL
    || (imageIds.includes("dumate-image0.1") ? "dumate-image0.1" : imageIds[0])
    || "dumate-image0.1"

  return {
    schema: 2,
    source,
    models,
    chatModels: ids.filter((id) => models[id].kind === "chat"),
    imageModels: imageIds,
    defaultChatModel,
    defaultImageModel,
  }
}

function saveSnapshot(path, catalog) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ schema: 2, models: catalog.models, savedAt: new Date().toISOString() }, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    })
    renameSync(temp, path)
  } finally {
    try { unlinkSync(temp) } catch { /* already renamed */ }
  }
}

export function loadCatalog(config = {}, { env = process.env } = {}) {
  const snapshotPath = join(config.stateDir, "model-catalog.snapshot.json")
  const sourcePath = config.configPath
    || discoverConfig({ userDataDir: config.userDataDir, env })

  try {
    if (!sourcePath) throw new Error("desktop model source unavailable")
    const catalog = importCatalog(readJson(sourcePath), { source: sourcePath, env })
    try { saveSnapshot(snapshotPath, catalog) } catch { /* snapshot is best-effort */ }
    return catalog
  } catch {
    try {
      const snapshot = readJson(snapshotPath)
      return importCatalog({ provider: { QianfanPersonalQuota: { models: snapshot.models } } }, {
        source: `snapshot:${snapshotPath}`,
        env,
      })
    } catch { /* try builtin catalog */ }
    try {
      const builtin = readJson(new URL("./models.default.json", import.meta.url))
      return importCatalog(builtin, { source: "builtin", env })
    } catch {
      return importCatalog({
        provider: {
          QianfanPersonalQuota: {
            models: {
              "model-text": { id: "model-text", limit: { context: 1_000_000, output: 384_000 } },
              "dumate-image0.1": { id: "dumate-image0.1", limit: { context: 200_000, output: 32_000 } },
            },
          },
        },
      }, { source: "fallback", env })
    }
  }
}
