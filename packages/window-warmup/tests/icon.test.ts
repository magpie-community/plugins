// 图标字段与 magpie 的读取规则对齐（internal/plugin/market.go ownIcon、internal/plugin/page.go）：
// 市场与插件行读 package.json 的 magpie.icon（只收 https:// 或 data:image/，上限 3<<19 字节）；
// 侧边栏页面图标读 magpie.page.icon（必须落在页面文件所在目录 page/ 内）。
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  magpie?: { icon?: string; page?: { icon?: string; file?: string } };
};

test("magpie.icon：data:image URI，且不超过 magpie ownIcon 的 1.5MB 上限", () => {
  const icon = pkg.magpie?.icon ?? "";
  expect(icon.startsWith("data:image/")).toBe(true);
  expect(icon.length).toBeLessThanOrEqual(3 << 19);
});

test("magpie.icon 与 page/icon.svg 是同一张图：插件页卡片与侧边栏图标不能只改一份", async () => {
  const icon = pkg.magpie?.icon ?? "";
  const b64 = icon.slice(icon.indexOf(",") + 1);
  const svg = await Bun.file(new URL("../page/icon.svg", import.meta.url)).text();
  expect(Buffer.from(b64, "base64").toString("utf8")).toBe(svg);
});

test("magpie.page.icon：文件存在，且在页面文件（page/）所在目录内", async () => {
  const pageIcon = pkg.magpie?.page?.icon ?? "";
  const pageFile = pkg.magpie?.page?.file ?? "";
  expect(pageFile.startsWith("page/")).toBe(true);
  expect(pageIcon.startsWith("page/")).toBe(true);
  // 与 magpie page.go 一致：图标相对页面目录解析后不得越出
  const rel = pageIcon.slice("page/".length);
  expect(rel).not.toContain("..");
  expect(rel).not.toMatch(/[/\\]/); // 就放在 page/ 一层，最简单也最稳
  await expect(stat(resolve(import.meta.dir, "..", pageIcon))).resolves.toBeTruthy();
});
