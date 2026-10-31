// Screenshot self-check (§11.3): playwright-core + Edge, scenarios × light/dark × 1440/960/560 → _tmp/shots/v1/.
// Scenarios: empty-project onboarding, empty conversation, default script finished, permission card, plan card, command palette (panel scenarios belong to P3-5).
// Each scenario also captures ?audit=1 metrics → _tmp/shots/v1/audit.json.
import { spawn } from "node:child_process";
import { findBrowser } from "./browser-path.mjs";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(root, "_tmp");
const XDG = join(TMP, "shot-xdg");
const PROJ = join(TMP, "shot-proj");
const OUT = join(TMP, "shots", "v1");
const PORT = 3497;
// Edge / Chrome / Chromium (Windows, macOS, Linux); MSEDGE_PATH or CHROME_PATH may be set
const EDGE = findBrowser();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const audits = {};
let daemon, browser;

async function wsCall(page, m, p) {
  return page.evaluate(async ([m, p]) => await window.__ws.call(m, p), [m, p]);
}

async function setup() {
  rmSync(XDG, { recursive: true, force: true });
  rmSync(PROJ, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(PROJ, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(PROJ, "a.txt"), "alpha\nbeta\n");
  // The changes panel scenario needs a git repository
  try {
    const { execFileSync } = await import("node:child_process");
    const g = (a) => execFileSync("git", a, { cwd: PROJ, stdio: "pipe", windowsHide: true });
    g(["init"]); g(["config", "user.email", "s@s"]); g(["config", "user.name", "s"]);
    g(["config", "core.autocrlf", "false"]);
    g(["add", "-A"]); g(["commit", "-m", "init", "-q"]);
  } catch {}
  daemon = spawn("node", [join(root, "daemon/dist/main.js"), "--port", String(PORT), "--data", XDG], {
    env: { ...process.env, AGENT_CONSOLE_MOCK: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { JSON.parse(readFileSync(join(XDG, "magpie/agent-console/daemon.json"), "utf8")); break; }
    catch { await sleep(300); }
  }
  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
}

// A separate page per scenario: set up the state first, then switch theme/width and shoot
async function newPage(width, theme, audit = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const dj = JSON.parse(readFileSync(join(XDG, "magpie/agent-console/daemon.json"), "utf8"));
  const query = `?theme=${encodeURIComponent(theme)}&lang=zh${audit ? "&audit=1" : ""}`;
  await page.goto(`http://127.0.0.1:${PORT}/${query}#t=${encodeURIComponent(dj.token)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ws && window.__ws.getState() === "open", { timeout: 10000 });
  await page.waitForFunction(() => window.__stores?.useData?.getState?.().loaded === true, { timeout: 20000 });
  await wsCall(page, "settings.set", { patch: { defaultProvider: "mock" } });
  return page;
}

async function shot(page, name, theme, width) {
  await page.screenshot({ path: join(OUT, `${name}-${theme}-${width}.png`) });
}

async function grabAudit(page, name, theme, width) {
  const el = await page.waitForSelector("#audit", { state: "attached", timeout: 8000 }).catch(() => null);
  if (!el) { audits[`${name}-${theme}-${width}`] = { error: "no audit" }; return; }
  audits[`${name}-${theme}-${width}`] = JSON.parse(await el.textContent());
}

// —— scenario setup (each state once, then one shot for each of 3 widths × 2 themes) ——
// For simplicity: evaluate inside the page to change data-theme + viewport and reshoot, instead of rebuilding the state for every combination.

async function scenario_emptyProject() {
  const page = await newPage(1440, "light");
  // No project: empty onboarding
  return page;
}

async function scenario_emptyThread(page) {
  // Create a project + conversation but send no message
  await page.click("text=新建项目");
  await page.fill(".dlg .tinput", PROJ);
  await page.waitForSelector("text=目录可用");
  await page.click(".dlg .btn.primary");
  await sleep(600);
  await page.hover(".pj");
  await page.click('.pj-act[title="新建对话"]');
  await page.waitForSelector(".t-item.on", { timeout: 8000 });
}

async function scenario_default(page) {
  await page.fill(".cp-ta", "看下这个项目");
  await page.keyboard.press("Enter");
  // Wait for turn_ended
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const g = await wsCall(page, "threads.get", { id: await page.evaluate(() => window.__stores.useUi.getState().currentThreadId) });
    if (g.runtimeStatus === "idle") break;
    await sleep(300);
  }
  await sleep(1500); // reveal catches up
}

async function scenario_perm(page) {
  await page.fill(".cp-ta", "/perm");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".card.perm", { timeout: 15000 });
}

async function scenario_plan(page) {
  await page.fill(".cp-ta", "/plan");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".card.plan", { timeout: 15000 });
}

async function scenario_cpal(page) {
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".cpal", { timeout: 5000 });
  await page.fill(".cpal-in", "对话");
  await sleep(300);
}

async function scenario_changes(page) {
  // Changes panel open: make a change, open the panel and click a file to see its diff
  writeFileSync(join(PROJ, "a.txt"), "alpha\nbeta\nchanged-line\n");
  await page.click('.ibtn[title="改动（Ctrl+J）"]');
  await page.waitForSelector(".chg-row", { timeout: 8000 });
  await page.click(".chg-row");
  await page.waitForSelector(".chg-diff .diff", { timeout: 8000 });
}

async function scenario_terminal(page) {
  await page.click('.ibtn[title="终端"]');
  const empty = await page.$(".tm-body .pn-empty .btn");
  if (empty) await empty.click();
  await page.waitForSelector(".tm-view .xterm", { timeout: 10000 });
  await page.click(".tm-view .xterm");
  await page.keyboard.type("echo hello", { delay: 15 });
  await page.keyboard.press("Enter");
  await sleep(1500);
}

const SCENARIOS = [
  { name: "empty", prep: scenario_emptyProject },
  { name: "thread", prep: scenario_emptyThread },
  { name: "default", prep: scenario_default },
  { name: "perm", prep: scenario_perm },
  { name: "plan", prep: scenario_plan },
  { name: "cpal", prep: scenario_cpal },
  { name: "changes", prep: scenario_changes },
  { name: "terminal", prep: scenario_terminal },
];

async function main() {
  await setup();
  // One long page accumulating state: empty → thread → default → perm (resolved) → plan (resolved) → cpal
  // A separate page per scenario is cleaner: a new page per scenario + set up the preceding state as needed
  for (const sc of SCENARIOS) {
    const page = await newPage(1440, "light", true);
    try {
      // Preconditions: thread needs a project + conversation; every other scenario starts from a conversation and then does its own setup
      if (sc.name === "empty") {
        // Empty-project onboarding
      } else if (sc.name === "thread") {
        await scenario_emptyThread(page);
      } else {
        await scenario_emptyThread(page);
        await sc.prep(page);
      }
      await grabAudit(page, sc.name, "light", 1440);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        for (const w of [1440, 960, 560]) {
          await page.setViewportSize({ width: w, height: 900 });
          await sleep(500);
          await shot(page, sc.name, theme, w);
        }
      }
    } catch (e) {
      console.log(`✗ ${sc.name}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    await page.close();
  }
  writeFileSync(join(OUT, "audit.json"), JSON.stringify(audits, null, 2));
  console.log(`截图完成 → ${OUT}（audit.json ${Object.keys(audits).length} 条）`);
  await browser?.close().catch(() => {});
  daemon?.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); daemon?.kill(); process.exit(1); });
