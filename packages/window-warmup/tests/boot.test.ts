// 带路页 boot.js 的失败测试（抄 fingerprint tests/boot.test.ts 的做法）：
// 在新上下文里执行脚本，断言跳转目标；并确保脚本没有任何联网调用
// （magpie 页面 CSP connect-src 'none'，只能整页跳转）。
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../page/boot.js", import.meta.url), "utf8");

test("脚本中不出现 fetch / XMLHttpRequest / WebSocket", () => {
  expect(source).not.toMatch(/fetch|XMLHttpRequest|WebSocket/);
});

interface BootResult {
  destination?: URL;
  said: { texts: string[] };
}

async function boot(opts: {
  dark?: boolean;
  tokens?: Record<string, string>;
  service?: string;
  port?: number;
  remote?: boolean;
} = {}): Promise<BootResult> {
  const said = { texts: [] as string[] };
  const el = () => {
    const kids: { textContent: string; style: Record<string, string>; appendChild: (x: unknown) => void }[] = [];
    return {
      textContent: "",
      style: {} as Record<string, string>,
      addEventListener: (_t: string, _fn: () => void) => {},
      appendChild(child: { textContent?: string }) {
        kids.push(child as never);
        said.texts.push(String(child?.textContent ?? ""));
      },
    };
  };
  let destination: URL | undefined;
  const document = {
    getElementById: (_id: string) => el(),
    createElement: (_tag: string) => el(),
  };
  await runInNewContext(source, {
    URL,
    URLSearchParams,
    btoa,
    atob,
    document,
    window: {
      magpie: {
        ready: Promise.resolve({ dark: opts.dark ?? true, tokens: opts.tokens }),
        service: opts.service ?? "",
        options: { get: async () => ({ port: opts.port }) },
      },
    },
    location: {
      hostname: opts.remote ? "magpie.example" : "127.0.0.1",
      href: opts.remote ? "http://magpie.example/boot/index.html" : "http://127.0.0.1/boot/index.html",
      replace: (url: string) => {
        destination = new URL(url);
      },
    },
  });
  // 带路页内部有多个 await（ready、options.get），等一个宏任务让它们全部走完
  await new Promise((r) => setTimeout(r, 0));
  return { destination, said };
}

test("有 magpie.service → 跳 service，并带上主题与令牌", async () => {
  const r = await boot({
    service: "http://magpie.example:8080/plugins/scheduled-messages/",
    tokens: { "--magpie-bg": "#101217" },
  });
  expect(r.destination?.origin).toBe("http://magpie.example:8080");
  expect(r.destination?.pathname).toBe("/plugins/scheduled-messages/");
  expect(r.destination?.searchParams.get("theme")).toBe("dark");
  const tokens = r.destination?.searchParams.get("tokens") ?? "";
  const decoded = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(tokens), (c) => c.charCodeAt(0))),
  ) as Record<string, string>;
  expect(decoded["--magpie-bg"]).toBe("#101217");
});

test("无 service → 跳 127.0.0.1 的插件端口", async () => {
  const r = await boot();
  expect(r.destination?.hostname).toBe("127.0.0.1");
  expect(r.destination?.port).toBe("3492"); // 默认端口与 package.json 的 magpie.options 一致
  expect(r.destination?.searchParams.get("theme")).toBe("dark");
});

test("插件选项 port 覆盖默认端口", async () => {
  const r = await boot({ port: 4567 });
  expect(r.destination?.port).toBe("4567");
});

test("无效端口退回默认 3492", async () => {
  const r = await boot({ port: -1 });
  expect(r.destination?.port).toBe("3492");
});

test("浅色主题跟随宿主", async () => {
  const r = await boot({ dark: false });
  expect(r.destination?.searchParams.get("theme")).toBe("light");
});

test("远程打开且无 service → 原地不动，给出 SSH 端口转发提示", async () => {
  const r = await boot({ remote: true, port: 3492 });
  expect(r.destination).toBeUndefined();
  expect(r.said.texts.join("\n")).toContain("SSH");
  expect(r.said.texts.join("\n")).toContain("3492");
});

test("页面资源与 API 全走相对路径：任意服务前缀下都落回转发内，本地直达不受影响", async () => {
  // magpie web 把服务转发在自己的前缀路径下，根绝对引用会解析到宿主根而 404
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  expect(html).not.toContain('href="/');
  expect(html).not.toContain('src="/');
  const app = await readFile(new URL("../web/app.ts", import.meta.url), "utf8");
  expect(app).not.toMatch(/["'`]\/api\//);
  expect(app).not.toContain('src="/');
  // 相对引用的解析语义：转发前缀下落回前缀内，本地根路径下等价于根绝对
  const base = "http://magpie.example:8080/plugins/scheduled-messages/";
  expect(new URL("app.js", base).pathname).toBe("/plugins/scheduled-messages/app.js");
  expect(new URL("style.css", base).pathname).toBe("/plugins/scheduled-messages/style.css");
  expect(new URL("api/state", base).pathname).toBe("/plugins/scheduled-messages/api/state");
  expect(new URL("api/state", "http://127.0.0.1:3492/").pathname).toBe("/api/state");
});
