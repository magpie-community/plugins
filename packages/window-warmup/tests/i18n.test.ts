// i18n 的测试：语言归一、三张译文的键集合一致、t 的查表与回退。不碰 DOM、不发请求。
import { expect, test } from "bun:test";
import { I18N, normalizeLang, setLang, t, type I18NTable, type Lang } from "../web/app";

test("normalizeLang：归一到 Magpie 的四种语言，识别不了回退 zh", () => {
  const table: [string | null | undefined, Lang][] = [
    ["zh", "zh"],
    ["zh-CN", "zh"],
    ["zh-TW", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["en", "en"],
    ["en-US", "en"],
    ["ja", "ja"],
    ["ja-JP", "ja"],
    ["fr", "zh"],
    ["", "zh"],
    [null, "zh"],
  ];
  for (const [raw, want] of table) expect(normalizeLang(raw)).toBe(want);
});

test("en / zh-TW / ja 三张译文的键集合完全一致，漏译即暴露", () => {
  const keys = (l: Lang): string[] => Object.keys((I18N[l] ?? {}) as I18NTable).sort();
  expect(keys("en")).toEqual(keys("zh-TW"));
  expect(keys("en")).toEqual(keys("ja"));
  // 译文一律非空：空串会退化成回退键，等于没译
  for (const l of ["en", "zh-TW", "ja"] as const) {
    for (const [k, v] of Object.entries(I18N[l] ?? {})) expect(v.trim().length).toBeGreaterThan(0);
  }
});

test("t：zh 恒等返回键，其他语言命中译文，未知键在任何语言都回退键本身", () => {
  const KEY = "必须选择账号";
  const UNKNOWN = "不存在的键";
  expect(t(KEY)).toBe(KEY); // 默认 zh：键即中文，逐字恒等
  expect(t(UNKNOWN)).toBe(UNKNOWN);
  for (const l of ["en", "zh-TW", "ja"] as const) {
    setLang(l);
    expect(t(KEY)).toBe(I18N[l]![KEY]);
    expect(t(UNKNOWN)).toBe(UNKNOWN);
  }
  setLang("zh");
  expect(t(KEY)).toBe(KEY);
});

test("调用点键 ⊆ 三张译表：app.ts 里每个 t(\"…\") 字面量在各语言都有词条", async () => {
  const src = await Bun.file(new URL("../web/app.ts", import.meta.url)).text();
  const keys = new Set<string>();
  for (const m of src.matchAll(/\bt\("((?:[^"\\]|\\.)*)"\)/g)) keys.add(m[1]);
  expect(keys.size).toBeGreaterThan(50); // 防止正则失配让测试空转
  for (const langName of ["en", "zh-TW", "ja"] as const) {
    const table = I18N[langName]!;
    const missing = [...keys].filter((k) => !(k in table));
    expect(missing).toEqual([]);
    if (missing.length) console.error(`${langName} 缺词条:`, missing);
  }
});
