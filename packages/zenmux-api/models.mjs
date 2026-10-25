export const SDK = { chat: "@ai-sdk/openai-compatible", responses: "@ai-sdk/openai", anthropic: "@ai-sdk/anthropic" };
const modalities = (values = ["text"]) => Object.fromEntries(values.map((x) => [x, true]));

export function models(catalog, bases) {
  if (!catalog?.models || typeof catalog.models !== "object" || Array.isArray(catalog.models))
    throw new Error("ZenMux is missing from the model catalog");
  const out = {};
  for (const [id, m] of Object.entries(catalog.models)) {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("ZenMux returned invalid model metadata");
    if (!id || id === "__proto__" || m.status === "deprecated") continue;
    if (m.modalities?.output && !m.modalities.output.includes("text")) continue;
    const npm = m.provider?.npm ?? catalog.npm ?? SDK.chat;
    const protocol = Object.keys(SDK).find((p) => SDK[p] === npm);
    if (!protocol) continue;
    // The catalog chooses the protocol, never a new destination for a key.
    out[id] = {
      id, providerID: "zenmux-api", name: m.name ?? id,
      api: { id, npm, url: bases[protocol] },
      limit: { context: 0, output: 0, ...m.limit },
      capabilities: {
        temperature: m.temperature ?? true, reasoning: m.reasoning ?? false,
        attachment: m.attachment ?? false, toolcall: m.tool_call ?? true,
        input: modalities(m.modalities?.input), output: modalities(m.modalities?.output),
        interleaved: m.interleaved ?? false,
      },
      cost: { ...m.cost, cache: { read: m.cost?.cache_read ?? 0, write: m.cost?.cache_write ?? 0 } },
      variants: Object.fromEntries((m.reasoning_options ?? []).filter((x) => x.type === "effort").flatMap((x) => x.values ?? []).map((x) => [x, { reasoningEffort: x }])),
      options: {}, headers: {}, status: "active", release_date: m.release_date ?? "",
    };
  }
  return out;
}

export function configModels(known) {
  return Object.fromEntries(Object.entries(known).map(([id, m]) => [id, {
    name: m.name, provider: { npm: m.api.npm, api: m.api.url }, limit: m.limit,
    reasoning: m.capabilities.reasoning, tool_call: m.capabilities.toolcall,
    attachment: m.capabilities.attachment,
    cost: { ...m.cost, cache_read: m.cost.cache.read, cache_write: m.cost.cache.write },
    variants: m.variants,
    modalities: { input: Object.keys(m.capabilities.input), output: Object.keys(m.capabilities.output) },
  }]));
}
