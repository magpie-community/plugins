import { SeuError } from "./errors.mjs"

// ChatSEU 的 SSE 读取与正文拼装。
//
// readSSE 读标准 Server-Sent Events（event:/id:/data: 行，空行派发）。
// Assembler 把一条回复的正文片段拼回完整的思考与答案：ChatSEU 用
// [line]/[space] 当换行和空格，思考内容包在 <思考内容>…</思考内容>
// 里，而这两者都可能被 SSE 分片切断，所以先拼串、再找出可能是半个
// 标签的尾巴扣住不放，等它长全（或流结束）再放出。
export const TAGS = ["<思考内容>", "</思考内容>", "[line]", "[space]"]

// decodeText 把 ChatSEU 的转义还原成真的换行和空格。
export function decodeText(s) {
  return String(s ?? "").replaceAll("[line]", "\n").replaceAll("[space]", " ")
}

// splitThink 拆开思考与正文：先 decodeText，再判断——以 <思考内容>
// 开头时，到 </思考内容>（或串尾）之间是 reasoning，其后是 text；
// 否则整段都是 text。
export function splitThink(raw) {
  const s = decodeText(raw)
  if (!s.startsWith("<思考内容>")) return { reasoning: "", text: s }
  const body = s.slice("<思考内容>".length)
  const end = body.indexOf("</思考内容>")
  if (end < 0) return { reasoning: body, text: "" }
  return { reasoning: body.slice(0, end), text: body.slice(end + "</思考内容>".length) }
}

// tagTail 是 s 的最长后缀，满足它是 TAGS 里某个标签的真前缀（完整
// 的标签不算）：正文流式播放时，这样的尾巴可能是被切断的标签或转义，
// 要扣住等下一个片段。
export function tagTail(s) {
  for (let n = Math.min(s.length, Math.max(...TAGS.map((t) => t.length)) - 1); n > 0; n--) {
    const tail = s.slice(-n)
    if (TAGS.some((t) => t !== tail && t.startsWith(tail))) return tail
  }
  return ""
}

// readSSE 读 res.body 的 SSE 事件，每个事件调一次 onEvent({event, id,
// data})；返回 false 即停止并取消流。读完 resolve；signal 中止时取消
// 流并以 signal.reason（默认 AbortError）拒绝。多行 data 用 \n 拼接，
// ":" 开头的行是注释，流结束时派发剩余的事件。
export function readSSE(res, onEvent, { signal, idleMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!res.body) return resolve()
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    let ev = { event: "", id: "", data: "" }
    let ended = false
    let idle
    const armIdle = () => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        if (ended) return
        ended = true
        signal?.removeEventListener("abort", abort)
        reader.cancel().catch(() => {})
        reject(new SeuError(`ChatSEU 的回复流 ${Math.round(idleMs / 1000)} 秒没有新内容。`, { code: "seu_stream_stalled", status: 504, retryAfter: 0 }))
      }, idleMs)
      idle.unref?.()
    }
    const dispatch = async () => {
      if (ev.data === "" && ev.event === "" && ev.id === "") return true
      const out = { ...ev }
      ev = { event: "", id: "", data: "" }
      return (await onEvent(out)) !== false
    }
    const abort = () => {
      if (ended) return
      ended = true
      clearTimeout(idle)
      reader.cancel().catch(() => {})
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    if (signal) {
      if (signal.aborted) return abort()
      signal.addEventListener("abort", abort, { once: true })
    }
    armIdle()
    ;(async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          buf += dec.decode(value, { stream: true })
          let at
          while ((at = buf.indexOf("\n")) >= 0) {
            let line = buf.slice(0, at)
            buf = buf.slice(at + 1)
            if (line.endsWith("\r")) line = line.slice(0, -1)
            if (line === "") {
              if (!(await dispatch())) return stop()
            } else if (line.startsWith(":")) continue
            else if (line.startsWith("data:")) ev.data += (ev.data ? "\n" : "") + line.slice(5).trimStart()
            else if (line.startsWith("event:")) ev.event = line.slice(6).trim()
            else if (line.startsWith("id:")) ev.id = line.slice(3).trim()
          }
        }
        buf += dec.decode()
        if (buf) {
          if (buf.startsWith("data:")) ev.data += (ev.data ? "\n" : "") + buf.slice(5).trimStart()
          else if (!buf.startsWith(":")) {
            const m = /^([a-zA-Z]+):\s*(.*)$/.exec(buf)
            if (m && m[1] in ev) ev[m[1]] = m[2].trim()
          }
        }
        await dispatch()
        stop()
      } catch (e) {
        if (!ended) {
          ended = true
          reject(e)
        }
      }
    })()
    function stop() {
      if (ended) return
      ended = true
      clearTimeout(idle)
      signal?.removeEventListener("abort", abort)
      reader.cancel().catch(() => {})
      resolve()
    }
  })
}

// Assembler 把 SSE 默认消息的 data 拼回一条回复，push 返回新增的
// {reasoning?, content?}。可能是半个标签的尾巴扣住不放，flush 在流
// 结束时放出剩下的。放出的原则与流式播放一致：新串以旧串为前缀才
// 增长，否则（服务端重写了已放出的内容）本次不放。
export class Assembler {
  #raw = ""
  #shownReasoning = ""
  #shownText = ""
  #reasoning = ""
  #text = ""

  push(piece) {
    this.#raw += String(piece ?? "")
    return this.#grow(false)
  }

  flush() {
    return this.#grow(true)
  }

  #grow(final) {
    const cur = decodeText(this.#raw)
    // 流结束时不再扣尾：把没有长全的尾巴也当正文放出
    const tail = final ? "" : tagTail(cur)
    const shown = cur.slice(0, cur.length - tail.length)
    const { reasoning, text } = splitThink(shown)
    const out = {}
    if (reasoning.startsWith(this.#reasoning) && reasoning.length > this.#reasoning.length) {
      out.reasoning = reasoning.slice(this.#reasoning.length)
      this.#reasoning = reasoning
    }
    if (text.startsWith(this.#text) && text.length > this.#text.length) {
      out.content = text.slice(this.#text.length)
      this.#text = text
    }
    return out
  }

  get text() {
    return this.#text
  }

  get reasoning() {
    return this.#reasoning
  }
}
