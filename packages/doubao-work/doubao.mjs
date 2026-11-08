// The Doubao adapter: what the generic driver (cdp.mjs) does in Doubao's
// desktop app (com.bot.pc.doubao, a Chromium fork) to run one request as
// one new 工作任务 and read its reply.
//
// The reply is read from the React props of the reply's node, the message
// object Doubao itself renders from: its text blocks are the raw markdown
// (the page's text loses code fences), a text block under a thinking block
// is the reasoning, ext.is_finish says it is done, and
// ext.context_window_usage counts the prompt's tokens.
import os from "node:os"
import path from "node:path"
import { App, Page, sleep } from "./cdp.mjs"

export const CHAT = "doubao-chat/chat"
export const MODELS = {
  auto: { label: "自动", name: "自动" },
  "doubao-2.1-lite": { label: "豆包 2.1 Lite", name: "豆包 2.1 Lite" },
  "doubao-2.1-pro": { label: "豆包 2.1 Pro", name: "豆包 2.1 Pro" },
}

export function binary(platform = process.platform) {
  if (process.env.DOUBAO_WORK_APP) return process.env.DOUBAO_WORK_APP
  if (platform === "darwin") return "/Applications/Doubao.app/Contents/MacOS/Doubao"
  return ""
}

export function dataDir(platform = process.platform, home = os.homedir()) {
  if (process.env.DOUBAO_WORK_HOME) return process.env.DOUBAO_WORK_HOME
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "magpie-doubao-work")
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "magpie-doubao-work")
}

export const owns = (list) => list.some((t) => String(t.url).includes(CHAT) && /^(doubao|chrome):/.test(String(t.url)))

// Page-side helpers, run through Runtime.evaluate. They read the page and
// press its controls the way a pointer does (Radix menus open on
// pointerdown, not on click()).
const LIB = String.raw`
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const press = (el) => { for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
const message = (el) => {
  if (!el) return null;
  const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
  let f = k && el[k];
  for (let d = 0; f && d < 40; d++, f = f.return) { const m = f.memoizedProps && f.memoizedProps.message; if (m && m.message_id !== undefined && m.content_blocks_v2) return m; }
  return null;
};
`

const js = (body) => `(async () => { ${LIB}\n${body} })()`

export const STATE = js(`
  const sb = $("[data-testid=sidebar_bottom]");
  const login = sb ? $$("button, [role=button]", sb).some((b) => b.innerText.trim() === "登录") : false;
  const out = location.href.includes("from_logout");
  return { url: location.href, signedIn: !!sb && !login && !out, name: sb ? sb.innerText.split("\\n")[0].trim() : "",
    input: !!($(".ProseMirror") && $(".ProseMirror").editor), sends: $$("[data-testid=send_message]").length };
`)

export const NEW_TASK = js(`
  const b = $("[data-testid=create_office_task_button] [role=button]") || $("[data-testid=create_office_task_button]");
  if (!b) return "no new-task button";
  b.click();
  for (let i = 0; i < 50; i++) {
    await wait(100);
    if (!$$("[data-testid=send_message]").length && $(".ProseMirror") && $(".ProseMirror").editor && /\\/chat\\/?$/.test(location.pathname + "")) return "";
    if (!$$("[data-testid=send_message]").length && $(".ProseMirror") && $(".ProseMirror").editor && !/\\/chat\\/\\d/.test(location.href)) return "";
  }
  return "the new task did not open";
`)

// Work tasks start on 本地电脑, which lets Doubao's agent read and run
// things on this computer. A request is the client's, so it goes on 云电脑.
export const CLOUD = js(`
  const b = $("[data-testid=chat_input_action_mode]");
  if (!b) return "no mode button";
  if (b.innerText.trim() === "云电脑") return "";
  press(b);
  let it;
  for (let i = 0; i < 20 && !it; i++) { await wait(100); it = $$("[role=menuitem]").find((e) => e.innerText.includes("云电脑")); }
  if (!it) return "no 云电脑 in the mode menu";
  press(it);
  for (let i = 0; i < 20; i++) { await wait(100); if (b.isConnected && b.innerText.trim() === "云电脑") return ""; }
  return "the mode stayed " + b.innerText.trim();
`)

export const pickModel = (label) =>
  js(`
  const label = ${JSON.stringify(label)};
  const b = $("[data-testid=chat_input_action_model]");
  if (!b) return "no model button";
  if (b.innerText.split("\\n")[0].trim() === label) return "";
  press(b);
  let it;
  for (let i = 0; i < 20 && !it; i++) { await wait(100); it = $$("[role=menu] [role=menuitem]").find((e) => e.innerText.split("\\n")[0].trim() === label); }
  if (!it) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "no " + label + " in the model menu"; }
  if (it.innerText.includes("升级")) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "upgrade"; }
  press(it);
  await wait(200);
  return "";
`)

// fill puts the prompt in the editor, one paragraph a line: that is how
// Doubao sends newlines (a hard break is dropped).
export const fill = (text) =>
  js(`
  const ed = $(".ProseMirror") && $(".ProseMirror").editor;
  if (!ed) return -1;
  const lines = ${JSON.stringify(String(text).split("\n"))};
  ed.chain().clearContent(true).insertContent(lines.map((l) => ({ type: "paragraph", content: l ? [{ type: "text", text: l }] : [] }))).focus("end").run();
  return ed.getText({ blockSeparator: "\\n" }).length;
`)

export const READ = js(`
  const sends = $$("[data-testid=send_message]");
  const r = message($$("[data-testid=receive_message]").pop());
  if (!r) return { sends: sends.length, reply: false };
  const blocks = r.content_blocks_v2 || [];
  const thinking = new Set(blocks.filter((b) => b.block_type === 10040).map((b) => b.block_id));
  let text = "", reasoning = "";
  for (const b of blocks) {
    const t = b.content && b.content.text_block;
    if (b.block_type !== 10000 || !t || typeof t.text !== "string") continue;
    if (b.parent_id && thinking.has(b.parent_id)) reasoning += t.text;
    else text += t.text;
  }
  const ext = r.ext || {};
  return { sends: sends.length, reply: true, id: String(r.message_id || r.unique_id || ""), text, reasoning,
    finished: ext.is_finish === "1" || !!(r.final_status && r.final_status.session),
    status: (r.final_status && r.final_status.session) || "", reason: ext.finish_reason_chat || "",
    usage: ext.context_window_usage || "", error: r.error_details ? JSON.stringify(r.error_details) : "" };
`)

export const usageOf = (raw) => {
  try {
    const u = typeof raw === "string" ? JSON.parse(raw) : raw
    const n = ["system_prompt", "messages", "skills", "tools"].reduce((s, k) => s + (Number(u?.[k]) || 0), 0)
    return n > 0 ? n : 0
  } catch {
    return 0
  }
}

export class DoubaoError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    Object.assign(this, { code }, extra)
  }
}

// Doubao drives the app. One request runs at a time: there is one window.
export class Doubao {
  constructor({ app, openPage = Page.open, poll = 150, idle = 180000, total = 900000 } = {}) {
    this.app = app ?? new App({ binary: binary(), dataDir: dataDir(), owns })
    Object.assign(this, { openPage, poll, idle, total })
    this.page = null
    this.queue = Promise.resolve()
  }

  async connect(signal) {
    if (this.page && !this.page.closed) return this.page
    const port = await this.app.start({ signal })
    this.page = await this.openPage(port, (t) => String(t.url).includes(CHAT))
    if (!this.page) throw new DoubaoError("豆包的对话窗口没有打开。请在豆包里打开一个对话窗口后再试。", "doubao_no_window")
    return this.page
  }

  async state(signal) {
    const page = await this.connect(signal)
    return page.eval(STATE)
  }

  // waitSignedIn opens the app and waits until the user has signed in to
  // it, for a first sign-in.
  async waitSignedIn({ timeout = 300000, signal } = {}) {
    const until = Date.now() + timeout
    for (;;) {
      let s
      // the app not starting is said at once; a window still loading is
      // waited for
      try { s = await this.state(signal) } catch (e) { if (String(e?.code ?? "").startsWith("app_") || signal?.aborted) throw e; s = null }
      if (s?.signedIn && s.name) return s
      if (Date.now() > until) return null
      await sleep(1500, signal)
    }
  }

  // ask runs one prompt in a new task. onUpdate gets each new read of the
  // reply ({text, reasoning}); it returns the finished read.
  ask(prompt, opts = {}) {
    const run = this.queue.then(() => this.#ask(prompt, opts))
    this.queue = run.catch(() => {})
    return run
  }

  async #ask(prompt, { model = "auto", signal, onUpdate = () => {} }) {
    signal?.throwIfAborted()
    const page = await this.connect(signal)
    const s = await page.eval(STATE)
    if (!s.signedIn) throw new DoubaoError("豆包没有登录。请在 magpie 里重新登录豆包工作。", "doubao_signed_out", { signIn: "expired" })
    const step = async (expr, what) => {
      const why = await page.eval(expr)
      if (why) throw new DoubaoError(`豆包${what}失败：${why}`, "doubao_ui")
    }
    await step(NEW_TASK, "新建任务")
    await step(CLOUD, "切换到云电脑")
    const label = (MODELS[model] ?? MODELS.auto).label
    const picked = await page.eval(pickModel(label))
    if (picked === "upgrade") throw new DoubaoError(`${label} 需要升级豆包会员。`, "doubao_upgrade", { status: 403 })
    if (picked) throw new DoubaoError(`豆包选择模型失败：${picked}`, "doubao_ui")
    const n = await page.eval(fill(prompt))
    if (n < 0) throw new DoubaoError("豆包的输入框没有找到。", "doubao_ui")
    signal?.throwIfAborted()
    await page.key("Enter", { keyCode: 13, text: "\r" })
    let last = null
    let changed = Date.now()
    const start = Date.now()
    for (let sent = false; ; ) {
      await sleep(this.poll, signal)
      const r = await page.eval(READ)
      if (!sent) {
        if (r.sends > 0) sent = true
        else if (Date.now() - start > 15000) throw new DoubaoError("豆包没有发出这条消息。", "doubao_ui")
        else continue
      }
      if (!r.reply) {
        if (Date.now() - start > 120000) throw new DoubaoError("豆包两分钟没有回复。", "doubao_timeout", { status: 504 })
        continue
      }
      if (!last || r.text !== last.text || r.reasoning !== last.reasoning) {
        changed = Date.now()
        onUpdate(r)
      }
      last = r
      if (r.finished) {
        if (!r.text && !r.reasoning && (r.error || !/^succeed/i.test(r.reason || "succeed")))
          throw new DoubaoError(`豆包没有回复（${r.status || r.reason || r.error || "unknown"}）`, "doubao_failed", { status: 502 })
        return r
      }
      if (Date.now() - changed > this.idle) throw new DoubaoError("豆包的回复停了三分钟。", "doubao_timeout", { status: 504 })
      if (Date.now() - start > this.total) throw new DoubaoError("豆包的回复超过了 15 分钟。", "doubao_timeout", { status: 504 })
    }
  }
}
