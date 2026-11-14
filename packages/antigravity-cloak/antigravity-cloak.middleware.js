// Antigravity answers a request whose system prompt reads as Claude Code's
// or the Claude Agent SDK's with a 429 "Resource has been exhausted", which
// isn't about the account's quota at all. Tried with a real account, it
// matches these lines in the system prompt:
//
//   "x-anthropic-billing-header: …"   Claude Code's billing line
//   "built on Anthropic's Claude Agent SDK"   the Agent SDK's identity line
//                    (Claude Desktop's Code tab and its subagents)
//   "You are Codex, an agent based on GPT-5"         Codex's own prompt
//   "You are Codex, a coding agent based on GPT-5"   for its GPT-5 models
//   "Hermes Agent, an intelligent AI assistant created by Nous Research"
//                    Hermes Agent's earlier default persona (its SOUL.md)
//   "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL."
//                    the first line of oh-my-pi (omp)'s system prompt
//
// (a Codex thread begun on a GPT model keeps its prompt after /model or a
// fork onto an Antigravity one)
//
// Since 11-14 Codex's two lines are turned away in a user's turn too (a
// pasted AGENTS.md, a developer message told after a reply), so they go
// reworded there as well; the other lines, tool results and the model's
// turns go as written.
//
// Up to 0.1.6 this middleware put zero-width spaces (U+200B) inside them.
// Since 11-14 Google's check reads past invisible characters: two U+200B in
// each word, one after every character, or U+2060 instead, each line was
// turned away 5 of 5 on a real account (hc295971796 on X, Claude Desktop's
// Code tab). Each line now goes reworded with the same meaning (saidAs),
// which went through 5 of 5, and only in what Antigravity alone is sent
// (onProvider, ctx.provider.account): every other provider, a Claude
// subscription above all, gets the prompt as the agent wrote it.
//
//   {"saidAs": {}, "extraWords": [], "accounts": ["antigravity"], "off": false}
//
// saidAs maps more phrases to what goes instead, should Google match others.
// extraWords are phrases still broken up with zero-width spaces, as before;
// Google reads past that now, so prefer saidAs. accounts are the
// subscriptions' kinds it acts on.
//
// After hexiaolv's magpie-antigravity-cloak (MIT), which does the same to
// every request whatever provider it goes to.

export const lines = ["x-anthropic-billing-header:", "built on Anthropic's Claude Agent SDK", "You are Codex, an agent based on GPT-5", "You are Codex, a coding agent based on GPT-5", "Hermes Agent, an intelligent AI assistant created by Nous Research", "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL."]

// saidAs is how each line goes, given the line as it was matched with its
// invisible characters taken out and its white space kept: Claude Code's
// billing line not at all (no Antigravity model reads it), the Agent SDK's
// as "built on the Claude Agent SDK by Anthropic", Codex's as "built on
// GPT-5", Hermes' as "built by Nous Research" (as its current persona says
// it), omp's with RFC 2119's own "key words".
const saidAs = [
  () => "",
  (m) => m.replace(/^(built\s+on\s+)anthropic's(\s+)(claude\s+agent\s+sdk)$/i, "$1the$2$3 by Anthropic"),
  (m) => m.replace(/based(\s+)on/i, "built$1on"),
  (m) => m.replace(/based(\s+)on/i, "built$1on"),
  (m) => m.replace(/created(\s+)by/i, "built$1by"),
  (m) => m.replace(/(key)(words)/i, "$1 $2"),
]

const zwsp = "​"

// invisible are the characters Google's check reads past. A line is matched
// with them anywhere inside it, so a copy an older version of this
// middleware or of magpie broke up is reworded as the line.
const invisible = "[\\u00ad\\u180e\\u200b-\\u200f\\u2060-\\u2064\\ufeff]"
const invisibleRe = new RegExp(invisible, "g")
const escape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// lineRe matches a line in any case, with any run of white space where it
// has a space: Google's check read omp's line wrapped after "REQUIRED," or
// with a tab or a no-break space for a space as it read the line itself (a
// real account, 11-14). The billing line is matched to its end.
function lineRe(line, toEnd) {
  const words = line.split(" ").map((w) => [...w].map(escape).join(`${invisible}*`))
  return new RegExp(words.join(`${invisible}*\\s+${invisible}*`) + (toEnd ? "[^\\n]*\\n?" : ""), "gi")
}

export function onProvider(body, ctx) {
  const o = ctx.options || {}
  if (o.off) return
  const accounts = Array.isArray(o.accounts) && o.accounts.length ? o.accounts : ["antigravity"]
  if (!accounts.includes(ctx.provider?.account)) return
  const cloak = cloaker(o)
  const cloakUser = cloaker({}, userLines)
  let changed = false
  const by = (f) => (s) => {
    if (typeof s !== "string") return s
    const t = f(s)
    if (t !== s) changed = true
    return t
  }
  const text = by(cloak)
  const said = by(cloakUser)
  switch (ctx.protocol) {
    case "anthropic":
      body.system = typeof body.system === "string" ? text(body.system) : parts(body.system, text)
      for (const m of Array.isArray(body.messages) ? body.messages : []) user(m, said)
      break
    case "chat":
      if (Array.isArray(body.messages)) body.messages = body.messages.filter((m) => system(m, text))
      for (const m of Array.isArray(body.messages) ? body.messages : []) user(m, said)
      break
    case "responses":
      body.instructions = text(body.instructions)
      if (typeof body.input === "string") body.input = said(body.input)
      if (Array.isArray(body.input)) body.input = body.input.filter((m) => system(m, text))
      for (const m of Array.isArray(body.input) ? body.input : []) user(m, said)
      break
    case "gemini":
      for (const k of ["systemInstruction", "system_instruction"]) if (body[k]) body[k].parts = parts(body[k].parts, text)
      for (const c of Array.isArray(body.contents) ? body.contents : []) if (c && c.role !== "model") user({ role: "user", content: c.parts }, said)
      break
  }
  return changed ? body : undefined
}

// system rewrites a system or developer message's text, a string or parts,
// and says whether the message stays: one that had text and has none left
// (Claude Code's billing line sent as a message of its own) is left out.
function system(m, text) {
  if (!m || (m.role !== "system" && m.role !== "developer")) return true
  const had = typeof m.content === "string" ? m.content !== "" : Array.isArray(m.content) && m.content.length > 0
  m.content = typeof m.content === "string" ? text(m.content) : parts(m.content, text)
  return !had || (typeof m.content === "string" ? m.content !== "" : !Array.isArray(m.content) || m.content.length > 0)
}

// user rewrites the text a user's message says itself, a string or text
// parts, in place: since 11-14 Antigravity also answers a bare 429 to
// Codex's GPT-5 line in a user's turn (a pasted AGENTS.md, a developer
// message magpie tells after a reply), 3 of 3 on a real account, and lets
// it through reworded (userLines). The other lines went through there as
// written, 3 of 3 each, and tool results and the model's turns went through
// with every line, so they stay.
function user(m, text) {
  if (!m || m.role !== "user") return
  if (typeof m.content === "string") {
    m.content = text(m.content)
    return
  }
  for (const p of Array.isArray(m.content) ? m.content : []) {
    if (!p || typeof p.text !== "string" || p.thought) continue
    if (p.type !== undefined && p.type !== "text" && p.type !== "input_text") continue
    p.text = text(p.text)
  }
}

// parts rewrites each part's text, and leaves out a part that had text and
// has none left: Claude Code's billing line is a block of its own.
function parts(list, text) {
  if (!Array.isArray(list)) return list
  const out = []
  for (const p of list) {
    if (p && typeof p.text === "string" && p.text !== "") {
      p.text = text(p.text)
      if (p.text === "") continue
    }
    out.push(p)
  }
  return out
}

// userLines are the lines, by their index in lines, Antigravity also turns
// away in a user's turn: Codex's GPT-5 lines.
const userLines = [2, 3]

// cloaker rewords every line where it appears, or only those of only, then
// each of saidAs' and extraWords' phrases.
function cloaker(o, only) {
  const rules = lines.map((l, i) => [lineRe(l, i === 0), saidAs[i], i]).filter(([, , i]) => !only || only.includes(i)).map(([re, as]) => [re, as])
  if (o.saidAs && typeof o.saidAs === "object") {
    for (const [from, to] of Object.entries(o.saidAs)) if (from.length > 1 && typeof to === "string") rules.push([lineRe(from, false), () => to])
  }
  const two = (m) => m.replace(/[A-Za-z0-9]{3,}/g, (w) => w[0] + zwsp + w[1] + zwsp + w.slice(2))
  for (const w of Array.isArray(o.extraWords) ? o.extraWords : []) if (typeof w === "string" && w.length > 1) rules.push([lineRe(w, false), two])
  return (s) => {
    for (const [re, as] of rules) s = s.replace(re, (m) => as(m.replace(invisibleRe, "")))
    return s
  }
}
