// MeowCode keeps every model as one provider record in
// %APPDATA%\MeowCode\agent\settings.json, with its key encrypted by Windows
// (DPAPI) where no plugin can write it. So magpie writes a file of its own
// beside it, magpie.json, holding one provider per magpie model with the
// gateway key in a header, and MeowCode reads that file as an overlay when
// it starts: magpie's models show up in MeowCode's own model list beside
// the user's providers. Switching the agent off clears the keys magpie
// wrote, and MeowCode ignores the empty file. MeowCode reads the overlay at
// start-up only, so it needs a restart to see a change.
export const agent = {
  id: "meowcode",
  name: "MeowCode",
  icon: "data:image/png;base64,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",
  config: "$APPDATA/MeowCode/agent/magpie.json",
  format: "json",
  model: "providerId",
  prefix: "magpie/",
  dir: "$APPDATA/MeowCode/agent",
  ua: ["meowcode"],
  notice: "Restart MeowCode to see magpie's models.",
}

// The overlay MeowCode reads: magpieKey is the one string key that holds
// the gateway's key, so magpie can tell the file is still its own; each
// provider record id carries magpie's prefix and matches the providerId
// magpie writes, so the model picked on the Agents page is the one
// MeowCode starts on.
export function connect({ gateway, model, models }) {
  const list = models.slice()
  const picked = model && model.id
  if (picked && !list.some((m) => m.id === picked)) {
    // a model picked before the catalog caught up still gets its record
    list.push({ id: picked, name: picked })
  }
  const providers = list.map((m) => {
    const provider = {
      id: `magpie/${m.id}`,
      name: "Magpie",
      baseUrl: gateway.v1,
      model: m.id,
      protocol: "openai-chat-completions",
      authStyle: "none",
      extraHeaders: { Authorization: `Bearer ${gateway.key}` },
      enabled: true,
      inputModalities: m.images ? ["text", "image"] : ["text"],
    }
    if (m.name && m.name !== m.id) provider.displayName = m.name
    if (m.context > 0) provider.contextWindow = m.context
    if (m.output > 0) provider.maxTokens = m.output
    return provider
  })
  return { magpieKey: gateway.key, providers }
}
