// 页面端到端冒烟：真实浏览器（Chromium 与 WebKit）打开本地服务页面，走一遍新建任务并保存。
// Playwright 是可选依赖：仓库不安装它，评审机通过 NODE_PATH 提供（1.62.0，Chromium + WebKit）。
// 导入失败或浏览器启动失败时整组跳过，仓库根目录的 bun test 不受影响。
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService, type ServiceHandle } from "../src/server";
import { fakeGateway, type FakeGateway } from "./fake-gateway";

// Playwright 的最小类型面：不依赖它的类型声明，没装也能通过 tsc
interface Locator {
  click(): Promise<void>;
  fill(v: string): Promise<void>;
  first(): Locator;
  waitFor(o?: { timeout?: number }): Promise<void>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  on(ev: "pageerror", cb: (e: unknown) => void): void;
  getByRole(role: string, o?: { name?: string; exact?: boolean }): Locator;
  getByPlaceholder(t: string): Locator;
  getByText(t: string): Locator;
}
/** 插件页在 magpie 里跑在 iframe 中：框架内的定位器 */
interface FrameLocator {
  getByRole(role: string, o?: { name?: string; exact?: boolean }): Locator;
  getByText(t: string): Locator;
  locator(selector: string): Locator;
}
interface Page {
  frameLocator(selector: string): FrameLocator;
  evaluate<T>(fn: () => T): Promise<T>;
  waitForFunction(fn: () => boolean, arg?: unknown, o?: { timeout?: number }): Promise<unknown>;
}
interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Engine {
  launch(): Promise<Browser>;
}
interface Playwright {
  chromium: Engine;
  webkit: Engine;
}

const pw = await (async (): Promise<Playwright | null> => {
  try {
    const name = "playwright"; // 非字面量：未安装时也不要求模块声明
    return (await import(name)) as unknown as Playwright;
  } catch {
    return null;
  }
})();

const ENGINES: Array<[string, Engine]> = pw ? [["chromium", pw.chromium], ["webkit", pw.webkit]] : [];

// 浏览器缺失时跳过整组（test.skipIf 在定义时求值）：探针各启动一次并立即关闭
const browsersReady = await (async () => {
  for (const [, engine] of ENGINES) {
    try {
      const b = await engine.launch();
      await b.close();
    } catch {
      return false;
    }
  }
  return ENGINES.length > 0;
})();
const testBrowser = test.skipIf(!browsersReady);

if (!browsersReady) test.skip("浏览器冒烟：本机没有可用的 Playwright/Chromium/WebKit，已跳过", () => {});

let svc: ServiceHandle;
let gw: FakeGateway;
let dir: string;

beforeAll(async () => {
  if (!browsersReady) return; // 没浏览器就不起服务
  dir = await mkdtemp(join(tmpdir(), "ww-browser-"));
  gw = fakeGateway({
    models: [
      { id: "acme/acme-pro-2", owned_by: "acme", reasoning: true, reasoning_levels: ["low", "high"] },
      { id: "acme/acme-mini-3", owned_by: "acme" },
    ],
    quotas: [
      {
        provider: "acme",
        user: "me@x.com",
        windows: [{ name: "5h", used: 40, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() }],
      },
    ],
    chat: { status: 200, body: { id: "x", choices: [] } },
  });
  svc = await startService({ port: 0, dir, base: gw.base, uiDir: join(import.meta.dir, "..", "dist", "ui") });
});

afterAll(async () => {
  await svc?.stop();
  gw?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

for (const [name, engine] of ENGINES) {
  testBrowser(
    `${name}：新建任务、切换触发方式并保存`,
    async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${svc.port}/?lang=zh`);
        // 目录加载完成前按钮就存在；等账号下拉渲染出目录里的账号再操作
        await page.getByRole("button", { name: "新建任务" }).click();
        await page.getByRole("button", { name: "账号 me@x.com", exact: true }).waitFor({ timeout: 15_000 });
        await page.getByPlaceholder("给任务起个名字").fill("浏览器冒烟");
        await page.getByRole("button", { name: "每天定时", exact: true }).click();
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await page.getByText("浏览器冒烟").first().waitFor({ timeout: 15_000 });
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    90_000,
  );
}

for (const [name, engine] of ENGINES) {
  testBrowser(
    `${name}：magpie 同款沙箱框架里「反馈问题」能收集诊断并复制两段内容`,
    async () => {
      // 与 magpie 宿主一致：sandbox="allow-scripts" + allow=""，下载/弹窗/Clipboard API 全被拦
      const host = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () =>
          new Response(
            `<!doctype html><iframe id="f" sandbox="allow-scripts" allow="" src="http://127.0.0.1:${svc.port}/?lang=zh"></iframe>`,
            { headers: { "content-type": "text/html" } },
          ),
      });
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${host.port}/`);
        const f = page.frameLocator("#f");
        await f.getByRole("button", { name: "反馈问题" }).click();
        await f.getByRole("button", { name: "① 复制 issue 链接" }).click();
        await f.getByText("链接已复制。").waitFor({ timeout: 15_000 });
        await f.locator("button:has-text('② 复制问题内容'):not([disabled])").waitFor({ timeout: 15_000 });
        await f.getByRole("button", { name: "② 复制问题内容" }).click();
        await f.getByText("问题内容已复制。").waitFor({ timeout: 15_000 });
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        host.stop(true);
      }
    },
    90_000,
  );
}

for (const [name, engine] of ENGINES) {
  testBrowser(
    `${name}：编辑区原地展开在所点的行（含新建任务的新行）下面；页脚链接样式不串到编辑区按钮`,
    async () => {
      // 经服务 API 先建两个任务（口令取自首页 boot 数据块）
      const base = `http://127.0.0.1:${svc.port}`;
      const html = await (await fetch(base)).text();
      const token = String(JSON.parse(/id="boot"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]).token);
      const ids: string[] = [];
      for (const taskName of ["原地展开甲", "原地展开乙"]) {
        const res = await fetch(`${base}/api/tasks`, {
          method: "POST",
          headers: { "x-window-warmup-token": token, "content-type": "application/json" },
          body: JSON.stringify({
            name: taskName, enabled: false, provider: "acme", account: "me@x.com", model: "", message: "hi",
            trigger: { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" },
          }),
        });
        ids.push(((await res.json()) as { id: string }).id);
      }
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`${base}/?lang=zh`);
        await page.getByText("原地展开甲").first().click();
        await page.getByPlaceholder("给任务起个名字").waitFor({ timeout: 15_000 });
        // 编辑区的前一个兄弟就是展开的那一行，且那一行不是列表最后一行
        const layout = await page.evaluate(() => {
          const ed = document.querySelector("#list .editor");
          const prev = ed?.previousElementSibling;
          return {
            prevIsOpenRow: !!prev?.classList.contains("open"),
            prevName: prev?.textContent?.includes("原地展开甲") ?? false,
            editorIsLast: ed === document.querySelector("#list")?.lastElementChild,
          };
        });
        expect(layout).toEqual({ prevIsOpenRow: true, prevName: true, editorIsLast: false });
        // 编辑区的「立即发送一次」走 .link 自己的 12px；页脚「反馈问题」是独立的 .foot-link（11.5px），
        // 两者共用类名时页脚规则会覆盖编辑区按钮
        const sizes = await page.evaluate(() => {
          const run = [...document.querySelectorAll("#list .editor button")].find((b) => b.textContent === "立即发送一次");
          const foot = document.getElementById("feedback");
          return {
            run: run ? getComputedStyle(run).fontSize : null,
            foot: foot ? getComputedStyle(foot).fontSize : null,
          };
        });
        expect(sizes).toEqual({ run: "12px", foot: "11.5px" });

        // 列表里已有任务时新建：编辑区紧跟底部的新行，与保存后任务追加到底部一致
        await page.getByRole("button", { name: "新建任务" }).click();
        await page.waitForFunction(() => {
          const ed = document.querySelector("#list .editor");
          return !!ed && ed === document.querySelector("#list")?.lastElementChild;
        }, undefined, { timeout: 15_000 });
        const added = await page.evaluate(() => {
          const list = document.querySelector("#list");
          const ed = list?.querySelector(".editor");
          return {
            editors: list?.querySelectorAll(".editor").length ?? 0,
            prevIsOpenRow: !!ed?.previousElementSibling?.classList.contains("open"),
            editorIsLast: ed === list?.lastElementChild,
          };
        });
        expect(added).toEqual({ editors: 1, prevIsOpenRow: true, editorIsLast: true });
      } finally {
        await browser.close();
        for (const id of ids) {
          await fetch(`${base}/api/tasks/${id}`, { method: "DELETE", headers: { "x-window-warmup-token": token } });
        }
      }
    },
    90_000,
  );
}
