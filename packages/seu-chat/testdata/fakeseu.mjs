// 假 ChatSEU 服务器：seu.test.mjs、probe.test.mjs 和 index.test.mjs 共用。
// opts 里每个应答（user / post / stream / del）可以是：信封对象（→ 200
// JSON）、{ status, body, headers }、Response、或返回这些的函数（post 的
// 函数收到第几次调用 n，从 1 起）。缺省按路径应答。
import { readFileSync } from "node:fs"

const THINK = () => readFileSync(new URL("./think.sse", import.meta.url), "utf8")

function answer(given, fallback) {
  const v = typeof given === "function" ? (given(fallback.n) ?? fallback.plain) : (given ?? fallback.plain)
  if (v instanceof Response) return v
  const { status = 200, body = v, headers = {} } = v && typeof v === "object" && ("body" in v || "status" in v) && !("code" in v) ? v : { body: v }
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers })
}

export function fakeSeu(opts = {}) {
  const calls = []
  const state = { n: { post: 0, del: 0 } }
  // Response 的 body 只能读一次，而夹具流可能永远不结束（测 abort），
  // 不能预读文本：用 tee 想流分发，每个请求拿一条新分支
  let rest = opts.stream?.body ?? null
  const streamOf = () => {
    if (rest) {
      const [mine, next] = rest.tee()
      rest = next
      return new Response(mine, { status: 200, headers: { "content-type": "text/event-stream", ...(opts.streamHeaders ?? {}) } })
    }
    return new Response(THINK(), { status: 200, headers: { "content-type": "text/event-stream", ...(opts.streamHeaders ?? {}) } })
  }
  const fallback = {
    get n() {
      return state.n.post
    },
    plain: { code: 0, response: "m-1" },
  }
  const json = (body, extra = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...extra } })
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    const call = { path: u.pathname, query: u.searchParams, headers: init.headers ?? {}, method: init.method ?? "GET", body: init.body }
    calls.push(call)
    if (u.pathname === "/api/cas/userInfo") {
      const r = answer(opts.user, { plain: { code: 0, response: { name: "张三", uid: "21321xxxx", isadmin: false, apiKeyEndpoints: false } } })
      return r
    }
    if (u.pathname === "/api/chat/streamchat" && (init.method ?? "GET") === "POST") {
      state.n.post++
      const r = answer(opts.post, { ...fallback })
      if (opts.setCookieOnPost) r.headers.append("set-cookie", opts.setCookieOnPost)
      return r
    }
    if (u.pathname === "/api/chat/streamchat") {
      if (typeof opts.stream === "function") return opts.stream(call)
      return await streamOf()
    }
    if (u.pathname === "/api/chat/del-conversation") {
      state.n.del++
      return json({ code: 0, response: true })
    }
    return json({ code: 404, message: "no such path: " + u.pathname }, { status: 404 })
  }
  return { fetch, calls, state }
}
