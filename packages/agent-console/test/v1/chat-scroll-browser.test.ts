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

function buildTallReply(): string {
  return [
    "现在已经安装并检查完成了，当前状态是正常的。",
    "",
    "已经完成：",
    "- `VoxWeave v0.2.0 Windows x64` 已安装到：`voxweave\\VoxWeave.exe`",
    "- VoxWeave 桌面程序正在运行。",
    "- 后台服务正在运行，地址是：`127.0.0.1:2994`",
    "- RVC 环境自检通过，CUDA 识别到：`NVIDIA GeForce RTX 3070 Ti`",
    "",
    "```text",
    "Python 3.12",
    "PyTorch 2.7.1+cu118",
    "FFmpeg 8.1.2",
    ...Array.from({ length: 18 }, (_, i) => `check-step-${i + 1}: status=ready latency=${10 + i}ms`),
    "```",
    "",
    "四个中文女声模型也已经保留并被识别为 `ready`：",
    "",
    "```text",
    "1  女声-可可",
    "2  女声-云儿青春",
    "3  女声-雅琳御姐",
    "4  女声-诗韵",
    ...Array.from({ length: 16 }, (_, i) => `preset-${i + 1}: D:\\VoxWeave\\models\\voice_${i + 1}.pth`),
    "```",
    "",
    "原始下载文件还保留在项目目录：",
    "",
    "```text",
    ...Array.from({ length: 14 }, (_, i) => `D:\\workwork\\变声器\\downloads\\archive_part_${i + 1}.zip`),
    "```",
    "",
    "以上全部验证完毕（BOTTOM_SENTINEL_136）。",
  ].join("\n");
}

describe.skipIf(!browserPath)("Chat virtual-list scroll to bottom in real Chromium (1.3.6)", () => {
  it("opens, recovers from hidden view, streams tall replies, and handles wheel-up + jump cleanly", async () => {
    const xdg = mkdtempSync(join(tmpdir(), "ac-scroll-xdg-"));
    const projDir = mkdtempSync(join(tmpdir(), "ac-scroll-proj-"));
    const dataDir = join(xdg, "magpie", "agent-console");
    const projectId = "p_scroll1";
    const threadId = "t_scroll1";
    const threadDir = join(dataDir, "threads", threadId);
    mkdirSync(threadDir, { recursive: true });

    const now = Date.now();
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
      v1Migrated: true,
      theme: "dark",
      lastProjectId: projectId,
      lastThreadId: threadId,
    }));
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify([
      { id: projectId, name: "变声器", path: projDir, createdAt: now },
    ]));

    const events: Record<string, unknown>[] = [];
    let seq = 1;
    for (let turn = 1; turn <= 6; turn++) {
      const turnId = `turn-${turn}`;
      events.push({ seq: seq++, ts: now - (20 - turn) * 1000, threadId, turnId, type: "user_message", text: `第 ${turn} 轮问题：现在已经安装好了吗？还是什么情况？你检查一下。` });
      events.push({ seq: seq++, ts: now - (20 - turn) * 1000 + 50, threadId, turnId, type: "turn_started", model: "codex/gpt-6.1-terra", mode: "bypassPermissions", effort: "high" });
      events.push({
        seq: seq++,
        ts: now - (20 - turn) * 1000 + 200,
        threadId,
        turnId,
        type: "assistant_message",
        itemId: `a-${turn}`,
        text: turn === 6 ? buildTallReply() : `第 ${turn} 轮检查汇报：\n\n` + Array.from({ length: 8 }, (_, j) => `- 检查项 ${j + 1}：已就绪`).join("\n"),
      });
      events.push({ seq: seq++, ts: now - (20 - turn) * 1000 + 400, threadId, turnId, type: "turn_ended", status: "completed", durationMs: 1200 });
    }
    writeFileSync(join(threadDir, "meta.json"), JSON.stringify({
      id: threadId,
      projectId,
      title: "那你像他们陪，他们那个说什么杂音…",
      titleAuto: false,
      provider: "mock",
      model: null,
      mode: "bypassPermissions",
      effort: "high",
      providerSessionId: null,
      status: "idle",
      pinned: false,
      archived: false,
      createdAt: now - 60000,
      updatedAt: now,
      lastTurnStatus: "completed",
      usage: { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, costUsd: 0.02 },
      seq: seq - 1,
    }));
    writeFileSync(join(threadDir, "timeline.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const port = 35400 + Math.floor(Math.random() * 400);
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
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(token.length).toBeGreaterThan(0);

      const url = `http://127.0.0.1:${port}/?lang=zh#t=${encodeURIComponent(token)}`;
      const page = await browser.newPage({ viewport: { width: 920, height: 860 } });
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.getByText("BOTTOM_SENTINEL_136", { exact: false }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(300);

      const readMetrics = () => page.evaluate(() => {
        const el = document.querySelector(".scroll") as HTMLElement;
        return {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          gap: el.scrollHeight - el.scrollTop - el.clientHeight,
          jumpVisible: Boolean(document.querySelector("button.jump")),
        };
      });

      const m1 = await readMetrics();
      expect(m1.scrollHeight).toBeGreaterThan(2200);
      expect(m1.gap).toBeLessThanOrEqual(2);
      expect(m1.jumpVisible).toBe(false);

      // Simulate plugin disable -> re-enable while host view starts hidden (0x0 layout), then becomes visible
      const hiddenPage = await browser.newPage({ viewport: { width: 920, height: 860 } });
      await hiddenPage.addInitScript(() => {
        const st = document.createElement("style");
        st.id = "__ac_hide";
        st.textContent = "html{display:none!important}";
        document.documentElement.appendChild(st);
      });
      await hiddenPage.goto(url, { waitUntil: "domcontentloaded" });
      await hiddenPage.waitForFunction(() => document.querySelectorAll(".tl-wrap [data-index]").length > 0, null, { timeout: 10000 });
      await hiddenPage.waitForTimeout(250);
      await hiddenPage.evaluate(() => document.getElementById("__ac_hide")?.remove());
      await hiddenPage.getByText("BOTTOM_SENTINEL_136", { exact: false }).waitFor({ timeout: 10000 });
      await hiddenPage.waitForTimeout(300);
      const mHidden = await hiddenPage.evaluate(() => {
        const el = document.querySelector(".scroll") as HTMLElement;
        return { gap: el.scrollHeight - el.scrollTop - el.clientHeight, jumpVisible: Boolean(document.querySelector("button.jump")) };
      });
      expect(mHidden.gap).toBeLessThanOrEqual(2);
      expect(mHidden.jumpVisible).toBe(false);
      await hiddenPage.close();

      // User wheels upward -> detaches stick and shows .jump (without false .jd dot)
      const box = await page.locator(".scroll").boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(200);
      const mUp = await readMetrics();
      expect(mUp.gap).toBeGreaterThan(200);
      expect(mUp.jumpVisible).toBe(true);
      expect(await page.locator("button.jump .jd").count()).toBe(0);

      // Clicking .jump lands all the way at the real bottom again
      await page.locator("button.jump").click();
      await page.waitForTimeout(250);
      const mJump = await readMetrics();
      expect(mJump.gap).toBeLessThanOrEqual(2);
      expect(mJump.jumpVisible).toBe(false);

      // Streaming a new tall multi-code-block reply stays pinned to the bottom without row count growing mid-stream
      const prevHeight = mJump.scrollHeight;
      await page.locator(".cp-ta").fill("/bigreply");
      await page.keyboard.press("Enter");
      await page.getByText("第 14 部分", { exact: false }).waitFor({ timeout: 15000 });
      await page.waitForTimeout(300);
      const mStream = await readMetrics();
      expect(mStream.scrollHeight).toBeGreaterThan(prevHeight + 1000);
      expect(mStream.gap).toBeLessThanOrEqual(2);
      expect(mStream.jumpVisible).toBe(false);
    } finally {
      await browser.close();
      daemon.kill("SIGTERM");
      rmSync(xdg, { recursive: true, force: true });
      rmSync(projDir, { recursive: true, force: true });
    }
  }, 45000);
});
