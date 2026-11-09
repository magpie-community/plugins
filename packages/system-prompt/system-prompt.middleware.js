// New API's 系统提示词 (a channel's system_prompt, with its "override"
// switch) as magpie gateway middleware, in each agent API's own place for
// it: Anthropic's system, Chat's first system or developer message,
// Responses' instructions, Gemini's systemInstruction.
//
//   {"system_prompt": "Answer in English.", "override": false,
//    "position": "append", "agents": [], "models": []}
//
// A request with no system prompt is given this one. One that has its own
// keeps it as it is, unless override is true: then this one is added
// before it ("prepend", New API's way) or after it ("append", the
// default, which keeps a prompt cache on the agent's own prompt). agents
// and models, when given, are the only agents and models it applies to.
//
// A model in models is a prefix of the model's name: of the whole id
// magpie gives it ("google/gemini-3.8-flash"), or of the part after any of
// its provider segments ("gemini-3.8-flash" of it, or of
// "openrouter/google/gemini-3.8-flash"), case aside. An agent wired to
// magpie names its model magpie's way, provider first, so a bare model
// name never matched the whole id (@liucl on X, 11-09). A routing group's
// request names the group ("group/…") until it is routed: the model a
// member is asked is known only on each try (onProvider, ctx.provider), so
// a request onRequest didn't match is matched again there, and only the
// tries on a model in models get the prompt.

export function onRequest(body, ctx) {
  const o = ctx.options || {}
  if (!wanted(o, ctx)) return
  const models = modelsOf(o)
  if (models && !matches(String(body.model ?? ctx.model ?? ""), models)) return
  if (ctx.state) ctx.state.given = true
  return give(body, ctx, o)
}

// onProvider gives the prompt to a try on a model in models, when the
// request's own model wasn't one (a group's). Each try starts from the body
// onRequest left, so a member not in models is sent none.
export function onProvider(body, ctx) {
  const o = ctx.options || {}
  const models = modelsOf(o)
  if (!models || ctx.state?.given || !wanted(o, ctx)) return
  const p = ctx.provider || {}
  const model = String(p.model ?? "")
  if (!model) return
  if (!matches(model, models) && !(p.id && matches(p.id + "/" + model, models))) return
  return give(body, ctx, o)
}

function wanted(o, ctx) {
  if (typeof o.system_prompt !== "string" || !o.system_prompt) return false
  return !(Array.isArray(o.agents) && o.agents.length && !o.agents.includes(ctx.agent))
}

// modelsOf is the prefixes in models, lowercase; null when it names none
// (one naming only what isn't a prefix matches nothing)
function modelsOf(o) {
  if (!Array.isArray(o.models) || !o.models.length) return null
  return o.models.filter((m) => typeof m === "string").map((m) => m.toLowerCase())
}

// matches: a prefix begins the whole id or the part after one of its "/"
function matches(id, prefixes) {
  const s = id.toLowerCase()
  const starts = [0]
  for (let i = s.indexOf("/"); i >= 0; i = s.indexOf("/", i + 1)) starts.push(i + 1)
  return prefixes.some((m) => starts.some((at) => s.startsWith(m, at)))
}

function give(body, ctx, o) {
  const prompt = o.system_prompt
  const before = o.position === "prepend"
  const over = !!o.override
  switch (ctx.protocol) {
    case "anthropic":
      return anthropic(body, prompt, over, before)
    case "chat":
      return chat(body, prompt, over, before)
    case "responses":
      return responses(body, prompt, over, before)
    case "gemini":
      return gemini(body, prompt, over, before)
  }
}

function anthropic(body, prompt, over, before) {
  const s = body.system
  if (s === undefined || s === null || s === "" || (Array.isArray(s) && !s.length)) {
    body.system = prompt
    return body
  }
  if (!over) return
  if (typeof s === "string") body.system = before ? prompt + "\n" + s : s + "\n" + prompt
  else if (Array.isArray(s)) {
    const block = { type: "text", text: prompt }
    if (before) s.unshift(block)
    else s.push(block)
  } else return
  return body
}

function chat(body, prompt, over, before) {
  if (!Array.isArray(body.messages)) return
  const first = body.messages[0]
  if (!first || (first.role !== "system" && first.role !== "developer")) {
    body.messages.unshift({ role: "system", content: prompt })
    return body
  }
  if (!over) return
  if (typeof first.content === "string") first.content = before ? prompt + "\n" + first.content : first.content + "\n" + prompt
  else if (Array.isArray(first.content)) {
    const part = { type: "text", text: prompt }
    if (before) first.content.unshift(part)
    else first.content.push(part)
  } else return
  return body
}

function responses(body, prompt, over, before) {
  const s = body.instructions
  if (typeof s !== "string" || !s) {
    body.instructions = prompt
    return body
  }
  if (!over) return
  body.instructions = before ? prompt + "\n" + s : s + "\n" + prompt
  return body
}

function gemini(body, prompt, over, before) {
  const key = body.system_instruction && !body.systemInstruction ? "system_instruction" : "systemInstruction"
  const s = body[key]
  if (!s || !Array.isArray(s.parts) || !s.parts.length) {
    body[key] = { parts: [{ text: prompt }] }
    return body
  }
  if (!over) return
  if (before) s.parts.unshift({ text: prompt })
  else s.parts.push({ text: prompt })
  return body
}
