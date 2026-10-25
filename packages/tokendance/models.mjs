export const SDK = { chat: "@ai-sdk/openai-compatible", responses: "@ai-sdk/openai", anthropic: "@ai-sdk/anthropic" };
const protocols = { "openai:chat-completions": "chat", "openai:responses": "responses", "anthropic:messages": "anthropic" };

export function models(catalog, baseURL, preferred = "auto") {
  if (!Array.isArray(catalog?.data)) throw new Error("TokenDance returned no model list");
  const out = {};
  for (const m of catalog.data) {
    if (typeof m?.id !== "string" || !m.id) throw new Error("TokenDance returned an invalid model id");
    if (m.id === "__proto__") continue;
    if (!Array.isArray(m.supported_protocols) || !m.supported_protocols.every((p) => typeof p === "string"))
      throw new Error("TokenDance omitted or malformed supported_protocols");
    const supported = m.supported_protocols.map((p) => p.trim().toLowerCase())
      .map((p) => Object.hasOwn(protocols, p) ? protocols[p] : undefined).filter(Boolean);
    const protocol = supported.includes(preferred) ? preferred : supported[0];
    // Image, video, embedding and other non-chat APIs are not chat models.
    if (!protocol) continue;
    out[m.id] = {
      id: m.id, providerID: "tokendance", name: m.name ?? m.id,
      api: { id: m.id, url: baseURL, npm: SDK[protocol] },
      limit: { context: Number(m.context_length) || 0, output: 0 },
      capabilities: { temperature: true, toolcall: true, input: { text: true }, output: { text: true } },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      options: {}, headers: {}, variants: {}, status: "active", release_date: "",
    };
  }
  return out;
}

export function configModels(known) {
  return Object.fromEntries(Object.entries(known).map(([id, m]) => [id, {
    name: m.name, provider: { npm: m.api.npm, api: m.api.url }, limit: m.limit, tool_call: true,
  }]));
}
