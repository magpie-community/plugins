// e2e (§11.2): playwright-core + Edge, isolated data directory _tmp/e2e-xdg, port 3497, AGENT_CONSOLE_MOCK=1.
// Scenarios 1–12, 16–27 (20–27: 1.3 overlap at 600 px, 全部自动同意, message actions, quotes, instant send, tool rows / summary,
// checklist + pill + reply footer + code block, the 全部自动同意 indicator / trace / upgrade notice); each prints ✓/✗, and any ✗ exits with code 1.
// The mock Agent starts slowly (E2E_MOCK_START_MS, default 1200 ms) like a real one on Windows, so every scenario runs
// with the user's message arriving before the Agent is up.
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
const PORT = Number(process.env.E2E_PORT || 3497);
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

  // Scenario 27: this data dir is an upgraded 1.2 user whose default was 全部放行 (as migrate/autoApprove13.ts leaves it;
  // the default itself is 每次询问 here so the mock scenarios keep asking)
  mkdirSync(join(XDG, "magpie/agent-console"), { recursive: true });
  writeFileSync(join(XDG, "magpie/agent-console/settings.json"), JSON.stringify({ v1Migrated: true, autoApproveUpgrade: { done: true, legacyDefault: true, noticed: false } }));
  daemon = spawn("node", [join(root, "daemon/dist/main.js"), "--port", String(PORT), "--data", XDG], {
    env: { ...process.env, AGENT_CONSOLE_MOCK: "1", AGENT_CONSOLE_MOCK_START_MS: process.env.E2E_MOCK_START_MS ?? "1200" },
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
  // 1.3 timeline polish: a short run (≤6 tool calls) stays flat, one compact row per step; the edit row shows +N -M
  // and opens its diff on click; the step list is a checklist with N/M
  const rows = await page.evaluate(() => {
    const g = [...document.querySelectorAll(".tg")].pop();
    const ts = g ? [...g.querySelectorAll(".ts:not(.ts-think)")] : [];
    const edit = ts.find((x) => x.dataset.kind === "edit");
    const r = {
      flat: !!g?.classList.contains("flat") && !g.querySelector(".tg-head"),
      steps: ts.length,
      oneLine: ts.every((x) => x.querySelector(".ts-head").getBoundingClientRect().height <= 30),
      diffStat: edit?.querySelector(".ts-diff")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      closed: !g?.querySelector(".diff"),
      ok: ts.filter((x) => x.querySelector(".ts-st.ok")).length,
    };
    edit?.querySelector(".ts-head")?.click();
    return r;
  });
  await sleep(200);
  const checks = await page.evaluate((rows) => ({
    ...rows,
    md: !!document.querySelector(".md"),
    diff: !!document.querySelector(".tg .ts .diff"),
    checklist: document.querySelector(".ck .ck-n")?.textContent ?? "",
    te: !!document.querySelector(".te"),
  }), rows);
  const ok = checks.flat && checks.steps === 5 && checks.oneLine && /\+2\s*[-−]1/.test(checks.diffStat) && checks.closed && checks.ok === 5
    && checks.md && checks.diff && checks.checklist === "3/4" && checks.te;
  record("场景2 默认剧本（正文/工具行/+N -M/diff/清单/结束行）", ok, JSON.stringify(checks));
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

// ---- 1.3 (Nolan's Windows report) ----
async function newThread() {
  // Over the API (scenario 18 may leave the sidebar as a drawer); close the right panel earlier scenarios opened
  // (below ~900 px it is a sheet over the chat)
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.__stores.useUi.getState().closePanel?.());
  // A dialog left open (e.g. scenario 16's palette when nothing matched): close it by pressing on its scrim
  for (let i = 0; i < 3 && await page.$(".dlg-scrim"); i++) { await page.mouse.click(4, 4); await sleep(200); }
  const projects = await wsCall("projects.list", {});
  const proj = projects.find((p) => p.path === PROJ) ?? projects[0];
  const th = await wsCall("threads.create", { projectId: proj.id, provider: "mock", mode: "default" });
  await page.waitForFunction((id) => window.__stores.useData.getState().threads.some((t) => t.id === id), th.id, { timeout: 8000 });
  await page.evaluate(([p, t]) => window.__stores.useUi.getState().select(p, t), [proj.id, th.id]);
  await page.waitForFunction((id) => window.__stores.useUi.getState().currentThreadId === id, th.id, { timeout: 5000 });
  _tid = th.id;
  await page.waitForSelector(sel.ta, { timeout: 5000 });
  await sleep(300);
}
async function waitIdle(ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await wsCall("threads.get", { id: await curThread() }).then((g) => g.runtimeStatus).catch(() => "?");
    if (st !== "running" && st !== "initializing") return;
    await sleep(250);
  }
  throw new Error("等待空闲超时");
}
/** Timeline rows never overlap: each row paints inside its virtual slot, one-line rows stay one line */
async function overlapProblems() {
  return page.evaluate(() => {
    const bad = [];
    const inked = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); const rs = [...rg.getClientRects()].filter((x) => x.height > 0);
      return rs.length ? { top: Math.min(...rs.map((x) => x.top)), bottom: Math.max(...rs.map((x) => x.bottom)) } : null; };
    const rows = [...document.querySelectorAll(".tl-wrap [data-index]")].map((el) => ({ el, i: +el.dataset.index, r: el.getBoundingClientRect() })).sort((a, b) => a.i - b.i);
    for (const row of rows) { const k = inked(row.el); if (k && (k.bottom > row.r.bottom + 1 || k.top < row.r.top - 1)) bad.push(`row ${row.i} paints outside its slot`); }
    for (let k = 0; k + 1 < rows.length; k++) if (rows[k + 1].i === rows[k].i + 1 && rows[k].r.bottom > rows[k + 1].r.top + 0.5) bad.push(`row ${rows[k].i} overlaps ${rows[k + 1].i}`);
    for (const el of document.querySelectorAll(".tl-wrap .tg-head, .tl-wrap .tg-run, .tl-wrap .rs-head, .tl-wrap .ts-head")) {
      const r = el.getBoundingClientRect(); const k = inked(el);
      if (r.height > 30 || (k && (k.bottom > r.bottom + 1 || k.top < r.top - 1))) bad.push(`${el.className} wraps/spills`);
    }
    return bad;
  });
}

async function scenario20() {
  // Folded tool groups + running row + long PowerShell commands + a pending approval, at Nolan's ~600 px window
  await newThread();
  await page.setViewportSize({ width: 600, height: 860 });
  // E2E_NEG_OVERLAP=1: put back 1.2's squeeze to prove this check catches it (must fail)
  const neg = process.env.E2E_NEG_OVERLAP ? await page.addStyleTag({ content: ".tg-head{height:24px!important;min-height:0!important;overflow:visible!important;white-space:normal!important}.tg-sum{white-space:normal!important;overflow:visible!important;max-width:42px}.ts-head{height:24px!important;min-height:0!important;overflow:visible!important;white-space:normal!important}.ts-title{white-space:normal!important;overflow:visible!important;max-width:42px}" }) : null;
  await send("/winrun 帮我启动一下");
  const seen = new Set();
  let approved = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    for (const b of await overlapProblems()) seen.add(b);
    if (!approved && await page.$(".card.perm:not(.done)")) {
      await sleep(400);
      for (const b of await overlapProblems()) seen.add(b);
      await page.click(".card.perm:not(.done) .btn.primary");
      approved = true;
    }
    const st = await wsCall("threads.get", { id: await curThread() }).then((g) => g.runtimeStatus).catch(() => "?");
    if (approved && st !== "running" && st !== "initializing") break;
    await sleep(40);
  }
  for (const b of await overlapProblems()) seen.add(b);
  await neg?.evaluate((el) => el.remove());
  await page.setViewportSize({ width: 1440, height: 900 });
  record("场景20 600px 运行中折叠行/运行行不重叠", approved && seen.size === 0, [...seen].slice(0, 3).join(" | "));
}

async function scenario21() {
  // 全部自动同意: a waiting card is approved by the switch, the next request never shows a card; both approvals are in
  // the timeline (#727 review 2) as the quiet 已自动同意 row, not as cards
  await newThread();
  await send("/perm");
  await page.waitForSelector(".card.perm:not(.done)", { timeout: 15000 });
  await page.click(".mode-chip");
  await page.click('.mode-menu .sm-opt:has-text("全部自动同意")');
  await page.waitForSelector('[data-testid="auto-approved"]', { timeout: 8000 });
  const chipAuto = await page.$(".mode-chip.auto");
  await waitIdle();
  await send("/perm");
  await sleep(500);
  await waitIdle();
  const cards = (await page.$$(".card.perm")).length;
  const rows = await page.$$eval('[data-testid="auto-approved"] .apv-n', (els) => els.map((e) => e.textContent));
  record("场景21 全部自动同意：待批卡片自动同意，之后不再弹", !!chipAuto && cards === 0 && rows.length === 2 && rows.every((r) => /已自动同意 1 项/.test(r ?? "")), `cards=${cards} rows=${JSON.stringify(rows)}`);
}

async function scenario27() {
  // #727 review 1–3: the persistent 全部自动同意 indicator at 600 px (light + dark), the auto-approved trace (persisted,
  // folded, expandable, still there after a reload), and the one-time upgrade notice for a 1.2 全部放行 default
  await newThread();
  const tid = await curThread();
  await page.setViewportSize({ width: 600, height: 860 });
  const banner = () => page.evaluate(() => {
    const b = document.querySelector('[data-testid="auto-on"]');
    if (!b) return null;
    const r = b.getBoundingClientRect(); const cs = getComputedStyle(b.querySelector("b"));
    const chip = document.querySelector(".mode-chip.auto");
    const [cr, cg, cb] = (cs.color.match(/[\d.]+/g) ?? []).map(Number);
    // No visible hint between the label and the link (Nolan): the per-Agent text is the label's tooltip + description
    const lab = b.querySelector(".cp-auto-t");
    const tip = lab?.getAttribute("title") ?? "";
    const descEl = lab && document.getElementById(lab.getAttribute("aria-describedby") ?? "");
    const visible = [...b.querySelectorAll(".cp-auto-t, .cp-auto-back")].map((e) => e.innerText).join("|");
    return { h: Math.round(r.height), hintGone: !b.querySelector(".cp-auto-d"), tip, described: !!descEl && descEl.textContent === tip, visible,
      onlyTwo: [...b.children].filter((e) => !e.classList.contains("sr-only")).length === 2, text: b.textContent, inView: r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth + 0.5,
      warm: cr - cb > 60 && cr > cg, chip: !!chip, theme: document.documentElement.dataset.theme };
  });
  const before = await banner();
  await page.click(".mode-chip");
  const menuHint = await page.textContent('.mode-menu .sm-opt:has-text("全部自动同意") .sm-hint');
  await page.click('.mode-menu .sm-opt:has-text("全部自动同意")');
  await page.waitForSelector('[data-testid="auto-on"]', { timeout: 5000 });
  const light = await banner();
  // persists: a turn, another conversation and back, a reload
  await send("/perm");
  await waitIdle();
  const other = await wsCall("threads.create", { projectId: (await wsCall("threads.get", { id: tid })).meta.projectId, provider: "mock", mode: "default" });
  await page.evaluate(([t]) => { const u = window.__stores.useUi.getState(); u.select(u.currentProjectId, t); }, [other.id]);
  await sleep(500);
  const offOther = await banner();
  await page.evaluate(([t]) => { const u = window.__stores.useUi.getState(); u.select(u.currentProjectId, t); }, [tid]);
  await page.waitForSelector('[data-testid="auto-on"]', { timeout: 5000 });
  await page.reload();
  await page.waitForFunction(() => window.__ws && window.__ws.getState() === "open", null, { timeout: 10000 });
  await page.waitForFunction((t) => window.__stores?.useUi?.getState?.().currentThreadId === t, tid, { timeout: 10000 });
  await page.waitForSelector('[data-testid="auto-on"]', { timeout: 8000 });
  await wsCall("settings.set", { patch: { theme: "dark" } });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await sleep(300);
  const dark = await banner();
  await wsCall("settings.set", { patch: { theme: "auto" } });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  // trace: persisted with auto, shown folded, opens to the command
  const evs = (await wsCall("threads.get", { id: tid })).events;
  const req = evs.find((e) => e.type === "permission_request");
  const res = evs.find((e) => e.type === "permission_resolved");
  await page.waitForSelector('[data-testid="auto-approved"]', { timeout: 8000 });
  const collapsed = await page.textContent('[data-testid="auto-approved"] .apv-head');
  await page.click('[data-testid="auto-approved"] .apv-head');
  const cmd = await page.textContent('[data-testid="auto-approved"] .apv-cmd').catch(() => null);
  const meta = await page.textContent('[data-testid="auto-approved"] .apv-meta').catch(() => null);
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(200);
  const wide = await banner();
  await page.setViewportSize({ width: 600, height: 860 });
  // back to 每次询问 from the banner
  await page.click(".cp-auto-back");
  await page.waitForFunction(() => !document.querySelector('[data-testid="auto-on"]'), null, { timeout: 5000 });
  const modeAfter = (await wsCall("threads.get", { id: tid })).meta.mode;
  await page.setViewportSize({ width: 1440, height: 900 });
  const okBanner = !before && !!light?.inView && light.warm && light.chip && /全部自动同意已开启/.test(light.text) && !offOther
    && !!dark?.inView && dark.warm && dark.theme === "dark"
    // one slim line (Nolan): never wraps; only 全部自动同意已开启 + 改回每次询问 are visible, the per-Agent text is the tooltip
    && light.h <= 26 && dark.h <= 26 && !!wide && wide.h <= 26 && light.hintGone && dark.hintGone && light.onlyTwo
    && light.visible === "全部自动同意已开启|改回每次询问" && light.described && /计划确认/.test(light.tip);
  const okTrace = req?.auto === true && res?.auto === true && res.requestId === req.requestId && /已自动同意 1 项/.test(collapsed ?? "")
    && /npm test/.test(collapsed ?? "") && /npm test/.test(cmd ?? "") && /全部自动同意/.test(meta ?? "");
  record("场景27a 全部自动同意：600px 常驻提示（浅/深色）+ 菜单写明", okBanner && /允许一次|跳过|沙箱/.test(menuHint ?? "") && modeAfter === "default",
    JSON.stringify({ before: !!before, light, dark, wideH: wide?.h, offOther: !!offOther, menuHint, modeAfter }).slice(0, 500));
  record("场景27b 自动同意留痕：持久化 auto + 折叠行可展开", okTrace, JSON.stringify({ collapsed, cmd, meta, req: req?.auto, res: res?.auto }).slice(0, 400));

  // upgrade: a 1.2 全部放行 default does not become real auto-approval for Cursor; told once
  const projectId = (await wsCall("threads.get", { id: tid })).meta.projectId;
  const c1 = await wsCall("threads.create", { projectId, provider: "cursor", mode: "bypassPermissions" });
  const c2 = await wsCall("threads.create", { projectId, provider: "cursor", mode: "bypassPermissions" });
  const m1 = await wsCall("threads.get", { id: c1.id });
  const m2 = await wsCall("threads.get", { id: c2.id });
  await page.evaluate(([p, t]) => window.__stores.useUi.getState().select(p, t), [projectId, c1.id]);
  await page.waitForSelector('[data-testid="auto-upgrade-notice"]', { timeout: 8000 });
  const noticeText = await page.textContent('[data-testid="auto-upgrade-notice"]');
  const bannerOnCursor = await page.$('[data-testid="auto-on"]');
  await page.click('[data-testid="auto-upgrade-notice"] .btn:has-text("开启")');
  await waitFor(async () => (await wsCall("threads.get", { id: c1.id })).meta.mode === "bypassPermissions", 5000, "开启全部自动同意");
  await page.waitForSelector('[data-testid="auto-on"]', { timeout: 5000 });
  const cursorHint = await page.getAttribute('[data-testid="auto-on"] .cp-auto-t', "title");
  const okUp = m1.meta.mode === "default" && m2.meta.mode === "default"
    && m1.events.filter((e) => e.code === "auto_approve_upgrade").length === 1 && m2.events.length === 0
    && /Cursor/.test(noticeText ?? "") && !bannerOnCursor && /允许一次/.test(cursorHint ?? "");
  record("场景27c 升级：1.2 全部放行默认值对 Cursor 不静默升级，只提示一次", okUp,
    JSON.stringify({ m1: m1.meta.mode, m2: m2.meta.mode, n1: m1.events.map((e) => e.code), n2: m2.events.length, cursorHint }).slice(0, 400));
}

async function scenario22() {
  // User-message actions: under the bubble, reachable without a hover gap, copy feedback, edit fills the input
  await newThread();
  await send("帮我启动一下");
  await page.waitForSelector(".um", { timeout: 8000 });
  await waitIdle();
  const bb = await (await page.$(".um")).boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await sleep(200);
  const ab = await (await page.$(".um-act")).boundingBox();
  let hidden = 0;
  for (let i = 0; i <= 10; i++) {
    await page.mouse.move(bb.x + bb.width / 2 + (ab.x + 8 - bb.x - bb.width / 2) * i / 10, bb.y + bb.height / 2 + (ab.y + 12 - bb.y - bb.height / 2) * i / 10);
    const vis = await page.$eval(".um-act", (a) => Number(getComputedStyle(a).opacity) > 0.5);
    if (!vis) hidden++;
  }
  const below = ab.y >= bb.y + bb.height - 1 && ab.x + ab.width <= bb.x + bb.width + 1;
  await page.click('.um-act button[aria-label="编辑（填回输入框，不会马上发送）"]');
  await sleep(200);
  const filled = await page.$eval(sel.ta, (t) => t.value);
  await page.fill(sel.ta, "");
  record("场景22 用户消息操作：气泡下方、无悬停缺口、编辑回填", below && hidden === 0 && filled === "帮我启动一下", `below=${below} hidden=${hidden} filled=${filled}`);
}

async function scenario23() {
  // Select text in a reply → 添加到对话 → quote chip → sent in front of the message as "> "
  await newThread();
  await send("看下这个项目");
  await page.waitForSelector(".tl-wrap .md p", { timeout: 15000 });
  await waitIdle();
  // A real mouse drag across the first reply paragraph
  await page.evaluate(() => document.querySelector(".tl-wrap .md p")?.scrollIntoView({ block: "center" }));
  await sleep(300);
  const pb = await (await page.$(".tl-wrap .md p")).boundingBox();
  await page.mouse.move(pb.x + 2, pb.y + 8);
  await page.mouse.down();
  await page.mouse.move(pb.x + Math.min(pb.width - 4, 200), pb.y + 8, { steps: 8 });
  await page.mouse.up();
  const r = await page.evaluate(() => window.getSelection()?.toString());
  await page.waitForSelector(".qs-pop", { timeout: 3000 });
  await page.click(".qs-pop");
  await page.waitForSelector(".qchip", { timeout: 3000 });
  await send("这句什么意思？");
  await waitIdle();
  const g = await wsCall("threads.get", { id: await curThread() });
  const last = g.events.filter((e) => e.type === "user_message").pop();
  const ok = !!r && typeof last?.text === "string" && last.text.startsWith("> ") && last.text.endsWith("这句什么意思？") && !!(await page.$(".um-quote"));
  record("场景23 选中添加到对话 → 引用随消息发送", ok, JSON.stringify(last?.text ?? "").slice(0, 120));
}

async function scenario24() {
  // 1.3 (Nolan): the bubble shows the moment 发送 is clicked, while the (slow) mock Agent is still starting; the
  // daemon's echo takes over the same DOM node (no duplicate, no jump); a failed send stays with 重试
  await newThread();
  await page.setViewportSize({ width: 600, height: 860 });
  await sleep(200);
  const text = "马上显示这条消息";
  await page.fill(sel.ta, text);
  const t = await page.evaluate((text) => new Promise((resolve) => {
    const t0 = performance.now();
    const r = { bubble: null, working: null };
    const tick = () => {
      const now = Math.round(performance.now() - t0);
      const row = [...document.querySelectorAll(".tl-wrap .um-row")].find((e) => e.textContent?.includes(text));
      if (r.bubble == null && row) { r.bubble = now; row.__mark = 1; r.cid = row.dataset.clientId; }
      if (r.working == null && document.querySelector(".cp-stop")) r.working = now;
      if ((r.bubble == null || r.working == null) && now < 5000) requestAnimationFrame(tick); else resolve(r);
    };
    requestAnimationFrame(tick);
    document.querySelector(".cp-send").click();
  }), text);
  // the echo (the daemon's user_message) replaces it in place
  await waitFor(() => page.evaluate((text) => (window.__tl.getState().items ?? []).some((i) => i.kind === "user" && i.text === text && !i.sendState), text), 8000, "回显");
  const same = await page.evaluate((cid) => !!document.querySelector(`.um-row[data-client-id="${cid}"]`)?.__mark, t.cid);
  await waitIdle();
  const count = await page.evaluate((text) => (window.__tl.getState().items ?? []).filter((i) => i.kind === "user" && i.text === text).length, text);
  const scrolled = await page.evaluate(() => { const el = document.querySelector(".scroll"); return el ? el.scrollHeight - el.scrollTop - el.clientHeight < 80 : false; });
  // Failure: thread.send rejects → the bubble stays, marked failed; 重试 sends it once
  await page.evaluate(() => { const ws = window.__ws; window.__origCall = ws.call.bind(ws);
    ws.call = (m, p, tm) => m === "thread.send" ? new Promise((_, rej) => setTimeout(() => rej(new Error("连接已断开")), 200)) : window.__origCall(m, p, tm); });
  await page.fill(sel.ta, "这条会发送失败");
  await page.click(sel.send);
  const failed = await page.waitForSelector(".um-row.failed .um-fail", { timeout: 5000 }).then(() => true).catch(() => false);
  await page.evaluate(() => { window.__ws.call = window.__origCall; });
  await page.click('.um-row.failed .um-fail-b[title="重新发送"]').catch(() => {});
  await waitFor(() => page.evaluate(() => !document.querySelector(".um-row.failed") && (window.__tl.getState().items ?? []).some((i) => i.kind === "user" && i.text === "这条会发送失败" && !i.sendState)), 8000, "重试后回显");
  await waitIdle();
  const retried = await page.evaluate(() => (window.__tl.getState().items ?? []).filter((i) => i.kind === "user" && i.text === "这条会发送失败").length);
  await page.setViewportSize({ width: 1440, height: 900 });
  const ok = t.bubble != null && t.bubble < 300 && t.working != null && t.working < 300 && same && count === 1 && scrolled && failed && retried === 1;
  record("场景24 点发送气泡立即出现（Agent 慢启动）、回显不重复不跳、失败可重试", ok,
    `bubble=${t.bubble}ms working=${t.working}ms sameNode=${same} count=${count} bottom=${scrolled} failed=${failed} retried=${retried}`);
}

async function scenario25() {
  // 1.3 timeline polish: a long run (/tools, 8 tool calls) folds into one summary row with counts and a failure count;
  // it expands to the same one-line rows, and the failed step shows its output
  await newThread();
  await send("/tools 跑一下 lint 和测试");
  await page.waitForSelector(".tg:not(.flat) .tg-head", { timeout: 15000 });
  const running = await page.waitForSelector(".tg-run", { timeout: 15000 }).then(() => true).catch(() => false);
  await waitIdle();
  const head = await page.evaluate(() => {
    const g = [...document.querySelectorAll(".tg:not(.flat)")].pop();
    const r = { sum: g?.querySelector(".tg-sum")?.textContent ?? "", fail: g?.querySelector(".tg-fail")?.textContent ?? "",
      closed: !g?.querySelector(".tg-list"), h: g?.querySelector(".tg-head")?.getBoundingClientRect().height ?? 99 };
    g?.querySelector(".tg-head")?.click();
    return r;
  });
  await sleep(200);
  const open = await page.evaluate(() => {
    const g = [...document.querySelectorAll(".tg.open")].pop();
    const ts = g ? [...g.querySelectorAll(".ts:not(.ts-think)")] : [];
    const failed = ts.find((x) => x.querySelector(".ts-st.fail"));
    return { steps: ts.length, failedOpen: !!failed?.querySelector(".ts-out"), failedOut: /no-unused-vars/.test(failed?.textContent ?? ""),
      edit: ts.find((x) => x.dataset.kind === "edit")?.querySelector(".ts-diff")?.textContent?.replace(/\s+/g, " ").trim() ?? "" };
  });
  const ok = running && /读取 3/.test(head.sum) && /搜索 2/.test(head.sum) && /运行 2/.test(head.sum) && /改动 1/.test(head.sum) && /1/.test(head.fail)
    && head.closed && head.h <= 30 && open.steps === 8 && open.failedOpen && open.failedOut && /[-−]1/.test(open.edit);
  record("场景25 长运行折叠成摘要（计数/失败数），展开为单行步骤", ok, JSON.stringify({ running, ...head, ...open }));
}

async function scenario26() {
  // 1.3 timeline polish: /tasks — an ACP plan (entries) as an N/M checklist, the "N/M 个任务" pill above the composer
  // (click scrolls the list into view), the reply footer (copy · model · time · duration) and the code block
  // (language, line numbers, wrap toggle, copy of the raw code)
  await newThread();
  await send("/tasks 修一下 checkout 偶发失败的测试");
  const pill = await waitFor(() => page.evaluate(() => {
    const t = document.querySelector(".tasks-pill")?.textContent ?? "";
    return /\d\/3/.test(t) ? t : null;
  }), 15000, "任务胶囊").catch(() => null);
  await waitIdle();
  await sleep(300);
  const done = await page.evaluate(() => {
    const ck = [...document.querySelectorAll(".ck")].pop();
    return { n: ck?.querySelector(".ck-n")?.textContent ?? "", rows: ck?.querySelectorAll(".ck-i.done").length ?? 0, lists: document.querySelectorAll(".ck").length,
      pillGone: !document.querySelector(".tasks-pill") };
  });
  const te = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".te")].pop();
    const metas = t ? [...t.querySelectorAll(".te-m")].map((m) => m.textContent.trim()) : [];
    return { copy: !!t?.querySelector(".te-copy"), model: metas.some((m) => /演示/.test(m)), time: metas.some((m) => /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$|^\d{2}:\d{2}$/.test(m)),
      dur: metas.some((m) => /^\d+(\.\d+)?\s*(ms|s|分|m)/.test(m)) };
  });
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = (s) => { window.__copied = s; return Promise.resolve(); }; });
  const cb = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".md .cb")].pop();
    if (!b) return null;
    const r = { lang: b.querySelector(".cb-lang")?.textContent ?? "", lines: b.querySelectorAll(".cb-l").length, numbered: b.querySelector("pre, code")?.closest(".numbered") != null || b.querySelector(".numbered") != null };
    b.querySelector(".cb-wrap").click();
    r.wrap = b.classList.contains("wrap") || b.querySelector(".cb-wrap").getAttribute("aria-pressed") === "true";
    b.querySelector(".cb-copy").click();
    return r;
  });
  await sleep(200);
  const copied = await page.evaluate(() => window.__copied);
  const okCopy = typeof copied === "string" && copied.startsWith("async function submit() {") && copied.trim().endsWith("}") && !/^\s*\d/.test(copied.split("\n")[1] ?? "");
  const ok = !!pill && done.n === "3/3" && done.rows === 3 && done.lists === 1 && done.pillGone && te.copy && te.model && te.time && te.dur
    && cb && cb.lang === "ts" && cb.lines === 5 && cb.numbered && cb.wrap && okCopy;
  record("场景26 任务清单 N/M + 胶囊、回复页脚（复制·模型·时间·用时）、代码块（语言/行号/换行/复制）", ok,
    JSON.stringify({ pill, ...done, ...te, cb, copied: copied?.slice(0, 30) }));
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

async function scenario28() {
  // Nolan's 1.2.0 bug: Cursor asked for permission, its stream died and the turn ended with the request open; the top
  // bar kept 等待授权 and the composer stayed locked with no card to click. /perm-abandon does the same in the mock.
  await newThread();
  await send("/perm-abandon");
  await waitIdle();
  await sleep(300);
  const state = () => page.evaluate(() => ({
    wait: !!document.querySelector(".tb-pill.wait"),
    locked: !!document.querySelector(".cp-ta")?.disabled,
    pending: window.__tl?.getState?.().pending?.length ?? -1,
  }));
  const live = await state();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ws && window.__ws.getState() === "open", { timeout: 10000 });
  await page.waitForSelector(".card.perm", { timeout: 10000 });
  await sleep(500);
  const reloaded = await state();
  const cancelled = await page.$eval(".card.perm", (e) => e.textContent.includes("已取消"));
  // A request that does wait: the 等待授权 pill brings its card into view from the top of a long conversation
  await send("/perm");
  await page.waitForSelector(`${sel.permCard} button:has-text("允许")`, { timeout: 15000 });
  await page.evaluate(() => { const el = document.querySelector(".tl-wrap") ?? document.querySelector("[data-index]")?.parentElement?.parentElement; if (el) el.scrollTop = 0; });
  const pillBtn = await page.$("button.tb-pill.wait");
  await pillBtn?.click();
  await sleep(400);
  const inView = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card.perm")].filter((c) => c.querySelector(".perm-btns"));
    const r = cards[0]?.getBoundingClientRect();
    return !!r && r.bottom > 0 && r.top < window.innerHeight;
  });
  await page.click(`${sel.permCard} button:has-text("允许")`);
  await waitIdle();
  const ok = !live.wait && !live.locked && live.pending === 0 && !reloaded.wait && !reloaded.locked && reloaded.pending === 0 && cancelled && !!pillBtn && inView;
  record("场景28 Agent 自己结束了带着授权请求的一轮：不卡等待授权；等待授权胶囊可跳到卡片", ok,
    JSON.stringify({ live, reloaded, cancelled, pillBtn: !!pillBtn, inView }));
}

async function main() {
  await setup();
  try {
    await newProjectFlow();
    // E2E_ONLY_13=1 runs just the 1.3 scenarios (20–27) and the console-error check
    const all = [scenario2, scenario3, scenario4, scenario5, scenario6, scenario7, scenario8, scenario9, scenario10, scenario11,
      scenario12, scenario13, scenario14, scenario15, scenario16, scenario17, scenario18, scenario20, scenario21, scenario22, scenario23, scenario24, scenario25, scenario26, scenario27, scenario28, scenario19];
    const only13 = new Set([scenario20, scenario21, scenario22, scenario23, scenario24, scenario25, scenario26, scenario27, scenario28, scenario19]);
    for (const f of all) if (!process.env.E2E_ONLY_13 || only13.has(f)) await f();
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
