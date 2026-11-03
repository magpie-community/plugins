// 页面端到端冒烟：真实浏览器（Chromium 与 WebKit）打开本地服务页面，走一遍新建任务并保存。
// 只在装了浏览器时运行（CI 由工作流执行 npx playwright install chromium webkit）；
// 本机没装浏览器时整组跳过，不影响其余单元测试。注意 HOME=$(mktemp -d) 会改变
// Playwright 查找浏览器缓存的根目录：套件在临时 HOME 下运行时，要么不覆盖 HOME
// （本包测试自带 XDG 隔离），要么设 PLAYWRIGHT_BROWSERS_PATH 指向真实缓存。
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserType } from "playwright";
import { buildAll } from "../scripts/build";
import { startService, type ServiceHandle } from "../src/server";
import { fakeGateway, type FakeGateway } from "./fake-gateway";

const ENGINES: Array<[string, BrowserType]> = [
  ["chromium", chromium],
  ["webkit", webkit],
];

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
  return true;
})();
const testBrowser = test.skipIf(!browsersReady);

let svc: ServiceHandle;
let gw: FakeGateway;
let dir: string;

beforeAll(async () => {
  await buildAll(); // 页面从 dist/ui 提供静态资源
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
