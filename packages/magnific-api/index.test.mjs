import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { argsOf, zodOf } from "./args.mjs"
import { buildBody, findModel, listModels, models } from "./catalog.mjs"
import { credentialOf } from "./magnific.mjs"
import { NATIVE, translate } from "./native.mjs"
import * as entry from "./index.mjs"

const tmp = mkdtempSync(join(tmpdir(), "magnific-test-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe("catalog", () => {
  test("covers image and video models with a status path each", () => {
    const all = Object.values(models)
    expect(all.filter((m) => m.kind === "image").length).toBeGreaterThan(20)
    expect(all.filter((m) => m.kind === "video").length).toBeGreaterThan(80)
    for (const m of all) expect(m.status.startsWith("/v1/ai/")).toBe(true)
    expect(models["video/kling-v3-pro"].status).toBe("/v1/ai/video/kling-v3")
    expect(models["image-to-video/kling-v2-6-pro"].params.prompt).toBeDefined()
    expect(JSON.stringify(models)).not.toContain("webhook_url")
  })
  test("finds models by id, short name, or says what is close", () => {
    expect(findModel("text-to-image/flux-2-pro").id).toBe("text-to-image/flux-2-pro")
    expect(findModel("flux-2-pro").id).toBe("text-to-image/flux-2-pro")
    expect(findModel("/v1/ai/mystic").id).toBe("mystic")
    expect(() => findModel("veo-3-1")).toThrow(/ambiguous.*text-to-video\/veo-3-1/)
    expect(() => findModel("nano")).toThrow(/Did you mean.*nano-banana-pro/)
  })
  test("lists by kind and search words", () => {
    expect(listModels({ kind: "image" }).every((m) => m.kind === "image")).toBe(true)
    expect(listModels({ search: "kling 3 pro" }).map((m) => m.id)).toContain("video/kling-v3-pro")
  })
  test("builds a body and names every wrong argument", () => {
    const veo = findModel("text-to-video/veo-3-1")
    expect(buildBody(veo, "a fox", { duration: 4, seed: null })).toEqual({ prompt: "a fox", duration: 4 })
    expect(() => buildBody(veo, undefined, {})).toThrow(/"prompt" is required/)
    expect(() => buildBody(veo, "x", { duration: 5 })).toThrow(/"duration" must be one of 4, 6, 8/)
    expect(() => buildBody(veo, "x", { size: "1k", seed: "1" })).toThrow(/unknown parameter "size"; "seed" must be integer/)
  })
  test("turns a local file into base64 only where the model takes it", () => {
    const file = join(tmp, "in.png")
    writeFileSync(file, "PNGDATA")
    const [id, key] = Object.entries(models).flatMap(([id, m]) =>
      Object.entries(m.params).filter(([, p]) => p.base64 && p.type === "string").map(([k]) => [id, k]))[0]
    const model = findModel(id)
    const required = Object.fromEntries(Object.entries(model.params).filter(([k, p]) => p.required && k !== key && k !== "prompt").map(([k, p]) => [k, p.enum?.[0] ?? "x"]))
    expect(buildBody(model, "p", { ...required, [key]: file })[key]).toBe(Buffer.from("PNGDATA").toString("base64"))
    expect(() => buildBody(findModel("video/kling-v3-pro"), "p", { start_image_url: file })).toThrow(/needs a public https URL/)
    expect(buildBody(findModel("video/kling-v3-pro"), "p", { start_image_url: "https://x/y.png" }).start_image_url).toBe("https://x/y.png")
  })
})

describe("credentials", () => {
  const home = join(tmp, "home")
  const env = { HOME: home }
  test("no key anywhere says how to sign in", () => {
    expect(() => credentialOf({}, undefined, env)).toThrow(/MAGNIFIC_API_KEY.*opencode auth login.*magpie plugin login/)
  })
  test("reads the OpenCode and magpie stores; the environment comes first", () => {
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true })
    writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ magnific: { type: "api", key: "oc-key" }, openai: { type: "api", key: "no" } }))
    expect(credentialOf({}, undefined, env).key).toBe("oc-key")
    const dir = join(tmp, "magpie")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ magnific: { type: "api", key: "mp-key" }, "magnific#ab12cd": { type: "api", key: "second" } }))
    expect(credentialOf({ directory: dir }, undefined, env).key).toBe("mp-key")
    expect(credentialOf({ directory: dir }, "magnific#ab12cd", env).key).toBe("second")
    expect(() => credentialOf({ directory: dir }, "magnific#nope", env)).toThrow(/Signed in: magnific, magnific#ab12cd/)
    expect(credentialOf({ directory: dir }, undefined, { ...env, MAGNIFIC_API_KEY: " env-key " }).key).toBe("env-key")
  })
})

describe("plugin", () => {
  let server, base, hooks
  const seen = []
  const polls = {}
  beforeAll(async () => {
    // A stand-in for api.magnific.com: tasks named by the prompt's first word.
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.startsWith("/files/")) return new Response("BYTES:" + url.pathname, { headers: { "content-type": url.pathname.endsWith("mp4") ? "video/mp4" : "image/png" } })
        seen.push({ method: req.method, path: url.pathname, key: req.headers.get("x-magnific-api-key") })
        if (req.headers.get("x-magnific-api-key") !== "good") return Response.json({ message: "Invalid API key" }, { status: 401 })
        if (req.method === "POST") {
          const body = await req.json()
          seen.at(-1).body = body
          return Response.json({ data: { task_id: body.prompt.split(" ")[0], status: "CREATED", generated: [] } })
        }
        const id = url.pathname.split("/").pop()
        const n = (polls[id] = (polls[id] ?? 0) + 1)
        if (id === "slow" && n < 3) return Response.json({ data: { task_id: id, status: "IN_PROGRESS", generated: [] } })
        if (id === "bad") return Response.json({ data: { task_id: id, status: "FAILED", generated: [] } })
        const ext = url.pathname.includes("video") ? "mp4" : "png"
        return Response.json({ data: { task_id: id, status: "COMPLETED", generated: [`${base}/files/${id}-a.${ext}`, `${base}/files/${id}-b`] } })
      },
    })
    base = `http://127.0.0.1:${server.port}`
    process.env.MAGNIFIC_API_KEY = "good"
    hooks = await entry.MagnificPlugin({ directory: join(tmp, "config") }, { apiBase: base, pollMs: 10 })
  })
  afterAll(() => { server.stop(true); delete process.env.MAGNIFIC_API_KEY })
  const ctx = () => ({ directory: join(tmp, "project"), abort: new AbortController().signal })
  const run = async (name, args) => JSON.parse(await hooks.tool[name].execute(args, ctx()))

  test("the entry exports the plugin and nothing else", () => {
    expect(Object.keys(entry)).toEqual(["MagnificPlugin"])
    expect(hooks.auth.provider).toBe("magnific")
    expect(hooks.auth.methods).toEqual([{ type: "api", label: "Magnific API key" }])
    expect(Object.keys(hooks.tool)).toEqual(["magnific_models", "magnific_generate", "magnific_task"])
  })
  test("arguments are JSON Schema, or zod fields where OpenCode's package is there", async () => {
    const plain = await entry.MagnificPlugin({}, { jsonArgs: true })
    expect(plain.tool.magnific_generate.args).toMatchObject({ type: "object", required: ["model"], properties: { params: { type: "object" }, wait_seconds: { type: "integer", maximum: 50 } } })
    expect(plain.tool.magnific_models.args.required).toBeUndefined()
    const z = await zodOf()
    if (!z) return
    const shape = z.object(argsOf({ a: { type: "string" }, n: { type: "integer", minimum: 0, maximum: 50 }, k: { type: "string", enum: ["x", "y"] }, o: { type: "object" } }, ["a"], z))
    expect(shape.parse({ a: "s", n: 3, k: "x", o: { any: 1 } })).toEqual({ a: "s", n: 3, k: "x", o: { any: 1 } })
    expect(shape.safeParse({}).success).toBe(false)
    expect(shape.safeParse({ a: "s", n: 51 }).success).toBe(false)
    expect(shape.safeParse({ a: "s", k: "z" }).success).toBe(false)
    expect(z.object(hooks.tool.magnific_generate.args).safeParse({ model: "mystic", params: { a: 1 } }).success).toBe(true)
  })
  test("magnific_models lists, filters and describes", async () => {
    const list = await hooks.tool.magnific_models.execute({ kind: "video", search: "veo" }, ctx())
    expect(list).toContain("text-to-video/veo-3-1  [video]")
    expect(list).not.toContain("[image]")
    const one = JSON.parse(await hooks.tool.magnific_models.execute({ model: "text-to-video/veo-3-1" }, ctx()))
    expect(one.params.duration.enum).toEqual([4, 6, 8])
  })
  test("generates an image: submits, polls, saves the files", async () => {
    const out = await run("magnific_generate", { model: "text-to-image/flux-2-pro", prompt: "img a red fox", params: { width: 1024 } })
    expect(out.status).toBe("COMPLETED")
    expect(out.task).toBe("text-to-image/flux-2-pro:img")
    expect(out.files).toEqual([
      join(tmp, "project/magnific-output/text-to-image-flux-2-pro-img-1.png"),
      join(tmp, "project/magnific-output/text-to-image-flux-2-pro-img-2.png"),
    ])
    expect(readFileSync(out.files[0], "utf8")).toBe("BYTES:/files/img-a.png")
    const post = seen.find((r) => r.method === "POST")
    expect(post).toMatchObject({ path: "/v1/ai/text-to-image/flux-2-pro", key: "good", body: { prompt: "img a red fox", width: 1024 } })
  })
  test("a video still running returns a task id that magnific_task finishes", async () => {
    const started = await run("magnific_generate", { model: "video/kling-v3-pro", prompt: "slow waves", wait_seconds: 0 })
    expect(started).toMatchObject({ task: "video/kling-v3-pro:slow", status: "CREATED" })
    expect(started.note).toContain('magnific_task with task="video/kling-v3-pro:slow"')
    expect(started.files).toBeUndefined()
    const done = await run("magnific_task", { task: started.task, wait_seconds: 5, output_dir: "clips" })
    expect(done.status).toBe("COMPLETED")
    expect(done.files[0]).toBe(join(tmp, "project/clips/video-kling-v3-pro-slow-1.mp4"))
    expect(existsSync(done.files[1])).toBe(true)
    expect(seen.filter((r) => r.method === "GET" && r.path === "/v1/ai/video/kling-v3/slow").length).toBe(3)
  })
  test("under magpie, which has no project, results go to the home folder", async () => {
    const home = process.env.HOME
    process.env.HOME = join(tmp, "userhome")
    try {
      const mp = await entry.MagnificPlugin({ directory: join(tmp, "config"), project: { id: "magpie" } }, { apiBase: base, pollMs: 10 })
      const out = JSON.parse(await mp.tool.magnific_generate.execute({ model: "mystic", prompt: "home sweet" }, { directory: join(tmp, "config") }))
      expect(out.files[0]).toBe(join(tmp, "userhome/magnific-output/mystic-home-1.png"))
    } finally { process.env.HOME = home }
  })
  test("OpenCode gets tools only: no provider models, an empty loader", async () => {
    expect(hooks.config).toBeUndefined()
    expect(hooks.provider).toBeUndefined()
    expect(hooks.auth.loader).toBeUndefined()
  })
  test("a failed generation saves nothing", async () => {
    const out = await run("magnific_generate", { model: "mystic", prompt: "bad idea" })
    expect(out).toMatchObject({ status: "FAILED", note: "The generation failed; nothing was saved." })
  })
  test("wrong arguments never reach the API", async () => {
    const before = seen.length
    await expect(hooks.tool.magnific_generate.execute({ model: "mystic", prompt: "x", params: { nope: 1 } }, ctx())).rejects.toThrow(/unknown parameter "nope"/)
    await expect(hooks.tool.magnific_task.execute({ task: "nocolon" }, ctx())).rejects.toThrow(/<model>:<task id>/)
    expect(seen.length).toBe(before)
  })
  test("a refused key is reported without the key", async () => {
    process.env.MAGNIFIC_API_KEY = "wrong-secret"
    try {
      const err = await hooks.tool.magnific_generate.execute({ model: "mystic", prompt: "x y" }, ctx()).catch((e) => e)
      expect(err.message).toMatch(/401 \(the API key was refused\): Invalid API key/)
      expect(err.message).not.toContain("wrong-secret")
    } finally { process.env.MAGNIFIC_API_KEY = "good" }
  })
})

describe("native magpie models", () => {
  let server, base, hooks, send
  const posts = []
  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.startsWith("/files/")) return new Response("BYTES:" + url.pathname, { headers: { "content-type": "video/mp4" } })
        if (req.headers.get("x-magnific-api-key") !== "acct-key") return Response.json({ message: "Invalid API key" }, { status: 401 })
        if (req.method === "POST") {
          const body = await req.json()
          posts.push({ path: url.pathname, body })
          return Response.json({ data: { task_id: body.prompt.split(" ")[0], status: "CREATED", generated: [] } })
        }
        const id = url.pathname.split("/").pop()
        if (id === "pending") return Response.json({ data: { task_id: id, status: "IN_PROGRESS", generated: [] } })
        if (id === "broken") return Response.json({ data: { task_id: id, status: "FAILED", generated: [] } })
        return Response.json({ data: { task_id: id, status: "COMPLETED", generated: [`${base}/files/${id}`] } })
      },
    })
    base = `http://127.0.0.1:${server.port}`
    hooks = await entry.MagnificPlugin({ directory: join(tmp, "config"), project: { id: "magpie" } }, { apiBase: base, pollMs: 10 })
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "acct-key" }))
    expect(loaded.baseURL).toBe("https://magnific.invalid/v1")
    send = async (method, path, body) => {
      const res = await loaded.fetch(`${loaded.baseURL}${path}`, { method, body: body && JSON.stringify(body) })
      return { status: res.status, res, json: res.headers.get("content-type")?.includes("json") ? await res.json() : null }
    }
  })
  afterAll(() => server.stop(true))

  test("every native model exists in the catalog and takes a prompt", () => {
    expect(NATIVE.filter((m) => m.kind === "image").length).toBeGreaterThan(5)
    expect(NATIVE.filter((m) => m.kind === "video").length).toBeGreaterThan(5)
    for (const m of NATIVE) expect(translate(m, { prompt: "x" }).body.prompt).toBe("x")
  })
  test("size and seconds become each model's own parameters", () => {
    const of = (id, request) => translate(NATIVE.find((m) => m.id === id), { prompt: "x", ...request }).body
    expect(of("mystic", { size: "1792x1024" })).toEqual({ prompt: "x", aspect_ratio: "widescreen_16_9" })
    expect(of("nano-banana-pro", { size: "1024x1024" }).aspect_ratio).toBe("1:1")
    expect(of("flux-2-pro", { size: "1024x1792" })).toEqual({ prompt: "x", width: 1024, height: 1792 })
    expect(of("runway-4-5", { size: "720x1280", seconds: "8" })).toEqual({ prompt: "x", ratio: "720:1280", duration: 8 })
    expect(of("kling-v3-pro", { size: "9:16", seconds: 7 })).toMatchObject({ aspect_ratio: "9:16", duration: "7" })
    expect(of("veo-3-1", { seconds: "7", extra: { resolution: "1080p" } })).toMatchObject({ duration: 6, resolution: "1080p" })
    expect(() => of("veo-3-1", { size: "big" })).toThrow(/Unsupported size/)
    expect(() => of("veo-3-1", { extra: { nope: 1 } })).toThrow(/unknown parameter "nope"/)
  })
  test("the config and provider hooks declare image-only and video-only models", async () => {
    const config = {}
    await hooks.config(config)
    expect(config.provider.magnific.models["veo-3-1"].modalities).toEqual({ input: ["text"], output: ["video"] })
    expect(config.provider.magnific.models["mystic"].modalities.output).toEqual(["image"])
    const listed = await hooks.provider.models({ models: {} })
    expect(Object.keys(listed)).toEqual(NATIVE.map((m) => m.id))
    expect(listed["kling-v3-pro"].capabilities.output).toMatchObject({ video: true, image: false, text: false })
  })
  test("POST /images/generations answers with b64_json, n images", async () => {
    const out = await send("POST", "/images/generations", { model: "magnific/flux-2-klein", prompt: "img fox", n: 2, size: "1024x1024" })
    expect(out.status).toBe(200)
    expect(out.json.data).toEqual([{ b64_json: Buffer.from("BYTES:/files/img").toString("base64") }, { b64_json: Buffer.from("BYTES:/files/img").toString("base64") }])
    expect(posts.filter((p) => p.path === "/v1/ai/text-to-image/flux-2-klein").length).toBe(2)
    expect(posts.at(-1).body).toEqual({ prompt: "img fox", aspect_ratio: "square_1_1" })
  })
  test("videos: create, poll, download", async () => {
    const made = await send("POST", "/videos", { model: "kling-v3-pro", prompt: "clip waves", size: "1280x720", seconds: "5" })
    expect(made.json).toMatchObject({ id: "kling-v3-pro:clip", object: "video", status: "queued", model: "kling-v3-pro", size: "1280x720", seconds: "5" })
    expect(posts.at(-1)).toEqual({ path: "/v1/ai/video/kling-v3-pro", body: { prompt: "clip waves", aspect_ratio: "16:9", duration: "5" } })
    expect((await send("GET", "/videos/kling-v3-pro:pending")).json).toMatchObject({ status: "in_progress", progress: 0 })
    expect((await send("GET", "/videos/kling-v3-pro:broken")).json).toMatchObject({ status: "failed", error: { message: expect.any(String) } })
    expect((await send("GET", "/videos/kling-v3-pro%3Aclip")).json).toMatchObject({ id: "kling-v3-pro:clip", status: "completed", progress: 100 })
    const file = await send("GET", "/videos/kling-v3-pro:clip/content")
    expect(file.res.headers.get("content-type")).toBe("video/mp4")
    expect(await file.res.text()).toBe("BYTES:/files/clip")
    expect((await send("GET", "/videos/kling-v3-pro:pending/content")).status).toBe(409)
  })
  test("what it cannot do is a 4xx with the reason", async () => {
    const before = posts.length
    expect((await send("POST", "/images/generations", { model: "veo-3-1", prompt: "x" })).json.error.message).toMatch(/Unknown Magnific image model.*mystic/)
    expect((await send("POST", "/videos", { model: "veo-3-1", prompt: "x", input_reference: "abc" })).json.error.message).toMatch(/input_reference is not supported/)
    expect((await send("POST", "/videos", { model: "veo-3-1" })).status).toBe(400)
    expect((await send("GET", "/videos/nope:1")).status).toBe(400)
    expect((await send("POST", "/chat/completions", {})).status).toBe(404)
    expect(posts.length).toBe(before)
  })
  test("a refused key comes back as 401", async () => {
    const loaded = await hooks.auth.loader(async () => ({ type: "api", key: "other" }))
    const res = await loaded.fetch("https://magnific.invalid/v1/videos", { method: "POST", body: JSON.stringify({ model: "veo-3-1", prompt: "x y" }) })
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toMatch(/the API key was refused/)
    await expect(hooks.auth.loader(async () => undefined)).rejects.toThrow(/magpie plugin login magnific/)
  })
})
