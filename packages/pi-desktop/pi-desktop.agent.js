// Pi-Desktop keeps its providers in a database only its own host process writes,
// so Magpie cannot wire it by editing a settings file. What Pi-Desktop does read
// from disk is a plugin folder: loaded as a local plugin, its manifest.json is
// read again every time Pi-Desktop starts. So the file this row keeps current is
// such a manifest. It declares Magpie as a provider with the models Magpie offers
// Pi-Desktop and their thinking levels, and Magpie rewrites it when they change.
export const agent = {
  // "pi-desktop" is taken: Magpie's own Sessions reader uses it, and own ids are refused.
  id: "pi-desktop-app",
  name: "Pi-Desktop",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMyYjNhNjciLz48cGF0aCBkPSJNMTQgMjBoMzZNMjUgMjB2MjZNMzkgMjB2MjBjMCA0IDIgNiA2IDYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI1IiBmaWxsPSIjZjVhNjIzIi8+PC9zdmc+",
  dir: "~/.pi-desktop",
  config: "~/.config/magpie-pi-desktop/plugin/manifest.json",
  format: "json",
  notice: "In Pi-Desktop: Extensions › More actions › Load local plugin, choose the folder .config/magpie-pi-desktop/plugin in your user folder, then Settings › AI providers › Add provider › Magpie with the key magpie-pi-desktop-app. Pi-Desktop picks up model changes when it starts. 在 Pi-Desktop 的 扩展 › 更多操作 › 加载本地插件 选用户文件夹下的 .config/magpie-pi-desktop/plugin，再到 设置 › AI 服务 › 添加服务 选 Magpie，填密钥 magpie-pi-desktop-app。模型有变化时，Pi-Desktop 重启后生效。",
}

// Pi-Desktop's thinking levels; Magpie's "none" is Pi-Desktop's "off", and its
// "ultra" has no Pi-Desktop level.
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
// Pi-Desktop's host refuses a plugin provider that declares more models than this.
export const MAX_MODELS = 64

// The level a chat starts on: `preferred` when the model has it, else the nearest
// level above, else the nearest below. Magpie picks Codex's default the same way.
export function defaultLevel(levels, preferred) {
  const at = LEVELS.indexOf(preferred || "high")
  for (let i = at; i < LEVELS.length; i++) if (levels.indexOf(LEVELS[i]) >= 0) return LEVELS[i]
  for (let i = at - 1; i >= 0; i--) if (levels.indexOf(LEVELS[i]) >= 0) return LEVELS[i]
  return undefined
}

// One model as a Pi-Desktop manifest declares it. Pi-Desktop takes thinking levels
// only from declared models: one it discovers from the gateway gets every level
// and starts on "off", which is also what a model declared without levels gets.
function modelEntry(model, preferred) {
  const entry = { id: model.id, name: model.name || model.id }
  if (model.context > 0) entry.contextWindow = model.context
  if (model.output > 0) entry.maxTokens = model.context > 0 ? Math.min(model.output, model.context) : model.output
  if (model.images) entry.supportsImages = true
  const efforts = model.efforts || []
  const levels = []
  for (let i = 0; i < LEVELS.length; i++) if (efforts.indexOf(LEVELS[i] === "off" ? "none" : LEVELS[i]) >= 0) levels.push(LEVELS[i])
  if (levels.length > 0) {
    entry.thinkingLevels = levels
    entry.defaultThinkingLevel = defaultLevel(levels, preferred)
  }
  return entry
}

export function declaredModels(models, preferred) {
  const seen = {}, out = []
  for (const model of models || []) {
    if (!model || typeof model.id !== "string" || !model.id || seen[model.id]) continue
    seen[model.id] = true
    out.push(modelEntry(model, preferred))
  }
  return out
}

const vendorOf = (model) => model.id.split("/")[0]

// Cuts the list into providers of at most `max` models, keeping one vendor's
// models (the id up to the first "/") together when they fit.
export function splitModels(models, max) {
  const limit = max || MAX_MODELS
  const chunks = [[]]
  let i = 0
  while (i < models.length) {
    let j = i + 1
    while (j < models.length && vendorOf(models[j]) === vendorOf(models[i])) j++
    let last = chunks[chunks.length - 1]
    if (last.length > 0 && last.length + (j - i) > limit) { last = []; chunks.push(last) }
    for (; i < j; i++) {
      if (last.length === limit) { last = []; chunks.push(last) }
      last.push(models[i])
    }
  }
  return chunks
}

// The provider cards: "magpie" first, so the key Pi-Desktop already holds for it
// stays, then magpie-2, …. With no models there is one card without any, and
// Pi-Desktop lists the gateway's models itself.
export function providers(baseUrl, models) {
  const chunks = splitModels(models || [])
  const out = []
  for (let i = 0; i < chunks.length; i++) {
    out.push({
      id: i ? "magpie-" + (i + 1) : "magpie",
      name: i ? "Magpie " + (i + 1) : "Magpie",
      category: { en: "Local gateway", "zh-CN": "本地网关" },
      description: {
        en: "Models from the Magpie gateway on this computer. Enter the key magpie-pi-desktop-app.",
        "zh-CN": "本机 Magpie 网关提供的模型。密钥填 magpie-pi-desktop-app。",
      },
      baseUrl,
      apiStyle: "chat_completions",
      authKind: "api_key",
      models: chunks[i],
    })
  }
  return out
}

// The whole manifest. `main` names the manifest itself: Pi-Desktop wants an entry
// file, a JSON file loads as a module with no hooks, and so the folder Magpie
// keeps needs no second file and runs no code.
export function manifest(baseUrl, models) {
  return {
    schemaVersion: 1,
    id: "local.magpie-gateway",
    name: "Magpie Gateway",
    version: "0.2.0",
    description: "Adds the local Magpie gateway as a model provider: every model Magpie offers Pi-Desktop, with its multi-vendor routing, groups and fallback. 把本机 Magpie 网关加为模型服务。",
    author: "magpie-community",
    homepage: "https://github.com/magpie-community/plugins/tree/main/packages/pi-desktop",
    main: "manifest.json",
    contributes: { providers: providers(baseUrl, models) },
    permissions: ["provider.register"],
    engines: { piDesktop: ">=0.22.0" },
  }
}

// Every top-level key of the manifest, plus "magpie": the gateway and the key
// this row is known by (Pi-Desktop ignores keys it does not know). Switching the
// row off takes all of them out again.
export function connect({ gateway, models }) {
  const out = manifest(gateway.v1, declaredModels(models))
  out.magpie = { baseUrl: gateway.v1, apiKey: gateway.key, apiStyle: "chat_completions" }
  return out
}
