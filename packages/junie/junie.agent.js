// Keep the gateway and Magpie's selection outside Junie's model discovery.
// The seed script writes ordinary model profiles and the launch selector.
export const agent = {
  id: "junie",
  name: "Junie CLI",
  icon: "https://junie.jetbrains.com/favicons/favicon.svg",
  bin: "junie",
  dir: "~/.junie",
  config: "~/.junie/magpie/connection.json",
  format: "json",
  model: "id",
  ua: ["junie"],
  notice: "Re-run the package's seed.mjs after changing the model in Magpie or its catalog, then restart Junie. Native ECO is unavailable for custom profiles in Junie 3893.6.",
  library: {
    instructions: "~/.junie/AGENTS.md",
    mcp: "~/.junie/mcp/mcp.json",
    mcpFormat: "claude",
    skills: "~/.junie/skills",
  },
}

export function connect({ gateway }) {
  return {
    baseUrl: gateway.v1.replace(/\/$/, "") + "/chat/completions",
    apiType: "OpenAICompletion",
    apiKey: gateway.key,
  }
}
