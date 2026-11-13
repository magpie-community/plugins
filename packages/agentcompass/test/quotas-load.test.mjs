// A configured quotas file that cannot be used is never silent: it is a pool-level `usage_failing`
// (`quotas_unreadable`) in the account list and in the decision warnings, logged once per change.
// No configured file keeps the old behaviour: null, no warning.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { onRequest as hookOnRequest } from "../src/hooks.js";
import { SessionContinuityStore } from "../src/continuity.js";
import { clearQuotasCache, getQuotasLoadStatus, listQuotaAccounts, loadLiveQuotas, selectBestRoute } from "../src/index.js";
import { getQuotasLoadStatus as statusFromLoader } from "../src/quota-loader.js";
import { profile } from "./profile.mjs";

const T0 = 1_700_000_000_000;
const win = { name: "7d", remaining: 80, used: 20, resetHours: 100 };
const good = (extra = {}) => ({ "claude/a": { kind: "subscription", plan: "max5", quota: { windows: [win] }, ...extra } });
const implProfile = profile();

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quotas-load-"));
  const logs = [];
  const warn = console.warn;
  console.warn = (...a) => logs.push(a.join(" "));
  clearQuotasCache();
  const cleanup = () => {
    console.warn = warn;
    clearQuotasCache();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn(dir, logs);
  } catch (err) {
    cleanup();
    throw err;
  }
  return result?.then ? result.finally(cleanup) : (cleanup(), result);
}

const poolRow = (quotas) => listQuotaAccounts(quotas, T0).find((a) => a.key === "pool/quotas");

test("no quotas file configured: null, no warning, not an error", () =>
  withTmp((_dir, logs) => {
    assert.equal(loadLiveQuotas({}, T0), null);
    assert.equal(loadLiveQuotas({ magpieConfigDir: "" }, T0), null);
    assert.deepEqual(logs, []);
    assert.equal(getQuotasLoadStatus().configured, false);
    assert.equal(statusFromLoader, getQuotasLoadStatus);
  }));

for (const [cause, prepare] of [
  ["missing", (file) => file],
  ["invalid_json", (file) => (fs.writeFileSync(file, "{ not json"), file)],
  ["wrong_schema", (file) => (fs.writeFileSync(file, JSON.stringify("hello")), file)],
  ["wrong_schema", (file) => (fs.writeFileSync(file, JSON.stringify([1, 2])), file)],
  ["wrong_schema", (file) => (fs.writeFileSync(file, JSON.stringify({ a: 1, b: "x" })), file)],
  ["unreadable", (file) => (fs.mkdirSync(file), file)],
]) {
  test(`a configured quotas file that is ${cause} is reported, not silently null`, () =>
    withTmp((dir, logs) => {
      const quotasPath = prepare(path.join(dir, "quotas.json"));
      const loaded = loadLiveQuotas({ quotasPath }, T0);
      assert.notEqual(loaded, null, "failure must reach the router, not vanish as null");

      const row = poolRow(loaded);
      assert.equal(row.state, "usage_failing");
      assert.match(row.reason, new RegExp(`quotas_unreadable: ${cause}`));
      assert.equal(row.dispatchable, true, "the file is not an account; it does not block dispatch");
      assert.equal(getQuotasLoadStatus().ok, false);
      assert.equal(getQuotasLoadStatus().cause, cause);

      const d = selectBestRoute(implProfile, { candidateModels: ["claude-sonnet-5-5"], now: T0, quotas: loaded });
      assert.equal(d.ok, true, "routing continues without quota limits");
      assert.ok(d.warnings.some((w) => /pool\/quotas: usage_failing/.test(w) && w.includes(`quotas_unreadable: ${cause}`)));
      assert.ok(d.accounts.some((a) => a.key === "pool/quotas"));
      assert.equal(logs.length, 1);
      assert.match(logs[0], /quotas file unusable, quotas_unreadable/);
    }));
}

test("hooks put the unreadable-file warning in the route state", async () =>
  withTmp(async (dir) => {
    const quotasPath = path.join(dir, "quotas.json");
    fs.writeFileSync(quotasPath, "{ nope");
    const ctx = {
      state: {},
      options: {
        continuityStore: new SessionContinuityStore(),
        quotasPath,
        candidateModels: ["claude-sonnet-5-5"],
        now: T0,
      },
    };
    await hookOnRequest(
      { model: "agentcompass", profile: implProfile, messages: [{ role: "user", content: "Implement the next helper." }] },
      ctx
    );
    assert.ok(ctx.state.route.warnings.some((w) => w.includes("quotas_unreadable: invalid_json")));
    assert.ok(ctx.state.route.accounts.some((a) => a.key === "pool/quotas" && a.state === "usage_failing"));
  }));

test("it is logged once per change, and once when the file is readable again", () =>
  withTmp((dir, logs) => {
    const quotasPath = path.join(dir, "quotas.json");
    for (let i = 0; i < 3; i++) loadLiveQuotas({ quotasPath }, T0 + i * 10_000);
    assert.equal(logs.length, 1, "same failure, one log line");

    fs.writeFileSync(quotasPath, "{ nope");
    for (let i = 0; i < 3; i++) loadLiveQuotas({ quotasPath }, T0 + 60_000 + i * 10_000);
    assert.equal(logs.length, 2, "a different cause logs again");
    assert.match(logs[1], /invalid_json/);

    fs.writeFileSync(quotasPath, JSON.stringify(good()));
    const ok = loadLiveQuotas({ quotasPath }, T0 + 200_000);
    assert.equal(poolRow(ok), undefined);
    assert.equal(logs.length, 3);
    assert.match(logs[2], /readable again/);
    loadLiveQuotas({ quotasPath }, T0 + 400_000);
    assert.equal(logs.length, 3, "healthy reads stay quiet");
    assert.equal(getQuotasLoadStatus().ok, true);
  }));

test("a file that breaks after a good read keeps the last snapshot, so an expired account stays excluded", () =>
  withTmp((dir) => {
    const quotasPath = path.join(dir, "quotas.json");
    fs.writeFileSync(
      quotasPath,
      JSON.stringify({
        ...good(),
        "claude/dead": { kind: "subscription", plan: "max5", status: "expired", quota: { windows: [win] } },
      })
    );
    assert.equal(listQuotaAccounts(loadLiveQuotas({ quotasPath }, T0), T0).length, 2);

    fs.writeFileSync(quotasPath, "{ nope");
    const broken = loadLiveQuotas({ quotasPath }, T0 + 60_000);
    const rows = listQuotaAccounts(broken, T0 + 60_000);
    assert.deepEqual(
      rows.map((r) => [r.key, r.state]),
      [["claude/a", "ready"], ["claude/dead", "plan_inactive"], ["pool/quotas", "usage_failing"]]
    );
    assert.equal(rows[2].last_success_at, new Date(T0).toISOString());

    // M3a: 10h after quotas.json breaks, accounts without inline timestamps and pool/quotas age out and stop dispatch
    const broken10h = loadLiveQuotas({ quotasPath }, T0 + 10 * 3600_000);
    const rows10h = listQuotaAccounts(broken10h, T0 + 10 * 3600_000);
    assert.equal(rows10h.find((r) => r.key === "claude/a").dispatchable, false);
    assert.equal(rows10h.find((r) => r.key === "pool/quotas").dispatchable, false);
    const d10h = selectBestRoute(implProfile, {
      candidateModels: ["claude-sonnet-4-6"],
      now: T0 + 10 * 3600_000,
      quotas: broken10h,
    });
    assert.equal(d10h.ok, false);
    assert.equal(d10h.targetModel, null);
  }));

test("M3a: a quotas file broken from startup is excluded once failing_since exceeds 6h, and says so", () =>
  withTmp((dir) => {
    const quotasPath = path.join(dir, "quotas.json");
    fs.writeFileSync(quotasPath, "{ nope");
    const q0 = loadLiveQuotas({ quotasPath }, T0);
    assert.equal(listQuotaAccounts(q0, T0)[0].dispatchable, true);

    const q7h = loadLiveQuotas({ quotasPath }, T0 + 7 * 3600_000);
    const [pool7h] = listQuotaAccounts(q7h, T0 + 7 * 3600_000);
    assert.equal(pool7h.key, "pool/quotas");
    assert.equal(pool7h.dispatchable, false);
    // No account depends on the file, so nothing the file holds is at stake: gateway rows still route, and the warning says why
    const d7h = selectBestRoute(implProfile, {
      candidateModels: ["claude-sonnet-4-6"],
      now: T0 + 7 * 3600_000,
      quotas: q7h,
    });
    assert.equal(d7h.ok, true);
    assert.ok(d7h.warnings.some((w) => /pool\/quotas: usage_failing, excluded from dispatch/.test(w)));
  }));
