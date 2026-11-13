// magpie-agy 模型目录回归（源自 configs 仓 test_agy_bridge_catalog.mjs）：目录刷新不得拖过 Magpie 的 2 秒 provider.models 超时，
// 失败不得冲掉已有动态目录，limit 元数据按家族给出，型号别名与 [1m] 剥除保持可用。
//
// 运行：bun test ./catalog.mjs（或在包目录 bun test）
// 全部经真实仓内 index.mjs 的 plugin.provider.models() / fetch 入口，边界替身见 testkit.mjs。

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  BASE_MODEL_ROWS, CATALOG_TTL_MS, baseBody, createBridgeKit, modelsOutput, readSse, sleep, tick,
} from "./testkit.mjs"

const FAST_BUDGET_MS = 750 // 计划给的调度容差；补丁内部等待预算是 500ms，远低于 Magpie 的 2s。
// 会话报出 agy 向本客户端开放的型号之前，只列 Gemini。
const FALLBACK_IDS = ["gemini-4-argon", "gemini-3.8-flash"]
const OFFERED_ALL = [
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"], ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
]
const NOT_YET_OFFERED = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b", "gpt-oss-120b-medium", "mystery-model"]
const DYNAMIC_ROWS = [...BASE_MODEL_ROWS, ["gemini-9-test-high", "Gemini 9 Test (High)"], ["gemini-9-test-low", "Gemini 9 Test (Low)"], ["mystery-model", "Mystery Model"]]
const DYNAMIC_OK = { stdout: modelsOutput(DYNAMIC_ROWS) }

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

async function timed(fn) {
  const started = performance.now()
  const value = await fn()
  return { value, ms: performance.now() - started }
}

function ids(models) {
  return Object.keys(models).sort()
}

function assertFallbackPresent(models) {
  for (const id of FALLBACK_IDS) assert.ok(models[id], `目录缺少 ${id}`)
  for (const id of NOT_YET_OFFERED) assert.equal(models[id], undefined, `没有会话开放就列出了 ${id}`)
}

// 后台刷新结束（假子进程已关）且模块自己的定时器都已清掉。
async function settle(kit) {
  for (let i = 0; i < 20 && kit.children.size; i++) await sleep(10)
  await tick()
  await tick()
}

test("没有 agy 时直接给静态目录，不起子进程", async () => {
  await withKit({ agyPath: null }, async (kit) => {
    const { value, ms } = await timed(() => kit.models())
    assertFallbackPresent(value)
    assert.equal(kit.modelsSpawns.length, 0)
    assert.ok(ms < FAST_BUDGET_MS, `耗时 ${ms}ms`)
  })
})

// JZGiVvkSOA75376 on X: a signed-out agy opens Google's sign-in in the browser
// whenever it runs (on Windows through ShellExecuteW, past any BROWSER shim).
test("agy 没存登录时不在后台跑 agy models、不起探测会话，请求答需要重新登录", async () => {
  await withKit({ platform: "darwin", storedSignIn: "missing", modelsBehavior: DYNAMIC_OK }, async (kit) => {
    assertFallbackPresent(await kit.models())
    const warming = kit.plugin.provider.warming?.()
    if (warming) await warming
    await settle(kit)
    assert.equal(kit.modelsSpawns.length, 0, "没登录也跑了 agy models")
    assert.equal(kit.acpSpawns.length, 0, "没登录也起了探测会话")
    assert.ok(kit.execFiles.some(c => c.file === "/usr/bin/security" && c.args.includes("antigravity")))
    const response = await kit.request(baseBody())
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("X-Magpie-Sign-In"), "expired")
    assert.match(await response.text(), /isn't signed in/)
    assert.equal(kit.acpSpawns.length, 0, "没登录也为请求起了 agy")
  })
  // 存着能续期的登录（access token 过期也一样）：照常列目录
  const value = "go-keyring-base64:" + Buffer.from(JSON.stringify({ token: { access_token: "a", refresh_token: "r", expiry: "2020-01-01T00:00:00Z" } })).toString("base64")
  await withKit({ platform: "darwin", storedSignIn: value + "\n", modelsBehavior: DYNAMIC_OK }, async (kit) => {
    await kit.models()
    const warming = kit.plugin.provider.warming?.()
    if (warming) await warming
    await settle(kit)
    assert.ok(kit.modelsSpawns.length >= 1, "有登录却没跑 agy models")
  })
})

test("首次 agy models 卡死时 750ms 内返回非空静态目录", async () => {
  await withKit({ modelsBehavior: { hang: true } }, async (kit) => {
    const { value, ms } = await timed(() => kit.models())
    assert.ok(ms < FAST_BUDGET_MS, `首次目录耗时 ${Math.round(ms)}ms，超过 ${FAST_BUDGET_MS}ms`)
    assertFallbackPresent(value)
    assert.equal(kit.modelsSpawns.length, 1)
    assert.equal(kit.timers.refed().length, 0, "agy models 卡死期间不应有挂住 Node 退出的模块定时器")
    await kit.finishChildren()
    assert.equal(kit.timers.refed().length, 0, "子进程结束后不应残留挂住退出的定时器")
    // 探测一起就在 warming() 里：等它跑完再数，不靠固定时长。
    const warming = kit.plugin.provider.warming?.()
    if (warming) await warming
    await settle(kit)
    assert.equal(kit.acpSpawns.length, 0, "agy models 没答出来时不应起探测会话")
  })
})

test("首次快速成功时直接拿到动态目录", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    const models = await kit.models()
    assert.ok(models["gemini-9-test"], "动态独有家族未出现在目录")
    assert.deepEqual(models["gemini-9-test"].variants && Object.keys(models["gemini-9-test"].variants).sort(), ["high", "low"])
    assert.equal(models["mystery-model"], undefined, "没有会话开放的非 Gemini 型号不应列出")
  })
})

test("会话开放的型号才列出：不等请求，探测会话就列出 Claude、GPT-OSS 和 agy models 没列的型号", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, offeredModels: [
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
    ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
    ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"], ["offered-only", "Offered Only"],
  ] }, async (kit) => {
    await kit.models()
    await settle(kit)
    const after = await kit.models()
    assert.deepEqual(Object.keys(after["claude-opus-5-5"]?.variants ?? {}).sort(), ["high", "low"])
    assert.deepEqual(JSON.parse(JSON.stringify(after["claude-opus-5-5"].limit)), { context: 1000000, output: 64000 })
    assert.deepEqual(JSON.parse(JSON.stringify(after["gpt-oss-120b"]?.limit ?? null)), { context: 131072, output: 32768 })
    assert.ok(after["offered-only"], "会话开放而 agy models 没列的型号应列出")
    assert.equal(after["claude-sonnet-5-5"], undefined, "agy models 列出但会话没开放的型号不应列出")
    assert.equal(after["gemini-3.8-flash"], undefined, "会话没开放的 Gemini 也不应列出")
    assert.equal(after["mystery-model"], undefined)
    assert.ok(after["gemini-4-argon"])
    // 探测只开会话、不发 prompt，用插件自己的名字，进程跑完就关。
    assert.equal(kit.acpLog.filter(entry => entry.method === "session/prompt").length, 0, "探测不应发 prompt")
    assert.equal(kit.acpLog.filter(entry => entry.method === "session/new").length, 1)
    assert.equal(kit.acpLog.find(entry => entry.method === "initialize")?.params?.clientInfo?.name, "opencode-agy-cli-auth")
    assert.deepEqual(kit.acpSpawns.map(spawn => spawn.args), [["acp"]])
    assert.equal(kit.children.size, 0, "探测的 agy acp 应已退出")
    // 已知开放什么之后不再探测。
    kit.clock.advance(CATALOG_TTL_MS)
    await kit.models()
    await settle(kit)
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("探测会话失败（agy 要求登录）时只列 Gemini，限流后再试，成功即列出", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, sessionNewError: { code: -32000, message: "Authentication required" }, offeredModels: [
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ] }, async (kit) => {
    await kit.models()
    await settle(kit)
    const failed = await kit.models()
    assert.equal(failed["claude-opus-5-5"], undefined)
    assert.ok(failed["gemini-4-argon"])
    assert.equal(kit.children.size, 0, "失败的探测也应关掉 agy acp")
    assert.equal(kit.acpSpawns.length, 1, "一分钟内不再探测")
    kit.sessionNewError = null
    kit.clock.advance(60_000)
    await kit.models()
    // 新鲜目录不等探测：等它起来并跑完。
    for (let i = 0; i < 200 && kit.acpSpawns.length < 2; i++) await sleep(5)
    await settle(kit)
    assert.equal(kit.acpSpawns.length, 2)
    const listed = await kit.models()
    assert.deepEqual(Object.keys(listed["claude-opus-5-5"]?.variants ?? {}).sort(), ["high", "low"])
  })
})

test("会话后来开放的型号变了，目录随之更新", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, offeredModels: [["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"]] }, async (kit) => {
    await kit.models()
    await settle(kit)
    assert.equal((await kit.models())["claude-opus-5-5"], undefined)
    kit.offeredModels = [["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"]]
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
    }
    const parsed = await readSse(await kit.request(baseBody({ model: "agy-cli/gemini-4-argon", tools: [], messages: [{ role: "user", content: "hi" }] })))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    assert.ok((await kit.models())["claude-opus-5-5"])
  })
})

// #1064（hiee3）：真实登录的 agy 上 `agy models` 约 4.4s、agy acp 开会话约 3s，都远过 500ms 的快速等待。
// 这里各模拟 1.5s：第一次 models() 只能给静态目录，但列表一到就该起探测，
// 后台跑完后的第一次 models() 就要有 Claude 和 GPT-OSS，不该要第三次。
const SLOW_MS = 1_500
const OFFERED_CLAUDE = [
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"], ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
]
const SLOW_AGY = { modelsBehavior: { stdout: modelsOutput(BASE_MODEL_ROWS), delayMs: SLOW_MS }, sessionNewDelayMs: SLOW_MS, offeredModels: OFFERED_CLAUDE }

// 等后台的列表与探测都结束：等状态（没有在跑的假子进程，且插件说没有在热身），不等固定时长。
async function warmed(kit) {
  const warming = kit.plugin.provider.warming?.()
  if (warming) await warming
  for (let i = 0; i < 1000 && kit.children.size; i++) await sleep(10)
  await settle(kit)
}

function assertClaudeListed(models, label) {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"]) assert.ok(models[id], `${label}：没有 ${id}，只有 ${ids(models).join(", ")}`)
}

test("#1064 慢 agy：第一次 models() 给静态目录，后台热身后的第一次就列出 Claude 和 GPT-OSS", async () => {
  await withKit(SLOW_AGY, async (kit) => {
    const { value: first, ms } = await timed(() => kit.models())
    assert.ok(ms < FAST_BUDGET_MS, `首次目录耗时 ${Math.round(ms)}ms`)
    assertFallbackPresent(first)
    await warmed(kit)
    assert.equal(kit.acpSpawns.length, 1, "列表一到就该起一次探测会话")
    const { value: after, ms: warmMs } = await timed(() => kit.models())
    assert.ok(warmMs < 100, `热身后的目录耗时 ${Math.round(warmMs)}ms`)
    assertClaudeListed(after, "热身后的第一次 models()")
    assert.equal(kit.modelsSpawns.length, 1)
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(kit.plugin.provider.warming(), null, "热身完了不该还说在热身")
  })
})

// #1086（yinbing-666）：重启后在 agy 再次回答前，也该列出上次的完整目录，而不是只有 Gemini。
test("#1086 重启后第一次 models() 就给上次 agy 列出并开放的目录，坏文件和别的 agy 仍给静态目录", async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "agy-catalog-saved-"))
  try {
    const agy = path.join(shared, process.platform === "win32" ? "agy.exe" : "agy")
    fs.writeFileSync(agy, "#!/bin/sh\nexit 99\n", { mode: 0o755 })
    const env = { XDG_STATE_HOME: path.join(shared, "state") }
    await withKit({ ...SLOW_AGY, agyPath: agy, env }, async (kit) => {
      assertFallbackPresent(await kit.models())
      await warmed(kit)
      assertClaudeListed(await kit.models(), "第一次运行")
    })
    const file = path.join(shared, "state", "magpie-agy-bridge", "models.json")
    const saved = fs.readFileSync(file, "utf8")
    assert.match(saved, /claude-sonnet-5-5-high/)

    // 重启：agy 还是慢，第一次 models() 就该有 Claude；探测等 agy models 回答后才起。
    await withKit({ ...SLOW_AGY, agyPath: agy, env }, async (kit) => {
      const { value: first, ms } = await timed(() => kit.models())
      assert.ok(ms < FAST_BUDGET_MS, `重启后首次目录耗时 ${Math.round(ms)}ms`)
      assertClaudeListed(first, "重启后第一次")
      assert.equal(kit.acpSpawns.length, 0, "agy models 回答前不该起探测会话")
      assert.equal(kit.modelsSpawns.length, 1, "保存的目录也要再问一次 agy")
      await warmed(kit)
    })

    // 另一个 agy 可执行文件不用这份目录。
    await withKit({ ...SLOW_AGY, env }, async (kit) => {
      assertFallbackPresent(await kit.models())
      await warmed(kit)
    })

    // 半截文件：当作不知道，给静态目录。
    fs.writeFileSync(file, saved.slice(0, Math.floor(saved.length / 2)))
    await withKit({ ...SLOW_AGY, agyPath: agy, env }, async (kit) => {
      assertFallbackPresent(await kit.models())
      await warmed(kit)
    })
  } finally {
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test("#1064 慢 agy：已登录时 authorize 读到的列表和探测就是目录，紧接着的 models() 不再是静态目录", async () => {
  await withKit(SLOW_AGY, async (kit) => {
    const { value: started, ms } = await timed(() => kit.plugin.auth.methods[0].authorize())
    assert.equal(started.method, "auto")
    assert.ok(ms < SLOW_MS * 2 + 3_000, `登录检查耗时 ${Math.round(ms)}ms`)
    assert.equal((await started.callback()).type, "success")
    const { value: listed, ms: listMs } = await timed(() => kit.models())
    assert.ok(listMs < 100, `登录后的目录耗时 ${Math.round(listMs)}ms`)
    assertClaudeListed(listed, "登录后的第一次 models()")
    assert.equal(kit.modelsSpawns.length, 1, "登录检查读过的列表不该再读一遍")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("#1064 登录检查不为探测等太久：会话一直不答时最多多等几秒", async () => {
  // 会话 60s 才答：authorize 只等探测约 3s，不该等到会话答（#1089：上界不留 1s 那么窄的余量）。
  // 下界是计时器，只会晚到不会早到，负载下也不会误报。
  const SESSION_MS = 60_000
  await withKit({ ...SLOW_AGY, sessionNewDelayMs: SESSION_MS }, async (kit) => {
    const { value: started, ms } = await timed(() => kit.plugin.auth.methods[0].authorize())
    assert.equal(started.method, "auto")
    assert.equal(kit.acpSpawns.length, 1, "登录检查该起探测会话")
    assert.ok(ms < SESSION_MS / 2, `登录检查等了会话（${Math.round(ms)}ms）`)
    assert.ok(ms >= SLOW_MS + 2_500, `登录检查没等探测（${Math.round(ms)}ms）`)
    const models = await kit.models()
    assert.ok(models["gemini-4-argon"])
    assert.equal(models["claude-opus-5-5"], undefined, "探测没答前不该列出 Claude")
  })
})

test("#1064 agyPath 变了，旧 agy 开放的型号不再列出，新 agy 重新探测", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK, offeredModels: OFFERED_CLAUDE }, async (kit) => {
    await kit.models()
    await warmed(kit)
    assertClaudeListed(await kit.models(), "agy-a")
    kit.env.AGY_PATH = kit.makeFakeAgy("agy-b")
    kit.offeredModels = [["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"]]
    const switched = await kit.models()
    assert.deepEqual(ids(switched).filter(id => /^(?:claude|gpt)-/.test(id)), [], "换了 agy 还在列旧 agy 开放的型号")
    await warmed(kit)
    assert.equal(kit.acpSpawns.length, 2, "新 agy 应重新探测")
    assert.equal(kit.acpSpawns.at(-1).file, kit.env.AGY_PATH)
    const after = await kit.models()
    assert.equal(after["claude-opus-5-5"], undefined)
    assert.ok(after["gemini-4-argon"])
  })
})

test("握手报出的 agy 版本低于 1.4.12 时拒绝会话并说明原因", async () => {
  await withKit({ agentVersion: "1.4.11" }, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const response = await kit.request(baseBody({ model: "agy-cli/gemini-4-argon", tools: [], messages: [{ role: "user", content: "hi" }] }))
    const text = response.status === 200 ? JSON.stringify((await readSse(response)).error) : await response.text()
    assert.match(text, /agy 1\.4\.11 is older than 1\.4\.12/)
    assert.equal(kit.acpLog.filter(entry => entry.method === "session/new").length, 0, "旧版本不应开会话")
  })
})

test("新鲜缓存不再等待也不再 spawn", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    await kit.models()
    await settle(kit)
    kit.modelsBehavior = { hang: true }
    const { value, ms } = await timed(() => kit.models())
    assert.ok(ms < 100, `热缓存耗时 ${Math.round(ms)}ms`)
    assert.ok(value["gemini-9-test"])
    assert.equal(kit.modelsSpawns.length, 1)
  })
})

test("TTL 边界：差 1ms 不刷新，到点后台刷新且过期期间仍 750ms 内返回旧动态目录", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    await kit.models()
    await settle(kit)
    assert.equal(kit.modelsSpawns.length, 1)
    kit.modelsBehavior = { hang: true }
    kit.clock.advance(CATALOG_TTL_MS - 1)
    await kit.models()
    assert.equal(kit.modelsSpawns.length, 1, "TTL 未到就重新 spawn 了")
    kit.clock.advance(1)
    const { value, ms } = await timed(() => kit.models())
    assert.equal(kit.modelsSpawns.length, 2, "TTL 到点没有刷新")
    assert.ok(ms < FAST_BUDGET_MS, `过期目录耗时 ${Math.round(ms)}ms`)
    assert.ok(value["gemini-9-test"], "过期刷新卡住时丢了上次的动态目录")
  })
})

test("50 个并发 models() 只 spawn 一次且结果一致", async () => {
  await withKit({ modelsBehavior: { ...DYNAMIC_OK, delayMs: 120 } }, async (kit) => {
    const { value: results, ms } = await timed(() => Promise.all(Array.from({ length: 50 }, () => kit.models())))
    assert.equal(kit.modelsSpawns.length, 1)
    assert.ok(ms < FAST_BUDGET_MS, `并发耗时 ${Math.round(ms)}ms`)
    const first = JSON.stringify(results[0])
    for (const item of results) assert.equal(JSON.stringify(item), first)
    assert.ok(results[0]["gemini-9-test"])
  })
})

test("失败、超时、空输出、不可解析输出都保留动态独有型号，成功后恢复更新", async () => {
  await withKit({ modelsBehavior: DYNAMIC_OK }, async (kit) => {
    assert.ok((await kit.models())["gemini-9-test"])
    await settle(kit)
    const failures = [
      ["退出码非零", { code: 1, stdout: "" }],
      ["被超时杀掉", { killed: true }],
      ["卡死", { hang: true }],
      ["spawn error 事件", { error: true }],
      ["spawn 同步抛错", { throwSync: true }],
      ["空输出", { code: 0, stdout: "" }],
      ["不可解析输出", { code: 0, stdout: "garbage\n\n   \n" }],
    ]
    for (const [label, behavior] of failures) {
      kit.modelsBehavior = behavior
      kit.clock.advance(CATALOG_TTL_MS)
      const before = kit.modelsSpawns.length
      const { value, ms } = await timed(() => kit.models())
      assert.equal(kit.modelsSpawns.length, before + 1, `${label}：没有发起刷新`)
      assert.ok(ms < FAST_BUDGET_MS, `${label}：耗时 ${Math.round(ms)}ms`)
      assert.ok(value["gemini-9-test"], `${label}：动态独有型号被静态表冲掉`)
      await kit.finishChildren()
      await settle(kit)
    }
    kit.modelsBehavior = { stdout: modelsOutput([...BASE_MODEL_ROWS, ["gemini-10-new-high", "G10 (High)"], ["gemini-10-new-low", "G10 (Low)"]]) }
    kit.clock.advance(CATALOG_TTL_MS)
    const recovered = await kit.models()
    assert.ok(recovered["gemini-10-new"], "恢复成功后没有换成新目录")
    assert.equal(recovered["gemini-9-test"], undefined, "成功刷新应整体替换为新目录")
  })
})

test("失败后的立即重试被限流，不形成请求风暴；隔一段时间后仍会再试", async () => {
  await withKit({ modelsBehavior: { code: 1, stdout: "" } }, async (kit) => {
    await kit.models()
    await settle(kit)
    for (let i = 0; i < 20; i++) await kit.models()
    await settle(kit)
    assert.ok(kit.modelsSpawns.length <= 2, `20 次立即重试起了 ${kit.modelsSpawns.length} 个 agy models`)
    const before = kit.modelsSpawns.length
    kit.clock.advance(CATALOG_TTL_MS)
    kit.modelsBehavior = DYNAMIC_OK
    const models = await kit.models()
    assert.equal(kit.modelsSpawns.length, before + 1, "间隔足够后没有再次尝试")
    assert.ok(models["gemini-9-test"])
  })
})

test("agyPath 变化后不复用旧可执行文件的动态目录", async () => {
  await withKit({ modelsBehavior: { stdout: modelsOutput([...BASE_MODEL_ROWS, ["gemini-only-on-a", "Gemini Only On A"]]) } }, async (kit) => {
    assert.ok((await kit.models())["gemini-only-on-a"])
    await settle(kit)
    kit.env.AGY_PATH = kit.makeFakeAgy("agy-b")
    kit.modelsBehavior = { hang: true }
    const { value, ms } = await timed(() => kit.models())
    assert.ok(ms < FAST_BUDGET_MS)
    assert.equal(value["gemini-only-on-a"], undefined, "换了 agy 仍在用旧 agy 的动态型号")
    assertFallbackPresent(value)
    assert.equal(kit.modelsSpawns.at(-1).file, kit.env.AGY_PATH)
  })
})

test("Gemini 4 Carbon（Ultra）：会话开放就列出，limit 是 Antigravity 型号表给的 1M/262144", async () => {
  const rows = [...BASE_MODEL_ROWS, ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"]]
  await withKit({ modelsBehavior: { stdout: modelsOutput(rows) }, offeredModels: [
    ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ] }, async (kit) => {
    await kit.models()
    await settle(kit)
    const after = await kit.models()
    assert.ok(after["gemini-4-carbon"], "Carbon 应列出")
    assert.deepEqual(JSON.parse(JSON.stringify(after["gemini-4-carbon"].limit)), { context: 1048576, output: 262144 })
  })
})

test("各家族 limit 正确，未知动态型号不猜成 1M", async () => {
  const expected = {
    "gemini-4-argon": { context: 1048576, output: 65536 },
    "gemini-3.8-flash": { context: 1048576, output: 65536 },
  }
  for (const [label, options] of [["静态目录", { agyPath: null }], ["动态目录", { modelsBehavior: DYNAMIC_OK }]]) {
    await withKit(options, async (kit) => {
      const models = await kit.models()
      for (const [id, limit] of Object.entries(expected)) {
        assert.deepEqual(JSON.parse(JSON.stringify(models[id]?.limit ?? null)), limit, `${label} ${id} 的 limit 不对`)
      }
      if (models["mystery-model"]) {
        const context = models["mystery-model"].limit?.context
        assert.ok(!(context >= 1_000_000), `未知型号被猜成 ${context}`)
      }
      if (models["gemini-9-test"]) {
        const context = models["gemini-9-test"].limit?.context
        assert.ok(!(context >= 1_000_000), `未证实家族被猜成 ${context}`)
      }
    })
  }
})

test("gpt-oss-120b 裸名映射到 medium，请求型号尾部 [1m] 被剥除", async () => {
  const cases = [
    ["agy-cli/gpt-oss-120b", "gpt-oss-120b-medium", "gpt-oss-120b"],
    ["agy-cli/gpt-oss-120b[1m]", "gpt-oss-120b-medium", "gpt-oss-120b"],
    ["agy-cli/gpt-oss-120b-medium", "gpt-oss-120b-medium", "gpt-oss-120b-medium"],
    ["agy-cli/gemini-4-argon[1m]", "gemini-4-argon-high", "gemini-4-argon"],
    ["agy-cli/claude-sonnet-5-5[1M]", "claude-sonnet-5-5-high", "claude-sonnet-5-5"],
  ]
  for (const [requested, agyModel, echoed] of cases) {
    await withKit({ agyPath: undefined, offeredModels: OFFERED_ALL }, async (kit) => {
      kit.defaultPrompt = async (agent) => {
        await agent.text("ok")
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
      }
      const parsed = await readSse(await kit.request(baseBody({ model: requested, tools: [], messages: [{ role: "user", content: `hi ${requested}` }] })))
      assert.equal(parsed.error, null, JSON.stringify(parsed.error))
      assert.deepEqual([...kit.setModels], [agyModel], `${requested} 实际选到 ${kit.setModels}`)
      assert.equal(parsed.model, echoed)
      assert.ok(!kit.setModels.some((item) => /\[1m\]/i.test(item)))
    })
  }
})

test("后台刷新抛异常不产生 unhandledRejection，模块定时器随结果一起清掉", async () => {
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on("unhandledRejection", onRejection)
  try {
    for (const behavior of [{ brokenChild: true }, { throwSync: true }, { error: true }, { code: 2 }]) {
      await withKit({ modelsBehavior: behavior }, async (kit) => {
        const models = await kit.models()
        assertFallbackPresent(models)
        await settle(kit)
        await sleep(20)
        assert.equal(kit.timers.refed().length, 0, `${JSON.stringify(behavior)} 残留定时器`)
      })
    }
    await sleep(50)
    assert.deepEqual(rejections.map(String), [])
  } finally {
    process.off("unhandledRejection", onRejection)
  }
})

test("慢刷新与失败刷新都不会挂住 Node 退出（独立子进程实测）", () => {
  // 探针不调用 dispose：只靠事件循环自然排空退出；临时目录在 exit 钩子里同步清掉。
  const probe = `
    import fs from "node:fs"
    const tk = await import(${JSON.stringify(new URL("./testkit.mjs", import.meta.url).href)})
    process.on("unhandledRejection", (reason) => { console.error("UNHANDLED", reason); process.exitCode = 3 })
    const slow = await tk.createBridgeKit({ modelsBehavior: { stdout: tk.modelsOutput(tk.BASE_MODEL_ROWS), delayMs: 900 } })
    const failing = await tk.createBridgeKit({ modelsBehavior: { error: true } })
    process.on("exit", () => { for (const kit of [slow, failing]) fs.rmSync(kit.tmp, { recursive: true, force: true }) })
    const started = performance.now()
    const a = await slow.models()
    const b = await failing.models()
    const elapsed = performance.now() - started
    console.log(JSON.stringify({ elapsed, a: Object.keys(a).length, b: Object.keys(b).length }))
  `
  const started = Date.now()
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", probe], {
    encoding: "utf8",
    timeout: 20_000,
  })
  const wall = Date.now() - started
  assert.equal(result.error, undefined, String(result.error))
  assert.equal(result.status, 0, `探针退出码 ${result.status}\nstdout:${result.stdout}\nstderr:${result.stderr}`)
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1))
  assert.ok(report.elapsed < 2 * FAST_BUDGET_MS, `两次 models() 共耗时 ${Math.round(report.elapsed)}ms`)
  assert.ok(report.a > 0 && report.b > 0)
  assert.ok(wall < 8_000, `子进程 ${wall}ms 才退出，疑似被定时器挂住`)
})
