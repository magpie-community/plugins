// 本文由AI自动生成
// 本地服务：口令、CORS、静态资源。跑在子进程里，测完就杀，
// 不把宿主那个「活到退出」的监听器留在测试进程里。
import { test, expect, afterAll } from "bun:test";
import http from "node:http";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../index.mjs", import.meta.url));
const PORT = 30000 + (process.pid % 20000);

const child = Bun.spawn(
  [
    process.execPath,
    "-e",
    `import p from ${JSON.stringify(entry)}; await p.server({}, { port: ${PORT} }); await new Promise(() => {});`,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

afterAll(() => {
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
});

function req(path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.setTimeout(30_000, () => r.destroy(new Error("请求超时")));
    r.on("error", reject);
    r.end();
  });
}

// 宿主不 await 启动，所以这里等它把端口打开。
const up = (async () => {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await req("/");
      if (r.status === 200) return r;
    } catch {
      /* 还没起来 */
    }
    await new Promise((s) => setTimeout(s, 100));
  }
  throw new Error("本地服务 15 秒内没起来");
})();

const tokenOf = (html) => /name="pace-token" content="([^"]+)"/.exec(html)?.[1] || "";

test("页面正常返回并注入口令", async () => {
  const r = await up;
  expect(r.status).toBe(200);
  expect(r.body).toContain("pace-token");
  expect(tokenOf(r.body).length).toBeGreaterThan(10);
});

test("不带口令的 /api/board 被拒，且仍带 CORS 头", async () => {
  await up;
  const r = await req("/api/board", { headers: { Origin: "null" } });
  expect(r.status).toBe(401);
  expect(r.headers["access-control-allow-origin"]).toBe("null");
});

test("Origin 为 null + 正确口令 → 拿到数据", async () => {
  const r0 = await up;
  const token = tokenOf(r0.body);
  const r = await req("/api/board", { headers: { Origin: "null", "x-pace-token": token } });
  expect(r.status).toBe(200);
  expect(r.headers["access-control-allow-origin"]).toBe("null");
  const d = JSON.parse(r.body);
  for (const k of ["group", "rows", "waste", "accounts", "snapshot", "warnings"]) {
    expect(d).toHaveProperty(k);
  }
  expect(Array.isArray(d.rows)).toBe(true);
});

test("预检请求回 204", async () => {
  await up;
  const r = await req("/api/board", {
    method: "OPTIONS",
    headers: { Origin: "null", "Access-Control-Request-Headers": "x-pace-token" },
  });
  expect(r.status).toBe(204);
});

test("静态资源里搜不到口令", async () => {
  const r0 = await up;
  const token = tokenOf(r0.body);
  for (const p of ["/app.js", "/style.css"]) {
    const r = await req(p);
    expect(r.status).toBe(200);
    expect(r.body).not.toContain(token);
  }
});

test("Host 不是回环就挡掉", async () => {
  await up;
  const r = await req("/api/board", { headers: { Host: "evil.example" } });
  expect(r.status).toBe(403);
});
