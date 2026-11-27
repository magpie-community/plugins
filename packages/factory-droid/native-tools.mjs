import { connect, failure } from "./acp.mjs"

// Return the native tool's output as soon as it completes. Model-written
// prose is not a search result or a generated image.
export async function invokeBuiltin({ key, signal, name, prompt, matches, setup }) {
  let finish, reject
  const output = new Promise((resolve, fail) => { finish = resolve; reject = fail })
  const calls = new Set()
  const rpc = connect({ key, signal, builtin: name, onUpdate(update) {
    if (update.name !== name) return
    if (update.sessionUpdate === "tool_call" && (!matches || matches(update.rawInput))) calls.add(update.toolCallId)
    if (!calls.has(update.toolCallId)) return
    if (update.status === "completed") finish(update)
    if (update.status === "failed") reject(failure(502, "Droid " + name + " failed."))
  } })
  try {
    await rpc.initialize()
    const session = await rpc.newSession()
    // Prefer the light chat model for selecting a tool when the account offers it.
    const light = session.models?.availableModels?.find(m => m.modelId === "deepseek-v4.1-flash")
    if (light) await rpc.request("session/set_model", { sessionId: session.sessionId, modelId: light.modelId })
    const parts = setup ? await setup(rpc.cwd) : []
    const turn = rpc.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }, ...parts] }, 300_000)
    return await Promise.race([output, turn.then(() => { throw failure(502, "Droid ended without a result from " + name + ".") })])
  } finally { rpc.close() }
}

export async function webSearch({ query, count } = {}, key, signal) {
  const q = typeof query === "string" && query.trim()
  if (!q) throw failure(400, "A search query is required.")
  const update = await invokeBuiltin({ key, signal, name: "WebSearch",
    prompt: "Call WebSearch once with this exact query: " + JSON.stringify(q), matches: input => input?.query === q })
  const text = update.rawOutput?.text ?? update.content?.find(c => c.content?.type === "text")?.content.text ?? ""
  const pages = [], seen = new Set()
  for (const part of text.split(/^\s*---\s*$/m)) {
    const match = /^\*\*(.+?)\*\*\s*\r?\n\s*URL:\s*(https?:\/\/\S+)[^\S\n]*\n?([\s\S]*)/m.exec(part)
    if (!match || seen.has(match[2]) || !URL.canParse(match[2])) continue
    seen.add(match[2])
    pages.push({ title: match[1], url: match[2], text: match[3].replace(/^Found \d+ results?\s*$/gm, "").trim() })
  }
  if (!pages.length && !/\b(?:found 0 results|no (?:web search )?results)\b/i.test(text)) throw failure(502, "Unrecognized WebSearch result.")
  return pages.slice(0, Math.max(1, Math.min(20, Number.isInteger(count) ? count : 10)))
}
