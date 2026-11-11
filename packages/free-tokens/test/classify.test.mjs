import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPayload } from "../src/classify.js";
import { readLocal } from "../src/inventory.js";

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const deal = (o = {}) => ({ id: "x", kind: "daily", title: "t", provider: "DeepSeek", detail: "", url: "https://example.com/a", tags: ["a"], endsAt: null, validity: "", verifiedAt: "2026-11-09T00:00:00Z", yuan: null, label: "", face: "", counted: true, ...o });
const ft = (deals) => ({ deals, basis: { usdCny: 6.67 } });
const TMP = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); TMP.push(d); return d; };
afterAll(() => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

test("meta sums: today counts only counted yuan; faceTotal all priced", () => {
  const p = buildPayload(ft([deal({ provider: "DeepSeek", yuan: 10, counted: true }), deal({ provider: "Zed", yuan: 5, counted: false }), deal({ provider: "MiniMax", yuan: null })]), { providers: [], checkin: {} });
  assert.equal(p.meta.todayClaimable, 10);
  assert.equal(p.meta.faceTotal, 15);
  assert.equal(p.meta.pricedCount, 2);
  assert.equal(p.meta.totalDeals, 3);
  assert.equal(p.meta.kindCounts.daily, 3);
});

test("allowlist drops non-official provider", () => {
  const p = buildPayload(ft([deal({ provider: "某中转站" }), deal({ provider: "DeepSeek" })]), { providers: [], checkin: {} });
  assert.deepEqual(p.deals.map((d) => d.provider), ["DeepSeek"]);
});

test("icons deduped per provider", () => {
  const p = buildPayload(ft([deal({ provider: "豆包" }), deal({ provider: "豆包", id: "y" })]), { providers: [], checkin: {} });
  assert.equal(Object.keys(p.icons).length, 1);
  assert.match(p.icons["豆包"], /^brand\//);
});

test("pick sanitizes kind/url/tags/endsAt/yuan", () => {
  const p = buildPayload(ft([deal({ kind: "<img src=x>", url: "javascript:alert(1)", tags: ["ok", 5], endsAt: 123, yuan: "9" })]), { providers: [], checkin: {} });
  const d = p.deals[0];
  assert.equal(d.kind, "other");
  assert.equal(d.url, null);
  assert.deepEqual(d.tags, ["ok"]);
  assert.equal(d.endsAt, null);
  assert.equal(d.yuan, null);
});

test("http url dropped, https kept", () => {
  const p = buildPayload(ft([deal({ url: "http://x/y" }), deal({ provider: "Zed", url: "https://ok/z" })]), { providers: [], checkin: {} });
  assert.equal(p.deals[0].url, null);
  assert.equal(p.deals[1].url, "https://ok/z");
});

test("three tiers with installed+claimed", () => {
  const local = { providers: [{ id: "qoder-cn", name: "Qoder CN", signedIn: true }], checkin: { "qoder-cn|a": { day: today, outcome: "claimed" } } };
  const p = buildPayload(ft([deal({ provider: "阿里云 Qoder", url: "https://docs.qoder.cn/x" }), deal({ provider: "Zed" }), deal({ provider: "DeepSeek" })]), local);
  assert.equal(p.demoState.configKnown, true);
  assert.equal(p.demoState.installed["qoder-cn"].checkin, "claimed");
  const t = (d) => { const m = p.mapping[d.provider]; if (!m) return "none"; const pid = Array.isArray(m.pid) ? (/qoder\.com/.test(d.url || "") ? "qoder" : /qoder\.cn/.test(d.url || "") ? "qoder-cn" : m.pid[0]) : m.pid; const st = p.demoState.installed[pid]; return !st ? "setup" : st.signedIn ? "ready" : "setup"; };
  assert.deepEqual(p.deals.map(t), ["ready", "setup", "none"]);
});

test("config unknown when providers unreadable; checkin unknown when null", () => {
  const dir = mkTmp("ft-cl-");
  fs.writeFileSync(path.join(dir, "plugin-providers.json"), "{bad");
  fs.writeFileSync(path.join(dir, "plugin-checkin.json"), "{bad");
  const p = buildPayload(ft([deal({ provider: "阿里云 Qoder", url: "https://docs.qoder.cn/x" })]), readLocal(dir));
  assert.equal(p.demoState.configKnown, false);
  assert.equal(p.demoState.checkinKnown, false);
});

test("empty/missing deals => empty list", () => {
  const p = buildPayload({}, { providers: [], checkin: {} });
  assert.deepEqual(p.deals, []);
  assert.equal(p.meta.totalDeals, 0);
});

test("checkin null guard: providers valid + checkin null => unknown, no throw", () => {
  const p = buildPayload(ft([deal({ provider: "阿里云 Qoder", url: "https://qoder.cn/x" })]), { providers: [{ id: "qoder-cn", signedIn: true }], checkin: null });
  assert.equal(p.demoState.checkinKnown, false);
  assert.equal(p.demoState.installed["qoder-cn"].checkin, null);
});

test("counted must be exactly true (undefined counted excluded from today)", () => {
  const p = buildPayload(ft([{ id: "x", kind: "daily", title: "t", provider: "DeepSeek", url: "https://e/x", tags: [], endsAt: null, validity: "", verifiedAt: null, yuan: 7, label: "", face: "", evidence: "official" }]), { providers: [], checkin: {} });
  assert.equal(p.meta.todayClaimable, 0);
  assert.equal(p.meta.faceTotal, 7);
  assert.equal(p.deals[0].counted, false);
});
test("provider whitespace trimmed and still allowlisted", () => {
  const p = buildPayload(ft([deal({ provider: "  DeepSeek  " })]), { providers: [], checkin: {} });
  assert.equal(p.deals.length, 1);
  assert.equal(p.deals[0].provider, "DeepSeek");
});
