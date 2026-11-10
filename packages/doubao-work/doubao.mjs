// The Doubao adapter: what the generic driver (cdp.mjs) does in 豆包工作
// (DoubaoWork, com.work.pc.doubao) or 豆包 (Doubao, com.bot.pc.doubao) to
// run one request as one new 工作任务 and read its reply. Both are the same
// Chromium 147 fork serving the same chat page under their own scheme
// (doubaowork://doubaowork-chat/chat, doubao://doubao-chat/chat), with the
// same 新工作任务 button, mode and model menus.
//
// The reply is read from the React props of the reply's node, the message
// object Doubao itself renders from: its text blocks are the raw markdown
// (the page's text loses code fences), a text block under a thinking block
// is the reasoning, ext.is_finish says it is done, and
// ext.context_window_usage counts the prompt's tokens.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { App, Page, sleep } from "./cdp.mjs"

// isChat says whether a page is either app's chat page. The page reports
// itself as chrome://doubao(work)-chat/chat from inside.
export const isChat = (url) => /^(doubao|doubaowork|chrome):\/\/(doubao|doubaowork)-chat\/chat/.test(String(url))

// Doubao has no API to ask which models it offers: the app's own model menu
// is the list, and it changes as Doubao adds models. These are the ones the
// menu showed when the plugin was written; they are only the fallback for
// when the menu cannot be read. The real list is read from the menu (see
// Doubao#discover) and kept in models.json under DOUBAO_WORK_HOME.
export const MODELS = {
  auto: { label: "自动", name: "自动" },
  "doubao-2.1-lite": { label: "豆包 2.1 Lite", name: "豆包 2.1 Lite" },
  "doubao-2.1-pro": { label: "豆包 2.1 Pro", name: "豆包 2.1 Pro" },
}

// idFor turns the first line of a menu row into the model id a client
// writes as doubao-work/<id>: "DeepSeek V4.1 Flash" -> "deepseek-v4.1-flash",
// "豆包 2.1 Lite" -> "doubao-2.1-lite", "自动" -> "auto". A label with no
// Latin letters or digits gets a stable hash instead.
export function idFor(label) {
  const text = String(label ?? "").trim()
  if (!text || text === "自动") return "auto"
  let id = text
    .replace(/豆包/g, "doubao ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!id) {
    let h = 0
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0
    id = "model-" + h.toString(36)
  } else if (!/^[a-z]/.test(id)) {
    id = "model-" + id
  }
  return id
}

// tableFrom builds the model table ({ id: {label, name} }) from the rows
// read off the menu. Nothing read means the fallback stays.
export function tableFrom(rows) {
  const out = {}
  for (const r of rows ?? []) {
    const label = String(r?.label ?? "").trim()
    if (!label) continue
    const id = idFor(label)
    if (out[id]) continue
    out[id] = { label, name: label }
  }
  if (!Object.keys(out).length) return { ...MODELS }
  if (out.auto) out.auto = { ...MODELS.auto }
  return out
}

// localAppData is %LOCALAPPDATA%, where Doubao's Windows installer puts
// the app for the user who installs it.
const localAppData = (home) => process.env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local")

// APPS are the desktop apps the plugin drives, 豆包工作 first: it is the
// app this plugin is named for. 豆包 has the same 工作任务 and was the only
// one the plugin knew until 0.1.5 (#917). On Windows the exe is the one
// under app\: Application\<name>.exe beside it is a launcher. Neither has
// a Linux build (their download pages offer macOS and Windows).
//   sub  the folder under dataDir() for this app's profile, port and model
//        list; 豆包's stays at the top, where 0.1.0 to 0.1.4 kept it
export const APPS = [
  { name: "豆包工作", mac: "DoubaoWork.app/Contents/MacOS/DoubaoWork", win: ["DoubaoWork", "Application", "app", "DoubaoWork.exe"], sub: "doubaowork", download: "https://www.doubao.com/work" },
  { name: "豆包", mac: "Doubao.app/Contents/MacOS/Doubao", win: ["Doubao", "Application", "app", "Doubao.exe"], sub: "", download: "https://www.doubao.com/download/desktop" },
]

// places lists where an app can be installed: /Applications, then
// ~/Applications on macOS; %LOCALAPPDATA% on Windows.
export function places(app, platform = process.platform, home = os.homedir()) {
  if (platform === "darwin") return [path.posix.join("/Applications", app.mac), path.posix.join(home, "Applications", app.mac)]
  if (platform === "win32") return [path.win32.join(localAppData(home), ...app.win)]
  return []
}

// choose picks the app to drive: { app, binary, dataDir }. DOUBAO_WORK_APP
// names the binary outright. A user already signed in to 豆包 through this
// plugin (its profile exists) stays on 豆包 while it is installed, so an
// update never signs them out. Otherwise the first app installed, 豆包工作
// first; with neither, 豆包工作's own place, so the error names it. On
// Linux the binary is "".
export function choose(platform = process.platform, home = os.homedir(), exists = fs.existsSync) {
  const P = platform === "win32" ? path.win32 : path.posix
  const base = dataDir(platform, home)
  const out = (app, bin) => ({ app, binary: bin, dataDir: app.sub ? P.join(base, app.sub) : base })
  const [work, doubao] = APPS
  if (process.env.DOUBAO_WORK_APP) {
    const bin = process.env.DOUBAO_WORK_APP
    return out(/doubaowork/i.test(bin) ? work : doubao, bin)
  }
  const found = (app) => places(app, platform, home).find((p) => exists(p))
  const old = found(doubao)
  if (old && exists(P.join(base, "profile"))) return out(doubao, old)
  for (const app of APPS) {
    const bin = found(app)
    if (bin) return out(app, bin)
  }
  return out(work, places(work, platform, home)[0] ?? "")
}

// binary is the executable choose picks.
export function binary(platform = process.platform, home = os.homedir(), exists = fs.existsSync) {
  return choose(platform, home, exists).binary
}

export function dataDir(platform = process.platform, home = os.homedir()) {
  if (process.env.DOUBAO_WORK_HOME) return process.env.DOUBAO_WORK_HOME
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "magpie-doubao-work")
  if (platform === "win32") return path.win32.join(localAppData(home), "magpie-doubao-work")
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "magpie-doubao-work")
}

export const owns = (list) => list.some((t) => isChat(t.url))

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

// MENU reads the model list off the app's own menu: press the model button,
// wait for the menu that has rows, and take the first line of each row.
// Rows that open a submenu ("推理强度", a "more models" entry) are not
// models and are left out. The menu is closed again with Escape.
export const MENU = js(`
  const b = $("[data-testid=chat_input_action_model]");
  if (!b) return { error: "no model button" };
  press(b);
  let menu;
  for (let i = 0; i < 30 && !menu; i++) {
    await wait(100);
    menu = $$("[role=menu]").find((m) => $$("[role=menuitem]", m).length);
  }
  if (!menu) return { error: "no model menu" };
  await wait(250);
  const rows = $$("[role=menuitem]", menu)
    .filter((e) => e.getAttribute("aria-haspopup") !== "menu")
    .map((e) => ({ label: e.innerText.split("\\n")[0].trim(), upgrade: e.innerText.includes("升级") }))
    .filter((r) => r.label);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return { rows };
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
  constructor({ app, openPage = Page.open, poll = 150, idle = 180000, total = 900000, fresh = 6 * 60 * 60 * 1000 } = {}) {
    if (!app) {
      const c = choose()
      app = new App({ binary: c.binary, dataDir: c.dataDir, owns })
    }
    this.app = app
    Object.assign(this, { openPage, poll, idle, total, fresh })
    this.cacheFile = this.app?.dataDir ? path.join(this.app.dataDir, "models.json") : ""
    this.table = null
    this.tableAt = 0
    this.page = null
    this.queue = Promise.resolve()
  }

  // modelList is what the plugin offers: the menu read last time, or the
  // fallback before the menu has ever been read. It never opens the app —
  // the menu is read by discover(), on sign-in and on a stale request.
  modelList() {
    if (this.table) return this.table
    try {
      const d = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"))
      if (d?.models && typeof d.at === "number" && Object.keys(d.models).length) {
        this.table = d.models
        this.tableAt = d.at
        return this.table
      }
    } catch {}
    this.table = { ...MODELS }
    this.tableAt = 0
    return this.table
  }

  stale() {
    this.modelList()
    return !this.tableAt || Date.now() - this.tableAt > this.fresh
  }

  #save(table) {
    this.table = table
    this.tableAt = Date.now()
    if (!this.cacheFile) return
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      const tmp = this.cacheFile + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify({ at: this.tableAt, models: table }, null, 1))
      fs.renameSync(tmp, this.cacheFile)
    } catch {}
  }

  // discover reads Doubao's model menu and keeps the result. It opens a
  // new task first when the current page has no model button (the app can
  // sit on 技能 or another page); nothing is sent, so no task runs.
  async discover({ signal } = {}) {
    const page = await this.connect(signal)
    let read = await page.eval(MENU)
    if (read?.error === "no model button") {
      const why = await page.eval(NEW_TASK)
      if (why) throw new DoubaoError("豆包读取模型列表失败：" + why, "doubao_ui")
      read = await page.eval(MENU)
    }
    if (read?.error) throw new DoubaoError("豆包读取模型列表失败：" + read.error, "doubao_ui")
    const table = tableFrom(read?.rows)
    this.#save(table)
    return table
  }

  async connect(signal) {
    if (this.page && !this.page.closed) return this.page
    const port = await this.app.start({ signal })
    this.page = await this.openPage(port, (t) => isChat(t.url))
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
    // the menu is open anyway to pick a model: refresh the list while here
    // when it has not been read for a while
    if (this.cacheFile && this.stale()) { try { await this.discover({ signal }) } catch {} }
    const table = this.modelList()
    const label = (table[model] ?? table.auto ?? MODELS.auto).label
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
