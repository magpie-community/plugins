import { test } from "bun:test";
import assert from "node:assert/strict";
import "../page/view.js";
const V = globalThis.FTView;
const MAP = { "阿里云 Qoder": { pid: ["qoder", "qoder-cn"], npm: "@magpie-community/opencode-qoder-auth", name: "Qoder" } };
const ctx = (over = {}) => ({ mapping: MAP, demoState: { configKnown: true, installed: {} }, icons: {}, ...over });

test("V is exposed as a global (classic script)", () => { assert.ok(V && typeof V.rowHtml === "function"); });
test("esc / safeUrl / colorFor / initials / fmtYuan", () => {
  assert.equal(V.esc(`<a>&"'`), "&lt;a&gt;&amp;&quot;&#39;");
  assert.equal(V.safeUrl("javascript:alert(1)"), null);
  assert.equal(V.safeUrl("https://a/b"), "https://a/b");
  assert.match(V.colorFor("abc"), /^#/);
  assert.equal(V.initials("Deep Seek"), "DS"); assert.equal(V.initials("豆包"), "豆"); assert.equal(V.initials(""), "?");
  assert.equal(V.fmtYuan(120), "120"); assert.equal(V.fmtYuan(12.5), "12.5"); assert.equal(V.fmtYuan("x"), "");
});
test("resolvePid array/nonarray", () => {
  assert.equal(V.resolvePid({ url: "https://qoder.com/x" }, MAP["阿里云 Qoder"]), "qoder");
  assert.equal(V.resolvePid({ url: "https://qoder.cn/x" }, MAP["阿里云 Qoder"]), "qoder-cn");
  assert.equal(V.resolvePid({ url: "https://other/x" }, MAP["阿里云 Qoder"]), "qoder");
  assert.equal(V.resolvePid({}, { pid: "z" }), "z");
});
test("bucketOf tiers", () => {
  const D = { provider: "阿里云 Qoder", url: "https://qoder.cn/x", kind: "daily" };
  assert.equal(V.bucketOf({ provider: "X" }, MAP, { configKnown: true, installed: {} }).key, "none");
  assert.equal(V.bucketOf(D, MAP, { configKnown: false, installed: {} }).key, "setup");
  assert.equal(V.bucketOf(D, MAP, { configKnown: true, installed: {} }).key, "setup");
  assert.equal(V.bucketOf(D, MAP, { configKnown: true, installed: { "qoder-cn": { signedIn: false } } }).mode, "login");
  const r = V.bucketOf(D, MAP, { configKnown: true, installed: { "qoder-cn": { signedIn: true, checkin: "claimed" } } });
  assert.equal(r.key, "ready"); assert.equal(r.checkin, "claimed");
  assert.equal(V.bucketOf({ ...D, kind: "monthly" }, MAP, { configKnown: true, installed: { "qoder-cn": { signedIn: true } } }).checkin, null);
});
test("counts", () => { const c = V.counts([{ provider: "X" }, { provider: "阿里云 Qoder", url: "https://qoder.cn/x", kind: "daily" }], MAP, { configKnown: true, installed: { "qoder-cn": { signedIn: true } } }); assert.equal(c.none, 1); assert.equal(c.ready, 1); });
test("avatarHtml icon vs fallback", () => { assert.match(V.avatarHtml("豆包", { "豆包": "brand/x.svg" }), /avatar logo/); const g = V.avatarHtml("豆包", {}); assert.match(g, /avatar gen/); assert.match(g, /豆/); });
test("summaryHtml", () => { const s = V.summaryHtml({ todayClaimable: 201 }, 50, { ready: 14, setup: 8, none: 28 }); assert.match(s, /¥201/); assert.match(s, /50/); });
test("rowHtml ready checkin states + yuan", () => {
  const b = { provider: "阿里云 Qoder", url: "https://qoder.cn/x", kind: "daily", title: "t", yuan: 12, label: "≈12" };
  const r = (checkin) => V.rowHtml(b, ctx({ demoState: { configKnown: true, installed: { "qoder-cn": { signedIn: true, checkin } } } }));
  assert.match(r("claimed"), /今日已领/); assert.match(r("done"), /今日已领/); assert.match(r("none"), /今日可领/); assert.match(r(null), /可用/); assert.match(r("failed"), /可用/); assert.match(r("inactive"), /可用/);
  assert.match(r("claimed"), /¥12/); assert.match(r("claimed"), /<small>≈12<\/small>/);
  assert.match(V.rowHtml({ ...b, kind: "monthly" }, ctx({ demoState: { configKnown: true, installed: { "qoder-cn": { signedIn: true } } } })), /可用/);
});
test("rowHtml setup install/login buttons", () => {
  const b = { provider: "阿里云 Qoder", url: "https://qoder.cn/x", kind: "daily", title: "t" };
  const ins = V.rowHtml(b, ctx());
  assert.match(ins, /安装插件/); assert.match(ins, /data-npm="@magpie-community\/opencode-qoder-auth"/); assert.match(ins, /data-pid="qoder-cn"/);
  assert.match(V.rowHtml(b, ctx({ demoState: { configKnown: true, installed: { "qoder-cn": { signedIn: false } } } })), /去登录/);
});
test("rowHtml none with/without url", () => {
  assert.match(V.rowHtml({ provider: "X", url: "https://e/x", kind: "daily", title: "t" }, ctx()), /复制链接/);
  assert.ok(!/复制链接/.test(V.rowHtml({ provider: "X", url: "javascript:1", kind: "daily", title: "t" }, ctx())));
});
test("rowHtml escapes kind/title (xss)", () => {
  const r = V.rowHtml({ provider: "X", kind: "<img>", title: "<b>evil</b>", url: "https://e/x" }, ctx({ mapping: {} }));
  assert.ok(!/<img>/.test(r)); assert.match(r, /&lt;img&gt;/);
  assert.ok(!/<b>/.test(r)); assert.match(r, /&lt;b&gt;evil&lt;\/b&gt;/);
});
test("installSteps uses full npm; loginSteps given", () => {
  const s = V.installSteps("@magpie-community/opencode-zed-auth");
  assert.match(s[1], /magpie plugin add @magpie-community\/opencode-zed-auth/);
  const l = V.loginSteps("Qoder", "qoder-cn"); assert.match(l[0], /Qoder/);
});

test("actionOf builds install/login/copy payloads from dataset", () => {
  const ins = V.actionOf({ act: "install", name: "Zed", npm: "@magpie-community/opencode-zed-auth" });
  assert.equal(ins.copyText, "@magpie-community/opencode-zed-auth");
  assert.match(ins.steps[1], /magpie plugin add @magpie-community\/opencode-zed-auth/);
  const lg = V.actionOf({ act: "login", name: "Qoder", pid: "qoder-cn" });
  assert.equal(lg.copyText, "magpie plugin login qoder-cn");
  const cp = V.actionOf({ act: "copy", url: "https://e/x" }); assert.equal(cp.copyText, "https://e/x");
  assert.equal(V.actionOf({ act: "copy", url: "javascript:1" }), null);
  assert.equal(V.actionOf({ act: "weird" }), null);
  assert.equal(V.actionOf(null), null);
});
