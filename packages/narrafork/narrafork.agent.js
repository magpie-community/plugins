// NarraFork — https://github.com/NarraFork/NarraFork — keeps one settings file,
// ~/.narrafork/settings.json, and reloads it whenever it changes on disk
// (server/lib/settings-file-watcher.ts watches the folder, so an edit made
// outside NarraFork is picked up without restarting it).
//
// NarraFork names a model "<provider prefix>:<model id>" (server/lib/settings/
// types.ts, rewriteModelReference in custom-api-providers.ts), so magpie
// writing "magpie:<provider>/<model>" is exactly the model id the gateway
// routes, and a routing group ("magpie:group/<id>") is one of those ids too:
// /v1/models lists the groups beside the models. Picking a group keeps the
// model NarraFork is on fixed while magpie decides what serves it, so changing
// a group's members in magpie needs nothing here — only making a new group
// does, as NarraFork reads the gateway's model list once.
//
// The provider itself lives in an ARRAY (settings.customApiProviders) and
// magpie's plugin config writer edits object keys only (internal/edit/json.go),
// so index.mjs, the host half, keeps that entry in place; this file only says
// where NarraFork keeps its model.

const PROVIDER = "magpie";

const SETTINGS = "~/.narrafork/settings.json";

// LEGACY is the arrays NarraFork keeps beside customApiProviders, for a
// settings.json written before the unified list existed.
const LEGACY = ["openaiProviders", "anthropicProviders", "geminiProviders"];

export const agent = {
  id: "narrafork",
  name: "NarraFork",
  dir: "~/.narrafork",
  config: SETTINGS,
  format: "json",
  model: "agent.defaultModel",
  prefix: PROVIDER + ":",
  ua: ["narrafork"],
  notice:
    "NarraFork reloads settings.json itself, so the model is in place at once: a narrator already running keeps the model it started on, and the next one starts on this. Picking a routing group (group/<id>) keeps this name while magpie decides what serves it.",
};

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const list = (value) => (Array.isArray(value) ? value : []);

const text = (value) => (typeof value === "string" ? value.trim() : "");

// providersOf is NarraFork's provider list: customApiProviders when the file
// has it, else the legacy arrays it is derived from
// (normalizeCustomApiProviderSettings in custom-api-providers.ts). Both at once
// would list every provider twice, since NarraFork mirrors the unified list
// back into the legacy ones on every load.
function providersOf(settings) {
  const custom = list(settings.customApiProviders);
  if (custom.length > 0) return custom;
  let out = [];
  for (const key of LEGACY) out = out.concat(list(settings[key]));
  return out;
}

// own is the narrator's own model, and every provider's default one, so the
// picker offers the way back to NarraFork's own setup: each is written as
// agent.defaultModel is, "<prefix>:<model>", and nothing of it goes through
// magpie.
export function own({ config, model } = {}) {
  const settings = isObject(config) ? config : {};
  const narrate = isObject(settings.agent) ? settings.agent : {};
  // NarraFork's own model is the file's; model is what magpie read from it
  const current = text(narrate.defaultModel) || text(model);
  const out = [];
  const seen = {};
  const add = (value, name, direct) => {
    if (!value || seen[value]) return;
    if (out.length >= 100) return;
    seen[value] = true;
    out.push({ value: value, model: name, direct: direct });
  };
  for (const provider of providersOf(settings)) {
    if (!isObject(provider) || provider.disabled === true) continue;
    const prefix = text(provider.prefix);
    const id = text(provider.defaultModel);
    // the gateway's own provider is magpie's models, listed by magpie
    if (!prefix || !id || prefix === PROVIDER) continue;
    add(prefix + ":" + id, text(provider.name) + " · " + id, text(provider.name) || prefix);
  }
  // and the model it is on now, when it isn't magpie's yet (a picker opened
  // before the first magpie model was picked must not look empty)
  if (current && current.indexOf(PROVIDER + ":") !== 0) {
    add(current, "NarraFork · " + current, "");
  }
  return out;
}
