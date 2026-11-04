// WillDeep CLI reads its Magpie connection from the private CLI support
// directory and applies it to new sessions without an explicit Profile.
// Magpie writes the file; the plugin only decides what goes in it.

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#19283d"/><path d="m14 18 14 14-14 14m20 0h16" fill="none" stroke="#77dfca" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const icon = "data:image/svg+xml," + encodeURIComponent(svg)

// Magpie exposes a single notice/error string, with no locale in connect input.
const messages = {
  zh: {
    notice:
      "预计最低版本：WillDeep CLI 0.142.0-rc1，命令为 willdeep。连接和模型变更仅对未显式选择的新会话生效，已有会话保留原 Profile 和模型。自定义 WILLDEEP_HOME 需匹配的本地插件路径。",
    gateway: "无法连接：gateway.v1 必须是本机回环 HTTP(S) 地址，路径须为 /v1。",
    marker: "无法连接：gateway.key 必须精确为 magpie-willdeep-cli；首版不支持真实网关密钥或共享网关。",
    model: "无法连接：model.id 必须是非空完整模型 ID，最多 1024 UTF-8 字节，且不含控制字符。",
  },
  en: {
    notice:
      "Expected minimum: WillDeep CLI 0.142.0-rc1, command willdeep. Connections and model changes affect new sessions without an explicit choice. Existing sessions keep their Profile and model. A custom WILLDEEP_HOME needs a matching local plugin path.",
    gateway: "Cannot connect: gateway.v1 must be a loopback HTTP(S) URL with the exact /v1 path.",
    marker: "Cannot connect: gateway.key must be exactly magpie-willdeep-cli. Real gateway keys and shared gateways are not supported in this version.",
    model: "Cannot connect: model.id must be a nonblank complete model ID, at most 1024 UTF-8 bytes, without control characters.",
  },
}

const text = (key) => messages.zh[key] + "\n" + messages.en[key]

export const agent = {
  id: "willdeep-cli",
  name: "WillDeep CLI",
  // Magpie finds the client by its command; Desktop's directory is not a
  // CLI installation signal.
  bin: "willdeep",
  config: "~/.willdeep/integrations/magpie/cli/connection.json",
  format: "json",
  model: "model",
  prefix: "",
  icon,
  notice: text("notice"),
}

// The willdeep.magpie-agent.v1 connection contract. Kept in step with
// willdeep-rs integrations/magpie/agent-willdeep-cli.
const limits = {
  modelBytes: 1024,
  contextMin: 4000,
  tokenMax: 1048576,
  outputMin: 1,
  portMax: 65535,
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

function loopbackURL(value) {
  if (typeof value !== "string") return false
  const match = /^https?:\/\/(localhost|127(?:\.(?:0|[1-9][0-9]{0,2})){3}|\[::1\])(?::([0-9]{1,5}))?\/v1$/.exec(value)
  // JS's $ also matches before a final newline; the whole string must match.
  if (!match || match[0] !== value) return false
  if (match[1].slice(0, 4) === "127.") {
    const octets = match[1].split(".")
    for (let i = 1; i < octets.length; i++) {
      if (Number(octets[i]) > 255) return false
    }
  }
  return match[2] === undefined || (Number(match[2]) >= 1 && Number(match[2]) <= limits.portMax)
}

function validModel(value) {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c <= 0x7f) bytes++
    else if (c <= 0x7ff) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      bytes += 4
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
    else bytes += 3
    if (bytes > limits.modelBytes) return false
  }
  return true
}

const tokens = (value, minimum) =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= limits.tokenMax ? value : null

function connection(input, clientID, marker) {
  const gateway = record(input) && record(input.gateway) ? input.gateway : {}
  if (!loopbackURL(gateway.v1)) throw new Error(text("gateway"))
  // Never stringify, log, return, or interpolate an untrusted key.
  if (gateway.key !== marker) throw new Error(text("marker"))
  const model = record(input) && record(input.model) ? input.model : {}
  if (!validModel(model.id)) throw new Error(text("model"))
  const context = tokens(model.context, limits.contextMin)
  let output = tokens(model.output, limits.outputMin)
  if (context !== null && output !== null && output > context) output = null
  // Magpie writes model.id through agent.model, preserving every prefix.
  return {
    schema_version: 1,
    client_id: clientID,
    enabled: true,
    base_url: gateway.v1,
    client_marker: marker,
    context_window: context,
    max_output_tokens: output,
  }
}

export function connect(input) {
  return connection(input, "willdeep-cli", "magpie-willdeep-cli")
}
