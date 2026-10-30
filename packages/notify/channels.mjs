// Where a notification goes. Each channel is one HTTPS POST to a service
// the user chose, with their own topic, key or webhook; nothing is sent
// anywhere else. send() never throws: it answers { ok, status?, error? }.
import { createHmac } from "node:crypto"

const TIMEOUT = 10_000

async function post(url, body, headers = {}, form = false) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", ...headers },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  // the IM robots answer 200 with an error code in the body
  let data
  try { data = await res.json() } catch {}
  const code = data?.code ?? data?.errcode ?? data?.StatusCode
  const okBody = data?.ok !== false && (code == null || code === 0 || code === 200)
  return res.ok && okBody ? { ok: true, status: res.status } : { ok: false, status: res.status, error: String(data?.msg ?? data?.errmsg ?? data?.description ?? data?.message ?? res.statusText ?? "").slice(0, 200) }
}

const trimSlash = (s) => String(s).replace(/\/+$/, "")

export const kinds = {
  // ntfy (ntfy.sh or your own server): JSON publish to the server root
  ntfy: (c, m) => post(trimSlash(c.server ?? "https://ntfy.sh"), {
    topic: c.topic, title: m.title, message: m.body, priority: c.priority ?? 3, tags: c.tags ?? [m.ok ? "white_check_mark" : "x"],
  }, c.token ? { authorization: `Bearer ${c.token}` } : {}),

  // Bark (iOS): api.day.app or your own bark-server
  bark: (c, m) => post(`${trimSlash(c.server ?? "https://api.day.app")}/push`, {
    device_key: c.key, title: m.title, body: m.body, group: c.group ?? "magpie", ...(c.sound ? { sound: c.sound } : {}),
  }),

  // Server酱 Turbo (SCT…) and Server酱³ (sctp<uid>t…)
  serverchan: (c, m) => {
    const key = String(c.key ?? "")
    const v3 = key.match(/^sctp(\d+)t/i)
    const url = v3 ? `https://${v3[1]}.push.ft07.com/send/${key}.send` : `https://sctapi.ftqq.com/${key}.send`
    return post(url, { title: m.title, desp: m.body }, {}, true)
  },

  // 飞书 / Lark custom robot, with its optional signing secret
  feishu: (c, m) => {
    const body = { msg_type: "text", content: { text: `${m.title}\n${m.body}` } }
    if (c.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      body.timestamp = timestamp
      body.sign = createHmac("sha256", `${timestamp}\n${c.secret}`).update("").digest("base64")
    }
    return post(c.webhook, body)
  },

  // 钉钉 custom robot, with its optional 加签 secret
  dingtalk: (c, m) => {
    let url = c.webhook
    if (c.secret) {
      const timestamp = String(Date.now())
      const sign = createHmac("sha256", c.secret).update(`${timestamp}\n${c.secret}`).digest("base64")
      url += `${url.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
    }
    return post(url, { msgtype: "text", text: { content: `${m.title}\n${m.body}` } })
  },

  // 企业微信 group robot
  wecom: (c, m) => post(c.webhook, { msgtype: "text", text: { content: `${m.title}\n${m.body}` } }),

  // Telegram bot
  telegram: (c, m) => post(`${trimSlash(c.server ?? "https://api.telegram.org")}/bot${c.token}/sendMessage`, {
    chat_id: c.chatId, text: `${m.title}\n${m.body}`, disable_web_page_preview: true,
  }),

  // anything else: the event as JSON
  webhook: (c, m) => post(c.url, { title: m.title, body: m.body, event: m.event }, c.headers ?? {}),
}

// what each kind needs before it can send
const needs = {
  ntfy: ["topic"], bark: ["key"], serverchan: ["key"], feishu: ["webhook"], dingtalk: ["webhook"],
  wecom: ["webhook"], telegram: ["token", "chatId"], webhook: ["url"],
}

export function usable(c) {
  if (!c || typeof c !== "object" || c.off) return false
  const n = needs[c.type]
  return !!n && n.every((k) => c[k] != null && String(c[k]).trim() !== "")
}

export async function send(c, m) {
  try {
    if (!usable(c)) return { ok: false, error: "channel not configured" }
    return await kinds[c.type](c, m)
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
  }
}
