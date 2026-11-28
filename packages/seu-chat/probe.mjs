// 验证门的手动脚本：不进 magpie，直接用真实 ChatSEU 验证这条链路。
//   node probe.mjs login                       开浏览器窗口登录，登录态存本机
//   node probe.mjs models                      列出模型表和当前登录的用户
//   node probe.mjs chat "<问题>" [modelId]     录一份真实回复到 testdata/real.sse
//   node probe.mjs tool [modelId]              发一个带工具的请求，验证模型是否
//                                              按 <tool_call> 回工具调用
// 用户全程不接触 cookie：login 由插件自己开窗口完成。登录态（含 cookie）
// 只存在本机 testdata/local/session.json，已在 .gitignore 里。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { flatten, parse } from "./prompt.mjs"
import { MODELS, modelsOf, parseCookieHeader, SeuClient } from "./seu.mjs"
import { profileRoot, signIn } from "./browser.mjs"

export const SESSION_FILE = "testdata/local/session.json"

// 验证门的探针请求：一个问题 + 一个 get_weather 工具。模型按理应该回
// <tool_call>{"name":"get_weather","arguments":{"city":"北京"}}</tool_call>。
export function toolProbeBody(modelId) {
  return {
    model: modelId,
    messages: [
      { role: "system", content: "You are a helpful assistant that uses tools." },
      { role: "user", content: "北京现在天气怎么样？请用工具查。" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "查询一个城市的当前天气",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "城市名" } },
            required: ["city"],
          },
        },
      },
    ],
  }
}

// 把 readSSE 收到的事件按原样写回 SSE 文本（event:/id:/data: 行 + 空行），
// 供录制和回放。
export function eventsToSSE(events) {
  let out = ""
  for (const ev of events) {
    if (ev.event) out += `event: ${ev.event}\n`
    if (ev.id) out += `id: ${ev.id}\n`
    for (const line of String(ev.data ?? "").split("\n")) out += `data: ${line}\n`
    out += "\n"
  }
  return out
}

const mask = (s) => (String(s ?? "").length <= 3 ? "***" : String(s).slice(0, 1) + "***" + String(s).slice(-1))

async function clientOf() {
  if (!existsSync(SESSION_FILE)) {
    console.error(`没有登录态，先运行：node probe.mjs login`)
    process.exit(1)
  }
  const session = JSON.parse(readFileSync(SESSION_FILE, "utf8"))
  const client = new SeuClient({ cookies: session.cookies })
  try {
    await client.userInfo({ signal: AbortSignal.timeout(15000) })
  } catch (e) {
    console.error(`登录已失效（${e.code ?? e.message}），重新运行：node probe.mjs login`)
    process.exit(1)
  }
  return { client, session }
}

async function saveSession(cookies, profile, who) {
  mkdirSync(join(SESSION_FILE, ".."), { recursive: true })
  writeFileSync(SESSION_FILE, JSON.stringify({ cookies, profile, who }, null, 1))
}

// runToolProbe 是 tool 命令的主体，测试直接调它。发一个带工具的请求，
// 录下 SSE，按 <tool_call> 协议解析回 calls。
export async function runToolProbe(client, { outDir, modelId, code, newId, signal, ask } = {}) {
  const body = toolProbeBody(modelId)
  const prompt = flatten(body)
  const events = []
  const result = await (ask ?? ((p, opts) => client.ask(p, { ...opts, modelCode: code })))(prompt, { signal, onEvent: (ev) => events.push(ev) })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `tool-${modelId}.sse`), eventsToSSE(events))
  const toolNames = (body.tools ?? []).map((t) => t.function.name).filter(Boolean)
  const calls = parse(result.text, newId, toolNames).calls
  return { text: result.text, reasoning: result.reasoning, calls }
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (!["login", "models", "chat", "tool"].includes(cmd)) {
    console.error("用法：node probe.mjs login | models | chat \"<问题>\" [modelId] | tool [modelId]")
    process.exit(2)
  }
  const options = {}
  try {
    options.models = JSON.parse(readFileSync("package.json", "utf8")).magpie?.options?.models
  } catch {}
  const models = modelsOf(options)

  if (cmd === "login") {
    const profile = join(profileRoot(), "probe")
    const verify = (cookies) => new SeuClient({ cookies }).userInfo({ signal: AbortSignal.timeout(15000) })
    console.log("将打开一个 Chrome/Edge 窗口（插件专用配置，不影响你平时的浏览器）。")
    console.log(`请在其中用学工号完成统一认证：${"https://chatseu.seu.edu.cn/chat"}`)
    const cookies = await signIn(profile, { verify })
    if (!cookies) {
      console.error("没有在窗口里完成东南大学登录，请再试一次。")
      process.exit(1)
    }
    const who = await verify(cookies)
    await saveSession(cookies, profile, { name: who.name, uid: who.uid })
    console.log(`已登录为 ${mask(who.name)}（${mask(who.uid)}）`)
    return
  }

  const { client, session } = await clientOf()

  if (cmd === "models") {
    console.log(`用户：${mask(session.who?.name)}（${mask(session.who?.uid)}）`)
    for (const [id, m] of Object.entries(models)) console.log(`${id}  ${m.name}  code=${m.code}`)
    return
  }

  const modelId = rest.find((r) => models[r]) ?? (cmd === "tool" || cmd === "chat" ? Object.keys(models)[0] : undefined)
  if (!models[modelId]) {
    console.error(`没有模型 ${modelId}。有：${Object.keys(models).join("、")}`)
    process.exit(1)
  }
  const code = models[modelId].code

  if (cmd === "chat") {
    const question = rest.find((r) => r !== modelId) ?? "用一句话介绍东南大学"
    const events = []
    const result = await client.ask(question, { modelCode: code, onEvent: (ev) => events.push(ev) })
    mkdirSync(join("testdata", "real.sse", ".."), { recursive: true })
    writeFileSync("testdata/real.sse", eventsToSSE(events))
    writeFileSync("testdata/userinfo.json", JSON.stringify({ name: mask(session.who?.name), uid: mask(session.who?.uid) }, null, 1))
    console.log(`model=${modelId} code=${code} conversationId=${result.conversationId}`)
    console.log(`reasoning ${result.reasoning.length} 字`)
    console.log("text:", result.text.slice(0, 200))
    return
  }

  if (cmd === "tool") {
    const out = await runToolProbe(client, { outDir: "testdata", modelId, code, newId: () => "call_" + Math.random().toString(36).slice(2, 8) })
    console.log(`model=${modelId} code=${code}`)
    console.log(`reasoning ${out.reasoning.length} 字`)
    if (out.calls.length) {
      console.log("calls:", JSON.stringify(out.calls, null, 1))
    } else {
      console.log("没有解析出工具调用。回复的前 300 字：")
      console.log(out.text.slice(0, 300))
    }
    return
  }

  console.error("用法：node probe.mjs login | models | chat \"<问题>\" [modelId] | tool [modelId]")
  process.exit(2)
}

// 直接运行才走 CLI；被测试 import 时不做任何事
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`${e.code ?? e.name ?? "error"} ${e.status ?? ""}: ${e.message}`)
    process.exit(1)
  })
}
