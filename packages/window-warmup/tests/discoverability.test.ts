import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 收录与可发现性回归。依据（magpie 源码）：
// - 社区插件靠 magpie-community/plugins 的 registry.json 收录，magpie 自己从 npm 取最新版
//   （internal/plugin/market.go），发版无需同步清单；只有名称、图标、简介变化才改这条。
// - 插件页搜索框把 [名称, 包名, 当前语言 summary, providers, npm 发布者] 拼成一串做小写子串匹配
//   （internal/gui/assets/plugins.js 的 match，不分词）：所以 summary 必须带上用户会搜的词。
// - 带 community: true 的 page 条目才会出现在不搜索时的「Pages」分区。

type Pkg = {
  name: string;
  description: string;
  main?: string;
  files: string[];
  keywords: string[];
  author?: string;
  repository: { url: string; directory?: string };
};

type Entry = {
  package: string;
  name: string;
  kind?: string;
  community?: boolean;
  icon?: string;
  summary: Record<string, string>;
};

const pkgDir = join(import.meta.dir, "..");
const repoRoot = join(pkgDir, "..", "..");
const pkg: Pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Pkg;
const registry = JSON.parse(readFileSync(join(repoRoot, "registry.json"), "utf8")) as { plugins: Entry[] };
const entry = registry.plugins.find((p) => p.package === pkg.name);
const readme = readFileSync(join(pkgDir, "README.md"), "utf8");

// 与 plugins.js 的 match 同一公式：当前语言的搜索串（zh 用户看 summary.zh，其余语言回退 en）
const searchable = (lang: "zh" | "en"): string =>
  [entry?.name ?? "", pkg.name, entry?.summary?.[lang] ?? entry?.summary?.en ?? ""].join(" ").toLowerCase();

// 插件页只匹配「当前语言」的 summary：中文词查 zh，英文词查 en；名称与包名两边都在
const ZH_WORDS = ["窗口预热", "预热", "窗口", "额度", "配额", "定时", "定时消息", "保活", "重置", "订阅", "每周"];
const EN_WORDS = [
  "warm up", "keep-alive", "keep alive", "quota", "usage window",
  "rate limit", "scheduled messages", "schedule", "daily", "reset",
];
const NAME_WORDS = ["window warmup", "warmup"];

describe("registry.json 收录", () => {
  test("这一条存在，字段与包一致", () => {
    expect(entry, `registry.json 里没有 ${pkg.name}`).toBeDefined();
    expect(entry?.kind).toBe("page");
    expect(entry?.community).toBe(true);
    expect(entry?.summary.zh).toBeTruthy();
    expect(entry?.summary.en).toBeTruthy();
  });

  test("图标指向本仓库包内文件，不用个人仓库的 raw 地址", () => {
    expect(entry?.icon).toBe(
      "https://raw.githubusercontent.com/magpie-community/plugins/main/packages/window-warmup/page/icon.svg",
    );
    expect(existsSync(join(pkgDir, "page", "icon.svg"))).toBe(true);
  });

  test("每个搜索词按界面语言命中对应搜索串", () => {
    for (const w of NAME_WORDS) {
      expect(searchable("zh"), `「${w}」未命中中文搜索串`).toContain(w);
      expect(searchable("en"), `「${w}」未命中英文搜索串`).toContain(w);
    }
    for (const w of ZH_WORDS) expect(searchable("zh"), `「${w}」未命中中文搜索串`).toContain(w);
    for (const w of EN_WORDS) expect(searchable("en"), `「${w}」未命中英文搜索串`).toContain(w);
  });

  test("README 提到作者与源码位置", () => {
    expect(readme).toContain("YangHonghang");
    expect(readme).toContain("magpie-community/plugins");
  });
});

describe("包契约（magpie 宿主与社区仓库约定）", () => {
  test("包名、入口、仓库目录", () => {
    expect(pkg.name).toBe("@magpie-community/page-window-warmup");
    expect(pkg.repository.directory).toBe("packages/window-warmup");
    expect(pkg.main === undefined || existsSync(join(pkgDir, pkg.main))).toBe(true);
  });

  test("files 只列发布必需的文件，且包含 dist 与 page", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("page");
    for (const f of pkg.files) expect(["dist", "page", "README.md", "LICENSE"]).toContain(f);
  });

  test("keywords 保留插件发现契约词", () => {
    for (const w of ["magpie", "magpie-page", "magpie-plugin"]) {
      expect(pkg.keywords, `keywords 缺「${w}」`).toContain(w);
    }
  });

  test("author 是作者本人", () => {
    expect(pkg.author ?? "").toContain("YangHonghang");
  });
});
