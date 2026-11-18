import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import * as magpieEntry from "../magpie.mjs"
import * as opencodeEntry from "../opencode.mjs"
import opencode2Default from "../opencode2.mjs"
import { DreaminaAuthPlugin } from "../index.mjs"
import { CliError, isCliInstalled, redactSensitiveText, resolveCliBin, runCli, setCliRunnerForTests } from "../cli.mjs"
import { ensureCanvas, getCreditStats, getVideoTask, readCanvasState, recordCreditSpend, resolveStatePath, saveVideoTask, setCreditBalance } from "../canvas-state.mjs"
import {
  LIVE_META,
  clearLiveModelCache,
  configModels,
  fetchLiveModels,
  openCodeModelOf,
  resolveImageParams,
  resolveVideoParams,
} from "../models.mjs"
import { escapePromptBraces } from "../media.mjs"

const SECRET_TOKEN = "mock-secret-credit-confirmation-token-xyz"
const SECRET_TEMP_URL = "https://cdn.example.invalid/temp-file?Signature=secretSig123&Expires=999999"

function makeTempDir(prefix = "dreamina-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeMockCli(handlers = {}) {
  const calls = []
  const fn = async (profile, args, opts) => {
    calls.push({ profile, args: [...args], opts })
    const key2 = args.slice(0, 2).join(" ")
    const key3 = args.slice(0, 3).join(" ")
    const handler = handlers[key3] ?? handlers[key2] ?? handlers[args[0]]
    if (!handler) {
      throw new Error(`Unexpected CLI call in test: ${args.join(" ")}`)
    }
    return handler(profile, args, opts, calls)
  }
  return { calls, fn }
}

describe("Dreamina plugin packaging & entry points", () => {
  it("exports only DreaminaAuthPlugin from opencode.mjs and magpie.mjs", () => {
    expect(Object.keys(opencodeEntry)).toEqual(["DreaminaAuthPlugin"])
    expect(Object.keys(magpieEntry)).toEqual(["DreaminaAuthPlugin"])
    expect(typeof opencodeEntry.DreaminaAuthPlugin).toBe("function")
    expect(typeof magpieEntry.DreaminaAuthPlugin).toBe("function")
  })

  it("matches required package.json metadata with zero runtime dependencies", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(pkg.name).toBe("@magpie-community/opencode-dreamina-auth")
    expect(pkg.version).toBe("0.1.0")
    expect(pkg.type).toBe("module")
    expect(pkg.license).toBe("MIT")
    expect(pkg.main).toBe("./opencode.mjs")
    expect(pkg.exports).toEqual({ "./server": "./magpie.mjs", ".": "./opencode2.mjs" })
    expect(pkg.scripts).toEqual({ test: "bun test" })
    expect(pkg.magpie?.name).toBe("Dreamina (即梦)")
    expect(pkg.magpie?.icon).toMatch(/^data:image\/png;base64,/)
    expect(pkg.magpie?.maxConcurrency).toBe(4)
    expect(pkg.dependencies).toBeUndefined()
  })

  it("integrates cleanly with OpenCode 2.x wrapper (opencode2.mjs)", async () => {
    const integrations = []
    const providers = []
    const sdkHooks = []
    const ctx = {
      location: { directory: os.tmpdir() },
      storage: new Map(),
      integration: {
        transform: async (fn) => fn({ update: () => {}, method: { update: (m) => integrations.push(m) } }),
        connection: { active: async () => undefined, resolve: async () => undefined },
      },
      provider: {
        transform: async (fn) => fn({ add: (p) => providers.push(p) }),
        reload: async () => {},
      },
      aisdk: {
        hook: async (_name, fn, filter) => sdkHooks.push({ fn, filter }),
      },
    }
    const dispose = await opencode2Default.setup(ctx)
    expect(typeof dispose).toBe("function")
    expect(integrations.length).toBe(2)
    expect(providers.length).toBe(1)
    expect(providers[0].info.id).toBe("dreamina")
    expect(providers[0].models.length).toBe(21)
    expect(sdkHooks[0].filter).toEqual({ providerID: "dreamina" })
    dispose()
  })
})

describe("cli.mjs", () => {
  afterEach(() => {
    setCliRunnerForTests(null)
  })

  it("resolves binary from DREAMINA_CANVAS_BIN, PATH, and fallback dirs", () => {
    const dir = makeTempDir("dreamina-bin-")
    try {
      const binPath = path.join(dir, "dreamina-canvas")
      fs.writeFileSync(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })

      expect(resolveCliBin({ env: { DREAMINA_CANVAS_BIN: binPath }, homedir: dir })).toBe(binPath)
      expect(resolveCliBin({ env: { PATH: dir }, homedir: dir })).toBe(binPath)
      expect(resolveCliBin({ env: { DREAMINA_CANVAS_BIN: path.join(dir, "missing") }, homedir: dir })).toBeNull()

      const localBinDir = path.join(dir, ".local", "bin")
      fs.mkdirSync(localBinDir, { recursive: true })
      const localBin = path.join(localBinDir, "dreamina-canvas")
      fs.writeFileSync(localBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      expect(resolveCliBin({ env: { PATH: "" }, homedir: dir })).toBe(localBin)
      expect(isCliInstalled({ env: { PATH: "" }, homedir: dir })).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("parses JSON envelopes, supports default profile, AbortSignal, and secret redaction", async () => {
    const { calls, fn } = makeMockCli({
      version: () => ({
        exitCode: 0,
        stdout: 'warning line before json\n{"schemaVersion":"1","ok":true,"data":{"version":"1.0.2"}}\n',
        stderr: "",
      }),
      auth: () => ({
        exitCode: 11,
        stdout: JSON.stringify({
          ok: false,
          error: { class: "auth", code: "not_logged_in", message: "Not logged in" },
        }),
        stderr: "",
      }),
    })
    setCliRunnerForTests(fn)

    const ok = await runCli("", ["version"])
    expect(ok.data.version).toBe("1.0.2")
    expect(calls[0].profile).toBe("default")

    await expect(runCli("default", ["auth", "account"])).rejects.toThrow(/Not logged in/)
    try {
      await runCli("default", ["auth", "account"])
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect(err.signIn).toBe("expired")
      expect(err.status).toBe(401)
    }

    const ac = new AbortController()
    ac.abort()
    await expect(runCli("default", ["version"], { signal: ac.signal })).rejects.toThrow(/Abort/)

    const redacted = redactSensitiveText(`--credit-token ${SECRET_TOKEN} ${SECRET_TEMP_URL}`)
    expect(redacted).not.toContain(SECRET_TOKEN)
    expect(redacted).not.toContain("secretSig123")
  })
})

describe("models.mjs", () => {
  afterEach(() => {
    setCliRunnerForTests(null)
    clearLiveModelCache()
  })

  it("builds static configModels and openCodeModelOf with image and video modalities", () => {
    const cfg = configModels()
    expect(Object.keys(cfg).length).toBe(21)
    expect(cfg["seedream_5.5"].provider.npm).toBe("@ai-sdk/openai-compatible")
    expect(cfg["seedream_5.5"].modalities).toEqual({ input: ["text", "image"], output: ["image"] })
    expect(cfg["seedance_2.5"].provider.npm).toBe("@ai-sdk/anthropic")
    expect(cfg["seedance_2.5"].modalities).toEqual({ input: ["text", "image"], output: ["video"] })

    const liveSpecs = {
      img: { id: "seedream_5.5", name: "Seedream 5.5", type: "image", npm: "@ai-sdk/openai-compatible" },
      vid: { id: "seedance_2.5", name: "Seedance 2.5", type: "video", npm: "@ai-sdk/anthropic" },
    }
    const ocImg = openCodeModelOf("dreamina", liveSpecs.img)
    const ocVid = openCodeModelOf("dreamina", liveSpecs.vid)
    expect(ocImg.capabilities.output).toEqual({ text: false, image: true, audio: false, video: false, pdf: false })
    expect(ocVid.capabilities.output).toEqual({ text: false, image: false, audio: false, video: true, pdf: false })
    expect(ocImg.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(ocVid.api.npm).toBe("@ai-sdk/anthropic")
  })

  it("preserves exact resolution casing and validates image & video parameters", () => {
    const img55 = resolveImageParams("seedream_5.5", { prompt: "cat", resolution: "1.5k", size: "1792x1024" })
    expect(img55).toEqual({
      model: "seedream_5.5",
      mode: "t2i",
      prompt: "cat",
      ratio: "16:9",
      resolution: "1.5K",
      count: 1,
    })

    const img50pro = resolveImageParams("seedream_5.0_pro", { prompt: "tall poster", ratio: "9:21", resolution: "4k" })
    expect(img50pro.ratio).toBe("9:21")
    expect(img50pro.resolution).toBe("4K")
    expect(() => resolveImageParams("seedream_5.5", { prompt: "x", ratio: "9:21" })).toThrow()

    const wan = resolveVideoParams("wan_3.0", { prompt: "ocean", resolution: "720p", seconds: "8" }, 0)
    expect(wan).toEqual({
      model: "wan_3.0",
      mode: "t2v",
      prompt: "ocean",
      ratio: "16:9",
      resolution: "720P",
      duration: 8,
      count: 1,
    })

    const seedance = resolveVideoParams("seedance_2.5", { prompt: "fly", resolution: "4K", duration: 25 }, 3)
    expect(seedance.resolution).toBe("4k")
    expect(seedance.mode).toBe("m2v")
    expect(seedance.duration).toBe(25)

    const hh2 = resolveVideoParams("happyhorse_1.1", { prompt: "run", resolution: "1080p" }, 2)
    expect(hh2.resolution).toBe("1080P")
    expect(hh2.mode).toBe("m2v")

    expect(() => resolveVideoParams("seedance_pro_fast", { prompt: "fast", duration: 4 }, 0)).toThrow()
    expect(() => resolveVideoParams("seedance_pro_fast", { prompt: "fast", duration: 6 }, 2)).toThrow()
    expect(() => resolveVideoParams("dreamina_vidu_q2", { prompt: "vidu", duration: 15 }, 0)).toThrow()
  })

  it("discovers live models via dreamina-canvas model list and falls back cleanly on error", async () => {
    setCliRunnerForTests(async (_profile, args) => {
      if (args.includes("image")) {
        return {
          ok: true,
          data: {
            items: [
              {
                type: "image",
                model: "seedream_5.5",
                modes: [
                  {
                    name: "i2i",
                    flags: [
                      { flag: "--ratio", values: ["1:1", "16:9"] },
                      { flag: "--resolution", values: ["1.5K", "2K"] },
                      { flag: "--count", min: 1, max: 4 },
                    ],
                    references: { min: 1, max: 10 },
                  },
                ],
              },
            ],
          },
        }
      }
      return {
        ok: true,
        data: {
          items: [
            {
              type: "video",
              model: "wan_3.0",
              modes: [
                {
                  name: "first_last_frame",
                  flags: [
                    { flag: "--ratio", values: ["16:9", "9:16"] },
                    { flag: "--resolution", values: ["720P", "1080P"] },
                    { flag: "--duration", min: 4, max: 15 },
                  ],
                  references: { min: 1, max: 1 },
                },
                {
                  name: "first_last_frame",
                  flags: [
                    { flag: "--ratio", values: ["16:9", "9:16"] },
                    { flag: "--resolution", values: ["720P", "1080P"] },
                    { flag: "--duration", min: 4, max: 15 },
                  ],
                  references: { min: 2, max: 2 },
                },
              ],
            },
          ],
        },
      }
    })

    const live = await fetchLiveModels("default", { fresh: true })
    expect(live[LIVE_META].live).toBe(true)
    expect(live[LIVE_META].fellBack).toBe(false)
    expect(live["wan_3.0"].modes.first_last_frame).toEqual({ minRefs: 1, maxRefs: 2 })
    expect(live["wan_3.0"].maxBatchCount).toBe(4)

    setCliRunnerForTests(async () => ({ exitCode: 1, stdout: "", stderr: "cli error" }))
    const fallback = await fetchLiveModels("default", { fresh: true })
    expect(fallback[LIVE_META].fellBack).toBe(true)
    expect(Object.keys(fallback).length).toBe(21)
  })
})

describe("canvas-state.mjs", () => {
  let tmpDir
  beforeEach(() => {
    tmpDir = makeTempDir("dreamina-state-")
  })
  afterEach(() => {
    setCliRunnerForTests(null)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates dedicated per-profile canvas once with 0600 permissions and persists video tasks", async () => {
    const { calls, fn } = makeMockCli({
      "canvas create": (_profile, args) => {
        const pid = args[args.indexOf("--project-id") + 1]
        return { ok: true, data: { project: { projectId: pid, name: "Magpie Gateway" } } }
      },
    })
    setCliRunnerForTests(fn)

    const [p1, p2] = await Promise.all([
      ensureCanvas("default", { directory: tmpDir }),
      ensureCanvas("default", { directory: tmpDir }),
    ])
    expect(p1).toBe(p2)
    expect(calls.length).toBe(1)

    const p3 = await ensureCanvas("default", { directory: tmpDir })
    expect(p3).toBe(p1)
    expect(calls.length).toBe(1)

    const pOther = await ensureCanvas("studio", { directory: tmpDir })
    expect(pOther).not.toBe(p1)
    expect(calls.length).toBe(2)

    await saveVideoTask(tmpDir, "video_test_1", {
      profile: "default",
      projectId: p1,
      nodeId: "node_abc1234567",
      submitId: "11111111-1111-4111-8111-111111111111",
      model: "seedance_2.5",
      duration: 6,
      createdAt: 1700000000000,
    })

    const statePath = resolveStatePath(tmpDir)
    const st = fs.statSync(statePath)
    expect(st.mode & 0o777).toBe(0o600)
    const state = readCanvasState(tmpDir)
    expect(state.canvases.default.projectId).toBe(p1)
    expect(getVideoTask(tmpDir, "video_test_1")?.duration).toBe(6)
  })

  it("tracks configured credit balance, spentSinceBalanceSet, and remainingCredits cleanly", async () => {
    const empty = await getCreditStats("default", { directory: tmpDir })
    expect(empty.configuredBalance).toBeNull()
    expect(empty.spentSinceBalanceSet).toBe(0)
    expect(empty.remainingCredits).toBeNull()

    await setCreditBalance("default", { balance: "", directory: tmpDir })
    await setCreditBalance("default", { balance: null, directory: tmpDir })
    await setCreditBalance("default", { balance: -5, directory: tmpDir })
    expect((await getCreditStats("default", { directory: tmpDir })).configuredBalance).toBeNull()

    await recordCreditSpend("default", { credits: 20, directory: tmpDir })
    await setCreditBalance("default", { balance: 1000, directory: tmpDir })
    await recordCreditSpend("default", { credits: 12, directory: tmpDir })

    const stats = await getCreditStats("default", { directory: tmpDir })
    expect(stats.todayCredits).toBe(32)
    expect(stats.totalCredits).toBe(32)
    expect(stats.configuredBalance).toBe(1000)
    expect(stats.spentSinceBalanceSet).toBe(12)
    expect(stats.remainingCredits).toBe(988)

    await recordCreditSpend("default", { credits: 2000, directory: tmpDir })
    expect((await getCreditStats("default", { directory: tmpDir })).remainingCredits).toBe(0)
  })
})

describe("media.mjs routes, quote_only, credit_guard, and video polling", () => {
  let tmpDir
  let outAssetDir
  beforeEach(() => {
    tmpDir = makeTempDir("dreamina-media-")
    outAssetDir = makeTempDir("dreamina-assets-")
    clearLiveModelCache()
  })
  afterEach(() => {
    setCliRunnerForTests(null)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outAssetDir, { recursive: true, force: true })
  })

  function buildGatewayMock({ quoteCredits = 15, videoState = "succeeded", failWait = false, authExpired = false } = {}) {
    const imgBytes = Buffer.from("fake-png-output-bytes")
    const vidBytes = Buffer.from("fake-mp4-video-bytes")
    const recorded = []
    let confirmed = false
    let ran = false

    const fn = async (profile, args) => {
      recorded.push({ profile, args: [...args] })
      if (authExpired && args[0] !== "model") {
        return {
          exitCode: 11,
          stdout: JSON.stringify({ ok: false, error: { class: "auth", message: "Please log in again" } }),
          stderr: "",
        }
      }
      const cmd = args.slice(0, 2).join(" ")
      if (cmd === "auth status") {
        return { ok: true, data: { loggedIn: true, expiresAt: "2026-12-31T00:00:00Z", region: "cn", profile } }
      }
      if (cmd === "model list") {
        return { exitCode: 1, stdout: "", stderr: "" } // trigger static fallback
      }
      if (cmd === "canvas create") {
        const pid = args[args.indexOf("--project-id") + 1]
        return { ok: true, data: { project: { projectId: pid, name: "Magpie Gateway" } } }
      }
      if (cmd === "resource upload") {
        const rid = args[args.indexOf("--resource-id") + 1]
        return { ok: true, data: { resourceId: rid, mediaType: "image" } }
      }
      if (args[0] === "node" && args[1] === "create") {
        const nid = args[args.indexOf("--node-id") + 1]
        return { ok: true, data: { node: { nodeId: nid } } }
      }
      if (cmd === "node quote") {
        const nid = args[args.indexOf("--node-id") + 1]
        return {
          ok: true,
          data: {
            items: [{ nodeId: nid, maxCredits: quoteCredits }],
            totalMaxCredits: quoteCredits,
            confirmationRequired: true,
          },
        }
      }
      if (cmd === "node confirm") {
        confirmed = true
        return {
          ok: true,
          data: { creditConfirmationToken: SECRET_TOKEN, creditCeiling: quoteCredits },
        }
      }
      if (cmd === "node run") {
        ran = true
        const nid = args[args.indexOf("--node-id") + 1]
        const sid = args[args.indexOf("--submit-id") + 1]
        const token = args[args.indexOf("--credit-token") + 1]
        expect(token).toBe(SECRET_TOKEN)
        return { ok: true, data: { items: [{ nodeId: nid, submitId: sid, state: "accepted" }] } }
      }
      if (cmd === "operation wait") {
        if (failWait) return { exitCode: 20, stdout: "", stderr: "" }
        return {
          ok: true,
          data: {
            state: "succeeded",
            resources: [{ resourceId: "res-out-img-1", state: "succeeded" }],
          },
        }
      }
      if (cmd === "operation status") {
        return {
          ok: true,
          data: {
            state: videoState,
            resources: videoState === "succeeded" ? [{ resourceId: "res-out-vid-1", state: "succeeded" }] : [],
          },
        }
      }
      if (cmd === "resource download") {
        const rid = args[2]
        const outDir = args[args.indexOf("--output") + 1]
        const isVid = rid.includes("vid")
        const target = path.join(outDir, isVid ? "output.mp4" : "output.png")
        fs.writeFileSync(target, isVid ? vidBytes : imgBytes)
        return {
          ok: true,
          data: { resourceId: rid, path: target, size: (isVid ? vidBytes : imgBytes).length },
        }
      }
      throw new Error(`Unhandled mock cmd: ${args.join(" ")}`)
    }

    return {
      recorded,
      fn,
      get confirmed() { return confirmed },
      get ran() { return ran },
      imgBytes,
      vidBytes,
    }
  }

  it("handles POST /images/generations (t2i and reference_images i2i)", async () => {
    const mock = buildGatewayMock({ quoteCredits: 12 })
    setCliRunnerForTests(mock.fn)

    const hooks = await DreaminaAuthPlugin({ directory: tmpDir })
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", metadata: { profile: "default" } }))

    const res = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "seedream_5.5",
        prompt: "a futuristic {{studio}} with {{res:11111111-1111-4111-8111-111111111111}}",
        size: "1792x1024",
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.length).toBe(1)
    expect(body.data[0].b64_json).toBe(mock.imgBytes.toString("base64"))

    // Verify --title is always passed even on non-empty prompts and literal {{ is escaped
    const t2iCall = mock.recorded.find((c) => c.args[0] === "node" && c.args[1] === "create")
    expect(t2iCall.args).toContain("--title")
    const titleVal = t2iCall.args[t2iCall.args.indexOf("--title") + 1]
    expect(titleVal.length).toBeGreaterThan(0)
    const promptVal = t2iCall.args[t2iCall.args.indexOf("--prompt") + 1]
    expect(promptVal).toBe("a futuristic \\{{studio}} with {{res:11111111-1111-4111-8111-111111111111}}")

    expect(escapePromptBraces("already \\{{escaped}} and {{unclosed")).toBe("already \\{{escaped}} and \\{{unclosed")

    // Verify no secret token leaked into state file
    const stateText = fs.readFileSync(resolveStatePath(tmpDir), "utf8")
    expect(stateText).not.toContain(SECRET_TOKEN)

    // Now test i2i with both data: URL and https:// URL in reference_images
    const tinyPng = "data:image/png;base64," + Buffer.from("png-bytes").toString("base64")
    const resI2i = await loaded.fetch("dreamina://local/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "seedream_5.0_pro",
        prompt: "merge both references",
        ratio: "9:21",
        resolution: "4k",
        reference_images: [tinyPng, "https://example.com/ref.png"],
      }),
    })
    expect(resI2i.status).toBe(200)
    const uploads = mock.recorded.filter((c) => c.args[0] === "resource" && c.args[1] === "upload")
    expect(uploads.length).toBe(2)
    expect(uploads[0].args).toContain("--file")
    expect(uploads[1].args).toContain("--source-url")
    const createCall = mock.recorded.filter((c) => c.args[0] === "node" && c.args[1] === "create").at(-1)
    expect(createCall.args).toContain("i2i")
    expect(createCall.args).toContain("9:21")
    expect(createCall.args).toContain("4K")
  })

  it("handles POST /images/edits multipart/form-data with image and image[]", async () => {
    const mock = buildGatewayMock({ quoteCredits: 10 })
    setCliRunnerForTests(mock.fn)

    const hooks = await DreaminaAuthPlugin({ directory: tmpDir })
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", metadata: { profile: "default" } }))

    const fd = new FormData()
    fd.append("model", "seedream_4.7")
    fd.append("prompt", "recolor in twilight")
    fd.append("image[]", new File([Buffer.from("img-1")], "one.png", { type: "image/png" }))
    fd.append("image[]", new File([Buffer.from("img-2")], "two.jpg", { type: "image/jpeg" }))

    const rawReq = new Request("dreamina://local/images/edits", { method: "POST", body: fd })
    const contentType = rawReq.headers.get("content-type")
    const rawBuf = Buffer.from(await rawReq.arrayBuffer())

    const res = await loaded.fetch("dreamina://local/images/edits", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: rawBuf,
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.data[0].b64_json).toBe(mock.imgBytes.toString("base64"))

    // Also test direct FormData body with single "image" field
    const fd2 = new FormData()
    fd2.append("model", "seedream_4.7")
    fd2.append("prompt", "single image edit")
    fd2.append("image", new File([Buffer.from("img-single")], "single.png", { type: "image/png" }))
    const res2 = await loaded.fetch("dreamina://local/images/edits", {
      method: "POST",
      body: fd2,
    })
    expect(res2.status).toBe(200)

    const uploads = mock.recorded.filter((c) => c.args[0] === "resource" && c.args[1] === "upload")
    expect(uploads.length).toBe(3)
  })

  it("enforces quote_only and credit_ceiling without calling confirm or run", async () => {
    const mockQuoteOnly = buildGatewayMock({ quoteCredits: 18 })
    setCliRunnerForTests(mockQuoteOnly.fn)

    let quoteOnlyOpt = true
    let creditGuardOpt = true
    const hooks = await DreaminaAuthPlugin({
      directory: tmpDir,
      magpie: {
        option: (_prov, key) => (key === "quote_only" ? quoteOnlyOpt : key === "credit_guard" ? creditGuardOpt : false),
      },
    })
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", metadata: { profile: "default" } }))

    const resQuoteOnly = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream_5.5", prompt: "test quote only" }),
    })
    expect(resQuoteOnly.status).toBe(403)
    const qBody = await resQuoteOnly.json()
    expect(qBody.error.totalMaxCredits).toBe(18)
    expect(mockQuoteOnly.confirmed).toBe(false)
    expect(mockQuoteOnly.ran).toBe(false)

    // Request quote_only: false must NOT bypass UI quote_only: true safety lock
    const resBypass = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream_5.5", prompt: "try bypass", quote_only: false }),
    })
    expect(resBypass.status).toBe(403)
    expect(mockQuoteOnly.confirmed).toBe(false)
    expect(mockQuoteOnly.ran).toBe(false)

    // Test credit_ceiling (default 200) exceeded
    quoteOnlyOpt = false
    const mockExpensive = buildGatewayMock({ quoteCredits: 250 })
    setCliRunnerForTests(mockExpensive.fn)
    const resCeil = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream_5.5", prompt: "expensive" }),
    })
    expect(resCeil.status).toBe(403)
    const cBody = await resCeil.json()
    expect(cBody.error.totalMaxCredits).toBe(250)
    expect(cBody.error.creditCeiling).toBe(200)
    expect(mockExpensive.confirmed).toBe(false)
    expect(mockExpensive.ran).toBe(false)

    // Test request credit_ceiling override allows 250
    const resAllowed = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream_5.5", prompt: "allowed", credit_ceiling: 300 }),
    })
    expect(resAllowed.status).toBe(200)
    expect(mockExpensive.confirmed).toBe(true)
    expect(mockExpensive.ran).toBe(true)

    // Test credit_guard = false allows 250 without explicit ceiling
    creditGuardOpt = false
    const mockGuardOff = buildGatewayMock({ quoteCredits: 250 })
    setCliRunnerForTests(mockGuardOff.fn)
    const resGuardOff = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream_5.5", prompt: "guard off" }),
    })
    expect(resGuardOff.status).toBe(200)
    expect(mockGuardOff.ran).toBe(true)
  })

  it("handles POST /videos, GET /videos/{id}, and GET /videos/{id}/content", async () => {
    let opState = "running"
    const mock = buildGatewayMock({ quoteCredits: 50 })
    setCliRunnerForTests(async (profile, args, opts, calls) => {
      if (args[0] === "operation" && args[1] === "status") {
        return {
          ok: true,
          data: {
            state: opState,
            resources: opState === "succeeded" ? [{ resourceId: "res-out-vid-1", state: "succeeded" }] : [],
          },
        }
      }
      return mock.fn(profile, args, opts, calls)
    })

    const hooks = await DreaminaAuthPlugin({ directory: tmpDir })
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", metadata: { profile: "default" } }))

    const createRes = await loaded.fetch("dreamina://local/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wan_3.0",
        prompt: "drone flight over alpine peaks",
        resolution: "720p",
        seconds: "8",
        first_frame: "data:image/png;base64," + Buffer.from("first").toString("base64"),
      }),
    })
    expect(createRes.status).toBe(200)
    const videoObj = await createRes.json()
    expect(videoObj.object).toBe("video")
    expect(videoObj.status).toBe("queued")
    expect(videoObj.seconds).toBe("8")

    // Ensure uppercase 720P and --title were passed to wan_3.0
    const createCall = mock.recorded.find((c) => c.args[0] === "node" && c.args[1] === "create")
    expect(createCall.args).toContain("720P")
    expect(createCall.args).toContain("first_last_frame")
    expect(createCall.args).toContain("--title")

    // Empty string first_frame/last_frame must be ignored cleanly (falls back to t2v)
    const t2vRes = await loaded.fetch("dreamina://local/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "seedance_2.5",
        prompt: "pure {{text}} video",
        first_frame: "",
        last_frame: "",
      }),
    })
    expect(t2vRes.status).toBe(200)
    const t2vCall = mock.recorded.filter((c) => c.args[0] === "node" && c.args[1] === "create").at(-1)
    expect(t2vCall.args).toContain("t2v")
    expect(t2vCall.args[t2vCall.args.indexOf("--prompt") + 1]).toBe("pure \\{{text}} video")

    // While running -> status in_progress, /content returns 409
    const poll1 = await loaded.fetch(`dreamina://local/videos/${videoObj.id}`, { method: "GET" })
    expect(poll1.status).toBe(200)
    expect((await poll1.json()).status).toBe("in_progress")

    const notReady = await loaded.fetch(`dreamina://local/videos/${videoObj.id}/content`, { method: "GET" })
    expect(notReady.status).toBe(409)

    // When succeeded -> status completed, /content returns video/mp4 bytes
    opState = "succeeded"
    const poll2 = await loaded.fetch(`dreamina://local/videos/${videoObj.id}`, { method: "GET" })
    expect((await poll2.json()).status).toBe("completed")

    const contentRes = await loaded.fetch(`dreamina://local/videos/${videoObj.id}/content`, { method: "GET" })
    expect(contentRes.status).toBe(200)
    expect(contentRes.headers.get("content-type")).toBe("video/mp4")
    const buf = Buffer.from(await contentRes.arrayBuffer())
    expect(buf.equals(mock.vidBytes)).toBe(true)

    // Missing video ID -> 404
    const missing = await loaded.fetch("dreamina://local/videos/video_does_not_exist", { method: "GET" })
    expect(missing.status).toBe(404)

    // Completed operation with empty resources -> 502 empty_output
    setCliRunnerForTests(async () => ({ ok: true, data: { state: "succeeded", resources: [] } }))
    const emptyContent = await loaded.fetch(`dreamina://local/videos/${videoObj.id}/content`, { method: "GET" })
    expect(emptyContent.status).toBe(502)
    expect((await emptyContent.json()).error.code).toBe("empty_output")
  })

  it("propagates 401 X-Magpie-Sign-In: expired on auth errors", async () => {
    const mock = buildGatewayMock({ authExpired: true })
    setCliRunnerForTests(mock.fn)
    const hooks = await DreaminaAuthPlugin({ directory: tmpDir })
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", metadata: { profile: "default" } }))

    const res = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream_5.5", prompt: "test auth" }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  })

  it("handles POST /chat/completions and POST /messages probes, quote-first chat prompts, and confirmed runs", async () => {
    const mock = buildGatewayMock({ quoteCredits: 18 })
    setCliRunnerForTests(mock.fn)
    const hooks = await DreaminaAuthPlugin({ directory: tmpDir })
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", metadata: { profile: "default" } }))

    // 1) OpenAI non-streaming probe -> 200 JSON, 0 node create calls
    const openAiProbe = await loaded.fetch("dreamina://local/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "high_aes_general_v50_flash",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(openAiProbe.status).toBe(200)
    const openAiJson = await openAiProbe.json()
    expect(openAiJson.object).toBe("chat.completion")
    expect(openAiJson.choices[0].message.content).toBe("OK")

    // 2) OpenAI streaming probe
    const openAiStream = await loaded.fetch("dreamina://local/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "seedream_5.5",
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    })
    expect(openAiStream.status).toBe(200)
    expect(openAiStream.headers.get("content-type")).toContain("text/event-stream")
    const openAiSse = await openAiStream.text()
    expect(openAiSse).toContain('"content":"OK"')
    expect(openAiSse).toContain("data: [DONE]")

    // 3) Anthropic non-streaming + streaming probes + isNewTopic probe
    const anthProbe = await loaded.fetch("dreamina://local/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "seedance_2.0_mini",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(anthProbe.status).toBe(200)
    const anthJson = await anthProbe.json()
    expect(anthJson.type).toBe("message")
    expect(anthJson.content[0].text).toBe("OK")

    const anthTopic = await loaded.fetch("dreamina://local/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "seedance_2.0_mini",
        stream: true,
        max_tokens: 128,
        system: "Analyze if this message asks isNewTopic and extract title",
        messages: [{ role: "user", content: "随机生成一段视频" }],
      }),
    })
    expect(anthTopic.status).toBe(200)
    const anthTopicSse = await anthTopic.text()
    expect(anthTopicSse).toContain("event: message_start")
    expect(anthTopicSse).toContain("isNewTopic")
    expect(anthTopicSse).toContain("event: message_stop")

    // Zero node create / confirm calls for all probes above
    expect(mock.recorded.some((c) => c.args[0] === "node")).toBe(false)

    // 4) Real video prompt without confirm -> quote only, no node confirm/run
    const quoteTurn = await loaded.fetch("dreamina://local/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "dreamina/seedance_2.0_mini",
        max_tokens: 4096,
        messages: [{ role: "user", content: "<system-reminder>ignored</system-reminder>\n随机生成一段视频" }],
      }),
    })
    expect(quoteTurn.status).toBe(200)
    const quoteTurnBody = await quoteTurn.json()
    expect(quoteTurnBody.content[0].text).toContain("18 积分")
    expect(quoteTurnBody.content[0].text).toContain("确认生成：随机生成一段视频")
    expect(mock.recorded.some((c) => c.args[0] === "node" && c.args[1] === "create")).toBe(true)
    expect(mock.recorded.some((c) => c.args[0] === "node" && c.args[1] === "quote")).toBe(true)
    expect(mock.confirmed).toBe(false)
    expect(mock.ran).toBe(false)

    // 5) Confirmed video prompt -> runs confirm + run and returns video task ID
    const confirmVideo = await loaded.fetch("dreamina://local/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "seedance_2.0_mini",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "确认生成：随机生成一段视频" }],
      }),
    })
    expect(confirmVideo.status).toBe(200)
    const confirmVideoSse = await confirmVideo.text()
    expect(confirmVideoSse).toContain("video_")
    expect(confirmVideoSse).toContain("已提交即梦视频生成任务")
    expect(mock.confirmed).toBe(true)
    expect(mock.ran).toBe(true)

    // 6) Confirmed image prompt -> persists file and returns link
    const confirmImg = await loaded.fetch("dreamina://local/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "seedream_5.5",
        max_tokens: 4096,
        messages: [{ role: "user", content: "确认生成：雪山日出" }],
      }),
    })
    expect(confirmImg.status).toBe(200)
    const confirmImgJson = await confirmImg.json()
    expect(confirmImgJson.choices[0].message.content).toContain("file://")
  })
})

describe("index.mjs auth methods, refresh, usage, and provider.models", () => {
  let tmpDir
  beforeEach(() => {
    tmpDir = makeTempDir("dreamina-auth-")
    clearLiveModelCache()
  })
  afterEach(() => {
    setCliRunnerForTests(null)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("supports config hook, options, existing-profile login, browser device login, refresh, usage, and provider.models", async () => {
    setCliRunnerForTests(async (profile, args) => {
      const cmd = args.slice(0, 2).join(" ")
      if (cmd === "auth status") {
        return {
          ok: true,
          data: {
            loggedIn: true,
            expiresAt: "2026-12-31T00:00:00Z",
            region: "cn",
            profile,
          },
        }
      }
      if (cmd === "auth account") {
        return {
          ok: true,
          data: { userId: 123456, isVip: true, vipLevel: "pro" },
        }
      }
      if (cmd === "auth login") {
        return {
          ok: true,
          data: {
            status: "pending",
            challenge: {
              deviceCode: "dev-code-123",
              userCode: "ABCD-1234",
              verificationUri: "https://example.com/verify",
              verificationUriComplete: "https://example.com/verify?code=ABCD-1234",
              pollSeconds: 5,
            },
          },
        }
      }
      if (cmd === "auth wait") {
        expect(args).toContain("--device-code")
        expect(args).toContain("dev-code-123")
        return {
          ok: true,
          data: {
            status: "logged_in",
            region: "cn",
            state: { loggedIn: true, expiresAt: "2026-12-31T00:00:00Z" },
          },
        }
      }
      if (cmd === "auth refresh") {
        if (profile === "expired_prof") {
          return {
            exitCode: 11,
            stdout: JSON.stringify({ ok: false, error: { class: "auth", message: "Refresh expired" } }),
            stderr: "",
          }
        }
        return { ok: true, data: { loggedIn: true, expiresAt: "2027-01-01T00:00:00Z", region: "cn" } }
      }
      if (cmd === "model list") {
        return { exitCode: 1, stdout: "", stderr: "" }
      }
      throw new Error(`Unexpected auth test CLI call: ${args.join(" ")}`)
    })

    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    const hooks = await DreaminaAuthPlugin({ directory: tmpDir })
    expect(hooks.auth.provider).toBe("dreamina")
    expect(hooks.auth.icon).toMatch(/^data:image\/png;base64,/)
    expect(hooks.auth.icon).toBe(pkg.magpie.icon)
    expect(hooks.auth.options).toEqual([
      {
        key: "quote_only",
        label: "Quote only",
        labels: { zh: "仅报价（不扣积分）", "zh-TW": "僅報價（不扣積分）" },
        description: "Quote credits only without running generation.",
        descriptions: {
          zh: "只询价并返回预估点数，不执行生成",
          "zh-TW": "只詢價並回傳預估點數，不執行生成",
        },
        default: false,
      },
      {
        key: "credit_guard",
        label: "200-credit ceiling",
        labels: { zh: "单次 200 点上限保护", "zh-TW": "單次 200 點上限保護" },
        description: "Block runs quoted above 200 credits.",
        descriptions: {
          zh: "单次报价超过 200 点时自动拦截",
          "zh-TW": "單次報價超過 200 點時自動攔截",
        },
        default: true,
      },
    ])
    expect(hooks.auth.methods[0].prompts.map((p) => p.key)).toEqual(["profile", "credits"])
    expect(hooks.auth.methods[0].prompts[1].validate("")).toBeNull()
    expect(hooks.auth.methods[0].prompts[1].validate("1000")).toBeNull()
    expect(hooks.auth.methods[0].prompts[1].validate("-1")).toBeTruthy()

    const cfg = { provider: {} }
    await hooks.config(cfg)
    expect(cfg.provider.dreamina.name).toBe("Dreamina (即梦)")
    expect(Object.keys(cfg.provider.dreamina.models).length).toBe(21)

    // Method 1: existing profile (blank -> "default")
    const m1 = await hooks.auth.methods[0].authorize({ profile: "" })
    expect(m1.method).toBe("auto")
    const r1 = await m1.callback()
    expect(r1.type).toBe("success")
    expect(r1.metadata.profile).toBe("default")
    expect(r1.metadata.isVip).toBe(true)
    expect(r1.accountId).toBe("default (123456)")

    // Method 2: browser sign-in
    const m2 = await hooks.auth.methods[1].authorize({ profile: "studio" })
    expect(m2.url).toBe("https://example.com/verify?code=ABCD-1234")
    expect(m2.instructions).toContain("ABCD-1234")
    const r2 = await m2.callback()
    expect(r2.type).toBe("success")
    expect(r2.metadata.profile).toBe("studio")

    // Refresh
    const refOk = await hooks.auth.refresh(r1)
    expect(refOk.metadata.profile).toBe("default")
    expect(refOk.expires).toBe(Date.parse("2027-01-01T00:00:00Z"))

    try {
      await hooks.auth.refresh({ metadata: { profile: "expired_prof" } })
      throw new Error("Expected refresh to throw")
    } catch (err) {
      expect(err.signIn).toBe("expired")
    }

    // Usage (no balance set -> concise plan, no OAuth until, single 今日点数 window)
    const u = await hooks.auth.usage(async () => r1)
    expect(u.plan).toBe("VIP · 专业会员")
    expect(u.signIn).toBe("kept")
    expect(u.until).toBeUndefined()
    expect(u.windows).toEqual([
      { name: "今日点数", display: "已用 0 点 · 单次上限 200 点", aside: true },
    ])

    // Provider models
    const models = await hooks.provider.models({}, { auth: r1 })
    expect(models["seedream_5.5"].capabilities.output.image).toBe(true)
    expect(models["seedance_2.5"].capabilities.output.video).toBe(true)
  })

  it("displays maestro VIP status and updated credit quotes/spends in auth.usage after generation", async () => {
    const imgBytes = Buffer.from("fake-png-bytes")
    setCliRunnerForTests(async (profile, args) => {
      const cmd = args.slice(0, 2).join(" ")
      if (cmd === "auth status") {
        return { ok: true, data: { loggedIn: true, expiresAt: "2026-12-31T00:00:00Z", region: "cn", profile } }
      }
      if (cmd === "auth account") {
        return { ok: true, data: { userId: 987654, isVip: true, vipLevel: "maestro" } }
      }
      if (cmd === "model list") return { exitCode: 1, stdout: "", stderr: "" }
      if (cmd === "canvas create") {
        const pid = args[args.indexOf("--project-id") + 1]
        return { ok: true, data: { project: { projectId: pid, name: "Magpie Gateway" } } }
      }
      if (cmd === "node create") {
        return { ok: true, data: { node: { nodeId: args[args.indexOf("--node-id") + 1] } } }
      }
      if (cmd === "node quote") {
        const nid = args[args.indexOf("--node-id") + 1]
        return { ok: true, data: { items: [{ nodeId: nid, maxCredits: 15 }], totalMaxCredits: 15 } }
      }
      if (cmd === "node confirm") {
        return { ok: true, data: { creditConfirmationToken: SECRET_TOKEN, creditCeiling: 15 } }
      }
      if (cmd === "node run") {
        return {
          ok: true,
          data: { items: [{ nodeId: args[args.indexOf("--node-id") + 1], submitId: args[args.indexOf("--submit-id") + 1], state: "accepted" }] },
        }
      }
      if (cmd === "operation wait") {
        return { ok: true, data: { state: "succeeded", resources: [{ resourceId: "res-img-1", state: "succeeded" }] } }
      }
      if (cmd === "resource get") {
        return { ok: true, data: { resourceId: "res-img-1", type: "image", status: "succeeded", creditsAmount: 12 } }
      }
      if (cmd === "resource download") {
        const target = path.join(args[args.indexOf("--output") + 1], "out.png")
        fs.writeFileSync(target, imgBytes)
        return { ok: true, data: { resourceId: "res-img-1", path: target, size: imgBytes.length } }
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`)
    })

    const hooks = await DreaminaAuthPlugin({ directory: tmpDir })
    const authObj = { type: "oauth", metadata: { profile: "default" } }
    const loaded = await hooks.auth.loader(async () => authObj)

    const genRes = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream_5.5", prompt: "sunset mountain" }),
    })
    expect(genRes.status).toBe(200)

    const u = await hooks.auth.usage(async () => authObj)
    expect(u.plan).toBe("VIP · 大师会员")
    expect(u.until).toBeUndefined()
    expect(u.windows).toEqual([
      { name: "今日点数", display: "已用 12 点 · 累计 12 点（单次上限 200 点）", aside: true },
    ])
  })

  it("tracks sign-in initial credits, generation deduction, DREAMINA_CREDITS_BALANCE, and liveBalance auto-detection", async () => {
    const imgBytes = Buffer.from("fake-png-bytes")
    let accountPayload = { userId: 987654, isVip: true, vipLevel: "maestro" }
    setCliRunnerForTests(async (profile, args) => {
      const cmd = args.slice(0, 2).join(" ")
      if (cmd === "auth status") {
        return { ok: true, data: { loggedIn: true, expiresAt: "2026-12-31T00:00:00Z", region: "cn", profile } }
      }
      if (cmd === "auth account") {
        return { ok: true, data: accountPayload }
      }
      if (cmd === "model list") return { exitCode: 1, stdout: "", stderr: "" }
      if (cmd === "canvas create") {
        const pid = args[args.indexOf("--project-id") + 1]
        return { ok: true, data: { project: { projectId: pid, name: "Magpie Gateway" } } }
      }
      if (cmd === "node create") {
        return { ok: true, data: { node: { nodeId: args[args.indexOf("--node-id") + 1] } } }
      }
      if (cmd === "node quote") {
        const nid = args[args.indexOf("--node-id") + 1]
        return { ok: true, data: { items: [{ nodeId: nid, maxCredits: 15 }], totalMaxCredits: 15 } }
      }
      if (cmd === "node confirm") {
        return { ok: true, data: { creditConfirmationToken: SECRET_TOKEN, creditCeiling: 15 } }
      }
      if (cmd === "node run") {
        return {
          ok: true,
          data: { items: [{ nodeId: args[args.indexOf("--node-id") + 1], submitId: args[args.indexOf("--submit-id") + 1], state: "accepted" }] },
        }
      }
      if (cmd === "operation wait") {
        return { ok: true, data: { state: "succeeded", resources: [{ resourceId: "res-img-1", state: "succeeded" }] } }
      }
      if (cmd === "resource get") {
        return { ok: true, data: { resourceId: "res-img-1", type: "image", status: "succeeded", creditsAmount: 12 } }
      }
      if (cmd === "resource download") {
        const target = path.join(args[args.indexOf("--output") + 1], "out.png")
        fs.writeFileSync(target, imgBytes)
        return { ok: true, data: { resourceId: "res-img-1", path: target, size: imgBytes.length } }
      }
      throw new Error(`Unexpected CLI call: ${args.join(" ")}`)
    })

    const hooks = await DreaminaAuthPlugin({ directory: tmpDir })
    const m = await hooks.auth.methods[0].authorize({ profile: "default", credits: "1000" })
    const signedIn = await m.callback()
    expect(signedIn.type).toBe("success")

    const loaded = await hooks.auth.loader(async () => signedIn)
    const genRes = await loaded.fetch("dreamina://local/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "seedream_5.5", prompt: "neon harbor" }),
    })
    expect(genRes.status).toBe(200)

    const uDeducted = await hooks.auth.usage(async () => signedIn)
    expect(uDeducted.plan).toBe("VIP · 大师会员")
    expect(uDeducted.until).toBeUndefined()
    expect(uDeducted.balance).toBe("剩余 988 点")
    expect(uDeducted.windows).toEqual([
      {
        name: "会员点数",
        used: 1.2,
        amount: 12,
        limit: 1000,
        unit: "credits",
        display: "剩余 988 / 1000 点 · 今日已用 12 点",
        aside: true,
      },
    ])

    // Env DREAMINA_CREDITS_BALANCE fallback overrides configuredBalance cleanly
    const prevEnv = process.env.DREAMINA_CREDITS_BALANCE
    process.env.DREAMINA_CREDITS_BALANCE = "500"
    try {
      const uEnv = await hooks.auth.usage(async () => signedIn)
      expect(uEnv.balance).toBe("剩余 488 点")
      expect(uEnv.windows[0]).toEqual({
        name: "会员点数",
        used: 2.4,
        amount: 12,
        limit: 500,
        unit: "credits",
        display: "剩余 488 / 500 点 · 今日已用 12 点",
        aside: true,
      })
    } finally {
      if (prevEnv === undefined) delete process.env.DREAMINA_CREDITS_BALANCE
      else process.env.DREAMINA_CREDITS_BALANCE = prevEnv
    }

    // Live balance from auth account takes precedence over env/configured balance
    accountPayload = { userId: 987654, isVip: true, vipLevel: "maestro", credits: 650 }
    const uLive = await hooks.auth.usage(async () => signedIn)
    expect(uLive.balance).toBe("剩余 650 点")
    expect(uLive.windows).toEqual([
      {
        name: "会员点数",
        display: "剩余 650 点 · 今日已用 12 点",
        aside: true,
      },
    ])

    // Also supports `balance` alias in auth account
    accountPayload = { userId: 987654, isVip: false, balance: 420 }
    const uLiveAlias = await hooks.auth.usage(async () => signedIn)
    expect(uLiveAlias.plan).toBe("普通用户")
    expect(uLiveAlias.balance).toBe("剩余 420 点")
  })
})
