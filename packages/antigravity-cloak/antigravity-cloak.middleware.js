// Antigravity answers a request whose system prompt reads as Claude Code's
// or the Claude Agent SDK's with a 429 "Resource has been exhausted", which
// isn't about the account's quota at all. Tried with a real account, it
// matches these words in the system prompt:
//
//   "x-anthropic-billing-header:"   Claude Code's billing line
//   "You are a Claude agent, built on Anthropic's Claude Agent SDK"
//   "You are Codex, an agent based on GPT-5"         Codex's own prompt
//   "You are Codex, a coding agent based on GPT-5"   for its GPT-5 models
//   "Hermes Agent, an intelligent AI assistant created by Nous Research"
//                    Hermes Agent's earlier default persona (its SOUL.md)
//
// (a Codex thread begun on a GPT model keeps its prompt after /model or a
// fork onto an Antigravity one)
// and lets the same prompt through with a zero-width space (U+200B) inside
// each. This middleware puts one after the first letter of each word in
// what Antigravity alone is sent (onProvider, ctx.provider.account): every
// other provider, a Claude subscription above all, gets the prompt as the
// agent wrote it. The model reads the words as before.
//
//   {"extraWords": [], "accounts": ["antigravity"], "off": false}
//
// extraWords are more words to break the same way, should Google match
// others; accounts are the subscriptions' kinds it acts on.
//
// After hexiaolv's magpie-antigravity-cloak (MIT), which does the same to
// every request whatever provider it goes to.

export const words = ["x-anthropic-billing-header", "Claude Agent SDK", "You are Codex, an agent based on GPT-5", "You are Codex, a coding agent based on GPT-5", "Hermes Agent, an intelligent AI assistant created by Nous Research"]

const zwsp = "​"

export function onProvider(body, ctx) {
  const o = ctx.options || {}
  if (o.off) return
  const accounts = Array.isArray(o.accounts) && o.accounts.length ? o.accounts : ["antigravity"]
  if (!accounts.includes(ctx.provider?.account)) return
  const list = words.concat(Array.isArray(o.extraWords) ? o.extraWords.filter((w) => typeof w === "string" && w.length > 1) : [])
  const cloak = cloaker(list)
  let changed = false
  const text = (s) => {
    if (typeof s !== "string") return s
    const t = cloak(s)
    if (t !== s) changed = true
    return t
  }
  switch (ctx.protocol) {
    case "anthropic":
      body.system = typeof body.system === "string" ? text(body.system) : parts(body.system, text)
      break
    case "chat":
      if (Array.isArray(body.messages)) for (const m of body.messages) system(m, text)
      break
    case "responses":
      body.instructions = text(body.instructions)
      if (Array.isArray(body.input)) for (const m of body.input) system(m, text)
      break
    case "gemini":
      for (const k of ["systemInstruction", "system_instruction"]) if (body[k]) parts(body[k].parts, text)
      break
  }
  return changed ? body : undefined
}

// a system or developer message's text, a string or parts
function system(m, text) {
  if (!m || (m.role !== "system" && m.role !== "developer")) return
  m.content = typeof m.content === "string" ? text(m.content) : parts(m.content, text)
}

function parts(list, text) {
  if (Array.isArray(list)) for (const p of list) if (p && typeof p.text === "string") p.text = text(p.text)
  return list
}

// cloaker breaks every word of list where it appears, whatever its case
function cloaker(list) {
  const res = list.map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))
  return (s) => {
    for (const re of res) s = s.replace(re, (m) => m[0] + zwsp + m.slice(1))
    return s
  }
}
