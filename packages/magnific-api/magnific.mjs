// Magnific's REST API: credentials, task submit and polling, downloads.
import { createWriteStream, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { extname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export const PROVIDER = "magnific"
const API = "https://api.magnific.com"
const DONE = new Set(["COMPLETED"])
const FAILED = new Set(["FAILED", "ERROR", "CANCELLED", "CANCELED"])

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return null }
}

// Where the hosts keep what the auth hook saved: magpie in its config
// directory (the plugin's `directory`), OpenCode in its data directory.
export function authFiles(input, env = process.env) {
  const home = env.HOME || homedir()
  return [
    input?.directory && join(input.directory, "plugin-auth.json"),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "magpie", "plugin-auth.json"),
    join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json"),
  ].filter(Boolean)
}

// The API key to use: MAGNIFIC_API_KEY, else the account signed in through
// the host (`account` picks one of several magpie accounts).
export function credentialOf(input, account, env = process.env) {
  if (!account && env.MAGNIFIC_API_KEY) return { type: "api", key: env.MAGNIFIC_API_KEY.trim() }
  const ids = new Set()
  for (const file of authFiles(input, env)) {
    for (const [id, auth] of Object.entries(readJson(file) ?? {})) {
      if (id !== PROVIDER && !id.startsWith(`${PROVIDER}#`)) continue
      ids.add(id)
      if (account ? id !== account : id !== PROVIDER) continue
      if (auth?.type === "api" && auth.key) return { type: "api", key: String(auth.key).trim() }
    }
  }
  if (account) throw new Error(`No Magnific account "${account}".${ids.size ? ` Signed in: ${[...ids].join(", ")}` : ""}`)
  throw new Error(
    "No Magnific API key. Set MAGNIFIC_API_KEY, or sign in: `opencode auth login` → Magnific, or `magpie plugin login magnific`. " +
    "Keys: https://www.magnific.com/user/organization/api-keys",
  )
}

export function createClient({ key, base = process.env.MAGNIFIC_API_BASE || API, fetch: send = fetch } = {}) {
  async function call(method, path, body, signal) {
    const res = await send(base.replace(/\/$/, "") + path, {
      method,
      headers: { "x-magnific-api-key": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    if (!res.ok) {
      const why = json?.message ?? json?.error?.message ?? json?.error ?? text.slice(0, 300)
      const hint = res.status === 401 ? " (the API key was refused)" : res.status === 429 ? " (rate limit, retry later)" : ""
      throw Object.assign(new Error(`Magnific ${method} ${path} answered ${res.status}${hint}: ${typeof why === "string" ? why : JSON.stringify(why)}`), { status: res.status })
    }
    return json?.data ?? json ?? {}
  }

  const taskOf = (model, data) => {
    const status = String(data.status ?? "").toUpperCase()
    return {
      task: `${model.id}:${data.task_id}`,
      model: model.id,
      kind: model.kind,
      status,
      done: DONE.has(status),
      failed: FAILED.has(status),
      urls: Array.isArray(data.generated) ? data.generated.filter((u) => typeof u === "string") : [],
      ...(data.error || data.message ? { error: data.error ?? data.message } : {}),
    }
  }

  return {
    async submit(model, body, signal) {
      const data = await call("POST", model.path, body, signal)
      if (!data.task_id) throw new Error(`Magnific started no task for ${model.id}: ${JSON.stringify(data).slice(0, 300)}`)
      return taskOf(model, data)
    },
    async status(model, taskId, signal) {
      return taskOf(model, await call("GET", `${model.status}/${encodeURIComponent(taskId)}`, undefined, signal))
    },
    // Polls until the task ends or `seconds` pass; a poll that fails for a
    // moment (network, 5xx, 429) is tried again, anything else is thrown.
    async wait(model, taskId, seconds, signal, every = 3000) {
      const until = Date.now() + seconds * 1000
      for (let last = null; ; ) {
        try { last = await this.status(model, taskId, signal) }
        catch (e) {
          if (signal?.aborted || (e.status && e.status < 500 && e.status !== 429)) throw e
          if (Date.now() >= until) throw e
        }
        if (last?.done || last?.failed || Date.now() + every > until) return last ?? { task: `${model.id}:${taskId}`, model: model.id, kind: model.kind, status: "UNKNOWN", urls: [] }
        await new Promise((r) => setTimeout(r, every))
      }
    },
  }
}

const EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" }

// Output links expire 30 minutes after generation, so results are saved
// as soon as the task completes.
export async function download(task, dir, { fetch: send = fetch, signal } = {}) {
  mkdirSync(dir, { recursive: true })
  const [model, id] = [task.model.replace(/[^\w.-]+/g, "-"), task.task.split(":").pop().slice(0, 8)]
  const files = []
  for (const [i, url] of task.urls.entries()) {
    const res = await send(url, { signal })
    if (!res.ok || !res.body) throw new Error(`Download of result ${i + 1} failed with ${res.status}; the link is ${url}`)
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim()
    const ext = extname(new URL(url).pathname) || EXT[type] || (task.kind === "video" ? ".mp4" : ".png")
    const path = join(dir, `${model}-${id}${task.urls.length > 1 ? `-${i + 1}` : ""}${ext}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(path))
    files.push(path)
  }
  return files
}
