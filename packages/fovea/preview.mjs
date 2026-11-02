// What fovea would do to a request, without sending it anywhere.
//
//   bun packages/fovea/preview.mjs --demo
//   bun packages/fovea/preview.mjs path/to/request.json
//   bun packages/fovea/preview.mjs path/to/request.json '{"keep_recent":4}'
//
// Prints, per message, what is kept and what is cut, then the totals. The
// body is never sent; the numbers are estimates from the same sizeOf() the
// middleware uses, so they match what the gateway decides.

import { readFileSync } from "node:fs"
import * as mod from "./fovea.middleware.js"

function size(v) {
  if (v === null || v === undefined) return 0
  if (typeof v === "string") return v.length
  if (typeof v !== "object") return 8
  let n = 8
  if (Array.isArray(v)) return v.reduce((a, x) => a + size(x), n)
  for (const k of Object.keys(v)) n += k.length + 2 + size(v[k])
  return n
}
const tok = (chars) => Math.round(chars / 4).toLocaleString("en-US")
const fmt = (n) => n.toLocaleString("en-US")

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith("{") && !a.startsWith("-"))
const options = argv.find((a) => a.startsWith("{")) ? JSON.parse(argv.find((a) => a.startsWith("{"))) : {}
const body = file ? JSON.parse(readFileSync(file, "utf8")) : demo()

const list = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
const before = list.map((m) => size(m))
const beforeTotal = size(body)

const out = mod.onRequest(body, { options })
const afterList = out ? (Array.isArray(out.messages) ? out.messages : out.input) : list
const afterTotal = out ? size(out) : beforeTotal

const rows = afterList.map((m, i) => ({
  i,
  role: m.role || m.type || "?",
  before: before[i] ?? 0,
  after: size(m),
}))
const cut = rows.filter((r) => r.after !== r.before)
const mark = (s) => (String(s).match(/\[fovea: [^\]]+\]/) || ["", ""])[0]

console.log(`请求：${list.length} 条消息，${fmt(beforeTotal)} 字符（约 ${tok(beforeTotal)} tokens）`)
console.log(`中间件：${out ? "改写" : "原样放行"}，选项 ${JSON.stringify(options) || "默认"}`)
if (cut.length) {
  console.log("\n被处理的旧消息：")
  for (const r of cut) {
    console.log(`  #${String(r.i).padStart(3)} ${String(r.role).padEnd(10)} ${fmt(r.before).padStart(9)} → ${fmt(r.after).padStart(9)}  ${mark(JSON.stringify(afterList[r.i])).slice(0, 60)}`)
  }
} else {
  console.log("\n没有消息被改动（在阈值内，或全在最近窗口里）。")
}
const saved = beforeTotal - afterTotal
console.log(`\n合计：${fmt(beforeTotal)} → ${fmt(afterTotal)} 字符（约 ${tok(beforeTotal)} → ${tok(afterTotal)} tokens，省 ${saved > 0 ? ((saved / beforeTotal) * 100).toFixed(1) : "0.0"}%）`)

// A history shaped like a coding agent's: a task, 150 tool round-trips with
// file-sized outputs, then the turn being sent.
function demo() {
  const filler = ("An agent reads a log line, notes the timestamp, checks the retry count, " +
    "compares it with the previous entry and moves on. ").repeat(40)
  const msgs = [
    { role: "system", content: "You are a coding agent. Be brief." },
    { role: "user", content: "Audit the gateway logs from last night and summarize each incident." },
  ]
  for (let i = 0; i < 150; i++) {
    msgs.push({ role: "assistant", content: `checking batch ${i}`, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_logs", arguments: `{"batch":${i}}` } }] })
    msgs.push({ role: "tool", tool_call_id: `call_${i}`, content: filler })
  }
  msgs.push({ role: "assistant", content: "done reading, 150 batches checked" })
  msgs.push({ role: "user", content: "Now summarize the incidents in one line." })
  return { model: "demo", messages: msgs, max_tokens: 100 }
}
