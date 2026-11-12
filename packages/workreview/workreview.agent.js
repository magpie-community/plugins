// Work Review (https://github.com/wm94i/Work-Review) keeps its live AI
// settings in config.json under the platform data dir, which differs per OS:
//   Windows  %APPDATA%\work-review\config.json
//   macOS    ~/Library/Application Support/work-review/config.json
//   Linux    ~/.local/share/work-review/config.json
// A descriptor can't switch on the platform (it runs in moejs: no process,
// no os, no fs), so magpie writes a small bridge file here and the package's
// Bun host (index.mjs) resolves the real config.json, keeps it in step, and
// restores the user's own text_model on disconnect. See COMPATIBILITY.md.
//
// Work Review's `custom` provider is plain OpenAI-compatible: it posts to
// <endpoint>/chat/completions with the api key as a Bearer token, so four
// keys of text_model are all magpie has to write. Model ids stay as magpie
// gives them, routing groups included (group/<id>).
export const agent = {
  id: "workreview",
  name: "Work Review",
  // Work Review's own icon, on the Agents page and the plugin's row
  icon: "https://raw.githubusercontent.com/wm94i/Work-Review/main/src-tauri/icons/icon.png",
  // magpie's own file for this agent; the host creates it once Work Review
  // is installed, so the agent appears only then, and syncs it to config.json
  config: "~/.magpie-workreview/agent.json",
  format: "json",
  // Work Review reads this at startup; saving AI settings in its UI
  // overwrites the four keys below, so pick the model in magpie again after.
  model: "text_model.model",
  notice:
    "Restart Work Review to use the new model. Saving AI settings inside Work Review overwrites magpie's values, so pick the model in magpie again. 重启 Work Review 后生效。",
};

function trimBase(url) {
  return String(url == null ? "" : url).replace(/\/+$/, "");
}

function usableModelId(candidate) {
  if (!candidate || candidate.id == null) return "";
  const id = String(candidate.id);
  return id.trim() ? id : "";
}

export function connect({ gateway, model } = {}) {
  const modelId = usableModelId(model);
  if (!modelId) throw new Error("Work Review: magpie gave no model id");
  if (!gateway || !gateway.v1) throw new Error("Work Review: magpie gateway address is missing");
  if (!gateway.key) throw new Error("Work Review: magpie gateway key is missing");

  return {
    // Work Review's OpenAI-compatible provider; it appends /chat/completions
    "text_model.provider": "custom",
    "text_model.endpoint": trimBase(gateway.v1),
    "text_model.api_key": gateway.key,
    "text_model.model": modelId,
  };
}
