// plugins#1560 (Rhymeyoung): on one Qoder CN account, every request through
// the plugin was queued (10605, p2) again after each wait the queue said was
// over, while Qoder CN's desktop app answered the same account in seconds.
// The queue's wait matched the app's step for step; what differed was what
// the request said of the client. Qoder's app 0.5.20 (Qoder and Qoder CN
// alike) bundles worker runtime 1.1.96-hotfix.8 (its runtime-info.json),
// which its envelope's Cosy-Version and its chat's business.version name,
// and its remote chat body says a few fields of every request beside them
// (bTr in that runtime). The plugin said app 0.4.8's 1.1.69 and none of
// those fields. QwenWork and Lingma speak as their own clients and keep
// their own versions and bodies.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const { cosyHeaders, chatHeaders, qoderBody, SITES } = _internal
const cred = { type: "oauth", uid: "u1", machineId: "m1", access: "a" }
const payloadOf = (h) => JSON.parse(Buffer.from(h.Authorization.split(".")[1], "base64").toString())
const chat = { messages: [{ role: "user", content: "hi" }] }
const m = { key: "fast", source: "system" }
const APP = { stream: true, chat_task: "FREE_INPUT", is_reply: true, is_retry: false, source: 1, version: "3", aliyun_user_type: "" }

for (const id of ["qoder", "qoder-cn"]) {
  test(`${id}: the envelope and the chat's business record say Qoder app 0.5.20's runtime, 1.1.96-hotfix.8`, () => {
    const site = SITES[id]
    const h = chatHeaders("https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation", cred, "", site, m)
    expect(h["Cosy-Version"]).toBe("1.1.96-hotfix.8")
    expect(payloadOf(h).cosyVersion).toBe("1.1.96-hotfix.8")
    expect(cosyHeaders("https://gateway.qoder.com.cn/algo/api/v2/service/ask/queue/status", cred, "", site)["Cosy-Version"]).toBe("1.1.96-hotfix.8")
    expect(qoderBody(chat, m, "", undefined, site).business.version).toBe("1.1.96-hotfix.8")
  })

  test(`${id}: the chat body says what Qoder's app says of every request`, () => {
    const body = qoderBody(chat, m, "", undefined, SITES[id])
    for (const [k, v] of Object.entries(APP)) expect([k, body[k]]).toEqual([k, v])
    // and its own ids are still the request's
    expect(body.chat_record_id).toBe(body.request_id)
    expect(body.agent_id).toBe("agent_common")
  })
}

test("QwenWork keeps its own client's version and body", () => {
  const site = SITES.qwenwork
  expect(cosyHeaders("https://gateway.qwenwork.cn/algo/api/v2/model/list", cred, "", site)["Cosy-Version"]).toBe("1.1.59")
  const body = qoderBody(chat, m, "", undefined, site)
  expect(body.business.version).toBe("1.1.59")
  for (const k of Object.keys(APP)) expect([k, body[k]]).toEqual([k, undefined])
})
