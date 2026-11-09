// magpie-agy 模型目录回归（源自 configs 仓 test_agy_bridge_catalog.mjs）：目录刷新不得拖过 Magpie 的 2 秒 provider.models 超时，
// 失败不得冲掉已有动态目录，limit 元数据按家族给出，型号别名与 [1m] 剥除保持可用。
//
// 运行：bun test ./catalog.mjs（或在包目录 bun test）
// 全部经真实仓内 index.mjs 的 plugin.provider.models() / fetch 入口，边界替身见 testkit.mjs。

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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

test("首次 agy models 卡死时 750ms 内返回非空静态目录", async () => {
  await withKit({ modelsBehavior: { hang: true } }, async (kit) => {
    const { value, ms } = await timed(() => kit.models())
    assert.ok(ms < FAST_BUDGET_MS, `首次目录耗时 ${Math.round(ms)}ms，超过 ${FAST_BUDGET_MS}ms`)
    assertFallbackPresent(value)
    assert.equal(kit.modelsSpawns.length, 1)
    assert.equal(kit.timers.refed().length, 0, "agy models 卡死期间不应有挂住 Node 退出的模块定时器")
    await kit.finishChildren()
    assert.equal(kit.timers.refed().length, 0, "子进程结束后不应残留挂住退出的定时器")
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
    assert.equal(kit.acpSpawns.length, 1)
    assert.deepEqual(kit.acpSpawns[0].args.slice(0, 2), ["acp", "--disable-telemetry"])
    assert.ok(kit.acpSpawns[0].args.includes("--gemini-dir"))
    assert.ok(kit.acpSpawns[0].args.includes("--app-data-dir"))
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
