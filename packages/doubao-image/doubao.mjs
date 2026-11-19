// A image-only provider on top of 豆包 (Doubao): every request is one image.
//
// It drives the same desktop app the doubao-work plugin drives, from the
// same profile (so the same sign-in and the same window), and keeps one
// Doubao conversation per client conversation: the first request opens a
// new 工作任务 and its id is remembered, later requests open that same
// conversation again, so the model keeps its context and its style.
//
// The prompt is not a chat prompt: doubao.mjs only reads the reply's
// images, and prompt.mjs asks for a picture, not for text.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { App, Page, sleep } from "./cdp.mjs"

export class DoubaoError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    Object.assign(this, { code }, extra)
  }
}

// APPS are the desktop apps that can draw: 豆包工作 first, then 豆包. Both
// have the same 工作任务, and both are Chromium builds this driver can
// open on its own profile.
export const APPS = [
  { name: "豆包工作", bundle: "com.work.pc.doubao", mac: "DoubaoWork.app/Contents/MacOS/DoubaoWork", win: ["DoubaoWork", "Application", "app", "DoubaoWork.exe"] },
  { name: "豆包", bundle: "com.bot.pc.doubao", mac: "Doubao.app/Contents/MacOS/Doubao", win: ["Doubao", "Application", "app", "Doubao.exe"] },
]

// isChat tells a chat page: doubao-chat/chat/<id> once a message has been
// sent, and doubao-chat/chat for a new task's page before that.
export const isChat = (url) => /doubao-chat\/chat(?:$|[/?#])/.test(String(url ?? ""))

export function dataDir(platform = process.platform, home = os.homedir()) {
  if (process.env.DOUBAO_WORK_HOME) return process.env.DOUBAO_WORK_HOME
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "magpie-doubao-work")
  if (platform === "win32") return path.win32.join(process.env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "magpie-doubao-work")
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "magpie-doubao-work")
}

// places lists where an app is installed. The same places the doubao-work
// plugin looks in, so one sign-in serves both.
export function places(app, platform = process.platform, home = os.homedir()) {
  if (platform === "darwin") return [path.posix.join("/Applications", app.mac), path.posix.join(home, "Applications", app.mac)]
  if (platform === "win32") return [path.win32.join(process.env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), ...app.win)]
  return []
}

// spotlight mentions the app bundles macOS knows by identifier, then its
// running copies: an app on another disk is found without a setting.
function spotlight() {
  const out = []
  for (const app of APPS) {
    try {
      out.push(...execFileSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${app.bundle}'`], { encoding: "utf8", timeout: 8000 }).split("\n"))
    } catch {}
  }
  try {
    for (const l of execFileSync("/bin/ps", ["-axo", "comm="], { encoding: "utf8", timeout: 8000 }).split("\n"))
      if (/\.app\/Contents\/MacOS\/Doubao(Work)?$/.test(l.trim())) out.push(l.trim())
  } catch {}
  return out.map((s) => s.trim()).filter(Boolean)
}

// choose picks the app to drive: { app, binary, dataDir }. DOUBAO_WORK_APP
// names the binary outright; else the first of the two that is installed.
export function choose(platform = process.platform, home = os.homedir(), exists = fs.existsSync) {
  const base = dataDir(platform, home)
  if (process.env.DOUBAO_WORK_APP) {
    const bin = process.env.DOUBAO_WORK_APP
    return { app: /doubaowork/i.test(bin) ? APPS[0] : APPS[1], binary: bin, dataDir: base }
  }
  for (const app of APPS) {
    const usual = places(app, platform, home).find((p) => exists(p))
    if (usual) return { app, binary: usual, dataDir: base }
  }
  if (platform === "darwin") {
    const hints = spotlight()
    for (const app of APPS) {
      const hit = hints.find((h) => h.includes("/" + app.mac.split("/")[0] + "/"))
      if (hit) return { app, binary: path.join(hit.slice(0, hit.indexOf(".app") + 4), app.mac.split("/").slice(1).join("/")), dataDir: base }
    }
  }
  return { app: APPS[0], binary: "", dataDir: base }
}

// Page-side helpers, run through Runtime.evaluate. press() is what the
// page's own menus listen for (Radix opens on pointerdown, not on click).
const LIB = String.raw`
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const press = (el) => { for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
const dismiss = async () => {
  if (!$$("[role=menu]").some((m) => $$("[role=menuitem]", m).length)) return;
  const at = $(".ProseMirror") || document.body;
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) at.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, view: window, pointerType: "mouse" }));
  await wait(200);
};
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
    editor: !!($(".ProseMirror") && $(".ProseMirror").editor),
    replies: $$("[data-testid=receive_message]").length, sends: $$("[data-testid=send_message]").length };
`)

// COUNTS is the page's message counts: what a send has to grow.
export const COUNTS = js(`
  return { url: location.href, replies: $$("[data-testid=receive_message]").length, sends: $$("[data-testid=send_message]").length,
    editor: !!($(".ProseMirror") && $(".ProseMirror").editor) };
`)

// MODE says which side of the app draws: "chat" (the default) is 对话,
// whose allowance is the chat one; "work" is a 工作任务, which counts
// against the work allowance. DOUBAO_IMAGE_MODE picks it.
// CHAT_MODEL is the model 对话's 图像生成 draws with.
export const CHAT_MODEL = "Seedream 5.5"

export const MODE = () => (String(process.env.DOUBAO_IMAGE_MODE ?? "").trim().toLowerCase() === "work" ? "work" : "chat")

// TALK switches the app to the 对话 side. The two sides share the window,
// and only the 工作 one has 云电脑 and 工作任务.
export const TALK = js(`
  const tab = [...document.querySelectorAll("[role=tab], button, [role=button], a")].find((e) => (e.innerText || "").trim() === "对话");
  if (!tab) return "";
  press(tab);
  await wait(600);
  return "";
`)

// IMAGE_ON turns 对话's 图像生成 skill on. The skill's own exit button is
// what says it is on already.
export const IMAGE_ON = js(`
  if ($("[data-testid=skill_input_exit_button]")) return "";
  let b = null;
  for (let i = 0; i < 40 && !b; i++) {
    b = [...document.querySelectorAll("button, [role=button]")].find((e) => (e.innerText || "").trim() === "图像生成");
    if (!b) await wait(150);
  }
  if (!b) return "no 图像生成 button";
  press(b);
  for (let i = 0; i < 40; i++) {
    await wait(150);
    if ($("[data-testid=skill_input_exit_button]")) return "";
  }
  return "the image skill did not open";
`)

// SET_MODEL picks the skill's drawing model by name. Its rows read
// "Seedream 5.5" then the description ("旗舰生图").
export const SET_MODEL = (name) =>
  js(`
  const name = ${JSON.stringify(name)};
  const txt = (e) => (e.innerText || "").trim();
  const first = (e) => txt(e).split("\\n")[0].trim();
  const btn = [...document.querySelectorAll("button")].find((e) => txt(e).startsWith("模型"));
  if (!btn) return "no model button";
  if (txt(btn).includes(name)) return "";
  press(btn);
  let row;
  for (let i = 0; i < 40 && !row; i++) {
    await wait(100);
    row = [...document.querySelectorAll("[role=menuitem]")].find((e) => first(e).startsWith(name));
  }
  if (!row) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "no " + name + " in the model menu"; }
  press(row);
  await wait(600);
  await dismiss();
  return "";
`)

// RATIO_STATUS is the 比例 button's own text: the check that a ratio took.
export const RATIO_STATUS = js(`
  const txt = (e) => (e.innerText || "").trim();
  const b = [...document.querySelectorAll("button")].find((e) => txt(e).startsWith("比例"));
  return b ? txt(b) : "";
`)

// SET_RATIO picks the 比例 menu's own button by its text ("9:16"); "" is
// the 自动 it starts on.
export const SET_RATIO = (key) =>
  js(`
  const key = ${JSON.stringify(key)};
  const txt = (e) => (e.innerText || "").trim();
  const btn = [...document.querySelectorAll("button")].find((e) => txt(e).startsWith("比例"));
  if (!btn) return "no ratio button";
  if (!key || txt(btn).includes(key)) return "";
  press(btn);
  let row;
  for (let i = 0; i < 40 && !row; i++) {
    await wait(100);
    row = [...document.querySelectorAll("[role=menu] button")].find((e) => txt(e) === key);
  }
  if (!row) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "no " + key + " in the ratio menu"; }
  press(row);
  await wait(500);
  return "";
`)

// NEW_CHAT opens a new 对话 and waits for its empty page. Doubao's own
// 新对话 is pressed when it is there (the window keeps one open already);
// the route is the fallback.
export const NEW_CHAT = js(`
  const idOf = () => { const m = /\\/chat\\/(\\d+)/.exec(location.href); return m ? m[1] : ""; };
  const firstLine = (e) => (e.innerText || "").trim().split("\\n")[0].trim();
  const before = idOf();
  const b = [...document.querySelectorAll("[role=button], button, a")].find((e) => firstLine(e) === "新对话");
  if (b) press(b);
  else location.href = "/chat";
  for (let i = 0; i < 120; i++) {
    await wait(150);
    const ready = $(".ProseMirror") && $(".ProseMirror").editor;
    const empty = !$$("[data-testid=send_message]").length && !$$("[data-testid=receive_message]").length;
    if (ready && empty && (idOf() === "" || idOf() !== before)) return "";
  }
  return "the new chat did not open";
`)

// NEW_TASK opens a new 工作任务 and waits for its empty page: a chat id
// that wasn't there before, an editor, and no messages yet. Waiting only
// for the editor is not enough — the old conversation's page keeps its
// editor while the new one loads, and a prompt typed then lands in the old
// conversation.
export const NEW_TASK = js(`
  const b = $("[data-testid=create_office_task_button] [role=button]") || $("[data-testid=create_office_task_button]");
  if (!b) return "no new-task button";
  const idOf = () => { const m = /\\/chat\\/(\\d+)/.exec(location.href); return m ? m[1] : ""; };
  const before = idOf();
  b.click();
  for (let i = 0; i < 120; i++) {
    await wait(150);
    const now = idOf();
    const ready = $(".ProseMirror") && $(".ProseMirror").editor;
    const empty = !$$("[data-testid=send_message]").length && !$$("[data-testid=receive_message]").length;
    // a new task's page has no id of its own until the first message is
    // sent; an id that is the old one means the old page is still up
    if (ready && empty && (now === "" || now !== before)) return "";
  }
  return "the new task did not open";
`)

// OPEN_CHAT goes back to a conversation the plugin opened before, by the
// id the page put in its address. The recent list's own link is pressed
// first (that is how a person reopens one); the route is used when the
// list doesn't hold it any more. An empty string means it is open.
export const openChat = (id) =>
  js(`
  const id = ${JSON.stringify(String(id))};
  const here = () => location.href.includes("/chat/" + id);
  const ready = () => here() && $(".ProseMirror") && $(".ProseMirror").editor;
  if (ready()) return "";
  const a = $$("a[href]").find((x) => (x.getAttribute("href") || "").endsWith("/chat/" + id));
  if (a) a.click();
  else location.href = "/chat/" + id;
  for (let i = 0; i < 80; i++) { await wait(250); if (ready()) return ""; }
  return "the conversation did not open";
`)

// CHAT_ID is the id of the conversation the page is showing.
export const CHAT_ID = js(`
  const m = /\\/chat\\/(\\d+)/.exec(location.href);
  return m ? m[1] : "";
`)

// CLOUD puts the task on 云电脑, so Doubao's agent never reads or runs
// anything on this computer. A request here only asks for a picture.
export const CLOUD = js(`
  const b = $("[data-testid=chat_input_action_mode]");
  if (!b) return "";
  if (b.innerText.trim() === "云电脑") return "";
  press(b);
  let it;
  for (let i = 0; i < 20 && !it; i++) { await wait(100); it = $$("[role=menuitem]").find((e) => e.innerText.includes("云电脑")); }
  if (!it) return "";
  press(it);
  for (let i = 0; i < 20; i++) { await wait(100); if (b.isConnected && b.innerText.trim() === "云电脑") return ""; }
  return "";
`)

// pickModel picks a model by the first line of its menu row, the way a
// person does: the model button, then the row with that name. The button
// itself may only show the 推理强度, so the row being there and being
// pressed is what counts.
export const pickModel = (label) =>
  js(`
  const label = ${JSON.stringify(label)};
  const b = $("[data-testid=chat_input_action_model]");
  if (!b) return "no model button";
  const first = (e) => (e.innerText.split("\\n").map((x) => x.trim()).filter(Boolean)[0] || "");
  press(b);
  let row;
  for (let i = 0; i < 30 && !row; i++) { await wait(100); row = $$("[role=menuitem]").find((e) => first(e) === label || first(e).startsWith(label + " ")); }
  if (!row) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "no " + label + " in the model menu"; }
  if (row.innerText.includes("升级")) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "upgrade"; }
  press(row);
  for (let i = 0; i < 20; i++) { await wait(100); if (!$("[role=menuitem]")) break; }
  await dismiss();
  return "";
`)

// fill writes the prompt into the editor, one paragraph a line.
export const fill = (text) =>
  js(`
  await dismiss();
  const ed = $(".ProseMirror") && $(".ProseMirror").editor;
  if (!ed) return -1;
  const lines = ${JSON.stringify(String(text).split("\n"))};
  ed.chain().clearContent(true).insertContent(lines.map((l) => ({ type: "paragraph", content: l ? [{ type: "text", text: l }] : [] }))).focus("end").run();
  return ed.getText({ blockSeparator: "\\n" }).length;
`)

export const SEND = js(`
  await dismiss();
  const b = $("[data-testid=chat_input_send_button]");
  if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
  b.click();
  return true;
`)

// READ is the last reply the page shows: its text and every image block
// (10010, gen_image_block). The URL there is the small watermarked one;
// the rich_media_layout_block (10084) beside it carries image_ori, the
// full-size copy, which needs no click.
export const READ = js(`
  const r = message($$("[data-testid=receive_message]").pop());
  const counts = { url: location.href, replies: $$("[data-testid=receive_message]").length, sends: $$("[data-testid=send_message]").length };
  if (!r) return { ...counts, reply: false };
  const blocks = r.content_blocks_v2 || [];
  const thinking = new Set(blocks.filter((b) => b.block_type === 10040).map((b) => b.block_id));
  let text = "", reasoning = "";
  const images = [];
  const orig = new Map();
  const addOrig = (im) => {
    if (!im) return;
    // image_ori_raw is the picture as drawn, without the watermark
    const ori = im.image_ori_raw || im.image_ori || im.image_preview || im.image_thumb || {};
    if (!ori.url) return;
    const key = String(im.key || ori.url).split("/").pop().split("~")[0];
    orig.set(key, { url: ori.url, width: ori.width || 0, height: ori.height || 0 });
  };
  // 10084 is a 工作任务's media; 2074 (creation_block) is how a 对话 draws
  // its picture, and it holds no URL until the drawing is done
  for (const b of blocks) {
    if (b.block_type === 10084) {
      const md = (b.content && b.content.rich_media_layout_block && b.content.rich_media_layout_block.media) || [];
      for (const x of md) addOrig((x && x.creation && x.creation.image) || (x && x.image));
    } else if (b.block_type === 2074) {
      const cb = b.content && b.content.creation_block;
      for (const c of (cb && cb.creations) || []) addOrig(c && c.image);
    }
  }
  for (const b of blocks) {
    const t = b.content && b.content.text_block;
    if (b.block_type === 10000 && t && typeof t.text === "string") {
      if (b.parent_id && thinking.has(b.parent_id)) reasoning += t.text;
      else text += t.text;
      continue;
    }
    if (b.block_type !== 10010) continue;
    const g = b.content && b.content.gen_image_block;
    const list = g && Array.isArray(g.images) ? g.images : [];
    for (const im of list) {
      const full = Array.isArray(im.full_size_url) ? im.full_size_url.find((u) => typeof u === "string" && u) : "";
      const url = full || im.uri || im.thumb_url || "";
      if (!url) continue;
      const key = String(url).split("?")[0].split("/").pop().split("~")[0];
      const big = orig.get(key);
      // the page's own copy without the watermark is the best one: it is
      // in the page as soon as the block is drawn
      const shown = $$("img").map((i) => i.currentSrc || i.src).find((u) => u && u.includes(key) && u.includes("wm0"));
      images.push({ url: shown || (big && big.url) || url, key, caption: im.caption || "",
        width: (big && big.width) || im.origin_width || im.width || 0,
        height: (big && big.height) || im.origin_height || im.height || 0 });
    }
  }
  // a 对话's picture has no 10010 block: the media found above is all of it
  for (const [key, big] of orig) {
    if (images.some((i) => i.key === key)) continue;
    const shown = $$("img").map((i) => i.currentSrc || i.src).find((u) => u && u.includes(key) && u.includes("wm0"));
    images.push({ url: shown || big.url, key, caption: "", width: big.width, height: big.height });
  }
  const ext = r.ext || {};
  return { ...counts, reply: true, id: String(r.message_id || r.unique_id || ""), text, reasoning, images,
    finished: ext.is_finish === "1" || !!(r.final_status && r.final_status.session),
    status: (r.final_status && r.final_status.session) || "", reason: ext.finish_chat_reason || "",
    error: r.error_details ? JSON.stringify(r.error_details) : "" };
`)

// fullImage opens a generated image's preview and reads the full-size,
// watermark-free copy the page renders there. Escape closes it again.
// FULLIMAGE finds the copy without the watermark. The page draws one by
// itself (cgen_wm0) once the image block is on screen; when it hasn't yet,
// the block's own picture is opened, and the preview makes one. Both wait
// a while: the block is drawn a moment after the reply finishes.
export const fullImage = (key) =>
  js(`
  const key = ${JSON.stringify(key)};
  const esc = () => { for (let i = 0; i < 2; i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); };
  const shown = () => $$("img").map((i) => i.currentSrc || i.src).find((u) => u && u.includes(key) && u.includes("wm0"));
  let img = null;
  for (let i = 0; i < 100; i++) {
    const u = shown();
    if (u) return u;
    img = $$("img").find((i) => { const s = i.currentSrc || i.src; return s && s.includes(key); });
    if (img) break;
    await wait(150);
  }
  if (!img) return "";
  img.scrollIntoView({ block: "center" });
  await wait(300);
  const r = img.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) img.dispatchEvent(new MouseEvent(t, o));
  for (let i = 0; i < 50; i++) {
    await wait(150);
    const u = shown();
    if (u) { esc(); await wait(200); return u; }
  }
  const late = shown();
  esc();
  await wait(200);
  return late || "";
`)

// sessionFile is where the client conversation → Doubao conversation map
// lives, beside the profile, so both plugins share one sign-in.
export const sessionFile = (dir) => path.join(dir, "image-sessions.json")

export const readSessions = (file) => {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"))
    return d && typeof d === "object" ? d : {}
  } catch {
    return {}
  }
}

export const writeSessions = (file, map) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(map, null, 1))
  } catch {}
}

// DoubaoImage drives the app. One request runs at a time: there is one
// window, and both plugins share it.
export class DoubaoImage {
  constructor({ app, openPage = Page.open, poll = 200, total = 8 * 60 * 1000 } = {}) {
    if (!app) {
      const c = choose()
      app = new App({ binary: c.binary, dataDir: c.dataDir, owns: (list) => list.some((t) => isChat(t.url)) })
    }
    Object.assign(this, { app, openPage, poll, total })
    this.page = null
    this.queue = Promise.resolve()
    this.file = sessionFile(this.app?.dataDir ?? dataDir())
  }

  ask({ prompt, sessionKey, model, signal, onUpdate = () => {} }) {
    const run = this.queue.then(() => this.#ask({ prompt, sessionKey, model, signal, onUpdate }))
    this.queue = run.catch(() => {})
    return run
  }

  async connect(signal) {
    if (this.page && !this.page.closed) return this.page
    const port = await this.app.start({ signal })
    this.page = await this.openPage(port, (t) => isChat(t.url))
    if (!this.page) throw new DoubaoError("豆包的对话窗口没有打开。", "doubao_no_window")
    return this.page
  }

  async state(signal) {
    const page = await this.connect(signal)
    return page.eval(STATE)
  }

  // waitSignedIn opens the app and waits until the user has signed in.
  async waitSignedIn({ timeout = 300000, signal } = {}) {
    const until = Date.now() + timeout
    for (;;) {
      let s
      try { s = await this.state(signal) } catch (e) { if (String(e?.code ?? "").startsWith("app_") || signal?.aborted) throw e; s = null }
      if (s?.signedIn && s.name) return s
      if (Date.now() > until) return null
      await sleep(1500, signal)
    }
  }

  // #open returns the id of the conversation sessionKey names, opening it
  // again when it was opened before, else a new 工作任务. The id is saved
  // as soon as it is known, so a request that fails later still finds the
  // same conversation next time.
  async #open(page, sessionKey, signal) {
    const map = readSessions(this.file)
    const known = sessionKey ? map[sessionKey] : ""
    if (known) {
      let why
      try { why = await page.eval(openChat(known)) } catch { why = "error" }
      if (!why) return known
      // the conversation is gone: a new one takes its place
      delete map[sessionKey]
      writeSessions(this.file, map)
    }
    const chat = MODE() === "chat"
    if (chat) {
      const tab = await page.eval(TALK)
      if (tab) throw new DoubaoError(`豆包切到对话失败：${tab}`, "doubao_ui")
    }
    const why = chat ? await page.eval(NEW_CHAT) : await page.eval(NEW_TASK)
    if (why) throw new DoubaoError(chat ? `豆包新建对话失败：${why}` : `豆包新建任务失败：${why}`, "doubao_ui")
    const id = await page.eval(CHAT_ID)
    if (id && sessionKey) {
      const fresh = readSessions(this.file)
      fresh[sessionKey] = id
      writeSessions(this.file, fresh)
    }
    return id
  }

  async #ask({ prompt, sessionKey, model = "", ratio = "", signal, onUpdate }) {
    signal?.throwIfAborted()
    const page = await this.connect(signal)
    // a window just started still draws itself: the side bar that says who
    // is signed in comes a few seconds in
    let s = await page.eval(STATE)
    for (let i = 0; i < 60 && !s.signedIn; i++) {
      await sleep(500, signal)
      s = await page.eval(STATE)
    }
    if (!s.signedIn) throw new DoubaoError("豆包没有登录。请在 magpie 里重新登录豆包。", "doubao_signed_out", { signIn: "expired" })
    const chat = MODE() === "chat"
    const chatId = await this.#open(page, sessionKey, signal)
    if (chat) {
      // 对话 draws through its 图像生成 skill, on Seedream: the skill is
      // pressed, the model picked by name, and the ratio by its menu key
      const on = await page.eval(IMAGE_ON)
      if (on) throw new DoubaoError(`豆包打开图像生成失败：${on}`, "doubao_ui")
      const picked = await page.eval(SET_MODEL(CHAT_MODEL))
      if (picked) throw new DoubaoError(`豆包选择模型失败：${picked}`, "doubao_ui")
      let ratioWhy = await page.eval(SET_RATIO(ratio))
      // picking the model can put 比例 back to 自动: set it again when it
      // did not stay
      if (!ratioWhy && ratio) {
        const shown = await page.eval(RATIO_STATUS)
        if (shown && !shown.includes(ratio)) ratioWhy = await page.eval(SET_RATIO(ratio))
      }
      if (ratioWhy) throw new DoubaoError(`豆包设置画幅失败：${ratioWhy}`, "doubao_ui")
    } else {
      // 云电脑 is a 工作任务 thing; a 对话 draws without one
      if (process.env.DOUBAO_IMAGE_CLOUD !== "0") { try { await page.eval(CLOUD) } catch {} }
      if (model) {
        const why = await page.eval(pickModel(model))
        if (why === "upgrade") throw new DoubaoError(`${model} 需要升级豆包会员。`, "doubao_upgrade", { status: 403 })
        if (why) throw new DoubaoError(`豆包选择模型失败：${why}`, "doubao_ui")
      }
    }
    const n = await page.eval(fill(prompt))
    if (n < 0) throw new DoubaoError("豆包的输入框没有找到。", "doubao_ui")
    signal?.throwIfAborted()
    const before = await page.eval(COUNTS)
    // the page must still be the conversation this request opened: a
    // prompt typed into another one's page would read that one's reply
    if (chatId && before.url && !String(before.url).includes("/chat/" + chatId))
      throw new DoubaoError("豆包的会话在发送前切换了，请再试一次。", "doubao_ui")
    if (!(await page.eval(SEND))) await page.key("Enter", { keyCode: 13, text: "\r" })

    let last = null
    let lastImgs = ""
    let changed = Date.now()
    const start = Date.now()
    let started = false
    let waitedForImage = 0
    for (;;) {
      await sleep(this.poll, signal)
      const r = await page.eval(READ)
      if (!started) {
        if (r.replies > before.replies) {
          started = true
          // a new task gets its id when the first message is sent: that id
          // is what the next request opens
          if (sessionKey && !chatId) {
            const m = /\/chat\/(\d+)/.exec(String(r.url ?? ""))
            if (m) {
              const map = readSessions(this.file)
              map[sessionKey] = m[1]
              writeSessions(this.file, map)
            }
          }
        } else if (Date.now() - start > 60000) throw new DoubaoError("豆包没有开始回复。", "doubao_timeout", { status: 504 })
        else continue
      }
      const imgs = JSON.stringify(r.images ?? [])
      if (!last || r.text !== last.text || r.reasoning !== last.reasoning || imgs !== lastImgs) {
        changed = Date.now()
        onUpdate(r)
      }
      last = r
      lastImgs = imgs
      if (r.finished) {
        // a 对话 says "已生成图片" before the picture is drawn: keep
        // reading until its block holds a URL
        if (MODE() === "chat" && !(r.images || []).length && !r.error) {
          if (!waitedForImage) waitedForImage = Date.now()
          if (Date.now() - waitedForImage < 120000) continue
        }
        // a new task's id is only in the address once its reply shows, so
        // it is saved here too when the first read came too early
        if (sessionKey && !chatId) {
          try {
            const id = await page.eval(CHAT_ID)
            if (id) {
              const map = readSessions(this.file)
              map[sessionKey] = id
              writeSessions(this.file, map)
            }
          } catch {}
        }
        if (!r.text && !(r.images || []).length && (r.error || !/^succeed/i.test(r.reason || "succeed")))
          throw new DoubaoError(`豆包没有回复（${r.status || r.reason || r.error || "unknown"}）`, "doubao_failed", { status: 502 })
        if (Array.isArray(r.images) && r.images.length && process.env.DOUBAO_IMAGES_FULL !== "0") {
          for (const im of r.images) {
            if (!im?.key) continue
            try {
              const full = await page.eval(fullImage(im.key))
              if (full) im.url = full
            } catch {}
          }
        }
        // the conversation was saved when it was opened
        return r
      }
      if (Date.now() - changed > 240000) throw new DoubaoError("豆包的回复停了四分钟。", "doubao_timeout", { status: 504 })
      if (Date.now() - start > this.total) throw new DoubaoError("豆包的回复超过了 8 分钟。", "doubao_timeout", { status: 504 })
    }
  }
}
