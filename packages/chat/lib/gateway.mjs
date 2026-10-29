// 和 magpie 自己的网关说话：列模型、发 chat completions（流式），带工具循环。
// 网关是 OpenAI 兼容的，所以这里就是标准的 chat completions 客户端。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_GATEWAY = "http://127.0.0.1:3425";

// 候选地址：显式指定的 → 本次 magpie 的 MAGPIE_ADDR → magpie 的老端口
function candidates(opts = {}) {
  const out = [];
  const push = (u) => {
    if (!u) return;
    const s = String(u).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(s) || out.includes(s)) return;
    out.push(s);
  };
  push(opts.gateway || process.env.MAGPIE_CHAT_GATEWAY);
  const addr = process.env.MAGPIE_ADDR;
  if (addr && /^[\w.-]+:\d+$/.test(addr)) push("http://" + addr);
  push(DEFAULT_GATEWAY);
  return out;
}

// 第一个真的答得上 /v1/models 的地址；都没答上就用默认的，让错误原样露出来
let picked = { at: 0, url: "" };
export async function resolveGateway(opts = {}) {
  if (picked.url && Date.now() - picked.at < 60e3) return picked.url;
  for (const url of candidates(opts)) {
    try {
      const res = await fetch(url + "/v1/models", {
        headers: headers(),
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        picked = { at: Date.now(), url };
        return url;
      }
    } catch {
      /* 换下一个 */
    }
  }
  return candidates(opts)[0] || DEFAULT_GATEWAY;
}

export function gatewayURL(opts = {}) {
  return picked.url || candidates(opts)[0] || DEFAULT_GATEWAY;
}

// 显式给的 key；没有就问 magpie 自己的 caller-keys.json 要一把
// （magpie web 的网关要 key，桌面版的不要，带着也无害）
let keyCache;
function callerKey() {
  if (keyCache !== undefined) return keyCache;
  keyCache = process.env.MAGPIE_API_KEY || process.env.MAGPIE_GATEWAY_KEY || "";
  if (keyCache) return keyCache;
  try {
    const dir = process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "magpie")
      : join(homedir(), ".config", "magpie");
    const list = JSON.parse(readFileSync(join(dir, "caller-keys.json"), "utf8"));
    const hit = Array.isArray(list) ? (list.find((k) => k?.secret && k.name) || list.find((k) => k?.secret)) : null;
    if (hit?.secret) keyCache = String(hit.secret);
  } catch {
    /* 没有这把 key 就算了 */
  }
  return keyCache;
}

function headers(extra = {}) {
  const h = { "content-type": "application/json", ...extra };
  const key = callerKey();
  if (key) h.authorization = "Bearer " + key;
  return h;
}

// 归一化成界面要用的形状：名字、思考档位、上下文、能不能看图
export function normalizeModel(m) {
  const id = String(m.id || "");
  const efforts = Array.isArray(m.reasoning_levels) && m.reasoning_levels.length
    ? m.reasoning_levels
    : (m.supported_reasoning_levels || []).map((x) => x.effort).filter(Boolean);
  const input = m.modalities?.input || m.input_modalities || [];
  return {
    id,
    name: String(m.display_name || m.magpie_label || m.name || id),
    provider: id.includes("/") ? id.slice(0, id.indexOf("/")) : "",
    // 真正接住请求的供应商：路由组模型的 provider 是 "group"，看 owned_by 才对
    owner: String(m.owned_by || m.provider_source_id || ""),
    reasoning: Boolean(m.reasoning) && efforts.length > 0,
    efforts,
    context: Number(m.max_input_tokens || m.context_length || m.context_window || 0) || 0,
    output: Number(m.max_output_tokens || 0) || 0,
    images: Array.isArray(input) ? input.includes("image") : false,
  };
}

export async function listModels(opts = {}) {
  const url = await resolveGateway(opts) + "/v1/models";
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`magpie ${res.status} · ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return list.map(normalizeModel).filter((m) => m.id);
}

// 发一次 chat completions（stream 时返回原始 Response，由调用方读 SSE）
export async function chatCompletions(body, { signal, stream = true } = {}, opts = {}) {
  const base = await resolveGateway(opts);
  return fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...body, stream }),
    signal,
  });
}

// 解析 SSE：逐行 data:，回调每个 JSON
export async function* sseChunks(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (!line || line.startsWith(":")) continue; // 心跳
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data);
        } catch {
          /* 半行，丢掉 */
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 已关闭 */ }
  }
}
