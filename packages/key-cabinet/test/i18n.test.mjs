import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(fileURLToPath(new URL("../ui/i18n.js", import.meta.url)), "utf8");

function load({ search = "", language = "en-US" } = {}) {
  const window = {};
  const document = { documentElement: {}, title: "钥匙柜" };
  runInNewContext(source, {
    window,
    document,
    location: { search },
    navigator: { language },
    URLSearchParams,
  });
  return { i18n: window.KC_I18N, document };
}

test("lang=en 时翻译静态文案与动态规则", () => {
  const { i18n, document } = load({ search: "?lang=en", language: "zh-CN" });
  assert.equal(i18n.lang, "en");
  assert.equal(document.documentElement.lang, "en");
  assert.equal(document.title, "Key Cabinet");
  assert.equal(i18n.t("钥匙柜"), "Key Cabinet");
  assert.equal(i18n.t("每周"), "Weekly");
  assert.equal(i18n.t("每 3 天"), "every 3 days");
  assert.equal(i18n.t("2 把钥匙"), "2 keys");
  assert.equal(i18n.t("已停用 · 点此启用"), "Off · click to enable");
  assert.equal(i18n.t("5,000 tokens · 含缓存读取（每周）"), "5,000 tokens · incl. cache reads (Weekly)");
  assert.equal(i18n.t("已指定 group/foo"), "Set to group/foo");
  assert.equal(
    i18n.t("Magpie 中这把 Key 当前是「已停用」，与本地记录不一致；页面按 Magpie 显示，点上面的状态按钮会把「已启用」写回 Magpie。"),
    "Magpie currently has this key Off, which differs from the local record. The page follows Magpie; the status button writes “On” back to Magpie."
  );
  // 前后空白保留，避免破坏模板缩进。
  assert.equal(i18n.t(" 钥匙柜 "), " Key Cabinet ");
  // 用户数据不翻译。
  assert.equal(i18n.t("group/never-stuck · 永不卡住 · route group"), "group/never-stuck · 永不卡住 · route group");
});

test("复制的配置模板逐行翻译，保留密钥行", () => {
  const { i18n } = load({ search: "?lang=en" });
  const text = [
    "# Magpie 钥匙柜 · project:dev · Gemini / google-genai",
    "GEMINI_API_KEY=sk-magpie-key-abc",
    "# GEMINI_MODEL 省略 = Auto",
  ].join("\n");
  assert.equal(
    i18n.block(text),
    [
      "# Magpie Key Cabinet · project:dev · Gemini / google-genai",
      "GEMINI_API_KEY=sk-magpie-key-abc",
      "# GEMINI_MODEL omitted = Auto",
    ].join("\n")
  );
});

test("lang=zh 或没有参数但浏览器是中文时保持中文", () => {
  for (const opts of [{ search: "?lang=zh" }, { search: "", language: "zh-CN" }]) {
    const { i18n, document } = load(opts);
    assert.equal(i18n.lang, "zh");
    assert.equal(document.documentElement.lang, "zh-CN");
    assert.equal(document.title, "钥匙柜");
    assert.equal(i18n.t("每周"), "每周");
  }
});

test("英文 Magpie 优先于中文浏览器", () => {
  const { i18n } = load({ search: "?lang=en", language: "zh-CN" });
  assert.equal(i18n.t("新钥匙"), "New key");
});
