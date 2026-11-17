import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

import { canonModel, cleanModelName, classifyWindow, periodHours, tokensOf } from "../lib/report.mjs";
import { startServer } from "../lib/server.mjs";

// 测试不去问真实的网关：指向一个没人监听的端口，额度就取自 quotas.json。
process.env.MAGPIE_ADDR = "127.0.0.1:1";

test("model names merge across context suffixes", () => {
  assert.equal(cleanModelName("grok-4.7@500k"), "grok-4.7");
  assert.equal(cleanModelName("grok-4.7@256k"), "grok-4.7");
  assert.equal(canonModel("grok-4.7@500k"), canonModel("grok-4.7@256k"));
  assert.equal(canonModel("GLM-5.3-Flash"), canonModel("glm-5.3-flash"));
});

test("a window is classified by its name", () => {
  assert.equal(classifyWindow("5 hours"), "rate");
  assert.equal(classifyWindow("Weekly"), "rate");
  assert.equal(classifyWindow("Total credits"), "aggregate");
  assert.equal(classifyWindow("Extra credits"), "credit");
  assert.equal(classifyWindow("deepseek-v4.1-flash tokens (est.)"), "token");
});

test("a window's period decides which one is the allowance", () => {
  assert.equal(periodHours("5 hours"), 5);
  assert.equal(periodHours("7 days"), 168);
  assert.equal(periodHours("Month"), 720);
  assert.ok(periodHours("Month") > periodHours("7 days"));
});

test("tokens count every field", () => {
  assert.equal(tokensOf({ in: 10, out: 5, cache_read: 3, cache_write: 2, reasoning: 1 }), 21);
});

// 最小的配置目录：一个账号、一个 5 小时窗口、一轮读数、同期用量。
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "model-quota-"));
  const hour = 3600 * 1000;
  const base = Date.parse("2026-11-10T00:00:00Z");
  const at = (h) => new Date(base + h * hour).toISOString();

  const usage = [];
  for (let i = 0; i < 40; i++) {
    usage.push({
      t: at(0.5 + i * 0.1),
      provider: "acme",
      providerAccount: "a@example.com",
      model: "acme-large@500k",
      in: 1000,
      out: 1000,
      cache_read: 0,
      cache_write: 0,
      reasoning: 0,
    });
  }
  writeFileSync(join(dir, "usage.jsonl"), usage.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(
    join(dir, "quota-history.json"),
    JSON.stringify({
      "acme|a@example.com": {
        "5 hours": [
          { at: at(0), left: 100, start: at(0) },
          { at: at(4), left: 90, start: at(0) },
        ],
      },
    }),
  );
  writeFileSync(
    join(dir, "quotas.json"),
    JSON.stringify({
      "acme|a@example.com": {
        quota: {
          provider: "acme",
          name: "Acme",
          plan: "Pro",
          user: "a@example.com",
          windows: [{ name: "5 hours", used: 20, remaining: 80, resetsAt: at(5) }],
        },
      },
    }),
  );
  return dir;
}

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });

test("the service guards its report and splits tokens by model", async () => {
  const dir = fixture();
  const info = await startServer({ port: 0, configDir: dir });
  try {
    const page = await get(info.port, "/", { host: `127.0.0.1:${info.port}`, "sec-fetch-mode": "navigate" });
    assert.equal(page.status, 200);
    const key = /name="magpie-quota-key" content="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(key, "the page carries its key");

    // 跨源抓页面拿不到口令。
    const grabbed = await get(info.port, "/", {
      host: `127.0.0.1:${info.port}`,
      "sec-fetch-mode": "cors",
      origin: "null",
    });
    assert.equal(grabbed.status, 403);

    // 没有口令读不到报表。
    const denied = await get(info.port, "/api/report", { host: `127.0.0.1:${info.port}`, origin: "null" });
    assert.equal(denied.status, 401);

    // 沙盒框架的 Origin: null 带着口令可以读。
    const allowed = await get(info.port, "/api/report", {
      host: `127.0.0.1:${info.port}`,
      origin: "null",
      "x-magpie-quota-key": key,
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], "null");

    const report = JSON.parse(allowed.body);
    assert.equal(report.pools.length, 1);
    assert.equal(report.pools[0].remaining, 80);
    assert.equal(report.models.length, 1);
    // 显示名去掉上下文后缀，同一个模型的不同容量归到一起。
    assert.equal(report.models[0].name, "acme-large");
    assert.ok(report.models[0].tokens > 0);
  } finally {
    await info.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another host name or origin is refused", async () => {
  const dir = fixture();
  const info = await startServer({ port: 0, configDir: dir });
  try {
    const wrongHost = await get(info.port, "/api/report", { host: `attacker.localhost:${info.port}` });
    assert.equal(wrongHost.status, 403);
    const otherOrigin = await get(info.port, "/api/report", {
      host: `127.0.0.1:${info.port}`,
      origin: "http://localhost:9999",
    });
    assert.equal(otherOrigin.status, 403);
  } finally {
    await info.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
