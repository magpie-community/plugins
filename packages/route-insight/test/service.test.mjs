// 服务端安全约定（PR #1004 阻断 1）：任何人都不能不带令牌读看板、也不能借浏览器跑检测。
// 用 bun test 从仓库根跑： bun test
import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
let svc = null;
let base = "";
let token = "";
let tmp = "";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "route-insight-test-"));
  // 临时配置目录：不碰真实 ~/.config/magpie，也不会读到你自己的用量
  fs.writeFileSync(path.join(tmp, "providers.json"), "[]");
  process.env.MAGPIE_CONFIG_DIR = tmp;
  const mod = await import(path.join(ROOT, "index.mjs"));
  const port = 4600 + Math.floor(Math.random() * 300);
  svc = await mod.start({ port });
  base = "http://127.0.0.1:" + port;
  const page = await fetch(base + "/", { headers: { "sec-fetch-mode": "navigate" } });
  const html = await page.text();
  const hit = /<meta name="service-token" content="([a-f0-9]{16,})"/.exec(html);
  token = hit ? hit[1] : "";
});

afterAll(() => {
  if (svc && svc.close) svc.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (error) {
    // 临时目录删不掉不影响结论
  }
});

test("页面里带着服务令牌", () => {
  expect(token.length).toBeGreaterThanOrEqual(16);
});

test("不带令牌读 /api/state 必须失败", async () => {
  const res = await fetch(base + "/api/state?window=today");
  expect(res.status).toBe(403);
  const body = await res.json();
  // json() 兜底总会写 ok:false，所以这里断的是「没拿到数据」而不是字段不存在
  expect(body.ok).toBe(false);
  expect(body.rows).toBeUndefined();
  expect(body.error).toBeTruthy();
});

test("错的令牌也失败", async () => {
  const res = await fetch(base + "/api/state?window=today", {
    headers: { "x-route-insight-token": "0".repeat(64) }
  });
  expect(res.status).toBe(403);
});

test("带令牌才读得到看板", async () => {
  const res = await fetch(base + "/api/state?window=today", {
    headers: { "x-route-insight-token": token }
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.rows)).toBe(true);
});

test("Origin: null 且没有令牌时，一个 CORS 放行头都不给", async () => {
  // 任意站点的沙箱 iframe 就是 Origin: null。以前这里无条件回 access-control-allow-origin: null，
  // 等于让别的网页跨源读走余额、账号邮箱和每一次请求。现在只有带对令牌才放行。
  const res = await fetch(base + "/api/state?window=today", { headers: { origin: "null" } });
  expect(res.status).toBe(403);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(res.headers.get("access-control-allow-methods")).toBeNull();
});

test("Origin: null 但带着令牌时放行（magpie 窗口里就是这么跑起来的）", async () => {
  // magpie 把插件页装在 sandbox="allow-scripts" 的 iframe 里，文档 origin 就是 "null"，
  // 跨源 fetch 没有 ACAO 就只会得到 TypeError: Failed to fetch。所以这条必须能过。
  const res = await fetch(base + "/api/state?window=today", {
    headers: { origin: "null", "x-route-insight-token": token }
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("null");
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test("预检只放行令牌头，且不带任何数据", async () => {
  const res = await fetch(base + "/api/lab/run", {
    method: "OPTIONS",
    headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "x-route-insight-token,content-type" }
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("null");
  expect(String(res.headers.get("access-control-allow-headers"))).toContain("x-route-insight-token");
  const text = await res.text();
  expect(text).toBe("");
});

test("不带令牌 POST /api/lab/run 不能替你花钱", async () => {
  const res = await fetch(base + "/api/lab/run", {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "null" },
    body: JSON.stringify({ model: "test/model", tests: ["relay"], prompt: "write my essay" })
  });
  expect(res.status).toBe(403);
});

test("页面只发给导航，别的网页 fetch 拿不到令牌", async () => {
  const res = await fetch(base + "/", { headers: { "sec-fetch-mode": "cors" } });
  expect(res.status).toBe(403);
});
