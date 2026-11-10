// Tool-declaration measurement, shared by the hook and the tests.

// The size of a tool declaration, per protocol. magpie speaks four shapes
// to four families of models, and the tools live in a different place in
// each:
//
//   anthropic (/v1/messages):     tools: [{ name, description, input_schema }]
//   chat (/v1/chat/completions):   tools: [{ type, function: {...} }]
//   responses (/v1/responses):     tools: [{ type, name, parameters }]
//   gemini (…/streamGenerateContent): tools: [{ functionDeclarations: [...] }]
//
// The numbers that matter for a cost comparison are the count and the
// bytes: the bytes are what the model reads again on every turn.
export function measureTools(body) {
  const out = { count: 0, bytes: 0, names: [] }
  if (!body || typeof body !== "object") return out

  const tools = Array.isArray(body.tools) ? body.tools : null
  if (!tools) return out

  for (const t of tools) {
    if (!t || typeof t !== "object") continue
    // A namespace's tools are its own tools (OpenAI responses).
    if (Array.isArray(t.tools)) {
      const inner = measureTools({ tools: t.tools })
      out.count += inner.count
      out.bytes += inner.bytes
      out.names.push(...inner.names)
      continue
    }
    // Gemini puts them one level deeper, under functionDeclarations.
    if (Array.isArray(t.functionDeclarations)) {
      for (const fd of t.functionDeclarations) {
        out.count++
        out.bytes += sizeOf(fd)
        if (fd && typeof fd.name === "string") out.names.push(fd.name)
      }
      continue
    }
    // OpenAI chat wraps them in a function object.
    if (t.function && typeof t.function === "object") {
      out.count++
      out.bytes += sizeOf(t.function)
      if (typeof t.function.name === "string") out.names.push(t.function.name)
      continue
    }
    // Anthropic and OpenAI responses keep them flat.
    out.count++
    out.bytes += sizeOf(t)
    if (typeof t.name === "string") out.names.push(t.name)
  }
  return out
}

// The size of one declaration, in bytes of JSON. This is a proxy for the
// tokens the model reads, not a token count: JSON is not BPE, and no
// tokenizer is exact for every provider. It is the same measure for every
// agent, which is what a comparison needs.
export function sizeOf(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
  } catch {
    return 0
  }
}

