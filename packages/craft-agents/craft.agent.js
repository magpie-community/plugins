// Craft Agents (craft.do's desktop agent app) keeps every AI connection in
// ~/.craft-agent/config.json under `llmConnections`, and talks to an
// OpenAI-compatible endpoint through pi's "pi_compat" provider. So magpie's
// model goes into a connection of its own there, as a plain model id beside
// magpie's /v1 address and `customEndpoint.api: "openai-completions"`.
//
// Craft keeps that array as a whole, not by key: a connection is one object
// of five-odd fields, so replacing it piecemeal is impossible. This plugin
// therefore writes the whole array as magpie alone and sets
// `defaultLlmConnection` to it. magpie saves what was there first, so
// switching the plugin off (or picking the agent's own model again) puts
// every connection back, in order.
//
// Craft reads the connection from config.json when a session starts, and
// applies a model change to running sessions without a restart.
//
// No API key is needed: with authType "none" and a localhost baseUrl, Craft
// sends the placeholder "not-needed", which magpie's gateway accepts. Its
// requests carry pi's own generic User-Agent, so magpie's Usage lists them
// under "pi" (see `ua` below).

import { icon } from "./icon.js"

export const agent = {
  id: "craft-agents",
  name: "Craft Agents",
  // Craft Agents' own app icon, on the Agents page and the plugin's row
  icon,
  // must match CONFIG_FILE in @craft-agent/shared/config/paths
  config: "~/.craft-agent/config.json",
  format: "json",
  // the model field of the connection this plugin writes (messages[0] once
  // the array holds only magpie's), so magpie reads back the model it set
  model: "llmConnections.0.defaultModel",
  // Craft Agents has no CLI on PATH; its folder says it is installed
  dir: "~/.craft-agent",
  // no ua: Craft's backend sends pi's own generic User-Agent, which magpie's
  // built-in Pi agent already claims, and authType "none" sends no key, so
  // Usage shows Craft's requests under "pi". Declaring pi's User-Agent here
  // would not help: magpie's own Pi agent matches it first.
  notice:
    "Craft Agents picks up the new model in its next session. Craft Agents 会在下一个会话使用新模型。",
}

// the connection slug this plugin owns; an existing connection with this
// slug is replaced, everything else in the array is set aside for restoring
const SLUG = "magpie"

export function connect({ gateway, model, models }) {
  if (!model) return {}

  const connection = {
    slug: SLUG,
    name: "Magpie",
    // pi_compat + openai-completions is what Craft's own "API Key" setup
    // writes for an OpenAI-compatible endpoint
    providerType: "pi_compat",
    // "none" needs no stored credential: Craft fills in "not-needed" for a
    // localhost endpoint, and magpie's gateway serves that
    authType: "none",
    baseUrl: gateway.v1,
    defaultModel: model.id,
    // the same list Craft shows in its picker, with the capabilities it
    // needs to decide whether images can be attached
    models: (models ?? []).map((m) => {
      const entry = { id: m.id, name: m.name || m.id }
      if (m.context) entry.contextWindow = m.context
      if (typeof m.images === "boolean") entry.supportsImages = m.images
      return entry
    }),
    customEndpoint: { api: "openai-completions" },
    createdAt: Date.now(),
  }

  return {
    llmConnections: [connection],
    defaultLlmConnection: SLUG,
  }
}
