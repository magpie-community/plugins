// OpenBitFun (openbitfun.com) as a magpie agent.
//
// OpenBitFun already knows magpie: its provider catalog ships a `magpie` preset
// (src/shared/ai-provider-catalog/providers.json) and its model settings can
// probe a gateway and import its catalog (MagpieSourceSection.tsx,
// magpieModels.ts). Doing it by hand is a second step in another app's UI.
//
// magpie cannot write that step itself. It edits a config one key path at a
// time, and OpenBitFun keeps the imported models in one array, ai.models, so a
// key holding the whole array would replace the user's own entries. So this
// agent writes magpie's own file instead, and the package's host part
// (index.mjs -> bridge.mjs) merges the entries into ai.models, taking them out
// again when the agent is switched off.
//
// No `model` key: the model is picked in OpenBitFun's own model settings among
// the ones written here, so the Agents row is a switch with no model picker.
export const agent = {
  id: "openbitfun",
  name: "OpenBitFun",
  icon: "https://openbitfun.com/assets/openbitfun-app-mark.png",
  // magpie's own folder, as kimi-desktop keeps one: nothing of OpenBitFun's is
  // read from here, and the file is made when it isn't there
  config: "~/.config/magpie-openbitfun/bridge.json",
  format: "json",
  // the desktop app's folder, for the row's "installed" hint; the CLI next to
  // it is not on PATH on a normal install
  dir: "$LOCALAPPDATA/OpenBitFun",
  ua: ["OpenBitFun", "openbitfun"],
  // magpie's Library. Skills are a folder of SKILL.md folders OpenBitFun reads
  // itself (path_manager.rs, user_skills_dir), so magpie links or copies them
  // in. MCP servers live inside app.json, which magpie cannot hand to an agent,
  // so it writes this agent's own Cursor-shaped file and the host part merges
  // it in. Instructions have no target: OpenBitFun reads them per workspace
  // (AGENTS.md, CLAUDE.md, .claude/rules) and has no user-level file.
  library: {
    mcp: "~/.config/magpie-openbitfun/library/mcp.json",
    mcpFormat: "cursor",
    skills: "$APPDATA/openbitfun/skills",
  },
  notice:
    "OpenBitFun reads app.json while it runs, so the models appear without a restart. 模型无需重启即可出现；重新选择默认模型后生效。",
}

// What the host part needs, and nothing else: native_endpoints and pricing are
// not part of an ai.models entry. `models` comes as magpie's own list, and the
// gateway key counts this agent's requests under its id.
export function connect({ gateway, models }) {
  const list = []
  for (const m of models || []) {
    if (!m || typeof m.id !== "string" || !m.id) continue
    const entry = { id: m.id }
    if (typeof m.name === "string" && m.name && m.name !== m.id) entry.name = m.name
    if (Number.isFinite(m.context) && m.context > 0) entry.context = m.context
    if (Number.isFinite(m.output) && m.output > 0) entry.output = m.output
    if (m.images === true) entry.images = true
    list.push(entry)
  }
  return { bridge: { version: 1, url: gateway.v1, key: gateway.key, models: list } }
}
