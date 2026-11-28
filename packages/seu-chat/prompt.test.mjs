import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parse, heldFrom, flatten } from "./prompt.mjs"
import { Streamer } from "./openai.mjs"

const CASES = JSON.parse(readFileSync(new URL("./testdata/lift-cases.json", import.meta.url), "utf8"))

const call_1 = () => "call_1"
const TOOLS = ["get_weather"]

test("GLM 自己的函数调用写法：ask_question({...}) 且没有 </tool_call> 也读成 tool_calls", () => {
  // 2026-11-27 线上真实输出（glm-5.3-flash，长上下文）：写成了
  // <tool_call>name({...})，而且没写闭合标签，以前整段当文字吐给用户
  const text = '先确认几件事：\n<tool_call>ask_question({"questions":[{"id":"repo","options":[{"label":"magpie-SEUchat"}],"question":"仓库名？","type":"select"}]})'
  const r = parse(text, call_1, ["ask_question"])
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].function.name, "ask_question")
  const args = JSON.parse(r.calls[0].function.arguments)
  assert.equal(args.questions[0].question, "仓库名？")
  assert.equal(args.questions[0].options[0].label, "magpie-SEUchat")
  assert.equal(r.text.trim(), "先确认几件事：")
})

test("函数调用写法：闭合标签在场、参数带嵌套括号与字符串里的括号都对", () => {
  const r = parse('<tool_call>write({"path":"a(b).txt","content":"x } y"})</tool_call>', call_1, ["write"])
  assert.equal(r.calls.length, 1)
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: "a(b).txt", content: "x } y" })
  assert.equal(r.text, "")
})

test("函数调用写法：参数没写完（流被截断）不当成调用，记 unreadable 让流报错重试", () => {
  const text = '<tool_call>write({"path":"a.txt","content":"没写完'
  const r = parse(text, call_1, ["write"])
  assert.equal(r.calls.length, 0)
  assert.equal(r.unreadable.length, 1)
  assert.equal(r.text.trim(), "")
})

test("函数调用写法：名字不像函数（中文/空）不当成调用", () => {
  const r = parse('<tool_call>看({"a":1})</tool_call>', call_1, ["看"])
  assert.equal(r.calls.length, 0)
})

test("裸 JSON 单调用：声明了工具时被读成 tool_calls（ChatSEU 真实形状，8/8 实测）", () => {
  const r = parse('{"name": "get_weather", "arguments": {"city": "北京"}}', call_1, TOOLS)
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].function.name, "get_weather")
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { city: "北京" })
  assert.equal(r.text, "")
})

test("裸 JSON 单调用：没声明工具时留在正文里", () => {
  const raw = '{"name": "get_weather", "arguments": {"city": "北京"}}'
  const r = parse(raw, call_1, null)
  assert.equal(r.calls.length, 0)
  assert.equal(r.text, raw)
})

test("裸 JSON：name 不是声明的工具时不.lift", () => {
  const raw = '{"name": "send_email", "arguments": {"to": "x"}}'
  const r = parse(raw, call_1, TOOLS)
  assert.equal(r.calls.length, 0)
})

test("裸 JSON：没有 arguments 不.lift（避免误伤普通 JSON 回答）", () => {
  const raw = '{"name": "Alice", "score": 5}'
  const r = parse(raw, call_1, TOOLS)
  assert.equal(r.calls.length, 0)
})

test("裸 JSON 扁平参数：声明了工具时，除 name 外的键都是参数（glm 长上下文漂移，2026-11-28 实测）", () => {
  const raw = '{"name": "bash", "command": "ls -la ~/Desktop/ | head -30"}'
  const r = parse(raw, call_1, ["bash", "read"])
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].function.name, "bash")
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { command: "ls -la ~/Desktop/ | head -30" })
  assert.equal(r.text, "")
})

test("裸 JSON 扁平参数：没声明工具时留在正文里", () => {
  const raw = '{"name": "bash", "command": "ls"}'
  const r = parse(raw, call_1, null)
  assert.equal(r.calls.length, 0)
  assert.equal(r.text, raw)
})

test("裸 JSON 扁平参数：name 不是声明的工具时不.lift", () => {
  const raw = '{"name": "Alice", "score": 5}'
  const r = parse(raw, call_1, ["bash", "read"])
  assert.equal(r.calls.length, 0)
})

test("裸 JSON 扁平参数：多个连续调用各成一个 tool_call", () => {
  const raw = '{"name":"bash","command":"a"}\n{"name":"read","path":"x"}'
  const r = parse(raw, call_1, ["bash", "read"])
  assert.deepEqual(r.calls.map((c) => c.function.name), ["bash", "read"])
})

test("裸 JSON 扁平参数：只有 name 没有别的键时不.lift", () => {
  const raw = '{"name": "bash"}'
  const r = parse(raw, call_1, ["bash"])
  assert.equal(r.calls.length, 0)
})

test("heldFrom：声明工具时扣住行首的 {\"name\"；没声明时不扣", () => {
  // 调用 JSON 独占一行时，行首就被扣住（流式时不把 JSON 当正文吐出）
  const raw = '好的。\n{"name": "get_weather", "arg'
  const lineStart = raw.indexOf("\n") + 1
  assert.equal(heldFrom(raw, TOOLS), lineStart)
  // 没声明工具：这个 {\"name\" 只是普通文本，一行都不扣
  assert.equal(heldFrom(raw, null), raw.length)
})

test("heldFrom：句中出现已声明工具名的 JSON 也扣住（2026-11-28 泄漏形状）；普通文本与非工具名不扣", () => {
  // 今天的真机 bug：模型把调用写在中文句子后，旧 heldFrom 不扣 → 半截 JSON 当正文吐出
  const raw = '先确认系统里有没有可用的 Python：{"name":"codemode","arguments":{"code":"x"}}'
  assert.ok(heldFrom(raw, ["codemode"]) <= raw.indexOf("{"), "扣在 JSON 起点或之前")
  // 声明了工具时，句中 {"name" 一律先扣 —— 流式早期读不到 name 的值，
  // 由 finish 的 parse 判断它是不是真调用（名字不匹配会放回正文）。
  const plain = '答案 {"name": "Alice"}'
  assert.ok(heldFrom(plain, TOOLS) <= plain.indexOf("{"))
  // 普通回答没有调用：不扣
  assert.equal(heldFrom("普通回答没有调用", TOOLS), "普通回答没有调用".length)
})

test("流式拼接 == 一次性解析：任意切点都一致（性质测试）", () => {
  // 覆盖四类回复：函数调用语法+闭合标签、函数调用语法无闭合（线上事故
  // 形状）、裸 JSON 调用、纯文本。对每个回复的每个切点模拟一次分片到达，
  // 断言流式拼出的调用与一次性 parse 完全一致。
  const replies = [
    {
      tools: ["ask_question"],
      text: '先确认几件事：\n<tool_call>ask_question({"questions":[{"id":"a","question":"哪个？","type":"select"}]})',
    },
    {
      tools: ["ask_question"],
      text: '先确认几件事：\nask_question({"questions":[{"id":"a","question":"哪个？","type":"select"}]})',
    },
    {
      tools: TOOLS,
      text: '好的。\n{"name": "get_weather", "arguments": {"city": "南京"}}',
    },
    {
      // 2026-11-28 真机原文：扁平参数调用（工具调用被当正文漏给用户）
      tools: ["powershell"],
      text: '{"name":"powershell","command":"[Environment]::GetFolderPath(\'Desktop\'); Test-Path \'C:\\Users\\x\\a.md\'"}',
    },
    {
      // 2026-11-28 真机原文：句中跟 codemode 调用
      tools: ["codemode", "powershell"],
      text: '先确认系统里有没有可用的 Python：{"name":"codemode","arguments":{"code":"const r = await tools.powershell({command: \'x\'})"}}',
    },
    { tools: TOOLS, text: "没有要调用的工具，直接回答。" },
  ]
  for (const { tools, text } of replies) {
    const whole = parse(text, call_1, tools)
    for (let cut = 1; cut < text.length; cut++) {
      const st = new Streamer(tools)
      // 流式下用户看到的是每次 update 吐的 content 加上 finish 的剩余；
      // 断言它与一次性解析的正文完全一致，调用也一样
      let streamed = st.update({ text: text.slice(0, cut) }).content ?? ""
      streamed += st.update({ text }).content ?? ""
      const got = st.finish({ text }, call_1)
      streamed += got.content
      assert.deepEqual(
        got.calls.map((c) => c.function),
        whole.calls.map((c) => c.function),
        `切点 ${cut} 的调用与一次性解析不一致`,
      )
      assert.equal(streamed.replace(/\s+$/, ""), whole.text.replace(/\s+$/, ""), `切点 ${cut} 的正文与一次性解析不一致`)
      // 注：裸 JSON 调用行之前的换行，流式路径已经吐给用户（heldFrom 从
      // 行首的 { 开始扣），一次性 parse 会 trim 掉——尾部可能多一个换行，
      // 是良性的既有差异；调用本身在任何切点都必须完全一致。
    }
  }
})

test("lift-cases 表：每条形状都抬升干净", () => {
  for (const c of CASES) {
    const r = parse(c.text, call_1, c.tools.length ? c.tools : null)
    assert.deepEqual(r.calls.map((x) => [x.function.name, JSON.parse(x.function.arguments)]), c.calls, c.label + " 调用")
    assert.equal(r.text.trim(), c.text_after.trim(), c.label + " 剩余正文")
    assert.equal(r.unreadable.length, c.unreadable ?? 0, c.label + " unreadable 数")
  }
})

test("flatten：孤儿 tool 结果（没有对应调用）照常落成文本，不崩", () => {
  const p = flatten({ messages: [{ role: "user", content: "x" }, { role: "tool", tool_call_id: "nope", content: "42" }] })
  assert.ok(p.includes("[tool result]\n42"))
})

test("flatten：pi 的失败结果把退出码提到标题里，模型一眼看出命令没跑成（2026-11-28 真机 exit 9009）", () => {
  // pi 的 bash 工具在非零退出时把状态行追加在内容末尾；OpenAI tool
  // 消息不带 isError，模型此前只看到裸输出，连试两次同一命令
  const body = {
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"python -c 'print(1)'\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Python was not found; run without arguments to install from the Microsoft Store…\n\nCommand exited with code 9009" },
    ],
    tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
  }
  const p = flatten(body)
  assert.ok(p.includes("[tool result of bash — exit code 9009]\n"), p)
  assert.ok(!p.includes("Command exited with code"), "状态行不重复出现")
})

test("flatten：超时与中止同样进标题；成功的工具结果标题不带状态", () => {
  const mk = (content) => flatten({ messages: [{ role: "user", content: "x" }, { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content }] })
  assert.ok(mk("partial\n\nCommand timed out after 120 seconds").includes("[tool result of bash — timed out after 120 seconds]"))
  // pi 超时句的后半（后台进程仍在写）是解释，留在正文
  const long = mk("partial\n\nCommand timed out after 30 seconds. The shell exited with code 1 after 30 seconds, but background processes it started kept writing output until the timeout.")
  assert.ok(long.includes("[tool result of bash — timed out after 30 seconds]\npartial\nThe shell exited with code 1 after 30 seconds, but background processes it started kept writing output until the timeout."), long)
  assert.ok(mk("partial\n\nCommand aborted").includes("[tool result of bash — aborted]"))
  assert.ok(mk("all good").includes("[tool result of bash]\nall good"))
})

test("flatten：正文里出现同句式不算状态行（只有末尾那一行算）", () => {
  const p = flatten({ messages: [{ role: "user", content: "x" }, { role: "tool", tool_call_id: "c", content: "echo 'Command exited with code 1'\nCommand exited with code 1" }] })
  assert.ok(p.includes("[tool result — exit code 1]\necho 'Command exited with code 1'"), p)
})

test("flatten：tool_choice 指定的工具名也按大小写不敏感匹配", () => {
  const body = { messages: [{ role: "user", content: "x" }], tools: [{ function: { name: "bash", parameters: { type: "object" } } }], tool_choice: { type: "function", function: { name: "Bash" } } }
  assert.ok(flatten(body).includes("You must call the tool bash now."))
})

test("空工具名但有 arguments：有调用意图读不出 → unreadable，不漏成正文（2026-11-28 真机）", () => {
  const text = '{"name": "", "arguments": {"path": "D:/桌面/novel"}}'
  const r = parse(text, call_1, ["bash", "list_dir", "read"])
  assert.equal(r.calls.length, 0)
  assert.equal(r.unreadable.length, 1, "记为 unreadable")
  assert.equal(r.text.trim(), "", "不留在正文")
})

test("空工具名但参数能唯一匹配一个声明工具的 schema → 补上名字抬升", () => {
  // 工具 schemas：只有 list_dir 有 path；bash 有 command
  const tools = [
    { function: { name: "list_dir", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    { function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
  ]
  const text = '{"name": "", "arguments": {"path": "D:/桌面/novel"}}'
  const r = parse(text, call_1, tools)
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].function.name, "list_dir")
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: "D:/桌面/novel" })
})

test("空工具名且参数匹配多个工具 → 不猜，记 unreadable", () => {
  const tools = [
    { function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    { function: { name: "list_dir", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  ]
  const text = '{"name": "", "arguments": {"path": "x"}}'
  const r = parse(text, call_1, tools)
  assert.equal(r.calls.length, 0)
  assert.equal(r.unreadable.length, 1)
})

test("<tool_call> 开了但读不出（无闭合、连开两个）→ 不漏成正文，读得出的抬升（2026-11-28 真机）", () => {
  const text = '<tool_call>ls<tool_call>find(pattern:"**/书童")'
  const r = parse(text, call_1, ["bash", "ls", "find"])
  assert.equal(r.text.trim(), "", "不留在正文")
  // 两块都能读（ls 无参、find JS 风格），所以不记 unreadable；若读不出则必须记
  assert.ok(r.calls.length + r.unreadable.length >= 2, "两个块要么抬升要么记 unreadable")
})

test("<tool_call> 开了但真的读不出（名字不是工具也没参数）→ unreadable，不漏成正文", () => {
  const text = '<tool_call>看不懂这个<tool_call>也不是调用'
  const r = parse(text, call_1, ["bash"])
  assert.equal(r.text.trim(), "")
  assert.equal(r.unreadable.length, 2)
})

test("函数语法里键没加引号（JS 对象风格）也能读成调用", () => {
  // glm 写 find(pattern:"**/书童") 而不是 find({"pattern":"..."})
  const text = '<tool_call>find(pattern:"**/书童")</tool_call>'
  const r = parse(text, call_1, ["find"])
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].function.name, "find")
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { pattern: "**/书童" })
})

test("连开的两个 <tool_call> 块各读各的：无参数的 ls + JS 风格的 find", () => {
  const text = '<tool_call>ls<tool_call>find(pattern:"**/书童")'
  const r = parse(text, call_1, ["ls", "find"])
  assert.deepEqual(r.calls.map((c) => c.function.name), ["ls", "find"])
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), {})
  assert.deepEqual(JSON.parse(r.calls[1].function.arguments), { pattern: "**/书童" })
  assert.equal(r.unreadable.length, 0)
  assert.equal(r.text.trim(), "")
})
