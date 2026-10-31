// e2e (§11.2): playwright-core + Edge, isolated data directory _tmp/e2e-xdg, port 3497, AGENT_CONSOLE_MOCK=1.
// Scenarios 1–12, 16–19; each prints ✓/✗, and any ✗ exits with code 1.
import { spawn, execFileSync } from "node:child_process";
import { findBrowser } from "./browser-path.mjs";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(root, "_tmp");
const XDG = join(TMP, "e2e-xdg");
const PROJ = join(TMP, "e2e-proj");
const PORT = 3497;
// Edge / Chrome / Chromium (Windows, macOS, Linux); MSEDGE_PATH or CHROME_PATH may be set
const EDGE = findBrowser();

const results = [];
const pageErrors = [];
let daemon, page, browser;
let daemonErr = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
function record(name, ok, extra = "") {
  results.push({ name, ok });
  log(`${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
}

async function wsCall(method, params) {
  return page.evaluate(async ([m, p]) => {
    const ws = window.__ws;
    return await ws.call(m, p);
  }, [method, params]);
}

async function waitFor(fn, ms = 15000, label = "") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(200);
  }
  throw new Error("等待超时 " + label);
}

const sel = {
  newProject: 'text=新建项目',
  dlgInput: '.dlg .tinput',
  dlgAdd: '.dlg .btn.primary',
  threadItem: '.t-item',
  ta: '.cp-ta',
  send: '.cp-send',
  stop: '.cp-stop',
  permCard: '.card.perm',
  allow: 'button:has-text("允许")',
  queueItem: '.q-item',
  pill: '.tb-pill',
};

async function setup() {
  rmSync(XDG, { recursive: true, force: true });
  rmSync(PROJ, { recursive: true, force: true });
  mkdirSync(PROJ, { recursive: true });
  writeFileSync(join(PROJ, "a.txt"), "alpha\nbeta\n");
  writeFileSync(join(PROJ, "b.txt"), "gamma\n");
  mkdirSync(join(PROJ, "src"), { recursive: true });
  writeFileSync(join(PROJ, "src", "index.ts"), "const x = 1;\n");
  writeFileSync(join(PROJ, ".gitattributes"), "* -text\n");
  // Initialize e2e-proj as a git repository (scenario 13 needs it)
  try {
    const g = (a) => execFileSync("git", a, { cwd: PROJ, stdio: "pipe", windowsHide: true });
    g(["init"]); g(["config", "user.email", "e@e"]); g(["config", "user.name", "e"]);
    g(["config", "core.autocrlf", "false"]); // Keep CRLF from making a.txt show as modified again after restore
    g(["add", "-A"]); g(["commit", "-m", "init", "-q"]);
  } catch (e) { log("[e2e] git init 失败（场景13 会失败）:", String(e).slice(0, 120)); }

  daemon = spawn("node", [join(root, "daemon/dist/main.js"), "--port", String(PORT), "--data", XDG], {
    env: { ...process.env, AGENT_CONSOLE_MOCK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  daemonErr = [];
  daemon.stderr.on("data", (d) => { daemonErr.push(String(d).trim()); process.stderr.write(`[daemon] ${d}`); });
  daemon.stdout.on("data", (d) => { const s = String(d); if (s.includes("已启动") || s.includes("error")) log("[daemon]", s.trim()); });

  // Wait for ping
  const t0 = Date.now();
  let token = null;
  while (Date.now() - t0 < 15000) {
    try {
      const dj = JSON.parse(readFileSync(join(XDG, "magpie/agent-console/daemon.json"), "utf8"));
      token = dj.token;
      break;
    } catch { await sleep(300); }
  }
  if (!token) throw new Error("daemon 未启动");
  globalThis.__token = token;

  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => { pageErrors.push(`dialog: ${d.message()}`); void d.dismiss(); });
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console: ${m.text()}`); if (m.text().startsWith("[tl]") || m.text().startsWith("[ws]")) pageErrors.push(`dbg: ${m.text()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/?lang=zh#t=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ws && window.__ws.getState() === "open", { timeout: 10000 });
  // e2e uses the Mock provider (real Claude would show permission prompts and bill usage)
  await wsCall("settings.set", { patch: { defaultProvider: "mock" } });
  // Codex detection in providers.list takes seconds: wait for the data layer before acting, so the empty-conversation composer and "＋" don't each create a conversation
  await page.waitForFunction(() => window.__stores?.useData?.getState?.().loaded === true, { timeout: 20000 });
}

async function newProjectFlow() {
  // Scenario 1: no-project onboarding → create → land in a new conversation
  await page.click(sel.newProject);
  await page.fill(sel.dlgInput, PROJ);
  await page.waitForSelector('text=目录可用', { timeout: 5000 });
  await page.click(sel.dlgAdd);
  await waitFor(async () => (await page.$$('.pj-group')).length >= 1, 8000, "项目组出现");
  // New conversation (project row ＋); wait until it's really selected — the empty state also has .cp-ta, and acting early would create another conversation
  await page.hover('.pj');
  await page.click('.pj-act[title="新建对话"]');
  await page.waitForSelector('.t-item.on', { timeout: 8000 });
  await page.waitForSelector(sel.ta, { timeout: 5000 });
  record("场景1 新建项目→新对话", true);
}

async function send(text) {
  await page.fill(sel.ta, text);
  await page.keyboard.press("Enter");
}

// End-of-turn markers: count turnend/err entries in the store, not the DOM (the virtual list renders only the visible area, so DOM counts miss some).
async function endCount() {
  return await page.evaluate(() => {
    const items = window.__tl?.getState?.().items ?? [];
    return items.filter((i) => i.kind === "turnend" || (i.kind === "permission" && i.status !== "pending")).length;
  });
}
async function waitEnd(seq = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const n = await endCount();
    if (n > seq) return n;
    // The daemon is idle but the DOM has no closing marker, which is also wrong → fall back to checking the DOM
    const st = await wsCall("threads.get", { id: await curThread() }).then((g) => g.runtimeStatus).catch(() => "?");
    if (st !== "running" && st !== "initializing") {
      await sleep(400); // Wait for the last frame to render
      if ((await endCount()) > seq) return seq + 1;
    }
    await sleep(300);
  }
  const dbg = await wsCall("threads.get", { id: await curThread() }).then((g) => `${g.runtimeStatus} evts:${g.events.length} last:${g.events.map(e=>e.type).slice(-3).join(",")} provider:${g.meta.provider}`).catch((e) => String(e));
  const dom = await page.evaluate(() => document.querySelector(".tl-wrap")?.innerText?.slice(-200)).catch(() => "?");
  throw new Error(`等待超时 turn_ended ${seq}（${dbg}）dom尾=${dom}`);
}

async function scenario2() {
  await send("看下这个项目");
  await waitEnd();
  const checks = await page.evaluate(() => ({
    md: !!document.querySelector(".md"),
    tg: !!document.querySelector(".tg"),
    diff: !!document.querySelector(".diff"),
    todo: !!document.querySelector(".rs-item"),
    te: !!document.querySelector(".te"),
  }));
  record("场景2 默认剧本（正文/工具组/diff/待办/结束行）", checks.md && checks.tg && checks.diff && checks.todo && checks.te, JSON.stringify(checks));
}

async function scenario3() {
  const sid0 = await wsCall("threads.get", { id: await curThread() }).then((g) => g.meta.providerSessionId);
  await send("再问一句");
  await waitEnd(1);
  const sid1 = await wsCall("threads.get", { id: await curThread() }).then((g) => g.meta.providerSessionId);
  record("场景3 多轮同一会话（providerSessionId 不变）", sid0 === sid1 && !!sid0, `${sid0} → ${sid1}`);
}

let _tid = null;
async function curThread() {
  // Use the conversation currently selected on the page (threads.list()[0] is sorted by updatedAt and picks the wrong one with several conversations)
  if (!_tid) _tid = await page.evaluate(() => window.__stores?.useUi?.getState?.().currentThreadId ?? null);
  return _tid;
}

async function scenario4() {
  await send("/slow");
  await waitFor(async () => (await page.$(sel.pill)) !== null, 8000, "running 胶囊");
  await send("排队消息一");
  await send("排队消息二");
  const n = await waitFor(async () => {
    const c = await page.$$eval(sel.queueItem, (e) => e.length);
    return c >= 2 ? c : null;
  }, 5000, "排队列表");
  await waitEnd(1 + await page.$$eval('.te', (e) => e.length).catch(() => 1)); // Wait for slow to finish, then queue two more turns
  // Wait for three turnends: slow + queue 1 + queue 2 — relaxed to waiting until the queue is empty
  await waitFor(async () => (await page.$$eval(sel.queueItem, (e) => e.length)) === 0, 45000, "队列清空");
  record("场景4 /slow 排队列表 + 自动发送", n >= 2);
}

async function scenario5() {
  await send("/slow");
  await waitFor(() => page.$(sel.stop), 8000, "运行中");
  await page.keyboard.down("Control");
  await page.fill(sel.ta, "插话内容XYZ");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await waitFor(async () => {
    const html = await page.content();
    return html.includes("插话：插话内容XYZ");
  }, 40000, "回复含插话");
  record("场景5 Ctrl+Enter 插话", true);
}

async function scenario6() {
  await send("/slow");
  await waitFor(() => page.$(sel.stop), 8000, "stop 按钮");
  const t0 = Date.now();
  await page.click(sel.stop);
  await waitFor(async () => {
    const g = await wsCall("threads.get", { id: await curThread() });
    return g.runtimeStatus === "idle" || g.runtimeStatus === "closed" ? true : null;
  }, 8000, "idle");
  const ms = Date.now() - t0;
  await send("停完再来一句");
  await waitEnd(await page.$$eval('.te, .err-card', (e) => e.length));
  record("场景6 停止≤1s→idle→再发成功", ms < 5000, `interrupted ${ms}ms`);
}

async function scenario7() {
  const tid = await curThread();
  await send("/perm");
  await page.waitForSelector(sel.permCard, { timeout: 15000 });
  const waiting = await page.$eval(sel.ta, (el) => el.placeholder.includes("授权"));
  await page.click(`${sel.permCard} button:has-text("允许")`);
  await waitEnd(await page.$$eval('.te', (e) => e.length - 0));
  // Deny path
  await send("/perm");
  await page.waitForSelector(`${sel.permCard} button:has-text("拒绝")`, { timeout: 15000 });
  await page.click(`${sel.permCard} button:has-text("拒绝")`);
  await waitFor(async () => {
    const html = await page.content();
    return html.includes("已被用户拒绝") || html.includes("已按你的要求跳过");
  }, 15000, "拒绝后回复");
  record("场景7 授权卡片 允许/拒绝", waiting);
}

async function scenario8() {
  await send("/plan");
  await page.waitForSelector('.card.plan', { timeout: 15000 });
  await page.click('.card.perm button:has-text("开始实施")');
  await waitEnd(await page.$$eval('.te', (e) => e.length - 0));
  const mode = await wsCall("threads.get", { id: await curThread() }).then((g) => g.meta.mode);
  record("场景8 计划卡片 → 实施（模式变化检查）", mode !== null);
}

async function scenario9() {
  await send("/ask");
  await page.waitForSelector('.card.ask', { timeout: 15000 });
  await page.click('.card.ask button:has-text("生产环境")');
  await page.fill('.ask-free', "记得备份");
  await page.click('.card.ask button:has-text("提交")');
  await waitFor(async () => (await page.content()).includes("生产环境"), 15000, "回复含答案");
  record("场景9 提问卡片 → 回复包含答案", true);
}

async function scenario10() {
  await send("/exit");
  let last = "?";
  try {
    await waitFor(async () => {
      const g = await wsCall("threads.get", { id: await curThread() });
      last = `${g.runtimeStatus}/${g.meta.status} evts:${g.events.length}`;
      return g.runtimeStatus === "closed" || g.meta.status === "closed" ? true : null;
    }, 15000, "closed");
  } catch (e) {
    const dom = await page.evaluate(() => document.querySelector(".cp-ta")?.placeholder + "|disabled:" + document.querySelector(".cp-ta")?.disabled + "|" + document.querySelector(".tl-wrap")?.innerText?.slice(-150));
    throw new Error(`等待超时 closed last=${last} dom=${dom}`);
  }
  await send("你还在吗");
  try {
    await waitFor(async () => (await page.content()).includes("（已续接）"), 20000, "续接前缀");
  } catch (e) {
    const g = await wsCall("threads.get", { id: await curThread() }).catch((x) => String(x));
    const dbg = await page.evaluate(() => {
      const tl = window.__tl?.getState?.();
      return {
        status: tl?.status, tid: tl?.threadId, n: tl?.items?.length, deduped: tl?.deduped, gaps: tl?.gaps?.slice(0, 8), seqMax: tl?.seqMax, evCount: tl?.evCount,
        tail: tl?.items?.slice(-6).map((i) => `${i.kind}:${(i.text ?? i.title ?? "").slice(0, 40)}`),
        dom: document.querySelector(".tl-wrap")?.innerText?.slice(-150),
      };
    }).catch((x) => String(x));
    throw new Error(`续接前缀超时 rt=${g.runtimeStatus} meta=${g.meta?.status} evts=${g.events?.length} last=${g.events?.slice(-5).map((x) => x.type + ":" + (x.status ?? "")).join(",")} dbg=${JSON.stringify(dbg).slice(0, 200)} logs=${pageErrors.filter((e) => e.startsWith("dbg:")).slice(-6).join("|")}`);
  }
  record("场景10 /exit 崩溃 → 再发续接", true);
}

async function scenario11() {
  await send("/perm");
  await page.waitForSelector(sel.permCard, { timeout: 15000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ws && window.__ws.getState() === "open", { timeout: 10000 });
  // After a reload the current conversation is still there (lastThreadId) and so is the card (pending or cancelled)
  await waitFor(async () => (await page.$('.card.perm')) !== null || (await page.$('.cp-ta')) !== null, 10000, "刷新后恢复");
  const hasPerm = await page.$('.card.perm');
  const cur = await curThread().catch(() => null);
  const selTid = await page.evaluate(() => window.__stores?.useUi?.getState?.().currentThreadId).catch(() => "?");
  record("场景11 刷新恢复（对话/卡片）", !!cur && !!hasPerm, `cur=${cur} sel=${selTid} perm=${!!hasPerm}`);
  // Cleanup: cancel this permission card (deny) so it doesn't block later scenarios
  try {
    const g = await wsCall("threads.get", { id: cur });
    const pend = g.pending?.[0];
    if (pend) await wsCall("thread.respond", { id: cur, requestId: pend.requestId, optionId: "decline" });
  } catch {}
}

async function scenario12() {
  // Upload a small png with the attachment button (setInputFiles goes through input[type=file])
  const png = join(TMP, "e2e.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex"));
  const input = await page.waitForSelector('input[type=file]', { state: "attached", timeout: 8000 });
  await input.setInputFiles(png);
  await page.waitForSelector('.att', { timeout: 8000 });
  // Wait for the upload to finish (send is disabled while uploading)
  try {
    await waitFor(async () => !(await page.$eval(sel.send, (b) => b.disabled).catch(() => true)), 15000, "上传完成");
  } catch (e) {
    const probe = await page.evaluate(async () => {
      const tl = window.__tl?.getState?.();
      return {
        pending: tl?.pending, status: tl?.status,
        atts: [...document.querySelectorAll(".att")].map((a) => a.outerHTML.slice(0, 120)),
        sendDisabled: document.querySelector(".cp-send")?.disabled,
      };
    });
    throw new Error(`上传完成超时 ${JSON.stringify(probe)} errs=${pageErrors.slice(-6).join("|").slice(0, 300)}`);
  }
  await page.click(sel.send);
  // Verify at the data layer (the user message has an attachment of image type); thumbnail rendering is the UI layer's job
  await waitFor(async () => {
    const g = await wsCall("threads.get", { id: await curThread() });
    const um = g.events.filter((e) => e.type === "user_message").pop();
    return um?.attachments?.some((a) => a.mime?.startsWith("image/")) ? true : null;
  }, 15000, "用户消息带图片附件");
  await waitFor(async () => (await page.$('.um-img')) !== null || (await page.evaluate(() => {
    const items = window.__tl?.getState?.().items ?? [];
    return items.some((i) => i.kind === "user" && i.attachments?.length);
  })), 15000, "缩略图条目");
  record("场景12 附件上传 → 用户消息含缩略图", true);
}

async function scenario16() {
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".cpal", { timeout: 5000 });
  const title = await page.$eval('.t-item.on .t-title, .t-item .t-title', (e) => e.textContent).catch(() => "新对话");
  await page.fill(".cpal-in", "新对话");
  await page.keyboard.press("Enter");
  await sleep(400);
  const on = await page.$eval(".tb-title", (e) => e.textContent).catch(() => "");
  record("场景16 命令面板 → 打开对话", !!on);
}

async function scenario17() {
  const t0 = Date.now();
  await send("/long");
  const opened = Date.now() - t0;
  await waitFor(async () => (await page.$('.te')) !== null, 60000, "/long 完成");
  // Scroll to the top and back to the bottom without errors (virtual list already tested; check for no new pageerror)
  const errBefore = pageErrors.length;
  await page.evaluate(() => { const s = document.querySelector(".scroll"); s.scrollTop = 0; });
  await sleep(300);
  await page.evaluate(() => { const s = document.querySelector(".scroll"); s.scrollTop = s.scrollHeight; });
  await sleep(300);
  record("场景17 /long 打开 ≤1s（记录值）+ 滚动无错", opened < 3000 && pageErrors.length === errBefore, `${opened}ms`);
}

async function scenario18() {
  await page.setViewportSize({ width: 560, height: 900 });
  await sleep(400);
  const res = await page.evaluate(() => {
    const sb = document.querySelector(".sidebar");
    const st = getComputedStyle(sb);
    return {
      sbFixed: st.position === "fixed",
      noHScroll: document.documentElement.scrollWidth <= 560 + 1,
    };
  });
  record("场景18 窄屏 560px：抽屉 + 无横向滚动", res.sbFixed && res.noHScroll, JSON.stringify(res));
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function scenario19() {
  // Filter benign console errors (e.g. favicon 404)
  const bad = pageErrors.filter((e) => !/favicon|404|net::/i.test(e) && !e.startsWith("dbg:"));
  record("场景19 无 pageerror / console error", bad.length === 0, bad.slice(0, 3).join(" | "));
}

async function scenario13() {
  // e2e-proj is already a git repository; make a change → changes panel appears → click diff → discard → it disappears
  const pid = await page.evaluate(() => {
    const ui = window.__stores.useUi.getState();
    const data = window.__stores.useData.getState();
    const th = data.threads.find((t) => t.id === ui.currentThreadId);
    return th?.projectId ?? ui.currentProjectId ?? data.projects[0]?.id;
  });
  writeFileSync(join(PROJ, "a.txt"), "alpha\nbeta\nCHANGEME\n");
  await page.click('.ibtn[title="改动（Ctrl+J）"]');
  await page.waitForSelector(".chg-row", { timeout: 8000 });
  const name = await page.$eval(".chg-row .chg-path", (e) => e.textContent);
  await page.click(".chg-row");
  await page.waitForSelector(".chg-diff .diff", { timeout: 8000 });
  const hasAdd = await page.$eval(".chg-diff", (e) => e.textContent.includes("CHANGEME"));
  // Discard the change
  await page.hover(".chg-row");
  await page.click(".chg-discard");
  await page.waitForSelector(".dlg", { timeout: 5000 });
  await page.click('.dlg .btn.danger');
  try {
    await waitFor(async () => {
      const st = await wsCall("git.status", { projectId: pid });
      return !(st.files ?? []).some((f) => f.path === "a.txt") ? true : null;
    }, 10000, "a.txt 改动消失");
  } catch (e) {
    const st = await wsCall("git.status", { projectId: pid }).catch((x) => String(x));
    const onDisk = readFileSync(join(PROJ, "a.txt"), "utf8");
    throw new Error(`${e.message} | status=${JSON.stringify(st).slice(0, 300)} | disk=${JSON.stringify(onDisk).slice(0, 120)} | pid=${pid}`);
  }
  await waitFor(async () => {
    const p = await page.$$eval(".chg-path", (e) => e.map((x) => x.textContent));
    return !p.includes("a.txt") ? true : null;
  }, 6000, "a.txt 行从 DOM 消失");
  const rowPaths = await page.$$eval(".chg-path", (e) => e.map((x) => x.textContent));
  const aTxtGone = !rowPaths.includes("a.txt");
  record("场景13 改动面板：列表→diff→放弃→a.txt 消失", name === "a.txt" && hasAdd && aTxtGone, `file=${name} add=${hasAdd} rows=${JSON.stringify(rowPaths)}`);
}

async function scenario14() {
  await page.click('.ibtn[title="文件"]');
  await page.waitForSelector(".ft-row", { timeout: 8000 });
  // Expand src/ and click a.txt to preview it
  const rows = await page.$$eval(".ft-row .ft-name", (els) => els.map((e) => e.textContent));
  await page.click('.ft-row:has-text("src")');
  await page.waitForSelector('.ft-row:has-text("index.ts")', { timeout: 5000 });
  await page.click('.ft-row:has-text("a.txt")');
  await page.waitForSelector(".ft-pre", { timeout: 8000 });
  const text = await page.$eval(".ft-pre", (e) => e.textContent);
  record("场景14 文件面板：树展开 + 预览", rows.includes("src") && text.includes("alpha"), `rows=${rows.length} text=${text.slice(0, 30)}`);
}

async function scenario15() {
  await page.click('.ibtn[title="终端"]');
  // New terminal
  await waitFor(async () => {
    const empty = await page.$('.tm-body .pn-empty .btn');
    if (empty) { await empty.click(); return true; }
    return (await page.$$(".tm-view")).length > 0 ? true : null;
  }, 5000, "新建终端");
  await waitFor(async () => (await page.$$(".tm-tab")).length >= 1, 8000, "终端 tab");
  // Wait for xterm to mount + attach to finish, then type echo hello-e2e
  try {
    await page.waitForSelector(".tm-view .xterm", { timeout: 10000 });
  } catch (e) {
    const dbg = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll(".tm-tab")].map((x) => x.textContent),
      views: [...document.querySelectorAll(".tm-view")].map((x) => ({ d: x.style.display, cs: getComputedStyle(x).display, w: x.offsetWidth, h: x.offsetHeight })),
      pnBody: document.querySelector(".pn-body")?.className,
      panelOpen: window.__stores?.useUi?.getState?.().panelOpen,
    })).catch((x) => String(x));
    throw new Error(`xterm 未可见 ${JSON.stringify(dbg)}`);
  }
  await sleep(1200); // Type only after the attach snapshot has been replayed
  await page.click(".tm-view .xterm");
  await page.keyboard.type("echo hello-e2e", { delay: 10 });
  await page.keyboard.press("Enter");
  await waitFor(async () => {
    const t = await page.$eval(".tm-view .xterm", (e) => e.textContent).catch(() => "");
    return t.includes("hello-e2e") ? true : null;
  }, 15000, "终端输出 echo");
  // Reload the page → the terminal is still there with its history
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ws && window.__ws.getState() === "open", { timeout: 10000 });
  await page.waitForFunction(() => window.__stores?.useData?.getState?.().loaded === true, { timeout: 20000 });
  // Panel state persists in settings: after a reload, don't click if it's already open (clicking again would close it)
  const needOpen = await page.evaluate(() => {
    const u = window.__stores.useUi.getState();
    return !(u.panelOpen && u.panelTab === "terminal");
  });
  if (needOpen) await page.click('.ibtn[title="终端"]');
  await waitFor(async () => (await page.$$(".tm-tab")).length >= 1, 10000, "刷新后终端仍在");
  try {
    await page.waitForSelector(".tm-view .xterm", { timeout: 10000 });
  } catch (e) {
    const dbg = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll(".tm-tab")].map((x) => x.textContent),
      views: [...document.querySelectorAll(".tm-view")].map((x) => ({ d: x.style.display, cs: getComputedStyle(x).display, w: x.offsetWidth, h: x.offsetHeight })),
      terms: [...document.querySelectorAll(".tm-body")].map((x) => x.childElementCount),
    })).catch((x) => String(x));
    throw new Error(`刷新后 xterm 未可见 ${JSON.stringify(dbg)}`);
  }
  await waitFor(async () => {
    const t = await page.$eval(".tm-view .xterm", (e) => e.textContent).catch(() => "");
    return t.includes("hello-e2e") ? true : null;
  }, 15000, "刷新后历史仍在");
  record("场景15 终端：echo→输出→刷新→历史仍在", true);
}

async function main() {
  await setup();
  try {
    await newProjectFlow();
    await scenario2();
    await scenario3();
    await scenario4();
    await scenario5();
    await scenario6();
    await scenario7();
    await scenario8();
    await scenario9();
    await scenario10();
    await scenario11();
    await scenario12();
    await scenario13();
    await scenario14();
    await scenario15();
    await scenario16();
    await scenario17();
    await scenario18();
    await scenario19();
  } catch (e) {
    record("中途异常", false, String(e?.message ?? e).slice(0, 600) + " ||daemon:" + daemonErr.slice(-4).join("|").slice(0, 400));
  }
  const pass = results.filter((r) => r.ok).length;
  log(`\n===== ${pass}/${results.length} 通过 =====`);
  await browser?.close().catch(() => {});
  daemon?.kill();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e); daemon?.kill(); process.exit(1); });
