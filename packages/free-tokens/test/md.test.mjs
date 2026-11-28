import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFreeTokensMd, amountOf, bjTime } from "../src/md.js";

// test/fixtures/free-tokens.md：2026-11-28 从 https://aihot.news/free-tokens.md 读到的原文，
// 只留了 19 条（分区标题里的条数随之改小），其余字节未动。
const REAL = fs.readFileSync(fileURLToPath(new URL("./fixtures/free-tokens.md", import.meta.url)), "utf8");

test("real md: every deal, in section order, with the right kind", () => {
  const ft = parseFreeTokensMd(REAL);
  assert.equal(ft.deals.length, 19);
  const kinds = {}; for (const d of ft.deals) kinds[d.kind] = (kinds[d.kind] || 0) + 1;
  assert.deepEqual(kinds, { daily: 5, weekly: 1, monthly: 3, once: 6, limited: 3, free: 1 });
  assert.deepEqual(ft.basis, { usdCny: 6.65 });
  assert.equal(ft.updatedAt, "2026-11-28T09:11:00+08:00");
});

test("real md: one deal's fields, as the page needs them", () => {
  const d = parseFreeTokensMd(REAL).deals.find((x) => x.title === "华为云码道免费版每日签到领 100 积分");
  assert.deepEqual(d, {
    id: "华为云码道免费版每日签到领 100 积分", kind: "daily", title: "华为云码道免费版每日签到领 100 积分",
    provider: "华为云码道",
    detail: "登录码道的“活动福利”点击“每日领取”；网页端、小程序、桌面端和 IDE 均可参与。积分只用于码道内置模型，不能当通用 API 余额；用完即停止调用。旧 Token 套餐需先切换为积分套餐。",
    scope: "码道内置模型，如 Kimi K3.1 Pro、GLM-5.3-Flash、DeepSeek V4.1 Flash；自接模型 API 费用另计",
    url: "https://support.huaweicloud.com/offers-codeartsagent/codeartsagent_offers_0004.html",
    tags: ["限产品内使用", "积分制个人体验版", "需每日手动领取"],
    endsAt: "2026-12-31T23:59:00+08:00", validity: "当日领取当日有效", verifiedAt: "2026-11-22T22:10:00+08:00",
    yuan: null, label: "100 积分", face: "", counted: false,
  });
});

test("real md: priced deals carry yuan and face; kinds of 其他福利", () => {
  const by = Object.fromEntries(parseFreeTokensMd(REAL).deals.map((d) => [d.title, d]));
  const rime = by["Rime 每月 50 美元语音模型额度"];
  assert.equal(rime.yuan, 333); assert.equal(rime.face, "50 美元"); assert.equal(rime.counted, true); assert.equal(rime.kind, "monthly");
  assert.equal(by["蚂蚁百灵每月 1 日送 10 元抵扣券"].yuan, 10);
  assert.equal(by["蚂蚁百灵每月 1 日送 10 元抵扣券"].face, "");
  assert.equal(by["阿里云百炼新人部分模型各送 100 万 Token"].yuan, 5.4);
  assert.equal(by["百度千帆新用户送 20 元代金券"].kind, "once");
  assert.equal(by["智谱 AutoClaw 国内版本周登录领 1 万积分"].kind, "limited");
  assert.equal(by["千问办公限时免费用 MiniMax M3.1 Flash"].kind, "limited");
  assert.equal(by["SoMark OXR 免费解析文档 API"].kind, "free"); // 门槛「无需注册」不算新人
  assert.equal(by["云知声 U Plan 免费档每周 2500 积分"].kind, "weekly");
});

test("truncated real md is refused, never shown half", () => {
  for (const n of [200, 2000, Math.floor(REAL.length / 2), REAL.length - 400]) {
    assert.throws(() => parseFreeTokensMd(REAL.slice(0, n)), /不完整|没有羊毛|没有标题/, `cut at ${n}`);
  }
  // 最后一条在中途断了，且后面再没有分区
  const cut = REAL.slice(0, REAL.indexOf("- 去领：https://somark.cn/oxr"));
  assert.throws(() => parseFreeTokensMd(cut), /最后一条在中途断了/);
});

test("empty, html and json bodies are refused", () => {
  for (const b of ["", null, undefined, "<!doctype html><html><body>verify</body></html>", '{"error":"use_open_interfaces"}']) {
    assert.throws(() => parseFreeTokensMd(b), /内容异常/);
  }
  assert.throws(() => parseFreeTokensMd("# t\n\n## 每天都能领（0 个）\n\n## 回答提示\n"), /没有羊毛/);
});

test("sections without counts, CRLF and wrapped values still parse", () => {
  const md = "# t\r\n- 更新：2026-11-28（北京时间）\r\n\r\n## 其他福利\r\n\r\n### A\r\n\r\n- 提供方：DeepSeek\r\n- 能领多少：¥10（面值）\r\n- 怎么领：第一行\r\n  第二行\r\n- 去领：https://e/x 看这里\r\n";
  const ft = parseFreeTokensMd(md);
  assert.equal(ft.deals.length, 1);
  assert.equal(ft.deals[0].detail, "第一行 第二行");
  assert.equal(ft.deals[0].url, "https://e/x");
  assert.equal(ft.deals[0].kind, "once");
  assert.equal(ft.basis, null);
  assert.equal(ft.updatedAt, "2026-11-28T23:59:00+08:00");
});

test("a deal with no link has url null", () => {
  const ft = parseFreeTokensMd("# t\n## 其他福利\n### A\n- 提供方：Zed\n- 能领多少：免费（长期）\n- 去领：见官网\n");
  assert.equal(ft.deals[0].url, null);
  assert.equal(ft.deals[0].kind, "free");
});

test("amountOf / bjTime", () => {
  assert.deepEqual(amountOf("≈¥0.5（每天 · 100 积分，按官方单独充值 10 元买 2000 积分）"), { yuan: 0.5, face: "100 积分", label: "" });
  assert.deepEqual(amountOf("¥20（面值）"), { yuan: 20, face: "", label: "" });
  assert.deepEqual(amountOf("¥300"), { yuan: 300, face: "", label: "" });
  assert.deepEqual(amountOf("免费（指定模型限免）"), { yuan: null, face: "", label: "免费" });
  assert.deepEqual(amountOf(undefined), { yuan: null, face: "", label: "" });
  assert.equal(bjTime("2026-12-05 23:59（北京时间）"), "2026-12-05T23:59:00+08:00");
  assert.equal(bjTime("长期"), null);
  assert.equal(bjTime(undefined), null);
});
