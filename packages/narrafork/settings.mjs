// What the host half of the NarraFork agent writes, kept in its own file:
// magpie's plugin host takes every function a plugin's main exports as a
// plugin of its own, so index.mjs exports the one it runs and nothing else.
//
// NarraFork keeps providers in an ARRAY (settings.customApiProviders), and
// magpie's plugin config writer edits object keys only (internal/edit/json.go),
// so the agent half (narrafork.agent.js) cannot add the "magpie" provider. This
// is where that one entry is added, and the only one touched: every other
// provider stays as it was.
//
// A settings.json without customApiProviders is left alone. NarraFork derives
// that list from the legacy per-protocol arrays itself
// (normalizeCustomApiProviderSettings), and converting it here would drop
// providers the derivation keeps.
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROVIDER = "magpie";
// NarraFork keeps each provider's keys under its id (server/lib/provider-keys.ts),
// and the keys outlive the entry: a provider written before keeps its own id.
export const PROVIDER_ID = "magpie01";
export const GATEWAY = "http://127.0.0.1:3425/v1";

const BACKUP = ".magpie.bak";

export function settingsPath(home) {
  const dir = home || process.env.NARRAFORK_HOME || join(homedir(), ".narrafork");
  return join(dir, "settings.json");
}

// stripJsonc is the text as JSON: NarraFork reads settings.json with
// Bun.JSONC.parse (server/lib/settings/index.ts), so comments and a trailing
// comma are legal in it and JSON.parse would refuse them.
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  const quote = (c) => c === '"';
  while (i < text.length) {
    const c = text[i];
    if (quote(c)) {
      // a string is copied whole, escapes and all
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === '"') {
          j++;
          break;
        } else j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) return out;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // a comma left before ] or } is legal in JSONC and refused by JSON.parse
  return out.replace(/,(\s*[\]}])/g, "$1");
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const text = (value) => (typeof value === "string" ? value.trim() : "");

// routedModel is the model NarraFork is on when magpie serves it, without the
// prefix the gateway routes: "magpie:group/daily" is "group/daily". A model of
// NarraFork's own ("openai:gpt-5.5") is none of this provider's business.
export function routedModel(settings) {
  const narrate = isObject(settings?.agent) ? settings.agent : {};
  const model = text(narrate.defaultModel);
  return model.indexOf(PROVIDER + ":") === 0 ? model.slice(PROVIDER.length + 1) : "";
}

// providerOf is the "magpie" entry NarraFork has, if it has one.
export function providerOf(settings) {
  const providers = Array.isArray(settings?.customApiProviders) ? settings.customApiProviders : [];
  return providers.find((p) => isObject(p) && (p.prefix === PROVIDER || p.id === PROVIDER_ID)) || null;
}

// wanted is the entry as it should be: the gateway, the key, and — when magpie
// serves the model NarraFork is on — that model, so the provider's own default
// is the one the gateway routes (a routing group's id included). Without one,
// the default the entry already has stays as it is.
export function wanted(gateway = GATEWAY, key = PROVIDER, settings = {}) {
  const entry = {
    name: PROVIDER,
    prefix: PROVIDER,
    baseUrl: gateway.replace(/\/$/, ""),
    apiKey: key,
    protocol: "completions-compatible",
    disabled: false,
  };
  const model = routedModel(settings);
  if (model) entry.defaultModel = model;
  return entry;
}

// planSettings is settings as NarraFork should have it: the "magpie" provider
// in customApiProviders, every other provider untouched. A settings.json
// without that array comes back as missing, and nothing is written for it.
export function planSettings(settings, asked) {
  if (!isObject(settings)) throw new Error("settings.json is not a JSON object");
  const source = settings.customApiProviders;
  if (!Array.isArray(source)) return { missing: true, changed: false };
  const providers = source.slice();
  const at = providers.findIndex((p) => isObject(p) && (p.prefix === PROVIDER || p.id === PROVIDER_ID));
  // only the provider being written is read: every other one keeps its own
  // fields, such as the proxy, headers and quota the UI set on it
  const was = at >= 0 && isObject(providers[at]) ? providers[at] : {};
  const entry = Object.assign({}, was, asked, { id: was.id || PROVIDER_ID });
  // NarraFork's type has defaultModel as text, and an entry written before
  // anything was picked has none yet
  if (typeof entry.defaultModel !== "string") entry.defaultModel = "";
  if (at >= 0) providers[at] = entry;
  else providers.push(entry);
  const next = Object.assign({}, settings, { customApiProviders: providers });
  return {
    missing: false,
    settings: next,
    changed: JSON.stringify(providers) !== JSON.stringify(source),
    added: at < 0,
    id: entry.id,
  };
}

// syncSettings leaves settings.json as planSettings says, atomically, and with
// one backup of the file as it was before this plugin touched it.
export async function syncSettings(options = {}) {
  const path = options.path || settingsPath(options.home);
  const gateway = options.gateway || GATEWAY;
  const key = options.key || PROVIDER;
  let body;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", path: path };
    throw error;
  }
  const settings = JSON.parse(stripJsonc(body));
  const planned = planSettings(settings, wanted(gateway, key, settings));
  if (planned.missing) return { status: "missing", path: path };
  if (!planned.changed) return { status: "unchanged", path: path, id: planned.id };
  const backup = path + BACKUP;
  if (!existsSync(backup)) await copyFile(path, backup);
  const temp = join(dirname(path), ".settings.json.magpie." + process.pid);
  await writeFile(temp, JSON.stringify(planned.settings, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
  return { status: planned.added ? "added" : "updated", path: path, id: planned.id };
}
