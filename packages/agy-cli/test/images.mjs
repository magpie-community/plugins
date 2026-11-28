import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createBridgeKit } from "./testkit.mjs"
import { IMAGE_MODEL_ID, isAllowedImagePermission, pickAspectRatio, pickBrainImage } from "../image.mjs"

const PNG_BYTES = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from("png-payload")])
const JPEG_BYTES = Buffer.concat([Buffer.from("ffd8ffe000104a4649460001", "hex"), Buffer.from("jpeg-payload")])
const WEBP_BYTES = Buffer.concat([Buffer.from("524946462400000057454250", "hex"), Buffer.from("webp-payload")])
const OUT_JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a4649460001", "hex"), Buffer.from("edited-output-jpeg")])

const GENERATIONS_URL = "agy://local/v1/images/generations"
const EDITS_URL = "agy://local/v1/images/edits"

async function withKit(options, fn) {
  if (typeof options === "function") {
    fn = options
    options = {}
  }
  const kit = await createBridgeKit({ sessionClose: true, ...options })
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function brainDirOf(kit, agent) {
  const spawn = kit.acpSpawns.find((s) => s.cwd === agent.cwd)
  const gi = spawn?.args?.indexOf("--gemini-dir") ?? -1
  const base = gi >= 0 && spawn.args[gi + 1]
    ? path.join(spawn.args[gi + 1], "antigravity-cli")
    : path.join(agent.env.HOME || kit.home, ".gemini", "antigravity-cli")
  return path.join(base, "brain", agent.sessionId)
}

function writeBrainImage(kit, agent, filename, bytes = OUT_JPEG) {
  const dir = brainDirOf(kit, agent)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, filename)
  fs.writeFileSync(file, bytes)
  return { dir, file }
}

test("provider.models 暴露 gemini-3.1-flash-image 作为 OpenAI 兼容纯图像模型", async () => {
  await withKit({ agyPath: null }, async (kit) => {
    const models = await kit.models()
    const img = models[IMAGE_MODEL_ID]
    assert.ok(img, "provider.models 缺少 gemini-3.1-flash-image")
    assert.equal(img.npm, "@ai-sdk/openai-compatible")
    assert.equal(img.api.npm, "@ai-sdk/openai-compatible")
    assert.equal(img.api.url, "agy://local")
    assert.deepEqual(img.capabilities.input, { text: true, image: true, audio: false, video: false, pdf: false })
    assert.deepEqual(img.capabilities.output, { text: false, image: true, audio: false, video: false, pdf: false })
  })
})

test("pickAspectRatio 将像素尺寸和比例折算为 agy 支持的枚举，未指定保持为空", () => {
  assert.equal(pickAspectRatio({}), "")
  assert.equal(pickAspectRatio({ size: "auto" }), "")
  assert.equal(pickAspectRatio({ aspect_ratio: "16:9" }), "16:9")
  assert.equal(pickAspectRatio({ size: "1024x1024" }), "1:1")
  assert.equal(pickAspectRatio({ size: "1536x1024" }), "3:2")
  assert.equal(pickAspectRatio({ size: "1024x1536" }), "2:3")
  assert.equal(pickAspectRatio({ size: "1792x1024" }), "16:9")
  assert.equal(pickAspectRatio({ size: "1024x1792" }), "9:16")
})

test("/images/generations 通过隔离 agy 会话生图并在结束后清理临时目录与 brain", async () => {
  await withKit(async (kit) => {
    let capturedBrain = ""
    let capturedWd = ""
    kit.defaultPrompt = async (agent) => {
      capturedWd = agent.cwd
      const promptText = agent.prompt.map((p) => p.text).join("\n")
      assert.match(promptText, /AspectRatio` to `3:2`/)
      assert.match(promptText, /A neon lighthouse in heavy rain/)
      assert.ok(fs.existsSync(path.join(agent.cwd, ".agents", "agents", "magpie-agy-image", "agent.md")))
      const written = writeBrainImage(kit, agent, "magpie_generated_1.jpg", OUT_JPEG)
      capturedBrain = written.dir
      await agent.text("Generated image.")
      return { stopReason: "end_turn", usage: { inputTokens: 1200, cachedReadTokens: 800, outputTokens: 45 } }
    }

    const res = await kit.fetch(GENERATIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: IMAGE_MODEL_ID, prompt: "A neon lighthouse in heavy rain", size: "1536x1024" }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()
    assert.equal(body.data.length, 1)
    assert.equal(body.data[0].b64_json, OUT_JPEG.toString("base64"))
    assert.equal(body.data[0].media_type, "image/jpeg")
    assert.deepEqual(body.usage, { input_tokens: 2000, output_tokens: 45 })
    assert.ok(!fs.existsSync(capturedWd), "临时工作目录未清理")
    assert.ok(!fs.existsSync(capturedBrain), "会话 brain 目录未清理")
  })
})

test("/images/edits 支持 multipart/form-data 多参考图改图、魔数识别扩展名及严格权限门控", async () => {
  await withKit(async (kit) => {
    kit.defaultPrompt = async (agent) => {
      // 第 1 张虽然标成 image/png，但魔数是 JPEG，应落盘为 ref_1.jpg；第 2 张是 WebP -> ref_2.webp
      const ref1 = path.join(agent.cwd, "ref_1.jpg")
      const ref2 = path.join(agent.cwd, "ref_2.webp")
      assert.deepEqual(fs.readFileSync(ref1), JPEG_BYTES)
      assert.deepEqual(fs.readFileSync(ref2), WEBP_BYTES)

      const promptText = agent.prompt.map((p) => p.text).join("\n")
      assert.ok(promptText.includes(ref1), "prompt 未包含 ref_1.jpg 绝对路径")
      assert.ok(promptText.includes(ref2), "prompt 未包含 ref_2.webp 绝对路径")
      assert.match(promptText, /Put the character from ref 1 into the background of ref 2/)

      // 权限门控实测：允许读 wd 内参考图、调用 image-generator 子代理、调用 generate_image
      const allowRead = await agent.requestPermission({ title: `read_file(${ref1})` })
      assert.equal(allowRead.result.outcome.optionId, "allow")

      const allowSub = await agent.requestPermission({ title: "invoke_subagent", rawInput: { SubagentName: "image-generator" } })
      assert.equal(allowSub.result.outcome.optionId, "allow")

      const allowGen = await agent.requestPermission({ name: "generate_image", rawInput: { ImagePaths: [ref1, ref2] } })
      assert.equal(allowGen.result.outcome.optionId, "allow")

      // 拒绝越界读文件、任意 shell 命令、以及非 image-generator 子代理
      const outside = path.join(kit.home, "secret.png")
      const denyOutsideRead = await agent.requestPermission({ title: `read_file(${outside})` })
      assert.equal(denyOutsideRead.result.outcome.optionId, "deny")

      const denyOutsideGen = await agent.requestPermission({ name: "generate_image", rawInput: { ImagePaths: [outside] } })
      assert.equal(denyOutsideGen.result.outcome.optionId, "deny")

      const denyGeneralSub = await agent.requestPermission({ title: "invoke_subagent", rawInput: { SubagentName: "general-purpose" } })
      assert.equal(denyGeneralSub.result.outcome.optionId, "deny")

      const denyShell = await agent.requestPermission({ title: "Run run_command?", rawInput: { CommandLine: "echo fake" } })
      assert.equal(denyShell.result.outcome.optionId, "deny")

      writeBrainImage(kit, agent, "magpie_generated_edit.png", PNG_BYTES)
      writeBrainImage(kit, agent, "view_file_reference.jpg", JPEG_BYTES)
      const later = new Date(Date.now() + 60000)
      fs.utimesSync(path.join(brainDirOf(kit, agent), "view_file_reference.jpg"), later, later)
      await agent.text("Edited.")
      return { stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 20 } }
    }

    const form = new FormData()
    form.append("model", IMAGE_MODEL_ID)
    form.append("prompt", "Put the character from ref 1 into the background of ref 2")
    form.append("image[]", new Blob([JPEG_BYTES], { type: "image/png" }), "mislabelled.png")
    form.append("image[]", new Blob([WEBP_BYTES], { type: "image/webp" }), "bg.webp")
    const serialized = new Response(form)
    const res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": serialized.headers.get("content-type") },
      body: new Uint8Array(await serialized.arrayBuffer()),
    })
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()
    assert.equal(body.data.length, 1)
    assert.equal(body.data[0].b64_json, PNG_BYTES.toString("base64"))
    assert.equal(body.data[0].media_type, "image/png")
  })
})

test("/images/edits 支持 JSON data URL 与 n>1 并行生成，以及多账号 HOME 隔离", async () => {
  const otherAuth = { type: "oauth", metadata: { agyHome: "imgacct2" } }
  await withKit(async (kit) => {
    const acctHome = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "accounts", "imgacct2")
    const token = path.join(acctHome, ".gemini", "antigravity-cli", "antigravity-oauth-token")
    fs.mkdirSync(path.dirname(token), { recursive: true })
    fs.writeFileSync(token, JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: "0001-01-01T00:00:00Z" } }))

    let seenHomes = []
    kit.defaultPrompt = async (agent) => {
      seenHomes.push(agent.env.HOME)
      writeBrainImage(kit, agent, `magpie_generated_${agent.index}.jpg`, OUT_JPEG)
      return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10 } }
    }

    const loader = await kit.plugin.auth.loader(async () => otherAuth)
    const res = await loader.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Add warm sunset lighting",
        n: 2,
        reference_images: [`data:image/png;base64,${PNG_BYTES.toString("base64")}`],
      }),
    })
    assert.equal(res.status, 200, await res.clone().text())
    const body = await res.json()
    assert.equal(body.data.length, 2)
    assert.deepEqual(body.usage, { input_tokens: 200, output_tokens: 20 })
    assert.equal(seenHomes.length, 2)
    for (const h of seenHomes) assert.match(h, /imgacct2$/)
  })
})

test("n>1 时任一会话失败会立即中止其余并行会话并释放 agy 进程", async () => {
  await withKit(async (kit) => {
    let entered = 0
    let bothStarted
    const ready = new Promise((resolve) => { bothStarted = resolve })
    let siblingCancelReceived = false
    let siblingSessionId = ""

    kit.defaultPrompt = async (agent) => {
      const turnNum = ++entered
      if (entered === 2) bothStarted()
      await ready
      if (turnNum === 1) {
        await agent.text("Individual quota reached for Gemini Image. Resets in 1h")
        return { stopReason: "end_turn" }
      }
      siblingSessionId = agent.sessionId
      await agent.waitCancel()
      siblingCancelReceived = true
      return new Promise(() => {})
    }

    const res = await kit.fetch(GENERATIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "two cats", n: 2 }),
    })

    assert.equal(res.status, 429)
    assert.match(await res.text(), /Individual quota reached/)
    assert.equal(siblingCancelReceived, true, "并行兄弟会话应收到中止信号")
    assert.ok(
      kit.acpLog.some((entry) => entry.method === "session/cancel" && entry.sessionId === siblingSessionId),
      "应向仍在运行的兄弟会话发送 session/cancel",
    )
    assert.equal(kit.children.size, 0, "所有并行 agy 子进程都应已释放")
  })
})

test("/images/edits 未出图且 brain 仅含参考图副本时返回 502，不把参考图当结果返回", async () => {
  await withKit(async (kit) => {
    // 1. brain 只有与参考图字节完全一致的副本 -> 502
    kit.defaultPrompt = async (agent) => {
      writeBrainImage(kit, agent, "view_file_ref.png", PNG_BYTES)
      await agent.text("Sorry, generate_image failed.")
      return { stopReason: "end_turn" }
    }
    let res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "edit", image: PNG_BYTES.toString("base64") }),
    })
    assert.equal(res.status, 502)
    assert.match(await res.text(), /Antigravity returned no generated image/)

    // 2. brain 只有无 magpie_generated 前缀的 viewed 副本（哪怕字节已重新编码）-> 502
    kit.defaultPrompt = async (agent) => {
      writeBrainImage(kit, agent, "view_file_reencoded.jpg", OUT_JPEG)
      await agent.text("Sorry, generate_image failed.")
      return { stopReason: "end_turn" }
    }
    res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "edit", image: PNG_BYTES.toString("base64") }),
    })
    assert.equal(res.status, 502)
    assert.match(await res.text(), /Antigravity returned no generated image/)

    // 3. 即使文件名带 magpie_generated 前缀，若字节与参考图完全相同也拒绝 -> 502
    kit.defaultPrompt = async (agent) => {
      writeBrainImage(kit, agent, "magpie_generated_unchanged.png", PNG_BYTES)
      return { stopReason: "end_turn" }
    }
    res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "edit", image: PNG_BYTES.toString("base64") }),
    })
    assert.equal(res.status, 502)
    assert.match(await res.text(), /Antigravity returned no generated image/)

    // 4. 无参考图的 /images/generations 仍保留无前缀回退
    const fallback = pickBrainImage([{ name: "custom_output.jpg", bytes: OUT_JPEG, mimeType: "image/jpeg" }])
    assert.equal(fallback?.name, "custom_output.jpg")
  })
})

test("生图会话超时时在 502 错误信息中透传超时原因", async () => {
  await withKit({ env: { AGY_BRIDGE_IMAGE_TIMEOUT_MS: "50" } }, async (kit) => {
    let keepAlive
    kit.defaultPrompt = async (agent) => {
      await agent.text("Working on it...")
      return new Promise((resolve) => {
        keepAlive = setTimeout(() => resolve({ stopReason: "end_turn" }), 5_000)
      })
    }
    try {
      const res = await kit.fetch(GENERATIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "slow image" }),
      })
      assert.equal(res.status, 502)
      const text = await res.text()
      assert.match(text, /Antigravity returned no generated image/)
      assert.match(text, /timed out/i)
    } finally {
      clearTimeout(keepAlive)
    }
  })
})

test("参数校验与上游错误码映射：缺图、超 3 张、mask、坏图片、未登录、无生图权限、配额耗尽", async () => {
  await withKit(async (kit) => {
    // 1. /images/edits 缺少参考图 -> 400
    let res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "edit nothing" }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /at least one reference image/)

    // 2. 超过 3 张参考图 -> 400
    const d = `data:image/png;base64,${PNG_BYTES.toString("base64")}`
    res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "four refs", images: [d, d, d, d] }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /at most 3 reference images/)

    // 3. 传了 mask -> 400
    res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "inpaint", image: d, mask: d }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /does not support mask/)

    // 4. 非图片字节 -> 400
    res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "bad bytes", image: Buffer.from("not an image").toString("base64") }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /not a valid PNG, JPEG, GIF or WebP/)

    // 5. response_format=url -> 400
    res = await kit.fetch(GENERATIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "cat", response_format: "url" }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /b64_json/)

    // 6. GET 方法 -> 405
    res = await kit.fetch(GENERATIONS_URL, { method: "GET" })
    assert.equal(res.status, 405)

    assert.equal(kit.acpSpawns.length, 0, "无效请求不应启动 agy 进程")

    // 7. 账号无生图权限 -> 403
    kit.defaultPrompt = async (agent) => {
      await agent.text("Image generation is unavailable to this account.")
      return { stopReason: "end_turn" }
    }
    res = await kit.fetch(GENERATIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "cat" }),
    })
    assert.equal(res.status, 403)
    assert.match(await res.text(), /not offered image generation/)

    // 8. 配额耗尽 -> 429
    kit.defaultPrompt = async (agent) => {
      await agent.text("Individual quota reached for Gemini Image. Resets in 2h15m")
      return { stopReason: "end_turn" }
    }
    res = await kit.fetch(GENERATIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "cat" }),
    })
    assert.equal(res.status, 429)
    assert.match(await res.text(), /Individual quota reached/)
  })

  // 9a. 已知未登录账号直接拦截 -> 401 + X-Magpie-Sign-In: expired，不起子进程
  await withKit({ platform: "darwin", storedSignIn: "missing" }, async (kit) => {
    await kit.models()
    const res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "edit", image: PNG_BYTES.toString("base64") }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("X-Magpie-Sign-In"), "expired")
    assert.equal(kit.acpSpawns.length, 0)
  })

  // 9b. 冷启动首次请求遇 agy session/new Authentication required -> 401 + X-Magpie-Sign-In: expired
  await withKit({ sessionNewError: { code: -32000, message: "Authentication required" } }, async (kit) => {
    const res = await kit.fetch(EDITS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "edit", image: PNG_BYTES.toString("base64") }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("X-Magpie-Sign-In"), "expired")
  })
})

test("isAllowedImagePermission 细粒度路径边界检查", () => {
  const wd = process.platform === "win32" ? "C:\\Temp\\img-wd" : "/tmp/img-wd"
  const inside = path.join(wd, "ref_1.png")
  const outside = process.platform === "win32" ? "C:\\Temp\\img-wd-evil\\ref_1.png" : "/tmp/img-wd-evil/ref_1.png"
  for (const input of [{}, { unknown: "image-generator" }, { SubagentName: " " }]) {
    assert.equal(isAllowedImagePermission({ name: "invoke_subagent", rawInput: input }, wd), false)
  }
  assert.equal(isAllowedImagePermission({ title: `Read ${inside}` }, wd), true)
  assert.equal(isAllowedImagePermission({ title: `Read ${outside}` }, wd), false)
  assert.equal(isAllowedImagePermission({ title: "view_file", locations: [{ path: inside }] }, wd), true)
  assert.equal(isAllowedImagePermission({ title: "view_file", locations: [{ path: outside }] }, wd), false)
  assert.equal(isAllowedImagePermission({ name: "generate_image", rawInput: {} }, wd), true)
  assert.equal(isAllowedImagePermission({ name: "generate_image", rawInput: { ImagePaths: [inside] } }, wd), true)
  assert.equal(isAllowedImagePermission({ name: "generate_image", rawInput: { ImagePaths: [inside, outside] } }, wd), false)
})
