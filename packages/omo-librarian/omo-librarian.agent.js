// OmO (oh-my-openagent) on magpie's Agents page: pick one of magpie's models for the researcher for docs and external knowledge; magpie writes ~/.omo/omo.jsonc's top-level agents.librarian.model
export const agent = {
  id: "omo-librarian",
  name: "OmO · Librarian",
  config: "~/.omo/omo.jsonc",
  model: "agents.librarian.model",
  notice: "Writes ~/.omo/omo.jsonc's top-level agents.librarian.model; a running omo session picks it up on restart.",
}
