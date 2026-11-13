import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLoginPanel } from "./login-panel.mjs";

let panel, root, csrf, calls, time, enabled, tokenData, urlOverride;
const upstream = async (path, options) => {
  const body = JSON.parse(options.body);
  calls.push({ path, body, base: options.base });
  if (path.endsWith("oauth-captcha-config")) return { code: 0, data: { enabled, region: "ga", prefix: "fixture", scene_id: "fixture-scene" } };
  if (path.endsWith("-oauth-url")) return { code: 0, data: { oauth_url: urlOverride ?? "https://auth.example.test/authorize?state=fixture-state" } };
  if (path.endsWith("-oauth-login")) return { code: 0, data: tokenData };
  throw new Error(`未预期的请求 ${path}`);
};
async function post(path, data, header = csrf) {
  const headers = { "Content-Type": "application/json" };
  if (header) headers["X-Autoclaw-Panel"] = header;
  const response = await fetch(`${root}api/${path}`, { method: "POST", headers, body: JSON.stringify(data) });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
const callback = (vendor = "google", query = "code=fixture-code&state=fixture-state") => `http://localhost:18432/auth/callback-${vendor}?${query}`;
async function begin(vendor = "google") {
  const start = await post("start", { vendor });
  expect(start.status).toBe(200);
  const id = start.data.id;
  const authorize = await post("authorize", { id, receipt: enabled ? "fixture-receipt" : "" });
  expect(authorize.status).toBe(200);
  return id;
}

beforeEach(async () => {
  calls = []; time = 1_000_000; enabled = true; urlOverride = null;
  tokenData = { access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 };
  panel = await createLoginPanel({ port: 0, now: () => time, call: upstream, profile: async () => ({ name: "fixture@example.test" }) });
  root = `http://127.0.0.1:${panel.port}/`;
  const response = await fetch(root);
  const html = await response.text();
  csrf = html.match(/name="autoclaw-panel" content="([a-f0-9]{48})"/)?.[1];
  expect(csrf).toBeDefined();
});
afterEach(async () => { await panel?.close(); });

describe("远程 Web 登录面板", () => {
  test("保留 Google 上游链接原文，诊断不暴露 state 或凭据", async () => {
    const query = new URLSearchParams({ client_id: "fixture.apps.googleusercontent.com", redirect_uri: "http://localhost:18432/auth/callback-google", response_type: "code", scope: "openid email profile", state: "fixture-state" });
    urlOverride = `https://accounts.google.com:443/o/oauth2/auth?${query}`;
    const start = await post("start", { vendor: "google" });
    const result = await post("authorize", { id: start.data.id, receipt: "fixture-receipt" });
    expect(result.status).toBe(200);
    expect(result.data.url).toBe(urlOverride);
    expect(result.data.diagnostics.redirectUri).toBe("http://localhost:18432/auth/callback-google");
    expect(result.data.diagnostics.clientId).toBe("fixture.apps.googleusercontent.com");
    expect(JSON.stringify(result.data.diagnostics)).not.toContain("fixture-state");
    expect(JSON.stringify(result.data.diagnostics)).not.toContain("fixture-access");
  });
  for (const key of ["client_id", "redirect_uri", "response_type", "scope"]) {
    for (const invalid of ["missing", "duplicate"]) {
      test(`Google ${key} ${invalid} 在面板报错，不生成无效链接`, async () => {
        const query = new URLSearchParams({ client_id: "fixture.apps.googleusercontent.com", redirect_uri: "http://localhost:18432/auth/callback-google", response_type: "code", scope: "openid email profile", state: "fixture-state" });
        if (invalid === "missing") query.delete(key); else query.append(key, query.get(key));
        urlOverride = `https://accounts.google.com/o/oauth2/auth?${query}`;
        const start = await post("start", { vendor: "google" });
        const result = await post("authorize", { id: start.data.id, receipt: "fixture-receipt" });
        expect(result.status).toBe(400);
        expect(result.data.error).toContain(key);
        expect(calls.filter((c) => c.path.endsWith("-oauth-login"))).toHaveLength(0);
      });
    }
  }
  for (const [key, value] of [["redirect_uri", "http://localhost:19654/auth/callback-google"], ["response_type", "token"]]) {
    test(`Google ${key} 与本次请求不一致时停止授权`, async () => {
      const query = new URLSearchParams({ client_id: "fixture.apps.googleusercontent.com", redirect_uri: "http://localhost:18432/auth/callback-google", response_type: "code", scope: "openid email profile", state: "fixture-state" });
      query.set(key, value);
      urlOverride = `https://accounts.google.com/o/oauth2/auth?${query}`;
      const start = await post("start", { vendor: "google" });
      expect((await post("authorize", { id: start.data.id, receipt: "fixture-receipt" })).status).toBe(400);
    });
  }
  for (const url of ["https://auth.example.test/?state=fixture-state&amp;x=1", "https://auth.example.test/?state=fixture-state\nx=1"]) {
    test(`拒绝包含 HTML 转义或换行的授权地址 ${JSON.stringify(url)}`, async () => {
      urlOverride = url;
      const start = await post("start", { vendor: "google" });
      expect((await post("authorize", { id: start.data.id, receipt: "fixture-receipt" })).status).toBe(400);
    });
  }
  test("服务页面不暴露跨域读取的 CSRF，脚本供 sandbox 加载", async () => {
    const html = await fetch(root);
    expect(html.headers.get("access-control-allow-origin")).toBeNull();
    const js = await fetch(`${root}login.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("access-control-allow-origin")).toBe("*");
    expect(await js.text()).toContain("fetch(`api/${path}`");
  });
  test("无 CSRF 或伪造 CSRF 均不能启动上游登录", async () => {
    for (const value of [null, "wrong", "x".repeat(48)]) expect((await post("start", { vendor: "google" }, value)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  test("允许 opaque sandbox 的预检，不使用 Cookie", async () => {
    const response = await fetch(`${root}api/start`, { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Headers": "content-type,x-autoclaw-panel" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
  test("拒绝未支持的供应商", async () => {
    expect((await post("start", { vendor: "untrusted" })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  test("验证码开启时没有回执不请求授权链接", async () => {
    const { data } = await post("start", { vendor: "google" });
    expect((await post("authorize", { id: data.id })).status).toBe(400);
    expect(calls).toHaveLength(1);
  });
  for (const vendor of ["google", "zai"]) {
    test(`${vendor} 从面板到原生账户回调的完整流程`, async () => {
      const id = await begin(vendor);
      const finish = await post("finish", { id, callback: callback(vendor) });
      expect(finish.status).toBe(200);
      expect(finish.data).toEqual({ ticket: expect.stringMatching(/^[a-f0-9]{48}$/), name: "fixture@example.test" });
      expect(JSON.stringify(finish.data)).not.toContain("fixture-access");
      expect(JSON.stringify(finish.data)).not.toContain("fixture-refresh");
      const auth = await panel.method.authorize();
      expect(auth.url).toBe("");
      expect(auth.method).toBe("code");
      const result = await auth.callback(` ${finish.data.ticket} `);
      expect(result.type).toBe("success");
      expect(result.access).toBe("fixture-access");
      expect(result.refresh).toBe("fixture-refresh");
      expect(result.deviceId).toMatch(/^[a-f0-9]{64}$/);
      expect(result.apiHost).toBe("https://autoglm-api.autoglm.ai");
      const urlCall = calls.find((c) => c.path.endsWith("-oauth-url"));
      const exchange = calls.find((c) => c.path.endsWith("-oauth-login"));
      expect(urlCall.body.ali_captcha_verify_param).toBe("fixture-receipt");
      expect(exchange.body.device_id).toBe(urlCall.body.device_id);
      expect(exchange.body.navigate_uri).toBe(callback(vendor).split("?")[0]);
      expect(exchange.body.navigate_uri).toBe(urlCall.body.navigate_uri);
      expect(exchange.body.code).toBe("fixture-code");
      expect(exchange.body.state).toBe("fixture-state");
      expect((await auth.callback(finish.data.ticket)).type).toBe("failed");
      expect((await post("finish", { id, callback: callback(vendor) })).status).toBe(400);
      expect(calls.filter((c) => c.path.endsWith("-oauth-login"))).toHaveLength(1);
    });
  }
  test("未开启验证码时仍可正常授权", async () => { enabled = false; expect(await begin()).toBeString(); });
  test("校验 state、端口、路径与重复参数，错误回调不消耗正确会话", async () => {
    const id = await begin();
    for (const address of [
      callback("google", "code=x&state=wrong"), callback("zai"), callback().replace(":18432", ":19654"),
      callback().replace("localhost", "example.test"), callback() + "&state=fixture-state", callback() + "&code=x", callback() + "#fragment",
      callback().replace("http://", "http://user@"), callback("google", "state=fixture-state"), "not a URL",
    ]) expect((await post("finish", { id, callback: address })).status).toBe(400);
    expect(calls.filter((c) => c.path.endsWith("-oauth-login"))).toHaveLength(0);
    expect((await post("finish", { id, callback: callback() })).status).toBe(200);
  });
  test("并发重复提交最多交换一次授权码", async () => {
    const id = await begin();
    const results = await Promise.all([post("finish", { id, callback: callback() }), post("finish", { id, callback: callback() })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(calls.filter((c) => c.path.endsWith("-oauth-login"))).toHaveLength(1);
  });
  test("不接受授权前提交的回调或已取消会话", async () => {
    const { data } = await post("start", { vendor: "google" });
    expect((await post("finish", { id: data.id, callback: callback() })).status).toBe(400);
    expect((await post("cancel", { id: data.id })).status).toBe(200);
    expect((await post("authorize", { id: data.id, receipt: "fixture" })).status).toBe(400);
  });
  test("过期会话与过期完成码均拒绝", async () => {
    const expired = await begin();
    time += 600_001;
    expect((await post("finish", { id: expired, callback: callback() })).status).toBe(400);
    const id = await begin();
    const { data } = await post("finish", { id, callback: callback() });
    time += 600_001;
    expect((await (await panel.method.authorize()).callback(data.ticket)).type).toBe("failed");
  });
  test("取消操作幂等，过期会话仍可重新开始", async () => {
    const id = await begin();
    time += 600_001;
    expect((await post("cancel", { id })).status).toBe(200);
    expect((await post("cancel", { id })).status).toBe(200);
    expect(await begin()).toBeString();
  });
  test("上游缺失凭据时不给出完成码", async () => {
    tokenData = { access_token: "fixture-access" };
    const id = await begin();
    const result = await post("finish", { id, callback: callback() });
    expect(result.status).toBe(400);
    expect(result.data.error).toContain("refresh_token");
    expect(result.data.ticket).toBeUndefined();
    expect(await begin()).toBeString();
  });
  test("不接受非 HTTPS 授权链接或缺失 state", async () => {
    for (const url of ["http://example.test/?state=x", "https://example.test/", "https://example.test/?state=x&state=y"]) {
      urlOverride = url;
      const { data } = await post("start", { vendor: "google" });
      expect((await post("authorize", { id: data.id, receipt: "fixture" })).status).toBe(400);
    }
  });
  test("请求体大小受限，错误方法不创建会话", async () => {
    expect((await post("start", { vendor: "google", padding: "x".repeat(33_000) })).status).toBe(400);
    expect((await fetch(`${root}api/start`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
  test("不重复生成授权链接，完成码不等于会话 ID", async () => {
    const id = await begin();
    expect((await post("authorize", { id, receipt: "fixture" })).status).toBe(400);
    expect((await (await panel.method.authorize()).callback(id)).type).toBe("failed");
  });
  test("面板上报地址后，登录框直接给出面板链接", async () => {
    const address = "https://magpie.example.test:3430/_magpie/plugin/abc/_magpie/service/";
    expect((await post("address", { url: address })).status).toBe(200);
    expect((await panel.method.authorize()).url).toBe(address);
  });
  test("只接受面板自身的地址形状，其它路径、凭据与协议一律拒绝", async () => {
    // 主机名无法在服务端校验（代理已把 Host 改成 127.0.0.1），真正的门是 CSRF 头；
    // 这里保证即使有人拿到 CSRF，也只能指向一个像面板的地址。
    for (const url of [
      "https://magpie.example.test/_magpie/plugin/abc/other/",
      "https://magpie.example.test/_magpie/service/x",
      "https://user:pass@magpie.example.test/_magpie/plugin/abc/_magpie/service/",
      "https://magpie.example.test/_magpie/plugin/abc/_magpie/service/#x",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ]) expect((await post("address", { url })).status).toBe(400);
    expect((await panel.method.authorize()).url).toBe("");
  });
  test("本机桌面服务的地址同样可上报", async () => {
    expect((await post("address", { url: "http://127.0.0.1:18741/" })).status).toBe(200);
    expect((await panel.method.authorize()).url).toBe("http://127.0.0.1:18741/");
  });
  test("上报的地址 10 分钟后不再出现在登录框里", async () => {
    expect((await post("address", { url: "http://localhost:18741/" })).status).toBe(200);
    time += 10 * 60_000 + 1;
    expect((await panel.method.authorize()).url).toBe("");
  });
});
