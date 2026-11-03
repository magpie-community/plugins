// Turning Tabbit's catalog into the models magpie shows.
//
// The catalog is the one `web.tabbit.com/proxy/v1/model_config/models` gives
// the app. Its fields that decide what an agent may do:
//
//   display_name       the id a turn is asked with (selected_model), so it is
//                      also this provider's model id — nothing is invented
//   supports_images    the model can read an image
//   supports_tools     the model has Tabbit's *server* tools (browser, search)
//                      — not client tools, so `toolcall` stays false
//   support_thinking   the model reasons, and the stream carries the thinking
//   model_access_type  free_unlimited (Default), free_metered, premium_only
//   display_multiplier Tabbit's credit multiplier, not a USD price
//   hidden             the app hides it; so do we
//
// Limits are not in the catalog. Tabbit publishes none, so the defaults below
// apply and are overridable per model: a context the vendor does not state is
// better shown as a known default than guessed from a description.

import { BASE } from "./api.mjs"

export const NPM = "@ai-sdk/openai-compatible"
export const CHAT_BASE = `${BASE}/api/v3/chat`

export const DEFAULT_CONTEXT = Number(process.env.TABBIT_CONTEXT || 131072)
export const DEFAULT_OUTPUT = Number(process.env.TABBIT_OUTPUT || 32768)

// The two limits Tabbit implies in a model's own description. Everything
// else keeps the default; an agent that is sent past a real limit gets
// Tabbit's own error, which magpie reads as a context overflow.
const LIMITS = {
  "DeepSeek-V4.1-Flash": { context: 1048576, output: 32768 },
  "DeepSeek-V4-Pro": { context: 1048576, output: 32768 },
}

// A bootstrap list, so the Providers page has something before a sign-in and
// the check script sees a non-empty config. The live catalog replaces it.
export const BOOTSTRAP = [
  { display_name: "Default", supports_images: false, supports_tools: true, support_thinking: true, model_access_type: "free_unlimited", display_multiplier: 0 },
  { display_name: "DeepSeek-V4.1-Flash", supports_images: true, supports_tools: true, support_thinking: true, model_access_type: "free_metered", display_multiplier: 0.2 },
  { display_name: "GLM-5.3-Flash", supports_images: true, supports_tools: true, support_thinking: true, model_access_type: "free_metered", display_multiplier: 0.1 },
  { display_name: "GLM-5.3", supports_images: false, supports_tools: true, support_thinking: true, model_access_type: "free_metered", display_multiplier: 0.6 },
  { display_name: "Qwen3.8-Max", supports_images: false, supports_tools: true, support_thinking: true, model_access_type: "free_metered", display_multiplier: 0.9 },
]

const clean = (v) => (typeof v === "string" ? v.trim() : "")

export function isFree(model) {
  return clean(model?.model_access_type).startsWith("free")
}

export function isPremium(model) {
  return clean(model?.model_access_type) === "premium_only"
}

// modelIdOf is the catalog's display name, verbatim: a turn asked with
// anything else is refused or answered by a different model.
export function modelIdOf(model) {
  return clean(model?.display_name)
}

// rowOf is the descriptor both magpie readers take: the config hook reads
// the top-level fields, the models hook reads `capabilities`.
export function rowOf(model, { context = DEFAULT_CONTEXT, output = DEFAULT_OUTPUT } = {}) {
  const id = modelIdOf(model)
  if (!id) return null
  const limit = LIMITS[id] ?? { context, output }
  const image = Boolean(model?.supports_images)
  const reasoning = Boolean(model?.support_thinking)
  return {
    id,
    providerID: "tabbit",
    name: id,
    api: { id, url: CHAT_BASE, npm: NPM },
    limit,
    // Tabbit's models all stream and reason; tool calls are Tabbit's own
    // server tools, so a client tool an agent declares cannot be honoured.
    reasoning,
    tool_call: false,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      temperature: true,
      reasoning,
      toolcall: false,
      attachment: false,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    options: {},
    headers: {},
    variants: {},
    status: "active",
    release_date: "",
  }
}

// rowsOf turns a catalog into { id: row }, the shape config and the models
// hook both return. Hidden rows are dropped, and so are premium-only rows
// when the caller asks for the free ones.
export function rowsOf(models, { freeOnly = false, context, output } = {}) {
  const out = {}
  for (const model of Array.isArray(models) ? models : []) {
    if (model?.hidden) continue
    if (freeOnly && !isFree(model)) continue
    const row = rowOf(model, { context, output })
    if (row) out[row.id] = row
  }
  return out
}

// namesOf is only what a turn needs: the display names, in catalog order.
export function namesOf(models) {
  return (Array.isArray(models) ? models : []).map(modelIdOf).filter(Boolean)
}

export const _internal = { LIMITS }