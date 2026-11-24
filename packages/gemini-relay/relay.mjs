// The Gemini web app, sent from inside the page. Two transports:
//
//  1. processSession (the app's new WebChannel, see webchannel.mjs) — the
//     primary path. Runs in the page, so the server sees the page's own
//     session context, which is what decides the model tier.
//  2. StreamGenerate (the app's old batchexecute) — the fallback, used when
//     the WebChannel path fails (handshake refused, endpoint changed, …).
//
// The model is chosen by the app's own "mode" byte (header
// x-goog-ext-525001261, JSPB index 14). Measured 2026-11-22 from the
// picker (otAQ7b): mode 1 serves the free tier's 4 Hydrogen, 3 the paid
// 4 Neon, 6 the 3.5 Flash-Lite, 8 the paid 4 Carbon (which needs its own
// set of inner slots, see buildInner). The hex id beside the mode does not
// change what is served; the thinking depth rides index 15 (1 normal,
// 2 high, 4 medium).
import { pageWebChannelEval, servedMismatch as wcServedMismatch } from "./webchannel.mjs"
import { lastUserText } from "./prompt.mjs"

export const APP = "https://gemini.google.com"

export class GeminiError extends Error {
  constructor(message, { code = "gemini_error", status = 502, signIn = false } = {}) {
    super(message)
    this.name = "GeminiError"
    this.code = code
    this.status = status
    this.signIn = signIn
  }
}

// The model table, from the app's own picker (hex ids + mode bytes
// measured 2026-11-22). mode is the tier byte (JSPB index 14 / proto
// field 15); think is the default thinking depth sent at index 15 /
// proto field 16. Anonymous (signed-out) requests hang or downgrade on
// the paid tiers, so those need a signed-in browser. Old ids stay as
// aliases: gemini-3.1-pro is 4 Neon, and the free tier's 4 Hydrogen was
// previously listed as "gemini-3.6-flash" — that id now means the real
// 3.6 Flash (fbb127…), with 4 Hydrogen under its own name.
export const MODELS = {
  "gemini-auto": { name: "Auto", hex: "", mode: 1, needsLogin: false },
  "gemini-4-hydrogen": { name: "4 Hydrogen", hex: "56fdd199312815e2", mode: 1, needsLogin: false },
  "gemini-3.5-flash-lite": { name: "3.5 Flash-Lite", hex: "cf41b0e0dd7d53e5", mode: 6, needsLogin: false },
  "gemini-4-neon": { name: "4 Neon", hex: "e6fa609c3fa255c0", mode: 3, needsLogin: true },
  "gemini-3.1-pro": { name: "4 Neon", hex: "e6fa609c3fa255c0", mode: 3, needsLogin: true },
  "gemini-4-carbon": { name: "4 Carbon", hex: "95a4c0abcba24364", mode: 8, needsLogin: true },
  "gemini-3.6-flash": { name: "3.6 Flash", hex: "fbb127bbb056c959", mode: 1, needsLogin: false },
}
// the old table keyed by b14; every model's b14 is its mode (same byte)
for (const m of Object.values(MODELS)) m.b14 = m.mode

export const slug = (name) =>
  "gemini-" +
  String(name)
    .toLowerCase()
    .replace(/^gemini\s*/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")

const uuid = () => crypto.randomUUID()

// buildInner assembles the 99-slot inner request, parameterized so both
// transports and both conversation modes share one constructor. The page
// functions receive it JSON-encoded; nothing is built inside the page.
//
//  metadata  inner[2]: null for a fresh (temporary) chat, or
//            [cid, rid, rcid, null×6, lastFinalMarker] to continue a
//            server-side conversation.
//  turn      inner[17] = [[turn]]: the number of completed turns before
//            this one (0 for the first message of a conversation).
//  temporary inner[45] = 1: nothing is kept in the account's history.
//            Temporary chats cannot be continued (the server answers
//            400), so a continued turn must pass temporary = false.
//  files     inner[0][3]: [[[ref], filename], …] — uploaded file
//            references (mode-independent).
//  mode      the tier byte; 8 (4 Carbon) needs its own slot values:
//            inner[6]=[1], inner[30]=[], inner[49]=40, inner[68]=2,
//            inner[83]=1, inner[91]=1, inner[96]=1, inner[98]=1.
//  think     inner[80]: 1 normal, 2 high, 4 medium (only 4 Carbon offers
//            medium in the web UI). inner[96] is 1 whenever thinking is
//            not normal (and always for mode 8).
export function buildInner({ prompt = "", files = null, metadata = null, turn = 0, temporary = true, mode = 1, think = 1 } = {}) {
  const inner = new Array(99).fill(null)
  inner[0] = [prompt, 0, null, files ?? null, null, null, 0]
  inner[1] = ["en"]
  inner[2] = metadata ?? ["", "", "", null, null, null, null, null, null, ""]
  inner[6] = mode === 8 ? [1] : [0]
  inner[7] = 1
  inner[10] = 1
  inner[11] = 0
  inner[17] = [[turn]]
  inner[18] = 0
  inner[27] = 1
  inner[30] = mode === 8 ? [] : [4]
  inner[41] = [1]
  if (temporary) inner[45] = 1 // temporary chat: never kept in the account's history
  inner[53] = 0
  if (mode === 8) {
    inner[49] = 40
    inner[68] = 2
    inner[83] = 1
    inner[91] = 1
    inner[98] = 1
  }
  inner[59] = uuid() // must equal the x-goog-ext-525005358-jspb uuid
  inner[61] = []
  inner[68] = mode === 8 ? 2 : 1
  inner[79] = mode
  inner[80] = think
  inner[96] = mode === 8 || think > 1 ? 1 : 0
  return inner
}

// modelHeader builds x-goog-ext-525001261-jspb (JSPB): the hex id at 4,
// the mode at 14, the thinking depth at 15, and a fresh uuid at 16 (its
// own — inner[59] carries a different one).
export function modelHeader(model = {}) {
  return JSON.stringify([
    1, null, null, null, model.hex || "56fdd199312815e2", null, null, 0, [4, 5, 6, 8], null, null, 1, null, null,
    model.mode ?? model.b14 ?? 1, model.think ?? 1, uuid(),
  ])
}

// streamGenerateEval builds the old-protocol page call: the page's own
// StreamGenerate fetch (its cookies, its tokens). inner arrives
// prebuilt; the page only wires it into the form.
function streamGenerateEval(inner, hex) {
  return `(function(){ const f = ${PAGE_ASK}; return f(${JSON.stringify(inner)}, ${JSON.stringify(hex || "56fdd199312815e2")}) })()`
}

// The page's own expressions. Everything runs in the page: its cookies,
// its TLS, its tokens. The inner request is passed as an argument, never
// interpolated — the prompt rides inside it as plain JSON.
const PAGE_ASK = `(async (inner, hex) => {
  const html = document.documentElement.innerHTML;
  const g = (k) => (html.match(new RegExp('"' + k + '":"([^"]*)"')) || [])[1] || "";
  const at = (html.match(/"SNlM0e":"([^"]+)"/) || [])[1] || "";
  const bl = g("cfb2h");
  if (!bl) throw new Error("页面里没有 cfb2h，Gemini 网页版可能改版了");
  const ru = inner[59];
  const mh = JSON.stringify([1,null,null,null,hex,null,null,0,[4,5,6,8],null,null,1,null,null,inner[79],inner[80],crypto.randomUUID()]);
  const q = new URLSearchParams({ bl, hl: "en", _reqid: String(100000 + Math.floor(Math.random() * 899999)), rt: "c" });
  const form = new URLSearchParams({ "f.req": JSON.stringify([null, JSON.stringify(inner)]) });
  if (at) form.set("at", at);
  const r = await fetch("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?" + q, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1",
      "x-goog-ext-525001261-jspb": mh, "x-goog-ext-525005358-jspb": JSON.stringify([ru, 1]) },
    body: form, credentials: "include",
  });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let text = "";
  while (true) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
  let model = "", reply = "", reasoning = "", err = "", code = "";
  let cid = "", rid = "", rcid = "", marker = "";
  for (const line of text.split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t.startsWith("[")) continue;
    let rows; try { rows = JSON.parse(t) } catch { continue }
    for (const e of rows) {
      if (!Array.isArray(e) || e[0] !== "wrb.fr" || typeof e[2] !== "string") continue;
      let bb; try { bb = JSON.parse(e[2]) } catch { continue }
      if (typeof bb?.[42] === "string" && bb[42]) model = bb[42];
      if (typeof bb?.[1]?.[0] === "string" && bb[1][0]) cid = bb[1][0];
      if (typeof bb?.[1]?.[1] === "string" && bb[1][1]) rid = bb[1][1];
      if (typeof bb?.[25] === "string" && bb[25]) marker = bb[25];
      if (bb?.[34]?.[0]?.[0] === "error") { err = String(bb[34][0][1]).slice(0, 120); code = String(e[5]?.[2]?.[0]?.[1]?.[0] ?? ""); }
      const c = bb?.[4]?.[0];
      if (Array.isArray(c)) {
        if (typeof c[1]?.[0] === "string" && c[1][0].length > reply.length) reply = c[1][0];
        const th = c[37]?.[0]?.[0];
        if (typeof th === "string" && th.length > reasoning.length) reasoning = th;
        if (typeof c[0] === "string" && /^rc_/.test(c[0])) rcid = c[0];
      }
    }
  }
  if (!rcid) { const m = text.match(/"rc_[A-Za-z0-9_-]{6,}"/); if (m) rcid = m[0].slice(1, -1); }
  if (r.status !== 200 && !reply) throw new Error("StreamGenerate HTTP " + r.status + (err ? "：" + err : "") + (code ? " [code " + code + "]" : ""));
  if (!reply && err) throw new Error("Gemini 拒绝了请求：" + err + (code ? " [code " + code + "]" : ""));
  return { status: r.status, model, reply, reasoning, code, cid, rid, rcid, finalMarker: marker };
})`

// what a mode byte is expected to serve, from the 2026-11-22
// measurements: mode 1 the free tier's 4 Hydrogen, 3 the paid 4 Neon,
// 8 the paid 4 Carbon, 6 the 3.5 Flash-Lite. auto is exempt from the
// check. (the check itself lives in webchannel.mjs so both transports
// share it)

// the thinking depths the paid models can run at (the app's selector
// offers them on the same model); 1 is the normal (default) depth
export const THINKING = ["low", "medium", "high"]

// thinkingByte maps the OpenAI reasoning_effort onto the app's
// thinking-depth byte (measured 2026-11-22: low/normal=1, high=2,
// medium=4); unset means the app's own default.
export function thinkingByte(effort) {
  if (!effort) return undefined
  const e = String(effort).toLowerCase()
  if (e === "low") return 1
  if (e === "high") return 2
  if (e === "medium") return 4
  throw new GeminiError(`思考深度只支持 low、medium、high，收到 ${effort}。`, { code: "invalid_request_error", status: 400 })
}

// The server's in-band error codes (HTTP stays 200; the code rides in
// batchexecute part[5][2][0][1][0], or the WebChannel's __sm__ status).
// Mapped onto OpenAI-shaped failures; 1013 stays retryable (502).
const ERROR_MAP = [
  [1013, 502, "temporary_error", "Gemini 临时错误，可稍后重试。"],
  [1037, 429, "usage_limit_exceeded", "已达 Gemini 用量限额。"],
  [1050, 400, "model_conversation_mismatch", "模型与当前会话不一致。"],
  [1052, 400, "model_header_invalid", "模型头无效。"],
  [1060, 403, "ip_blocked", "当前 IP 被 Gemini 拒绝。"],
  [1095, 429, "rate_limited", "触发限流风控，请稍后再试。"],
  [1096, 400, "request_rejected", "请求被拒绝（会话可能已失效）。"],
]

// errorFromText recognizes a mapped code (or a __sm__ status) in a page
// error and answers the GeminiError to throw; null when nothing matches.
export function errorFromText(text) {
  const s = String(text ?? "")
  const sm = s.match(/__sm__.{0,40}?"status"\s*:\s*(\d+)/) || s.match(/"status"\s*:\s*(\d+).*__sm__/)
  if (sm) {
    const n = Number(sm[1])
    if (n === 16) return new GeminiError("Gemini 凭证无效，请重新登录账号。", { code: "credential_invalid", status: 401, signIn: true })
    if (n === 7) return new GeminiError("Gemini API key 出现问题，请重新登录账号。", { code: "api_key_invalid", status: 400, signIn: true })
  }
  for (const [code, status, name, msg] of ERROR_MAP) {
    if (s.includes("code " + code) || s.includes("[" + code + "]") || s.includes('"' + code + '"') || new RegExp("\\b" + code + "\\b").test(s))
      return new GeminiError(msg + `（错误码 ${code}）`, { code: name, status })
  }
  return null
}

export class RelaySession {
  constructor({ browser, model = MODELS["gemini-3.6-flash"], pool = null, accountKey = "" } = {}) {
    this.browser = browser
    this.model = model
    this.pool = pool // the shared SessionPool for server-side conversations
    this.accountKey = accountKey
  }

  // ask sends one turn and answers the whole reply. When a session pool
  // and the full messages array are given, a matching server-side
  // conversation is continued (only the new user text is sent, no
  // temporary-chat slot); otherwise the whole flattened prompt rides in
  // a fresh temporary chat. A failed continuation falls back to the
  // temporary path once.
  async ask(prompt, { model = this.model, signal, strictModel = false, messages = null, continueConversation = true, files = null, onUpdate = null } = {}) {
    if (prompt.length > 600_000)
      throw new GeminiError(`请求有 ${prompt.length} 个字符，超过能可靠发送的 600000。请压缩上下文后再试。`, {
        code: "context_length_exceeded",
        status: 413,
      })
    const pool = this.pool
    const canPool = !!(pool && continueConversation && Array.isArray(messages) && messages.length > 1)
    const binding = { account: this.accountKey, browserKey: this.browserKey(), modelKey: model.hex + ":" + (model.mode ?? model.b14 ?? 1) }
    // a pooled conversation is bound to one account/browser/model: the
    // lookup drops the trailing user turn (the reply completed that history)
    const prior = canPool ? pool.find(messages, binding) : null
    let lastError = null
    // the continuation goes first; a fresh temporary chat is both the
    // starting point and the fallback when the server refuses to continue
    for (const usePool of prior ? [true, false] : [false]) {
      const r = await this._run(prompt, {
        model,
        signal,
        strictModel,
        usePool,
        state: usePool ? prior : null,
        messages,
        binding,
        onUpdate,
      }).catch((e) => ({ err: e }))
      if (!r.err) return r
      lastError = r.err
      if (usePool && prior) {
        // the server refused this continuation: forget it, rebuild from
        // scratch as a temporary chat
        try { pool.invalidate(messages.slice(0, -1)) } catch {}
        continue
      }
      break
    }
    throw lastError
  }

  browserKey() {
    return this.browser?.profileDir || "anonymous"
  }

  // _run is one full attempt across both transports. usePool selects the
  // continuation plan (metadata from the pooled state, only the new user
  // text, no slot 45) or the temporary chat (whole prompt, slot 45).
  // files are the uploaded file references for inner[0][3]; they ride the
  // model option (index.mjs spreads them in) and never force a rebuild.
  async _run(prompt, { model, signal, strictModel, usePool, state, messages, binding, onUpdate = null }) {
    const mode = model.mode ?? model.b14 ?? 1
    const think = model.think ?? 1
    const files = model.files ?? null
    let inner
    if (usePool && state) {
      inner = buildInner({
        prompt: lastUserText(messages),
        files,
        metadata: [state.cid, state.rid, state.rcid ?? "", null, null, null, null, null, null, state.tok26 ?? ""],
        turn: state.turn ?? 0,
        temporary: false,
        mode,
        think,
      })
    } else {
      inner = buildInner({ prompt, files, temporary: true, mode, think })
    }
    let lastError = null
    for (const transport of ["webchannel", "stream"]) {
      if (transport === "stream" && lastError && lastError.fallback === false) break
      for (let attempt = 0; attempt < 2; attempt++) {
        // the page is read fresh every try: a reopen must be used, not the
        // closed one this attempt started on
        const page = await this.browser.ensure()
        // streaming deltas: the page pushes the running text through a CDP
        // binding as it reads frames; the node side diffs it (Streamer) and
        // calls onUpdate. The binding lives only for this turn.
        let offDelta = null
        const pushName = onUpdate ? "__gwrDelta" + Math.floor(Math.random() * 1e9) : ""
        if (onUpdate) {
          const seen = { text: "", reasoning: "" }
          const fire = (d) => {
            if (typeof d?.text === "string" && d.text.length > seen.text.length) {
              seen.text = d.text
            }
            if (typeof d?.reasoning === "string" && d.reasoning.length > seen.reasoning.length) {
              seen.reasoning = d.reasoning
            }
            try { onUpdate({ text: seen.text, reasoning: seen.reasoning }) } catch {}
          }
          this.browser.deltaHandlers ??= new Set()
          const unsub = this.browser.onDelta(pushName, fire)
          offDelta = () => { unsub(); try { page.send("Runtime.removeBinding", { name: pushName }).catch(() => {}) } catch {} }
          await this.browser.installBinding(page, pushName).catch(() => {})
        }
        try {
          const r =
            transport === "webchannel"
              ? await page.eval(pageWebChannelEval(model.hex, mode, think, inner, pushName))
              : await page.eval(streamGenerateEval(inner, model.hex))
          if (signal?.aborted) throw new GeminiError("已取消", { code: "aborted", status: 499 })
          // the page function reports transport trouble in its result (it
          // resolves instead of throwing): an error, an error frame, or no
          // reply at all is a failed ask, not a successful empty one — let
          // the retry/fallback machinery see it
          if (!r || r.err || r.errFrame || !r.reply)
            throw new Error(String(r?.err || r?.errFrame || "网页里没有等到回复") + (r?.code ? ` [code ${r.code}]` : ""))
          // strict: what the server actually served must be the tier asked
          // for, not a silent downgrade
          if (strictModel) {
            const mismatch = wcServedMismatch(r.served?.length ? r.served : r.model ? [r.model] : [], model)
            if (mismatch)
              throw Object.assign(new GeminiError(mismatch, { code: "model_served_mismatch", status: 502 }), {
                fallback: false,
              })
          }
          // remember the server-side conversation so the next turn with
          // this history can continue it — a fresh temporary chat stores
          // one too (its cid/rid/rcid/marker are what the next request
          // continues; the continuation itself goes out without slot 45).
          // A continued turn advances the stored turn index.
          if (this.pool && r.cid) {
            const priorMessages = usePool && state ? messages.slice(0, -1) : messages
            this.pool.remember(
              [...(priorMessages ?? []), { role: "assistant", content: r.reply }],
              { cid: r.cid, rid: r.rid, rcid: r.rcid, tok26: r.finalMarker, turn: usePool && state ? (state.turn ?? 0) + 1 : 1 },
              binding,
            )
          }
          return { text: r.reply, reasoning: r.reasoning ?? "", model: r.model ?? r.served?.[0] }
        } catch (e) {
          offDelta?.()
          if (e?.code === "model_served_mismatch") throw e // never blind-retry into the same downgrade
          if (e?.code === "aborted") throw e
          // a mapped server error (quota, IP block, …) is final: no retry,
          // no fallback — but a pooled continuation first falls back to the
          // temporary path in ask()
          const mapped = errorFromText(String(e?.message ?? e))
          if (mapped && mapped.code !== "temporary_error") throw Object.assign(mapped, { fallback: false })
          lastError = e
          // the page may have been closed or navigated; reopen once — and
          // tear the old browser down first, or the new Chrome hits the
          // profile's singleton lock and dies
          if (attempt === 0 && (!this.browser.started() || /400|401|403|no api key|handshake|cfb2h|SNlM0e|没有等到回复/i.test(String(e?.message)))) {
            try { await page.close() } catch {}
            await this.browser.stop().catch(() => {})
            await this.browser.ensure()
            continue
          }
          break // this transport failed; try the next one
        } finally {
          offDelta?.()
        }
      }
    }
    const mapped = errorFromText(String(lastError?.message ?? lastError))
    if (mapped) throw mapped
    throw new GeminiError(String(lastError?.message ?? lastError), { status: 502 })
  }
}
