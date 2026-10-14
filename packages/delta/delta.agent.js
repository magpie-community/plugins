// Delta (delta.dev by Zed Industries) as a magpie coding agent.
// Settings are stored in settings.json:
// - Windows: %APPDATA%/delta/settings.json
// - macOS / Linux: ~/.config/delta/settings.json
//
// Delta's settings root struct is StoredSettings with 3 fields: version, portable, native.
// Custom providers belong in: native.custom_providers
// Worker model belongs in: portable.profiles.worker.model
// Skills, AGENTS instructions, and MCP belong in: ~/.agents

/**
 * Determine Delta's settings.json path based on platform.
 *
 * MoeJS (Magpie's embedded JS engine for agent plugins) runs without a Node.js `process` global.
 * It populates `new Error().stack` with the absolute filesystem path of the executing script file during import.
 * On Windows, this path contains backslashes ('\') or drive letters (':\'), whereas on macOS/Linux it uses forward slashes.
 * We inspect the stack trace to detect Windows vs. POSIX platforms.
 *
 * @param {string} [stackOverride] - Optional stack string for unit testing.
 * @returns {string} Path template for Magpie expansion.
 */
export function getDeltaConfigPath(stackOverride) {
  const stack = typeof stackOverride === "string" ? stackOverride : (new Error().stack || "");
  const isWindows =
    (typeof process !== "undefined" && process.platform === "win32") ||
    stack.includes("\\") ||
    stack.includes(":\\") ||
    stack.includes(":/") ||
    /^[a-zA-Z]:/.test(stack);

  return isWindows
    ? "~/AppData/Roaming/delta/settings.json"
    : "~/.config/delta/settings.json";
}

export const agent = {
  id: "delta",
  name: "Delta",
  bin: "delta",
  config: getDeltaConfigPath(),
  format: "json",
  model: "portable.profiles.worker.model",
  ua: ["delta", "zed"],
  notice: "Restart Delta if the model picker does not update immediately.",
  icon: "https://delta.dev/favicon.svg",
  library: {
    instructions: "~/.agents/AGENTS.md",
    mcp: "~/.agents/mcp.json",
    mcpFormat: "zed",
    skills: "~/.agents/skills",
  },
};

/**
 * Configure Delta to connect to magpie's local gateway.
 * @param {Object} context
 * @param {Object} context.gateway - { url, v1, key }
 * @param {Object} context.model - { id, name, context, output, efforts }
 * @param {Array} [context.models] - list of all active models in magpie
 */
export function connect({ gateway, model, models }) {
  let deltaModels = (models || []).map((m) => ({
    id: m.id,
    context_window: m.context || 128000,
    max_output_tokens: m.output || 16384,
    reasoning_efforts: Array.isArray(m.efforts) ? m.efforts : [],
    parallel_tool_calls: true,
    interleaved_reasoning: false,
  }));

  if (deltaModels.length === 0 && model?.id) {
    deltaModels = [
      {
        id: model.id,
        context_window: model.context || 128000,
        max_output_tokens: model.output || 16384,
        reasoning_efforts: Array.isArray(model.efforts) ? model.efforts : [],
        parallel_tool_calls: true,
        interleaved_reasoning: false,
      },
    ];
  }

  const targetModelId = model?.id || deltaModels[0]?.id || "";

  const headers = [];
  if (gateway?.key) {
    headers.push({
      name: "Authorization",
      value: `Bearer ${gateway.key}`,
    });
  }

  const magpieProvider = {
    name: "Magpie",
    base_url: gateway?.v1 || "http://127.0.0.1:3425/v1",
    api_mode: "open_ai_chat_completions",
    headers,
    models: deltaModels,
  };

  return {
    "native.custom_providers": [magpieProvider],
    "portable.profiles.worker.model": targetModelId,
  };
}
