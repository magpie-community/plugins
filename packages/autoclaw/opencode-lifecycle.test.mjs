import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { createLoginMethod } from "./login-panel.mjs";
import { AutoclawAuthPlugin as openCodeOversea, AutoclawCnAuthPlugin as openCodeCn } from "./opencode.mjs";

const client = {
  app: { log: async () => {} },
  auth: { set: async () => {} },
  tui: { showToast: async () => {} },
  config: { get: async () => ({ data: {} }) },
};
const magpie = {
  option: async () => undefined,
  options: async () => ({}),
  load: async () => {},
  usage: async () => {},
  account: (id) => id,
};
const input = { client, magpie, directory: process.cwd(), worktree: process.cwd(), project: {}, $: undefined };

async function occupyPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

function fixturePanel() {
  let closed = false;
  const result = { type: "success", access: "access", refresh: "refresh", expires: 1 };
  return {
    isClosed: () => closed,
    panel: {
      async close() { closed = true; },
      method: {
        async authorize() {
          return {
            url: "https://magpie.example.test/_magpie/plugin/abc/_magpie/service/",
            method: "code",
            instructions: "fixture",
            async callback() { return result; },
          };
        },
        async callback() { return result; },
      },
    },
  };
}

describe("AutoClaw 面板启动失败隔离", () => {
  test("端口被占用时两个 provider 仍完成 auth 注册", async () => {
    const occupied = await occupyPort();
    try {
      const suffix = randomBytes(4).toString("hex");
      const mod = await import(`./opencode.mjs?occupied-${suffix}`);
      const options = { loginPort: occupied.port };
      const [oversea, cn] = await Promise.all([
        mod.AutoclawAuthPlugin(input, options),
        mod.AutoclawCnAuthPlugin(input, options),
      ]);
      expect(oversea.auth.provider).toBe("autoclaw");
      expect(cn.auth.provider).toBe("autoclaw-cn");
      expect(oversea.auth.methods).toHaveLength(1);
      expect(oversea.auth.methods[0].type).toBe("oauth");
      expect(typeof oversea.auth.methods[0].authorize).toBe("function");
      expect(typeof cn.auth.methods[0].authorize).toBe("function");

      // 等预热失败收敛，再验证宿主点「登录」时收到可显示的 failed，而非整包失效。
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = await oversea.auth.methods[0].authorize();
      expect(started.type).toBe("failed");
      expect(started.error).toContain("登录面板启动失败");
      expect(started.error).toContain(String(occupied.port));
      const callback = await oversea.auth.methods[0].callback("any-ticket");
      expect(callback.type).toBe("failed");
    } finally {
      await occupied.close();
    }
  });

  test("启动失败后释放端口，下一次 authorize 可以重试成功", async () => {
    const fixture = fixturePanel();
    let attempts = 0;
    const login = createLoginMethod({
      port: 18741,
      factory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("EADDRINUSE");
        return fixture.panel;
      },
    });
    const failed = await login.method.authorize();
    expect(failed.type).toBe("failed");
    expect(failed.error).toContain("EADDRINUSE");

    const ok = await login.method.authorize();
    expect(ok.url).toContain("/_magpie/plugin/abc/_magpie/service/");
    expect(ok.method).toBe("code");
    expect(await login.method.callback("ticket")).toMatchObject({ type: "success" });
    expect(attempts).toBe(2);
    await login.close();
    expect(fixture.isClosed()).toBe(true);
  });

  test("预热与并发 authorize/callback 只启动一次面板", async () => {
    const fixture = fixturePanel();
    let calls = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const login = createLoginMethod({
      port: 18741,
      factory: () => { calls += 1; return pending; },
    });
    login.warm();
    const authorize = login.method.authorize();
    const callback = login.method.callback("ticket");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    release(fixture.panel);
    const [a, b] = await Promise.all([authorize, callback]);
    expect(a.url).toContain("/_magpie/plugin/abc/_magpie/service/");
    expect(b.type).toBe("success");
    await login.close();
    expect(fixture.isClosed()).toBe(true);
  });

  test("OpenCode 没有 magpie 输入时不启动面板，保留本地 OAuth 方法", async () => {
    const [oversea, cn] = await Promise.all([
      openCodeOversea({ client, directory: process.cwd(), worktree: process.cwd(), project: {}, $: undefined }),
      openCodeCn({ client, directory: process.cwd(), worktree: process.cwd(), project: {}, $: undefined }),
    ]);
    expect(oversea.auth.provider).toBe("autoclaw");
    expect(oversea.auth.methods[0].label).toBe("AutoClaw 网页登录（Google / z.ai）");
    expect(cn.auth.provider).toBe("autoclaw-cn");
    expect(cn.auth.methods[0].label).toBe("AutoClaw 手机验证码登录（国内）");
  });
});
