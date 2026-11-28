import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { flatten, parse } from "./prompt.mjs"
import { readSSE } from "./sse.mjs"
import { SeuClient } from "./seu.mjs"
import { eventsToSSE, toolProbeBody } from "./probe.mjs"
import { fakeSeu } from "./testdata/fakeseu.mjs"

test("toolProbeBody 带一个 get_weather 工具", () => {
  const body = toolProbeBody("glm-5.3-flash")
  assert.equal(body.model, "glm-5.3-flash")
  assert.equal(body.tools[0].function.name, "get_weather")
  assert.equal(body.tools[0].type, "function")
  assert.ok(body.messages.some((m) => m.role === "user" && m.content.includes("北京")))
  const prompt = flatten(body)
  assert.match(prompt, /## get_weather/)
  assert.match(prompt, /北京现在天气怎么样/)
})

test("eventsToSSE 还原出能被 readSSE 读回的事件", async () => {
  const text = eventsToSSE([{ event: "", id: "", data: "<思考内容>想</思考内容>用工具<tool_call>{\"name\":\"get_weather\",\"arguments\":{\"city\":\"北京\"}}</tool_call>" }])
  const seen = []
  await readSSE(new Response(text), (ev) => {
    seen.push(ev)
    return true
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].event, "")
  assert.equal(seen[0].data.includes("<tool_call>"), true)
  const result = parse(seen[0].data, () => "call_1")
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].function.name, "get_weather")
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { city: "北京" })
})

// probe 的 CLI 主体（session 存取与 ask 流程）用注入测试：
test("probe 的 ask 走 fakeSeu 能拿到 calls 并写出 tool-<modelId>.sse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seu-probe-"))
  const fake = fakeSeu()
  const client = new SeuClient({ cookies: { SESSION: "abc" }, fetchImpl: fake.fetch })
  const { runToolProbe } = await import("./probe.mjs")
  // 注入一个回工具调用的假 ask（假服务器的流只会回 think.sse 正文）
  const ask = async (prompt, opts = {}) => {
    opts.onEvent?.({ event: "metadata", id: "conv-probe", data: '{"rounds":1}' })
    opts.onEvent?.({ event: "", id: "", data: "<tool_call>{\"name\":\"get_weather\",\"arguments\":{\"city\":\"北京\"}}</tool_call>" })
    return {
      text: "<tool_call>{\"name\":\"get_weather\",\"arguments\":{\"city\":\"北京\"}}</tool_call>",
      reasoning: "",
      conversationId: "conv-probe",
    }
  }
  const out = await runToolProbe(client, { outDir: dir, modelId: "glm-5.3-flash", code: 4, newId: () => "call_1", ask })
  assert.equal(out.calls.length, 1)
  assert.equal(out.calls[0].function.name, "get_weather")
  const file = join(dir, "tool-glm-5.3-flash.sse")
  assert.equal(existsSync(file), true)
  assert.ok(readFileSync(file, "utf8").includes("metadata"))
  rmSync(dir, { recursive: true, force: true })
})
