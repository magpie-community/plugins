// The Gemini web app, sent from inside the page. Two transports:
//
//  1. processSession (the app's new WebChannel, see webchannel.mjs) — the
//     primary path. Runs in the page, so the server sees the page's own
//     session context, which is what decides the model tier.
//  2. StreamGenerate (the app's old batchexecute) — the fallback, used when
//     the WebChannel path fails (handshake refused, endpoint changed, …).
//
// The model is chosen by the app's own "mode" byte (header
// x-goog-ext-525001261): 1 serves the free tier, 3 the pro tier. The hex id
// beside it does not change what is served; the picker's "High"/"Medium"
// labels come from header byte 15 (2/4).
import { pageWebChannelEval, servedMismatch as wcServedMismatch } from "./webchannel.mjs"

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

// hex ids are what the account's picker shows; the byte after it is what
// routes the tier. auto sends no header: Google picks, as the app does.
// Names say what each route serves today: b14=1 is the free tier's
// 4 Hydrogen, b14=3 the Pro tier's 4 Neon (measured 2026-11-22); the ids
// keep the picker's own names for compatibility.
export const MODELS = {
  "gemini-auto": { name: "Auto", hex: "", b14: 1 },
  "gemini-3.6-flash": { name: "4 Hydrogen（Auto 同档）", hex: "56fdd199312815e2", b14: 1 },
  "gemini-3.1-pro": { name: "4 Neon", hex: "56fdd199312815e2", b14: 3 },
  "gemini-3.1-pro-high": { name: "4 Neon High", hex: "56fdd199312815e2", b14: 3, b15: 2 },
  "gemini-3.1-pro-medium": { name: "4 Neon Medium", hex: "56fdd199312815e2", b14: 3, b15: 4 },
}

export const slug = (name) =>
  "gemini-" +
  String(name)
    .toLowerCase()
    .replace(/^gemini\s*/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")

const uuid = () => crypto.randomUUID()

// innerRequest is StreamGenerate's f.req payload for a temporary chat
// (slot 45): nothing is kept in the account's history.
export function innerRequest(prompt) {
  const inner = new Array(99).fill(null)
  inner[0] = [prompt, 0, null, null, null, null, 0]
  inner[1] = ["en"]
  inner[2] = ["", "", "", null, null, null, null, null, null, ""]
  inner[6] = [0]
  inner[7] = 1
  inner[10] = 1
  inner[11] = 0
  inner[17] = [[0]]
  inner[18] = 0
  inner[27] = 1
  inner[30] = [4]
  inner[41] = [1]
  inner[45] = 1 // temporary chat, always
  inner[53] = 0
  inner[59] = uuid()
  inner[61] = []
  inner[68] = 1
  inner[79] = 1
  inner[80] = 1
  return inner
}

export function modelHeader(model = {}) {
  return JSON.stringify([
    1, null, null, null, model.hex || "56fdd199312815e2", null, null, 0, [4, 5, 6, 8], null, null, 1, null, null,
    model.b14 ?? 1, model.b15 ?? 1, uuid(),
  ])
}

// streamGenerateEval builds the old-protocol page call: the page's own
// StreamGenerate fetch (its cookies, its tokens), temporary chat always.
function streamGenerateEval(hex, b14, b15, prompt) {
  return `(function(){ const f = ${PAGE_ASK}; return f(${JSON.stringify(prompt)}, ${JSON.stringify(hex || "56fdd199312815e2")}, ${b14 ?? 1}, ${b15 ?? 1}, 1) })()`
}

// The page's own expressions. Everything runs in the page: its cookies,
// its TLS, its tokens. prompt is passed as an argument, never interpolated.
const PAGE_ASK = `(async (prompt, hex, b14, b15, temporaryChat) => {
  const html = document.documentElement.innerHTML;
  const g = (k) => (html.match(new RegExp('"' + k + '":"([^"]*)"')) || [])[1] || "";
  const at = (html.match(/"SNlM0e":"([^"]+)"/) || [])[1] || "";
  const bl = g("cfb2h");
  if (!bl) throw new Error("页面里没有 cfb2h，Gemini 网页版可能改版了");
  const inner = new Array(99).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ["en"]; inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0]; inner[7] = 1; inner[10] = 1; inner[11] = 0;
  inner[17] = [[0]]; inner[18] = 0; inner[27] = 1; inner[30] = [4];
  inner[41] = [1]; inner[53] = 0;
  inner[45] = 1; // temporary chat: never kept in the account's history
  if (temporaryChat !== 1) throw new Error("internal: temporary chat flag must stay on (slot 45)");
  const ru = crypto.randomUUID();
  inner[59] = ru; inner[61] = []; inner[68] = 1;
  inner[79] = 1; inner[80] = 1;
  if (temporaryChat !== 1) throw new Error("internal: temporary chat flag must stay on (slot 45)");
  const mh = JSON.stringify([1,null,null,null,hex,null,null,0,[4,5,6,8],null,null,1,null,null,b14,b15,crypto.randomUUID()]);
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
  let model = "", reply = "", reasoning = "", err = "";
  for (const line of text.split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t.startsWith("[")) continue;
    let rows; try { rows = JSON.parse(t) } catch { continue }
    for (const e of rows) {
      if (!Array.isArray(e) || e[0] !== "wrb.fr" || typeof e[2] !== "string") continue;
      let bb; try { bb = JSON.parse(e[2]) } catch { continue }
      if (typeof bb?.[42] === "string" && bb[42]) model = bb[42];
      if (bb?.[34]?.[0]?.[0] === "error") err = String(bb[34][0][1]).slice(0, 120);
      const c = bb?.[4]?.[0];
      if (Array.isArray(c)) {
        if (typeof c[1]?.[0] === "string" && c[1][0].length > reply.length) reply = c[1][0];
        const th = c[37]?.[0]?.[0];
        if (typeof th === "string" && th.length > reasoning.length) reasoning = th;
      }
    }
  }
  if (r.status !== 200 && !reply) throw new Error("StreamGenerate HTTP " + r.status + (err ? "：" + err : ""));
  if (!reply && err) throw new Error("Gemini 拒绝了请求：" + err);
  return { status: r.status, model, reply, reasoning };
})`

// what a mode byte is expected to serve, from the 2026-11-22
// measurements: b14=1 the free tier's 4 Hydrogen, b14=3 the pro tier's
// 4 Neon, and Auto whatever Google picks. auto is exempt from the check.
// (the check itself lives in webchannel.mjs so both transports share it)

export class RelaySession {
  constructor({ browser, model = MODELS["gemini-3.6-flash"] } = {}) {
    this.browser = browser
    this.model = model
  }

  // ask sends one prompt and answers the whole reply. The WebChannel
  // (processSession) path is tried first; a transport-level failure there
  // falls back to the old StreamGenerate. A tier mismatch never falls back:
  // strict means fail loudly, not retry into the same downgrade.
  async ask(prompt, { model = this.model, signal, strictModel = false } = {}) {
    if (prompt.length > 600_000)
      throw new GeminiError(`请求有 ${prompt.length} 个字符，超过能可靠发送的 600000。请压缩上下文后再试。`, {
        code: "context_length_exceeded",
        status: 413,
      })
    const page = await this.browser.ensure()
    let lastError = null
    for (const transport of ["webchannel", "stream"]) {
      if (transport === "stream" && lastError && lastError.fallback === false) break
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r =
            transport === "webchannel"
              ? await page.eval(pageWebChannelEval(model.hex, model.b14, model.b15, prompt))
              : await page.eval(streamGenerateEval(model.hex, model.b14, model.b15, prompt))
          if (signal?.aborted) throw new GeminiError("已取消", { code: "aborted", status: 499 })
          // strict: what the server actually served must be the tier asked
          // for, not a silent downgrade
          if (strictModel) {
            const mismatch = wcServedMismatch(r.served?.length ? r.served : r.model ? [r.model] : [], model)
            if (mismatch)
              throw Object.assign(new GeminiError(mismatch, { code: "model_served_mismatch", status: 502 }), {
                fallback: false,
              })
          }
          return { text: r.reply, reasoning: r.reasoning ?? "", model: r.model ?? r.served?.[0] }
        } catch (e) {
          if (e?.code === "model_served_mismatch") throw e // never blind-retry into the same downgrade
          if (e?.code === "aborted") throw e
          lastError = e
          // the page may have been closed or navigated; reopen once
          if (attempt === 0 && (!this.browser.started() || /400|401|403|no api key|handshake|cfb2h|SNlM0e/i.test(String(e?.message)))) {
            try { await page.close() } catch {}
            this.browser._page = null
            await this.browser.ensure()
            continue
          }
          break // this transport failed; try the next one
        }
      }
    }
    throw new GeminiError(String(lastError?.message ?? lastError), { status: 502 })
  }
}
