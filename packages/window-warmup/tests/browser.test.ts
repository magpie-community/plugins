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
