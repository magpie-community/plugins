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
import { execFileSync } from "node:child_process"
import { App, Page, sleep } from "./cdp.mjs"

// isChat says whether a page is either app's chat page. The page reports
// itself as chrome://doubao(work)-chat/chat from inside.
export const isChat = (url) => /^(doubao|doubaowork|chrome):\/\/(doubao|doubaowork)-chat\/chat/.test(String(url))

// The models Doubao offers come from the list its own page asks for
// (brief_list, see LIST and listOf) and change as Doubao adds models. These
// are the ones it listed when the plugin was written; they are only the
// fallback for when nothing could be read. The real list is read by
// Doubao#discover and kept in models.json under DOUBAO_WORK_HOME.
export const MODELS = {
  auto: { label: "自动", name: "自动" },
  "doubao-2.1-lite": { label: "豆包 2.1 Lite", name: "豆包 2.1 Lite" },
  "doubao-2.1-pro": { label: "豆包 2.1 Pro", name: "豆包 2.1 Pro" },
}

// EFFORTS are the names Doubao gives its 推理强度 levels, lowest first, and
// the OpenAI reasoning_effort each one is offered as.
export const EFFORTS = [
  ["低", "low"],
  ["中", "medium"],
  ["高", "high"],
  ["极高", "xhigh"],
  ["最高", "max"],
]

// effortFor turns a client's reasoning_effort into one of a model's
// 推理强度 names: the same level when the model has it, else the nearest,
// the higher one on a tie. none and minimal ask for the lowest. "" when the
// client asked for nothing (or the model has no levels): the model's own
// default stays.
export function effortFor(asked, efforts) {
  const list = (efforts ?? []).filter((e) => EFFORTS.some(([n]) => n === e))
  const want = String(asked ?? "").trim().toLowerCase()
  if (!want || !list.length) return ""
  const rank = (name) => EFFORTS.findIndex(([n]) => n === name)
  let i = EFFORTS.findIndex(([n, o]) => o === want || n === want)
  if (want === "none" || want === "minimal") i = 0
  if (i < 0) return ""
  let best = list[0]
  for (const e of list) {
    const d = Math.abs(rank(e) - i), b = Math.abs(rank(best) - i)
    if (d < b || (d === b && rank(e) > rank(best))) best = e
  }
  return best
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
    .replace(/高速/g, " fast ")
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

// rateOf reads the multiple a menu row says it costs from the lines under
// the model's name ("2x 额度", "×0.5", "消耗 1.5 倍"); 0 when it says none.
// Version numbers and context sizes ("V4.1", "256K") are not multiples.
export function rateOf(lines) {
  for (const line of lines ?? []) {
    const t = String(line ?? "")
    const m = t.match(/(?:^|[^\w.])[x×]\s*(\d+(?:\.\d+)?)(?![\w.])/i) || t.match(/(\d+(?:\.\d+)?)\s*(?:[x×]|倍)(?![a-z])/i)
    const n = m ? Number(m[1]) : 0
    if (n > 0) return n
  }
  return 0
}

// tableFrom builds the model table from the rows read off Doubao's list
// (listOf) or its menu: { id: {label, name, key?, efforts?, effort?, rate?} }.
// key is Doubao's own id for the model (model_item_key), efforts its
// 推理强度 names and effort the one it picks by default. Nothing read means
// the fallback stays.
export function tableFrom(rows) {
  const out = {}
  for (const r of rows ?? []) {
    const label = String(r?.label ?? "").trim()
    if (!label) continue
    let id = idFor(label)
    if (out[id]?.label === label) continue
    // two rows whose names differ only in what idFor can't spell (a
    // Chinese suffix) must not become one model
    for (let n = 2; out[id]; n++) id = idFor(label) + "-" + n
    out[id] = { label, name: label }
    if (r.key) out[id].key = String(r.key)
    if (Array.isArray(r.efforts) && r.efforts.length) out[id].efforts = r.efforts.map(String)
    if (r.effort) out[id].effort = String(r.effort)
    const rate = Number(r?.rate) || rateOf(r?.lines)
    if (Number.isFinite(rate) && rate > 0) out[id].rate = rate
  }
  if (!Object.keys(out).length) return { ...MODELS }
  if (out.auto && !out.auto.key) out.auto = { ...MODELS.auto, ...out.auto, label: MODELS.auto.label }
  return out
}

// lookup finds a model in the table by the id the plugin gives it, by
// Doubao's own id for it (model_item_key, "person-deepseek-v4-1-flash-261017")
// or by its name as the menu shows it ("DeepSeek V4.1 Flash").
export function lookup(table, model) {
  const want = String(model ?? "")
  if (table?.[want]) return table[want]
  for (const m of Object.values(table ?? {})) if (m?.key === want || m?.label === want) return m
  return null
}

// listOf turns LIST's reply into rows for tableFrom: the models of
// 工作任务 (mode 3, the agent mode, the one for "office" conversations),
// in the order Doubao lists them, each with its 推理强度 names. A mode
// without its own list takes the shared list's models it supports. null
// when the reply has no such list.
export function listOf(read) {
  const conf = read?.conf
  if (!conf || typeof conf !== "object") return null
  const modes = conf.mode_list?.item_list ?? []
  const mode =
    modes.find((m) => String(m?.mode_id) === "3") ??
    modes.find((m) => Number(m?.agent_mode) === 1) ??
    modes.find((m) => (m?.conversation_mode_list ?? []).includes("office") && String(m?.default_conversation_mode ?? "office") === "office")
  let items = mode?.model_list?.item_list
  if (!Array.isArray(items) || !items.length) {
    const all = conf.model_list?.item_list ?? []
    const keys = new Set((mode?.support_models ?? []).map((m) => String(m?.model_item_key)))
    // no modes at all: the shared list is the only one; modes without a
    // work task (another app's list) give none
    items = keys.size ? all.filter((i) => keys.has(String(i?.model_item_key))) : mode || modes.length ? [] : all
  }
  const rows = []
  for (const i of items ?? []) {
    const label = String(i?.name ?? "").trim()
    if (!label) continue
    const opts = i.reasoning_effort_config?.option_list ?? []
    const efforts = opts.map((o) => String(o?.name ?? "").trim()).filter(Boolean)
    const def = opts.find((o) => o?.level === i.reasoning_effort_config?.default_level)
    rows.push({ label, key: String(i.model_item_key ?? ""), efforts, effort: def ? String(def.name).trim() : "", upgrade: !!i.subscribe_config?.need_upgrade })
  }
  return rows.length ? rows : null
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
  { name: "豆包工作", bundle: "com.work.pc.doubao", mac: "DoubaoWork.app/Contents/MacOS/DoubaoWork", win: ["DoubaoWork", "Application", "app", "DoubaoWork.exe"], sub: "doubaowork", download: "https://www.doubao.com/work" },
  { name: "豆包", bundle: "com.bot.pc.doubao", mac: "Doubao.app/Contents/MacOS/Doubao", win: ["Doubao", "Application", "app", "Doubao.exe"], sub: "", download: "https://www.doubao.com/download/desktop" },
]

// places lists where an app can be installed: /Applications, then
// ~/Applications on macOS; %LOCALAPPDATA% on Windows.
export function places(app, platform = process.platform, home = os.homedir()) {
  if (platform === "darwin") return [path.posix.join("/Applications", app.mac), path.posix.join(home, "Applications", app.mac)]
  if (platform === "win32") return [path.win32.join(localAppData(home), ...app.win)]
  return []
}

// Where the app is installed when it is not in the usual place. The system
// knows: Windows keeps an uninstall entry (InstallLocation, DisplayIcon,
// UninstallString), an App Paths entry and the path of a running copy;
// macOS's Spotlight knows every bundle by its identifier, and a running
// copy has its path in ps. Each finder returns paths (files or folders) the
// install may be under; installedAt turns them into the app's binary.
const WIN_PROBE = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$o = @()
foreach ($r in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') {
  Get-ItemProperty $r -ErrorAction SilentlyContinue | Where-Object { ($_.PSChildName + $_.DisplayIcon + $_.UninstallString + $_.InstallLocation) -match 'Doubao' } | ForEach-Object { $o += $_.InstallLocation, $_.DisplayIcon, $_.UninstallString }
}
foreach ($r in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\') {
  foreach ($e in 'DoubaoWork.exe', 'Doubao.exe') { $k = Get-ItemProperty ($r + $e) -ErrorAction SilentlyContinue; if ($k) { $o += $k.'(default)', $k.Path } }
}
Get-CimInstance Win32_Process -Filter "Name='DoubaoWork.exe' or Name='Doubao.exe'" -ErrorAction SilentlyContinue | ForEach-Object { $o += $_.ExecutablePath }
ConvertTo-Json -Compress -InputObject @($o | Where-Object { $_ })
`

// hintsWin lists the paths Windows has for 豆包工作 and 豆包.
export function hintsWin(run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })) {
  try {
    const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_PROBE])
    const list = JSON.parse(out.trim() || "[]")
    return (Array.isArray(list) ? list : [list]).filter((x) => typeof x === "string" && x.trim())
  } catch {
    return []
  }
}

// hintsMac lists the app bundles Spotlight knows by identifier, then the
// paths of running copies.
export function hintsMac(run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] })) {
  const out = []
  for (const app of APPS) {
    try {
      out.push(...run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${app.bundle}'`]).split("\n"))
    } catch {}
  }
  try {
    for (const l of run("/bin/ps", ["-axo", "comm="]).split("\n")) if (/\.app\/Contents\/MacOS\/Doubao(Work)?$/.test(l.trim())) out.push(l.trim())
  } catch {}
  // Spotlight may be off or not indexing that disk: look one folder down
  // in the places apps are put as well
  const roots = ["/Applications", path.join(os.homedir(), "Applications")]
  try { for (const v of fs.readdirSync("/Volumes")) roots.push(path.join("/Volumes", v), path.join("/Volumes", v, "Applications")) } catch {}
  for (const r of roots.slice()) {
    try { for (const e of fs.readdirSync(r, { withFileTypes: true })) if (e.isDirectory() && !e.name.endsWith(".app")) roots.push(path.join(r, e.name)) } catch {}
  }
  for (const r of roots) for (const app of APPS) out.push(path.join(r, app.mac.split("/")[0]))
  return out.map((l) => l.trim()).filter(Boolean)
}

let hinted
const systemHints = (platform) => {
  if (platform !== "win32" && platform !== "darwin") return []
  return (hinted ??= {})[platform] ??= platform === "win32" ? hintsWin() : hintsMac()
}

// installedAt turns hint paths into the binaries app could have there.
// A hint may be the exe, a folder, or a command ("\"D:\\x\\uninstall.exe\" /S",
// "D:\\x\\icon.ico,0"): the quotes and the icon index are taken off, and the
// folder it names and the three above it are tried, each as <dir>\app\<exe>
// and <dir>\<exe>. On macOS a hint is a .app folder or a binary inside one.
export function installedAt(app, hints, platform = process.platform) {
  const out = []
  const add = (p) => { if (p && !out.includes(p)) out.push(p) }
  if (platform === "darwin") {
    const suffix = "/" + app.mac
    for (const h of hints) {
      const i = h.indexOf(".app")
      if (i < 0) continue
      const bundle = h.slice(0, i + 4)
      if (bundle.endsWith("/" + app.mac.split("/")[0])) add(bundle + "/" + app.mac.split("/").slice(1).join("/"))
    }
    return out
  }
  if (platform !== "win32") return out
  const W = path.win32
  const exe = app.win[app.win.length - 1]
  for (const h of hints) {
    let p = String(h).trim()
    const q = p.match(/^"([^"]+)"/)
    p = q ? q[1] : p.replace(/\s+\/[A-Za-z].*$/, "").replace(/,-?\d+$/, "")
    p = p.replace(/[\\/]+$/, "")
    if (!/^[A-Za-z]:\\|^\\\\/.test(p)) continue
    if (W.basename(p).toLowerCase() === exe.toLowerCase()) add(p)
    let d = /\.[A-Za-z0-9]{1,5}$/.test(W.basename(p)) ? W.dirname(p) : p
    for (let n = 0; n < 4; n++) {
      add(W.join(d, "app", exe))
      add(W.join(d, "Application", "app", exe))
      add(W.join(d, exe))
      const up = W.dirname(d)
      if (up === d) break
      d = up
    }
  }
  return out
}

// choose picks the app to drive: { app, binary, dataDir }. DOUBAO_WORK_APP
// names the binary outright. A user already signed in to 豆包 through this
// plugin (its profile exists) stays on 豆包 while it is installed, so an
// update never signs them out. Otherwise the first app installed, 豆包工作
// first; with neither, 豆包工作's own place, so the error names it. An app
// is looked for in its usual place first, then where the system says it was
// installed (find returns those hints; it runs once, and only when a usual
// place has nothing). On Linux the binary is "".
export function choose(platform = process.platform, home = os.homedir(), exists = fs.existsSync, find = exists === fs.existsSync ? systemHints : () => []) {
  const P = platform === "win32" ? path.win32 : path.posix
  const base = dataDir(platform, home)
  const out = (app, bin) => ({ app, binary: bin, dataDir: app.sub ? P.join(base, app.sub) : base })
  const [work, doubao] = APPS
  if (process.env.DOUBAO_WORK_APP) {
    const bin = process.env.DOUBAO_WORK_APP
    return out(/doubaowork/i.test(bin) ? work : doubao, bin)
  }
  let hints
  const found = (app) => {
    const usual = places(app, platform, home).find((p) => exists(p))
    if (usual) return usual
    hints ??= find(platform) ?? []
    return installedAt(app, hints, platform).find((p) => exists(p))
  }
  const old = exists(P.join(base, "profile")) ? found(doubao) : ""
  if (old) return out(doubao, old)
  for (const app of APPS) {
    const bin = found(app)
    if (bin) return out(app, bin)
  }
  return out(work, places(work, platform, home)[0] ?? "")
}

// binary is the executable choose picks.
export function binary(platform = process.platform, home = os.homedir(), exists = fs.existsSync, find) {
  return choose(platform, home, exists, find).binary
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
// dismiss closes a menu left open: a pointerdown outside it, as Radix
// takes one. A menu can stay open after its item is pressed (its closing
// animation waits for a frame a window in the background doesn't draw),
// and an open menu keeps the focus, so Enter would not send.
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

// pickModel picks the model whose menu row is label. A row's first line
// is the model's name, maybe followed by a badge ("限时优惠", "0.01x"): a
// row is taken by its exact name first, then by the name and a badge, never
// by a longer name ("Kimi K3.1 Pro" is not "Kimi K3.1 Pro 高速").
export const pickModel = (label) =>
  js(`
  const label = ${JSON.stringify(label)};
  const b = $("[data-testid=chat_input_action_model]");
  if (!b) return "no model button";
  if (b.innerText.split("\\n")[0].trim() === label) return "";
  const esc = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const first = (e) => e.innerText.split("\\n")[0].trim();
  const badge = (t) => t.startsWith(label + " ") && /^(限时|优惠|小额|免费|新|热|推荐|hot|new|beta|[\\d.]+\\s*[x×倍]|[x×]\\s*[\\d.]+)/i.test(t.slice(label.length + 1).trim());
  press(b);
  let it;
  for (let i = 0; i < 20 && !it; i++) {
    await wait(100);
    const rows = $$("[role=menu] [role=menuitem]").filter((e) => e.getAttribute("aria-haspopup") !== "menu");
    it = rows.find((e) => first(e) === label) || rows.find((e) => badge(first(e)));
  }
  if (!it) { esc(); return "no " + label + " in the model menu"; }
  if (it.innerText.includes("升级")) { esc(); return "upgrade"; }
  press(it);
  await wait(200);
  return "";
`)

// EFFORT sets the 推理强度 of the model picked: the model button shows it
// under the model's name ("自动\n中"); otherwise the model menu's 推理强度
// row opens a submenu (hovered, then ArrowRight, as Radix opens one) and
// the level is pressed there.
export const EFFORT = (name) =>
  js(`
  const name = ${JSON.stringify(name)};
  const b = $("[data-testid=chat_input_action_model]");
  if (!b) return "no model button";
  const now = () => b.innerText.split("\\n").map((x) => x.trim()).filter(Boolean)[1] || "";
  if (now() === name) return "";
  const esc = () => { for (let i = 0; i < 2; i++) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); };
  press(b);
  let row;
  for (let i = 0; i < 20 && !row; i++) { await wait(100); row = $$("[role=menu] [role=menuitem]").find((e) => e.getAttribute("aria-haspopup") === "menu" && e.innerText.includes("推理强度")); }
  if (!row) { esc(); return "no 推理强度 in the model menu"; }
  for (const t of ["pointerenter", "pointermove", "pointerover"]) row.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerType: "mouse" }));
  row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  let it;
  for (let i = 0; i < 20 && !it; i++) { await wait(100); it = $$("[role=menu]").filter((m) => !m.contains(row)).flatMap((m) => $$("[role=menuitem]", m)).find((e) => e.innerText.split("\\n")[0].trim() === name); }
  if (!it) { esc(); return "no " + name + " under 推理强度"; }
  press(it);
  for (let i = 0; i < 10 && now() !== name; i++) await wait(100);
  await dismiss();
  return now() === name ? "" : "推理强度 stayed " + now();
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
    .map((e) => { const l = e.innerText.split("\\n").map((x) => x.trim()).filter(Boolean); return { label: l[0] || "", lines: l.slice(1), upgrade: e.innerText.includes("升级") }; })
    .filter((r) => r.label);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return { rows };
`)

// fill puts the prompt in the editor, one paragraph a line: that is how
// Doubao sends newlines (a hard break is dropped).
export const fill = (text) =>
  js(`
  await dismiss();
  const ed = $(".ProseMirror") && $(".ProseMirror").editor;
  if (!ed) return -1;
  const lines = ${JSON.stringify(String(text).split("\n"))};
  ed.chain().clearContent(true).insertContent(lines.map((l) => ({ type: "paragraph", content: l ? [{ type: "text", text: l }] : [] }))).focus("end").run();
  return ed.getText({ blockSeparator: "\\n" }).length;
`)

// SEND presses the send button; false when there is none to press.
export const SEND = js(`
  await dismiss();
  const b = $("[data-testid=chat_input_send_button]");
  if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
  b.click();
  return true;
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

// QUOTA asks the app's own page for the plan's allowance, the way the
// page's 订阅 view does (its cookies sign the call).
export const QUOTA = js(`
  try {
    const r = await fetch("https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j };
  } catch (e) { return { error: String(e && e.message || e) }; }
`)

// BOT_ID is the bot Doubao's page names when it asks for its action bar
// (the app's code has it as a constant); without it brief_list answers
// 710010202.
export const BOT_ID = "7338286299411103781"

// LIST asks Doubao for the action bar its own page builds the model menu
// from (POST /alice/slot/action_bar_v3/brief_list), the way the page does:
// with the page's cookies and the query the page sends (version_code, aid,
// device_id...; the bare path answers 710010702). The query is taken from
// the page's own brief_list call, or from any other /alice/ call it made.
// It returns the deep-thinking entry's menu_conf_v2 with the icons left out.
export const LIST = js(`
  const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.startsWith("https://www.doubao.com/alice/"));
  const own = urls.filter((u) => u.includes("/brief_list?")).pop();
  let url = own;
  if (!url) {
    const any = urls.filter((u) => u.includes("?")).pop();
    const q = new URL(any || "https://www.doubao.com/alice/?").searchParams;
    q.delete("msToken"); q.delete("a_bogus");
    url = "https://www.doubao.com/alice/slot/action_bar_v3/brief_list?" + q;
  }
  try {
    const r = await fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot_id: ${JSON.stringify(BOT_ID)}, language_code: "zh" }) });
    const j = await r.json().catch(() => null);
    if (!j || j.code !== 0) return { status: r.status, code: j && j.code, msg: j && j.msg };
    const e = ((j.data && j.data.entry_list) || []).find((e) => e.action_bar_key === "coco_deep_thinking");
    const v = e && e.active_switch_conf && e.active_switch_conf.menu_conf_v2;
    const bare = (x) => JSON.parse(JSON.stringify(x == null ? null : x, (k, val) => (/icon/i.test(k) ? undefined : val)));
    return { status: r.status, code: 0, conf: bare(v) };
  } catch (e) { return { error: String(e && e.message || e) }; }
`)

const HOUR = 3600000
// quotaOf turns quota/summary into magpie's usage: the plan's short name
// and one window per limit, as a percent used. A window names its span when
// the reply gives one; without times it is just 额度.
export function quotaOf(read) {
  const d = read?.body?.data
  if (!d || typeof d !== "object") return null
  const groups = [...(d.window_limit_section?.window_limit_groups ?? []), ...(d.enterprise_window_limit_section?.window_limit_groups ?? [])]
  const windows = []
  for (const g of groups)
    for (const w of g?.window_limits ?? []) {
      const pct = Number(w?.used_percent)
      if (!Number.isFinite(pct)) continue
      const span = Number(w.end_time) - Number(w.start_time)
      let name = "额度"
      if (w.start_time > 0 && span > 0) name = span <= 6 * HOUR ? "5 小时" : span <= 8 * 24 * HOUR ? "每周" : "本月"
      const out = { name, used: Math.max(0, Math.min(100, pct)) }
      if (w.less_than_one_percent && pct === 0) out.display = "不到 1%"
      if (w.end_time > 0) out.resetsAt = Number(w.end_time)
      windows.push(out)
    }
  const exhausted = d.window_limit_section?.usage_exhausted === true || d.enterprise_window_limit_section?.usage_exhausted === true
  if (exhausted) for (const w of windows) w.used = 100
  return { plan: String(d.current_subscription?.display?.short_name || d.current_subscription?.display?.product_name || ""), windows }
}

export const usageOf = (raw) => {
  try {
    const u = typeof raw === "string" ? JSON.parse(raw) : raw
    const n = ["system_prompt", "messages", "skills", "tools"].reduce((s, k) => s + (Number(u?.[k]) || 0), 0)
    return n > 0 ? n : 0
  } catch {
    return 0
  }
}

// CACHE is the models.json format: 2 since the list comes from brief_list.
const CACHE = 2

// rateIn finds the multiple the model menu shows for the model named label:
// its row is the one with that name, or that name and a badge ("Kimi K3
// 0.65x") when no other model has the longer name.
export function rateIn(menu, label, rows = []) {
  for (const r of menu ?? []) {
    const l = String(r?.label ?? "").trim()
    if (l === label) return Number(r.rate) || rateOf(r.lines)
  }
  for (const r of menu ?? []) {
    const l = String(r?.label ?? "").trim()
    if (l.startsWith(label + " ") && !rows.some((o) => o.label !== label && l.startsWith(o.label) && o.label.length > label.length))
      return Number(r.rate) || rateOf([l.slice(label.length), ...(r.lines ?? [])])
  }
  return 0
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
    this.missAt = 0
    this.readAt = 0
    this.cacheFile = this.app?.dataDir ? path.join(this.app.dataDir, "models.json") : ""
    this.table = null
    this.tableAt = 0
    this.page = null
    this.queue = Promise.resolve()
  }

  // modelList is what the plugin offers: the list read last time, or the
  // fallback before it has ever been read. It never opens the app — the
  // list is read by discover(), on sign-in and on a stale request. A
  // models.json older than CACHE is not used: up to 0.1.9 it could hold the
  // 对话 menu's 快速 and 专家, so it is read again.
  modelList() {
    if (this.table) return this.table
    try {
      const d = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"))
      if (d?.v === CACHE && d?.models && typeof d.at === "number" && Object.keys(d.models).length) {
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
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE, at: this.tableAt, models: table }, null, 1))
      fs.renameSync(tmp, this.cacheFile)
    } catch {}
  }

  // discover reads the models Doubao's 工作任务 offers and keeps them. It
  // asks Doubao's own list first (LIST), the one the page builds its menu
  // from. When that can't be read it reads the model menu of a new work
  // task: the page may sit on a 对话 page, whose menu (快速, 专家) is
  // another list. Nothing is sent, so no task runs. inTask says the page is
  // on a new work task already (ask), so its menu is read too, for the
  // multiple each model costs, which only the menu shows.
  async discover({ signal, inTask = false } = {}) {
    const page = await this.connect(signal)
    const old = this.modelList()
    let rows = null
    try { rows = listOf(await page.eval(LIST)) } catch {}
    let menu = null
    if (!rows || inTask) {
      if (!inTask) {
        const why = await page.eval(NEW_TASK)
        if (why) throw new DoubaoError("豆包读取模型列表失败：" + why, "doubao_ui")
      }
      const read = await page.eval(MENU)
      if (read?.error && !rows) throw new DoubaoError("豆包读取模型列表失败：" + read.error, "doubao_ui")
      menu = read?.rows ?? null
    }
    if (!rows) rows = menu
    else if (menu) rows = rows.map((r) => ({ ...r, rate: rateIn(menu, r.label, rows) }))
    const table = tableFrom(rows)
    // a model whose multiple the menu didn't show this time keeps the one
    // it showed before
    for (const m of Object.values(table)) {
      const was = Object.values(old).find((o) => o?.label === m.label)
      if (!(m.rate > 0) && was?.rate > 0) m.rate = was.rate
    }
    this.#save(table)
    return table
  }

  // ensureList reads the menu once when it has never been read, for an
  // account that signed in before the plugin read menus (or whose sign-in
  // read failed): without it the list stays at the three built-in models
  // until the first request. Only an app this plugin has started before
  // (its data folder exists) is opened for it; a failed read is tried
  // again after a minute. It queues behind a running ask.
  async ensureList({ signal } = {}) {
    this.modelList()
    if (this.tableAt || !this.app?.start || !this.cacheFile) return
    if (!fs.existsSync(path.dirname(this.cacheFile)) || Date.now() - this.readAt < 60000) return
    this.readAt = Date.now()
    const run = this.queue.then(() => this.tableAt || this.discover({ signal }))
    this.queue = run.catch(() => {})
    try { await run } catch {}
  }

  // known says whether Doubao offers model. A model the list read last
  // doesn't have sends the plugin back to the menu at once (Doubao adds
  // models between reads, #1048), at most once a minute, so a client
  // asking for a name Doubao never had doesn't open the menu each time.
  // The read waits its turn behind a running ask: both press the same
  // controls.
  async known(model, { signal } = {}) {
    if (lookup(this.modelList(), model)) return true
    if (!this.app?.start || Date.now() - this.missAt < 60000) return false
    this.missAt = Date.now()
    const run = this.queue.then(() => this.discover({ signal }))
    this.queue = run.catch(() => {})
    try { await run } catch { return false }
    return !!lookup(this.modelList(), model)
  }

  // quota reads the plan's allowance through the app's page. Only an app
  // this plugin has started before is opened for it (its data folder
  // exists), so a usage read never launches Doubao for a user who has
  // not signed in here.
  async quota({ signal } = {}) {
    if (!(this.page && !this.page.closed)) {
      if (!this.app?.start) throw new DoubaoError("没有找到豆包。", "app_missing")
      if (this.app.dataDir && !fs.existsSync(this.app.dataDir)) throw new DoubaoError("还没有登录过豆包工作窗口。", "doubao_signin")
    }
    const page = await this.connect(signal)
    return page.eval(QUOTA)
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

  // reload loads the chat page again: a running app keeps the model menu
  // it loaded when it started, and Doubao adds models in between.
  async #reload(page, signal) {
    await page.call("Page.reload", { ignoreCache: true })
    for (const until = Date.now() + 30000; Date.now() < until; ) {
      await sleep(500, signal)
      let s
      try { s = await page.eval(STATE) } catch { continue }
      if (s?.input) return
    }
    throw new DoubaoError("豆包的页面重新加载后没有打开。", "doubao_ui")
  }

  // effort is the client's reasoning_effort ("low" ... "max"); "" is the
  // model's own default.
  async #ask(prompt, { model = "auto", effort = "", signal, onUpdate = () => {} }) {
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
    // refresh the list while here when it has not been read for a while
    if (this.cacheFile && this.stale()) { try { await this.discover({ signal, inTask: true }) } catch {} }
    const table = this.modelList()
    const m = lookup(table, model) ?? table.auto ?? MODELS.auto
    const label = m.label
    let picked = await page.eval(pickModel(label))
    if (/^no .* in the model menu$/.test(picked)) {
      // the list has it and the menu doesn't: the menu is the one the page
      // loaded with, older than the list. Load the page again, once.
      await this.#reload(page, signal)
      await step(NEW_TASK, "新建任务")
      await step(CLOUD, "切换到云电脑")
      picked = await page.eval(pickModel(label))
    }
    if (picked === "upgrade") throw new DoubaoError(`${label} 需要升级豆包会员。`, "doubao_upgrade", { status: 403 })
    if (picked) throw new DoubaoError(`豆包选择模型失败：${picked}`, "doubao_ui")
    // no effort asked: the model's own default, not the level the last
    // request left the app on (the app keeps that)
    const level = effortFor(effort, m.efforts) || (m.efforts?.includes(m.effort) ? m.effort : "")
    if (level) await step(EFFORT(level), "设置推理强度")
    const n = await page.eval(fill(prompt))
    if (n < 0) throw new DoubaoError("豆包的输入框没有找到。", "doubao_ui")
    signal?.throwIfAborted()
    // the send button, as a person sends; Enter when there is none. Enter
    // alone was seen not to send while a menu of the page stayed open.
    if (!(await page.eval(SEND))) await page.key("Enter", { keyCode: 13, text: "\r" })
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
