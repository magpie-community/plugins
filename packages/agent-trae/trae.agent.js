// Trae (ByteDance's AI IDE) as a Magpie agent.
//
// Trae has no model file Magpie can write:
//   * Add Model posts the model to Trae's cloud (api/ide/v1/add_custom_model);
//   * the local state.vscdb only caches what the cloud answered, and its `ak`
//     is encrypted by Trae's native layer;
//   * user settings.json carries no address or model, and Trae ignores VS
//     Code's chatLanguageModels.json.
// This agent selects its models internally: the descriptor omits `model`, so
// the Agents row has a connect switch and the model-list control, not a
// single-model dropdown. The Bun companion (index.mjs + bridge.mjs) prepares
// a preview of the models enabled for the row (the gateway's /v1/models
// answer for this agent key); the plugin's page shows that preview and
// mirrors the models into Trae's cloud only after the user confirms.
// Authentication is this package's own "trae-agent" sign-in only. No other
// app's or plugin's credentials are used, no extension is installed into
// Trae, no debugging port, no Trae window.
//
// MCP servers are mirrored into Trae's User/mcp.json. Skills are written
// straight into ~/.trae/skills, Trae's documented global skills folder.
//
// This module runs in Magpie's moejs sandbox: no Node APIs, no imports.

const ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAMTSURBVFhHrVf/bfIwEM0mMAITtNmACaAsULUbwCaMwAiMwAAtcf+v1IQEQvhlf3rG5+9ysQuqOOnVd+9+PZxQiSQRZoxJjTELY4x6IFZu5kTu82aM6Rtjlua/aeZz4zz8WF3MIKgfWo6EHC59vjC0XMYhDnFbhCN+MznkXiORof4lLZ8wMlTILTSQ3wg/Y8bzKQTg5YjZb8NCuZi4mL+AALyhnJRDZE5yIbtVT76i5x9KSpM1sTqyWJ6L8wJkkvzYkFsWuoGQdQR4e3t7M/1+/yF4f3/HyJCojgCffHl5MfiSPAKTCf+iWaM9HQHeuAD5ie5FRAA92s470HrmaKIBSgU1wqLvDHoiArhl0RsICJAvlIy56TsEdG6glQwI8DabzSzkJ07T1IsNCGjdkLPODQQfwdfXF/F6Op16Hj4My+iZ40QcENCa7+wqQGvLX/9c/dZLSAKQm8/nUoD++fkxg8HAC0B9lmVSgF+OOW6PSrTWEACz5OVyseACMMzVaOTm87m9CfiuDyL0cDi0teDX67XvxyzqpXq7EDdwuVzU+XymxbZICsAwcK7O1rAeDp/LskxzAWIH7cmS8/kMARoFp9PJFuLkAj4/Py1HQI3r0SL2PHqEAMr7HdidHI9HheB4PLaWfH9/64+PDwM8Pz93/sncAxIwHo/tfALt8wIQHA4HS+Ik30HzYX/BaDSyc9xc7YA9KmmaRtFSoGkaEqDJf3p6Mr1ez38y8nFKhPjX19fW7MPhADHAVUDTNLTMnhL7/Z5yBB6jxvehlsA5WQd/v9+rBH94E6Gu6w7nmgDEdEpYnvpdT2gOfJXUda3quta73c42wccpYp7nuZZPtSyW4LPhr5LdbrcAAWy3W5ugmPOSc/DiOAfInkAduEVSVVVaVZVdEgGG2YGCk3VGzKE+X0vCWP76U62qqqVr1jhDoGGM4wuifbxfxMr/MsrzvF+WpSrLUm82G1OW5SMRmqmw0wsgEZvNRqHYNdhGDnCEWM0tlGW57Cznluf5pCiKRVEUq6IoIMgCfgyUv1G3yPM8lfv+AQ6YUk2YwOqhAAAAAElFTkSuQmCC"

export const agent = {
  id: "trae",
  name: "Trae",
  aliases: ["trae-ai"],
  icon: ICON,
  // Trae's own folder under the user's home; used to detect it on every OS.
  dir: "~/.trae",
  // Where this row keeps the endpoint and key Magpie hands the plugin. Trae
  // itself does not read this file; the Bun companion uses it to talk to
  // Magpie's gateway. No `model`: this agent picks its whole model list
  // itself, so the row shows the model-list control and the connect switch
  // instead of a single-model dropdown.
  config: "~/.trae/magpie/connection.json",
  format: "json",
  // Trae's requests identify as Trae; this helps Magpie's usage attribution.
  ua: ["trae"],
  // No notice: the row stays clean; state and errors live in
  // ~/.trae/magpie/model-state.json and Magpie's log.
  library: {
    // Magpie writes MCP servers here; the companion mirrors them into Trae's
    // real User/mcp.json, whose location differs by OS.
    mcp: "~/.trae/magpie/mcp.json",
    mcpFormat: "claude",
    // Trae's documented global skills folder (macOS/Linux ~/.trae/skills,
    // Windows %USERPROFILE%/.trae/skills).
    skills: "~/.trae/skills",
    // No instructions: Trae reads AGENTS.md only from each project's root,
    // and has no global instructions file this plugin could name. A Trae
    // skill or a project-level AGENTS.md is the supported route.
  },
}

// endpointFor is the full request URL the Trae model uses.
function endpointFor(gateway) {
  const base = String(gateway?.v1 ?? "").replace(/\/+$/, "")
  return base + "/chat/completions"
}

// guideFor is every value the row keeps for the Bun companion. Magpie writes
// the returned keys into the connection file; `model` is absent because this
// agent's models come from the row's model list, not a single choice.
function guideFor({ gateway, model } = {}) {
  if (!gateway?.v1 || !gateway?.key) {
    throw new Error("Choose a model with a configured Magpie gateway first.")
  }
  const out = {
    provider: "custom_openai_compatible",
    endpoint: endpointFor(gateway),
    apiKey: gateway.key,
    apiFormat: "chat_completions",
  }
  if (model?.id) {
    out.modelId = model.id
    out.modelName = model.name || model.id
  }
  if (model?.context > 0) out.contextWindow = model.context
  if (model?.output > 0) out.maxOutputTokens = model.output
  if (typeof model?.images === "boolean") out.supportsImages = model.images
  return out
}

export function connect(input = {}) {
  return guideFor(input)
}

// Tests use these; Magpie only reads `agent` and `connect` from this module.
export const _internal = { endpointFor, guideFor }
