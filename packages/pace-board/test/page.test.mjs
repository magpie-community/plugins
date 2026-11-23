// 本文由AI自动生成
// 用文本断言守住页面侧的硬规则：沙盒不许 inline、不许 module、
// 带路页只导航，真界面才从自己的服务取数。
import { test, expect } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => fs.readFileSync(dir + p, "utf8");

const pkg = JSON.parse(read("package.json"));
const leadHtml = read("page/index.html");
const boot = read("page/boot.js");
const boardHtml = read("page/board/index.html");
const app = read("page/board/app.js");
const index = read("index.mjs");

test("包名与仓库字段符合同仓 page 包约定", () => {
  expect(pkg.name).toBe("@magpie-community/page-pace-board");
  expect(pkg.repository.directory).toBe("packages/pace-board");
  expect(pkg.magpie.page.file).toBe("page/index.html");
  for (const f of ["index.mjs", "lib", "page", "test", "LICENSE", "README.md"]) {
    expect(pkg.files).toContain(f);
  }
});

test("声明的页面与图标真的在包里", () => {
  expect(fs.existsSync(dir + pkg.magpie.page.file)).toBe(true);
  expect(fs.existsSync(dir + pkg.magpie.page.icon)).toBe(true);
});

test("页面不使用内联事件处理器（CSP 会拦）", () => {
  for (const html of [leadHtml, boardHtml]) {
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
  }
});

test("页面不使用 ES module（沙盒 origin 为 null）", () => {
  expect(leadHtml).not.toMatch(/type=["']module["']/);
  expect(boardHtml).not.toMatch(/type=["']module["']/);
});

test("带路页只做导航，不联网", () => {
  // 注释里会提到 WebSocket（解释为什么不能用），只看代码本身
  const code = boot.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(code).toContain("location.replace");
  expect(code).not.toMatch(/\bfetch\s*\(/);
  expect(code).not.toMatch(/XMLHttpRequest|WebSocket|EventSource/);
  expect(code).not.toMatch(/window\.open/);
});

test("真界面从自己的服务取数，并带上一次性口令", () => {
  expect(boardHtml).toContain('name="pace-token"');
  expect(app).toContain('fetch("/api/board"');
  expect(app).toContain("x-pace-token");
  expect(app).toContain('meta[name="pace-token"]');
});

test("默认端口三处一致（包声明 / 宿主 / 带路页）", () => {
  const port = pkg.magpie.page.service.port;
  expect(pkg.magpie.options.port).toBe(port);
  expect(index).toContain(`const DEFAULT_PORT = ${port};`);
  expect(boot).toContain(`const DEFAULT_PORT = ${port};`);
});

test("包内没有凭证", () => {
  const all = [leadHtml, boot, boardHtml, app, read("page/board/style.css"), index, read("lib/source.mjs"), read("lib/paths.mjs")].join("\n");
  expect(all).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  expect(all).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
});
