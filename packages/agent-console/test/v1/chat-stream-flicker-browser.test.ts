import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
// @ts-expect-error mjs helper
import { findBrowser } from "../../scripts/browser-path.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const browserPath: string | null = findBrowser();

describe.skipIf(!browserPath)("Chat streaming markdown flicker in real Chromium (1.3.7)", () => {
  it("streams multi-code-block replies with no bare <pre> frames, no height collapse, sticky bottom, wrap persist, XSS safe", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "ac-flicker-xdg-"));
    const projDir = mkdtempSync(join(tmpdir(), "ac-flicker-proj-"));
    const dataDir = join(xdg, "magpie", "agent-console");
    const projectId = "p_flicker1";
    const threadId = "t_flicker1";
    mkdirSync(join(dataDir, "threads", threadId), { recursive: true });
    const now = Date.now();
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
      v1Migrated: true, theme: "dark", lastProjectId: projectId, lastThreadId: threadId,
    }));
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify([
      { id: projectId, name: "flicker", path: projDir, createdAt: now },
    ]));
    writeFileSync(join(dataDir, "threads", threadId, "meta.json"), JSON.stringify({
      id: threadId, projectId, title: "stream flicker", titleAuto: false, provider: "mock", model: null,
      mode: "bypassPermissions", effort: "high", providerSessionId: null, status: "idle", pinned: false,
      archived: false, createdAt: now - 1000, updatedAt: now, lastTurnStatus: "completed",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, seq: 0,
    }));
    writeFileSync(join(dataDir, "threads", threadId, "timeline.jsonl"), "");

    const port = 35700 + Math.floor(Math.random() * 400);
    const daemon = spawn(process.execPath, [join(root, "daemon/dist/main.js"), "--port", String(port), "--data", xdg], {
      env: { ...process.env, AGENT_CONSOLE_MOCK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launchArgs = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
    const browser = await chromium.launch({ executablePath: browserPath!, headless: true, args: launchArgs });
    try {
      let token = "";
      const readyDeadline = Date.now() + 12000;
      while (Date.now() < readyDeadline) {
        try {
          const dj = JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8"));
          if (dj.token) { token = dj.token; break; }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(token.length).toBeGreaterThan(0);

      const page = await browser.newPage({ viewport: { width: 920, height: 860 } });
      await page.goto(`http://127.0.0.1:${port}/?lang=zh#t=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".cp-ta", { timeout: 10000 });
      await page.waitForTimeout(250);

      await page.evaluate(() => {
        const w = window as unknown as { __flicker: Record<string, unknown> };
        w.__flicker = {
          barePreFrames: 0,
          heightDrops: 0,
          maxDrop: 0,
          lastH: 0,
          gapMax: 0,
          samples: 0,
          stop: false,
        };
        const f = w.__flicker as {
          barePreFrames: number; heightDrops: number; maxDrop: number; lastH: number;
          gapMax: number; samples: number; stop: boolean;
        };
        const sample = () => {
          if (f.stop) return;
          f.samples++;
          const md = document.querySelector(".md.streaming") || document.querySelector(".as .md");
          const scroll = document.querySelector(".scroll") as HTMLElement | null;
          if (md) {
            let bare = 0;
            for (const pre of md.querySelectorAll("pre")) if (!pre.closest(".cb")) bare++;
            if (bare > 0) f.barePreFrames++;
            const h = (md as HTMLElement).scrollHeight;
            if (f.lastH > 0 && h < f.lastH - 2) {
              f.heightDrops++;
              f.maxDrop = Math.max(f.maxDrop, f.lastH - h);
            }
            f.lastH = h;
          }
          if (scroll) {
            const gap = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
            if (gap > f.gapMax) f.gapMax = gap;
          }
          requestAnimationFrame(sample);
        };
        // Also catch bare <pre> between React commit and paint via MutationObserver
        const mo = new MutationObserver(() => {
          const md = document.querySelector(".md.streaming") || document.querySelector(".as .md");
          if (!md) return;
          for (const pre of md.querySelectorAll("pre")) {
            if (!pre.closest(".cb")) f.barePreFrames++;
          }
        });
        mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        (w.__flicker as { mo: MutationObserver }).mo = mo;
        requestAnimationFrame(sample);
      });

      await page.locator(".cp-ta").fill("/bigreply slow");
      await page.keyboard.press("Enter");
      // Wait until a few code blocks exist, then toggle wrap on the first one mid-stream
      await page.waitForFunction(() => document.querySelectorAll(".as .md .cb").length >= 3, null, { timeout: 15000 });
      await page.locator(".as .md .cb").first().locator(".cb-wrap").click();
      expect(await page.locator(".as .md .cb").first().evaluate((el) => el.classList.contains("wrap"))).toBe(true);

      await page.getByText("第 14 部分", { exact: false }).waitFor({ timeout: 20000 });
      await page.waitForTimeout(600);

      const result = await page.evaluate(() => {
        const w = window as unknown as { __flicker: {
          barePreFrames: number; heightDrops: number; maxDrop: number; gapMax: number;
          samples: number; stop: boolean; mo?: MutationObserver;
        } };
        w.__flicker.stop = true;
        w.__flicker.mo?.disconnect();
        const md = document.querySelector(".as .md");
        const scroll = document.querySelector(".scroll") as HTMLElement | null;
        const first = md?.querySelector(".cb");
        return {
          barePreFrames: w.__flicker.barePreFrames,
          heightDrops: w.__flicker.heightDrops,
          maxDrop: w.__flicker.maxDrop,
          gapMax: w.__flicker.gapMax,
          samples: w.__flicker.samples,
          finalCbs: md ? md.querySelectorAll(".cb").length : 0,
          finalBare: md ? [...md.querySelectorAll("pre")].filter((p) => !p.closest(".cb")).length : -1,
          finalGap: scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : -1,
          wrapStillOn: first ? first.classList.contains("wrap") : false,
          hasCbHead: md ? md.querySelectorAll(".cb-head").length : 0,
        };
      });

      expect(result.samples).toBeGreaterThan(50);
      expect(result.finalCbs).toBeGreaterThanOrEqual(14);
      expect(result.hasCbHead).toBe(result.finalCbs);
      expect(result.finalBare).toBe(0);
      // Primary flicker: React used to paint bare <pre> then decorate to .cb after paint
      expect(result.barePreFrames).toBe(0);
      // Large collapses were the decorate flash (baseline ~169px); tiny markdown-structure
      // reflows at the streaming tip (~one line) are unrelated and still allowed
      expect(result.maxDrop).toBeLessThan(40);
      expect(result.finalGap).toBeLessThanOrEqual(2);
      // Stick may lag a frame while the virtualizer remeasures; never leave the bottom for long
      expect(result.gapMax).toBeLessThanOrEqual(120);
      expect(result.wrapStillOn).toBe(true);

      // Copy button present and wired (clipboard may be denied in headless — just ensure click doesn't throw)
      await page.locator(".as .md .cb").first().locator(".cb-copy").click();

      // XSS: finished assistant markdown must not execute markup (DOMPurify + escaped fences)
      // Finished assistant markdown via the timeline store (window.__tl from main.tsx)
      const liveXss = await page.evaluate(async () => {
        type R = { ok: boolean; xss: boolean; bareImg: boolean; script: boolean; cb: number };
        const useTl = (window as unknown as { __tl?: { setState: (p: unknown) => void } }).__tl;
        if (!useTl) return { ok: false, xss: true, bareImg: true, script: true, cb: 0 } satisfies R;
        const evil = "hello\n\n```html\n<img src=x onerror=window.__xssLive=1>\n<script>window.__xssLive=1</script>\n```\n\n<img src=x onerror=window.__xssLive=1>\n<script>window.__xssLive=1</script>";
        useTl.setState({
          items: [{ kind: "assistant", key: "xss1", itemId: "xss1", text: evil, streaming: false }],
          status: "idle",
          pending: [],
          queue: [],
          error: null,
        });
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));
        const md = document.querySelector(".as .md") || document.querySelector(".md");
        return {
          ok: true,
          xss: Boolean((window as unknown as { __xssLive?: boolean }).__xssLive),
          bareImg: md ? md.querySelectorAll("img").length > 0 : false,
          script: md ? md.querySelectorAll("script").length > 0 : false,
          cb: md ? md.querySelectorAll(".cb").length : 0,
        } satisfies R;
      });
      expect(liveXss.ok).toBe(true);
      expect(liveXss.xss).toBe(false);
      expect(liveXss.bareImg).toBe(false);
      expect(liveXss.script).toBe(false);
      expect(liveXss.cb).toBeGreaterThanOrEqual(1);
    } finally {
      await browser.close();
      daemon.kill("SIGTERM");
      rmSync(xdg, { recursive: true, force: true });
      rmSync(projDir, { recursive: true, force: true });
    }
  }, 60000);

  it("a growing code block keeps its wrap toggle, the stuck bottom never bounces 16px, and the shell doesn't re-render per token", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "ac-flicker2-xdg-"));
    const projDir = mkdtempSync(join(tmpdir(), "ac-flicker2-proj-"));
    const dataDir = join(xdg, "magpie", "agent-console");
    const projectId = "p_flicker2";
    const threadId = "t_flicker2";
    mkdirSync(join(dataDir, "threads", threadId), { recursive: true });
    const now = Date.now();
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
      v1Migrated: true, theme: "dark", lastProjectId: projectId, lastThreadId: threadId,
    }));
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify([
      { id: projectId, name: "flicker2", path: projDir, createdAt: now },
    ]));
    writeFileSync(join(dataDir, "threads", threadId, "meta.json"), JSON.stringify({
      id: threadId, projectId, title: "stream flicker 2", titleAuto: false, provider: "mock", model: null,
      mode: "bypassPermissions", effort: "high", providerSessionId: null, status: "idle", pinned: false,
      archived: false, createdAt: now - 1000, updatedAt: now, lastTurnStatus: "completed",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }, seq: 0,
    }));
    writeFileSync(join(dataDir, "threads", threadId, "timeline.jsonl"), "");

    const port = 36100 + Math.floor(Math.random() * 400);
    const daemon = spawn(process.execPath, [join(root, "daemon/dist/main.js"), "--port", String(port), "--data", xdg], {
      env: { ...process.env, AGENT_CONSOLE_MOCK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launchArgs = process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [];
    const browser = await chromium.launch({ executablePath: browserPath!, headless: true, args: launchArgs });
    try {
      let token = "";
      const readyDeadline = Date.now() + 12000;
      while (Date.now() < readyDeadline) {
        try {
          const dj = JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8"));
          if (dj.token) { token = dj.token; break; }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(token.length).toBeGreaterThan(0);

      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      // A minimal DevTools hook: React reports every commit, which lets the page count component renders
      await page.addInitScript(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true, isDisabled: false, renderers: new Map(), inject: () => 1, checkDCE() {},
          onCommitFiberRoot: () => { w.__lastCommit = performance.now(); (w.__onCommit as (() => void) | undefined)?.(); },
          onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
        };
        // Requests still waiting for their response (boot calls like providers.list land late and re-render App)
        const open = new Set<unknown>();
        w.__openReqs = open;
        const OW = window.WebSocket;
        window.WebSocket = class extends OW {
          constructor(...a: ConstructorParameters<typeof WebSocket>) {
            super(...a);
            this.addEventListener("message", (e) => {
              try { const m = JSON.parse(String(e.data)); if (m.t === "res") open.delete(m.id); } catch {}
            });
          }
          send(data: Parameters<WebSocket["send"]>[0]) {
            try { const m = JSON.parse(String(data)); if (m.t === "req") open.add(m.id); } catch {}
            super.send(data);
          }
        };
      });
      await page.goto(`http://127.0.0.1:${port}/?lang=zh#t=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".composer .cp-ta", { timeout: 10000 });

      await page.evaluate(() => {
        type Fiber = { tag: number; return: Fiber | null; alternate: Fiber | null; memoizedState: unknown };
        const w = window as unknown as Record<string, unknown>;
        const fiberOf = (el: Element | null): Fiber | null => {
          if (!el) return null;
          const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$"));
          return k ? (el as unknown as Record<string, Fiber>)[k]! : null;
        };
        // nearest function / memo / forwardRef component above a host fiber
        const fnAbove = (f: Fiber | null): Fiber | null => {
          while (f && ![0, 11, 14, 15].includes(f.tag)) f = f.return;
          return f;
        };
        // A render gives a function component a fresh hook list (memoizedState); a skipped one keeps it
        const T: Record<string, { f: Fiber; seen: Set<unknown>; n: number; at: number[] }> = {};
        const track = (name: string, f: Fiber | null) => {
          if (f) T[name] = { f, seen: new Set([f.memoizedState, f.alternate?.memoizedState]), n: 0, at: [] };
        };
        const layout = fnAbove(fiberOf(document.querySelector(".app")));
        track("Layout", layout);
        track("App", fnAbove(layout?.return ?? null));
        track("Sidebar", fnAbove(fiberOf(document.querySelector(".sidebar > *"))));
        track("Topbar", fnAbove(fiberOf(document.querySelector(".topbar"))));
        track("Panel", fnAbove(fiberOf(document.querySelector(".panel > *"))));
        track("Composer", fnAbove(fiberOf(document.querySelector(".composer"))));
        w.__renders = T;
        w.__onCommit = () => {
          for (const t of Object.values(T)) {
            for (const st of [t.f.memoizedState, t.f.alternate?.memoizedState]) {
              if (st && !t.seen.has(st)) { t.seen.add(st); t.n++; t.at.push(performance.now()); }
            }
          }
        };
      });
      // Let the late boot responses (providers.list, settings) land before measuring
      await page.waitForFunction(() => {
        const w = window as unknown as { __openReqs: Set<unknown>; __lastCommit?: number };
        return w.__openReqs.size === 0 && performance.now() - (w.__lastCommit ?? 0) > 600;
      }, null, { timeout: 15000, polling: 100 });
      const tracked = await page.evaluate(() => Object.keys((window as unknown as { __renders: object }).__renders).sort());
      expect(tracked).toEqual(["App", "Composer", "Layout", "Panel", "Sidebar", "Topbar"]);

      await page.evaluate(() => {
        const w = window as unknown as { __f2: Record<string, unknown> };
        const f = {
          stop: false, barePreFrames: 0, endD: [] as number[], wrapLost: 0, clicked: false, frames: 0,
          sbMut: 0, tbMut: 0,
        };
        w.__f2 = f as unknown as Record<string, unknown>;
        new MutationObserver((m) => { f.sbMut += m.filter((x) => x.type === "childList").length; })
          .observe(document.querySelector(".sidebar")!, { subtree: true, childList: true });
        new MutationObserver((m) => { f.tbMut += m.filter((x) => x.type === "childList").length; })
          .observe(document.querySelector(".topbar")!, { subtree: true, childList: true });
        // Distance from the streaming row's content to the scroller's bottom edge, while stuck and overflowing
        const measure = () => {
          const s = document.querySelector(".scroll") as HTMLElement | null;
          const md = document.querySelector(".md.streaming");
          if (!s || !md || s.scrollTop <= 0) return;
          const rows = [...s.querySelectorAll<HTMLElement>("[data-index]")];
          const last = rows.reduce<HTMLElement | null>((a, b) => (!a || +b.dataset.index! > +a.dataset.index! ? b : a), null);
          if (!last || !last.contains(md)) return;
          const inner = (last.firstElementChild as HTMLElement | null) ?? last;
          f.endD.push(Math.round(s.getBoundingClientRect().bottom - inner.getBoundingClientRect().bottom));
          for (const pre of md.querySelectorAll("pre")) if (!pre.closest(".cb")) f.barePreFrames++;
          if (f.clicked && !md.querySelector(".cb")?.classList.contains("wrap")) f.wrapLost++;
        };
        const loop = () => {
          if (f.stop) return;
          f.frames++;
          // Frame end: a ResizeObserver created now delivers its first callback in this frame's RO step, after the
          // app's own observers (virtualizer remeasure, stick-to-bottom) — the layout that is about to be painted
          const ro = new ResizeObserver(() => { ro.disconnect(); measure(); });
          ro.observe(document.body);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });

      await page.locator(".cp-ta").fill("/codestream");
      await page.keyboard.press("Enter");
      // First block still open and growing: toggle its wrap mid-stream (in-page: Playwright's click waits for a
      // stable element, which a growing block never is)
      await page.waitForFunction(() => (document.querySelector(".md.streaming .cb")?.querySelectorAll(".cb-l").length ?? 0) >= 4, null, { timeout: 15000 });
      const atClick = await page.evaluate(() => {
        const cb = document.querySelector(".md.streaming .cb")!;
        cb.querySelector(".cb-wrap")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        (window as unknown as { __f2: { clicked: boolean } }).__f2.clicked = true;
        return { lines: cb.querySelectorAll(".cb-l").length, blocks: document.querySelectorAll(".md.streaming .cb").length };
      });
      expect(atClick.blocks).toBe(1);

      // Mid-stream window: the shell's nodes and render counts
      const base = await page.evaluate(() => {
        const w = window as unknown as { __renders: Record<string, { n: number }>; __f2: Record<string, unknown>; __shell: Element[] };
        w.__shell = [document.querySelector(".sidebar")!, ...document.querySelector(".sidebar")!.children,
          document.querySelector(".topbar")!, ...document.querySelector(".topbar")!.children];
        w.__f2.sbMut = 0; w.__f2.tbMut = 0;
        return { t: performance.now(), lines: document.querySelector(".md.streaming .cb")!.querySelectorAll(".cb-l").length,
          n: Object.fromEntries(Object.entries(w.__renders).map(([k, v]) => [k, v.n])) };
      });
      await page.waitForFunction(() => (document.querySelectorAll(".md.streaming .cb")[1]?.querySelectorAll(".cb-l").length ?? 0) >= 10, null, { timeout: 20000 });
      const mid = await page.evaluate((b) => {
        const w = window as unknown as { __renders: Record<string, { n: number }>; __f2: { sbMut: number; tbMut: number }; __shell: Element[] };
        const cbs = document.querySelectorAll(".md.streaming .cb");
        return {
          seconds: (performance.now() - b.t) / 1000,
          linesAdded: cbs[0]!.querySelectorAll(".cb-l").length - b.lines + cbs[1]!.querySelectorAll(".cb-l").length,
          renders: Object.fromEntries(Object.entries(w.__renders).map(([k, v]) => [k, v.n - b.n[k]!])),
          shellKept: w.__shell.every((el) => el.isConnected),
          sbMut: w.__f2.sbMut,
          tbMut: w.__f2.tbMut,
        };
      }, base);
      expect(mid.linesAdded).toBeGreaterThanOrEqual(20);
      // Streamed tokens never reach the three-column shell (1.3.6: App re-rendered Layout/Sidebar/Topbar/Panel per delta)
      expect(mid.renders.App).toBe(0);
      expect(mid.renders.Layout).toBe(0);
      expect(mid.renders.Sidebar).toBe(0);
      expect(mid.renders.Panel).toBe(0);
      // Topbar and Composer only tick their 1 Hz running clocks (1.3.6: every delta re-rendered both)
      expect(mid.renders.Topbar).toBeLessThanOrEqual(Math.ceil(mid.seconds) + 1);
      expect(mid.renders.Composer).toBeLessThanOrEqual(Math.ceil(mid.seconds) + 1);
      expect(mid.renders.Composer).toBeLessThan(mid.linesAdded / 2);
      expect(mid.shellKept).toBe(true);
      expect(mid.sbMut).toBe(0);
      expect(mid.tbMut).toBe(0);

      await page.waitForFunction(() => !document.querySelector(".md.streaming"), null, { timeout: 20000 });
      await page.waitForTimeout(300);
      const result = await page.evaluate(() => {
        const w = window as unknown as { __f2: { stop: boolean; barePreFrames: number; endD: number[]; wrapLost: number; frames: number } };
        w.__f2.stop = true;
        const cbs = [...document.querySelectorAll(".as .md .cb")];
        let bounces = 0;
        const d = w.__f2.endD;
        for (let i = 1; i < d.length; i++) if (Math.abs(d[i]! - d[i - 1]!) >= 8) bounces++;
        return {
          frames: w.__f2.frames, samples: d.length, min: Math.min(...d), max: Math.max(...d), bounces,
          barePreFrames: w.__f2.barePreFrames, wrapLost: w.__f2.wrapLost,
          blocks: cbs.length,
          firstWrap: cbs[0]?.classList.contains("wrap"), firstPressed: cbs[0]?.querySelector(".cb-wrap")?.getAttribute("aria-pressed"),
          firstLines: cbs[0]?.querySelectorAll(".cb-l").length ?? 0,
          secondWrap: cbs[1]?.classList.contains("wrap"),
        };
      });
      expect(result.blocks).toBe(2);
      // The toggled block kept growing after the click and stayed wrapped on every frame to the end
      expect(result.firstLines).toBeGreaterThan(atClick.lines);
      expect(result.firstLines).toBe(22);
      expect(result.firstWrap).toBe(true);
      expect(result.firstPressed).toBe("true");
      expect(result.wrapLost).toBe(0);
      expect(result.secondWrap).toBe(false);
      expect(result.barePreFrames).toBe(0);
      // Stuck to the bottom with the list's 16px gap on every painted frame (1.3.6 alternated 4px ↔ 20px per line)
      expect(result.samples).toBeGreaterThan(60);
      expect(result.max - result.min).toBeLessThanOrEqual(2);
      expect(result.bounces).toBe(0);
    } finally {
      await browser.close();
      daemon.kill("SIGTERM");
      rmSync(xdg, { recursive: true, force: true });
      rmSync(projDir, { recursive: true, force: true });
    }
  }, 60000);
});
