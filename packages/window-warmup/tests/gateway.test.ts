import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsOf, pinFor } from "../src/accounts";
import {
  createQuotaReader,
  fetchCatalog,
  fetchQuotas,
  gatewayBase,
  modelProvider,
  pickAutoModel,
  pickEffort,
  refreshQuotaCard,
  send,
  WARMUP_MESSAGE,
} from "../src/gateway";
import type { CachedModel, KeyDirectoryEntry } from "../src/magpie-files";
import type { CatalogAccount, EffortPick, QuotaEntry, QuotaWindow, RawModel, Task } from "../src/types";
import { fakeGateway, type FakeGateway, type FakeGatewayOpts } from "./fake-gateway";

const started: FakeGateway[] = [];
const cleanupDirs: string[] = [];
function start(opts: FakeGatewayOpts = {}): FakeGateway {
  const gw = fakeGateway(opts);
  started.push(gw);
  return gw;
}
afterEach(async () => {
  for (const gw of started.splice(0)) gw.stop();
  while (cleanupDirs.length) await rm(cleanupDirs.pop()!, { recursive: true, force: true });
});

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    name: "早报",
    enabled: true,
    provider: "openai",
    account: "",
    model: "openai/gpt-5",
    message: "hi",
    trigger: { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" },
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const chatReqs = (gw: FakeGateway) => gw.requests.filter((r) => r.path === "/v1/chat/completions");
const bodyOf = (r: FakeGateway["requests"][number]) => r.body as Record<string, unknown>;

function okPick(pick: EffortPick): { send: string | null; label: string } {
  if ("error" in pick) throw new Error(`意外的 error 结果：${pick.error}`);
  return pick;
}

const FUTURE = new Date(Date.now() + 2 * 3_600_000).toISOString();

describe("gatewayBase", () => {
  test("MAGPIE_ADDR host:port → 拼 http://", () => {
    expect(gatewayBase({ MAGPIE_ADDR: "127.0.0.1:9" })).toBe("http://127.0.0.1:9");
  });

  test("缺省 127.0.0.1:3425", () => {
    expect(gatewayBase({})).toBe("http://127.0.0.1:3425");
  });

  test("已是完整地址 → 原样保留并去掉尾部斜杠", () => {
    expect(gatewayBase({ MAGPIE_ADDR: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });
});

describe("pickEffort", () => {
  const m = (over: Partial<RawModel>): RawModel => ({ id: "m", ...over });

  test("档位列表为空 → 不适用", () => {
    expect(pickEffort(m({ reasoning: true, reasoning_levels: [] }))).toEqual({
      send: null,
      label: "不适用",
    });
  });

  test("reasoning 为假 → 不适用（即使列表里有 none）", () => {
    expect(pickEffort(m({ reasoning: false, reasoning_levels: ["none", "high"] }))).toEqual({
      send: null,
      label: "不适用",
    });
  });

  test("reasoning 缺失 → 视为不思考，不适用", () => {
    expect(pickEffort(m({ reasoning_levels: ["low", "high"] }))).toEqual({
      send: null,
      label: "不适用",
    });
  });

  test("disabled 归一为 none → 关闭", () => {
    expect(pickEffort(m({ reasoning: true, reasoning_levels: ["disabled", "high"] }))).toEqual({
      send: "none",
      label: "关闭（模型支持关闭）",
    });
  });

  test("off 同样归一为 none", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["off", "high"] }))).send).toBe(
      "none",
    );
  });

  test("minimal < low", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["minimal", "low"] }))).send).toBe(
      "minimal",
    );
  });

  test("乱序 → low", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["high", "low"] }))).send).toBe(
      "low",
    );
  });

  test("low/high → low，标签注明已用最低档", () => {
    expect(pickEffort(m({ reasoning: true, reasoning_levels: ["low", "high"] }))).toEqual({
      send: "low",
      label: "low（模型必须思考，已用最低档）",
    });
  });

  test("纯数字档低于命名档 → 2048", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["2048", "low"] }))).send).toBe(
      "2048",
    );
  });

  test("数字档按数值取最小", () => {
    expect(
      okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["8192", "2048", "low"] }))).send,
    ).toBe("2048");
  });

  test("已知名低于未知名 → high", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["high", "turbo"] }))).send).toBe(
      "high",
    );
  });

  test("只有未知名 → 列表第一档，标签注明", () => {
    const pick = pickEffort(m({ reasoning: true, reasoning_levels: ["turbo", "fast"] }));
    expect("error" in pick).toBe(false);
    if (!("error" in pick)) {
      expect(pick.send).toBe("turbo");
      expect(pick.label.includes("按模型列表第一档")).toBe(true);
    }
  });

  test("supported_reasoning_levels[].effort 同样识别", () => {
    const pick = pickEffort(m({ reasoning: true, supported_reasoning_levels: [{ effort: "medium" }] }));
    expect(okPick(pick).send).toBe("medium");
  });

  test("档位字段损坏（提不出任何档位）→ error", () => {
    const levels = [42] as unknown as string[];
    expect("error" in pickEffort(m({ reasoning: true, reasoning_levels: levels }))).toBe(true);
  });

  test("档位字段存在但不是数组 → error（宁可报错也不误判成模型不思考）", () => {
    const levels = "low,high" as unknown as string[];
    expect("error" in pickEffort(m({ reasoning: true, reasoning_levels: levels }))).toBe(true);
    const supported = "low" as unknown as { effort: string }[];
    expect("error" in pickEffort(m({ reasoning: true, supported_reasoning_levels: supported }))).toBe(
      true,
    );
  });
});

describe("send", () => {
  test("请求体与会话头：max_tokens 16、stream false、消息恒为 hi、无 pin 则无账号头", async () => {
    const gw = start();
    const r = await send(gw.base, mkTask(), null, null, new AbortController().signal);
    expect(r.outcome).toBe("ok");
    expect(r.reason).toBe("");
    expect(typeof r.ms).toBe("number");
    const [req] = chatReqs(gw);
    expect(req.method).toBe("POST");
    expect(bodyOf(req)).toEqual({
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      stream: false,
    });
    expect(req.headers["x-magpie-session"]).toBe("window-warmup/t1");
    expect(req.headers["x-magpie-account"]).toBeUndefined();
    expect(WARMUP_MESSAGE).toBe("hi");
  });

  test("带 effort 与 pin → reasoning_effort 与 X-Magpie-Account", async () => {
    const gw = start();
    await send(gw.base, mkTask(), "acc-1", "low", new AbortController().signal);
    const [req] = chatReqs(gw);
    expect(bodyOf(req).reasoning_effort).toBe("low");
    expect(req.headers["x-magpie-account"]).toBe("acc-1");
  });

  test("中文 pin 按原始字节到线路上仍是 UTF-8（假网关读原始字节）", async () => {
    // 真 socket 假网关：直接读请求字节，绕开 Headers 的解码差异
    let got: string | null = null;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          const head = data.toString("latin1");
          const m = /^x-magpie-account:\s*(.*)\r?$/im.exec(head.slice(0, head.indexOf("\r\n\r\n")));
          if (m && got === null) got = m[1];
          socket.end();
        },
        error() {},
      },
    });
    try {
      await send(`http://127.0.0.1:${server.port}`, mkTask(), "免费flash", null, new AbortController().signal);
      expect(got).not.toBeNull();
      // 线路上的字节（latin1 逐字节还原）就是 UTF-8 的原文
      expect(Buffer.from(got!, "latin1").toString("utf8")).toBe("免费flash");
    } finally {
      server.stop(true);
    }
  });

  test("429 + 上游 message → failed，原因含状态码与原文", async () => {
    const gw = start({ chat: { status: 429, body: { error: { message: "余额不足" } } } });
    const r = await send(gw.base, mkTask(), null, null, new AbortController().signal);
    expect(r.outcome).toBe("failed");
    expect(r.reason.includes("429")).toBe(true);
    expect(r.reason.includes("余额不足")).toBe(true);
  });

  test("固定账号 403 → 只请求一次，不改用其他账号", async () => {
    const gw = start({ chat: { status: 403, body: { error: { message: "该账号无权使用此模型" } } } });
    const r = await send(gw.base, mkTask(), "acc-1", null, new AbortController().signal);
    expect(r.outcome).toBe("failed");
    expect(chatReqs(gw)).toHaveLength(1);
  });

  test("网关不可达 → failed，原因是底层原始错误（不再写死「连不上 Magpie」）", async () => {
    const gw = start();
    const base = gw.base;
    gw.stop();
    // 同一地址直接 fetch 拿到的原始错误信息，就是 send 应上报的
    let raw = "";
    try {
      await fetch(`${base}/v1/models`);
    } catch (e) {
      raw = e instanceof Error ? e.message : String(e);
    }
    expect(raw).not.toBe("");
    const r = await send(base, mkTask(), null, null, new AbortController().signal);
    expect(r.outcome).toBe("failed");
    expect(r.reason).toBe(raw);
    expect(r.reason.includes("连不上 Magpie")).toBe(false);
  });

  test("超过注入的超时 → unknown，原因按实际超时时长生成（不硬写 30 秒）", async () => {
    const gw = start({ chat: { delayMs: 500 } });
    const r = await send(gw.base, mkTask(), null, null, new AbortController().signal, 50);
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toBe("50 毫秒内没有结果，可能已发送");

    const gw2 = start({ chat: { delayMs: 2500 } });
    const r2 = await send(gw2.base, mkTask(), null, null, new AbortController().signal, 2000);
    expect(r2.outcome).toBe("unknown");
    expect(r2.reason).toBe("2 秒内没有结果，可能已发送");
  });

  test("HTTP 200 但响应体不完整 → unknown（不能判 ok）", async () => {
    const gw = start({ chat: { breakBody: "truncate" } });
    const r = await send(gw.base, mkTask(), null, null, new AbortController().signal);
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toContain("响应");
  });

  test("响应中途连接重置 → unknown（可能已发送，不是连不上）", async () => {
    const gw = start({ chat: { breakBody: "reset" } });
    const r = await send(gw.base, mkTask(), null, null, new AbortController().signal);
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toContain("可能已发送");
  });

  test("外部 signal 中止 → unknown 发送被取消", async () => {
    const gw = start({ chat: { delayMs: 500 } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await send(gw.base, mkTask(), null, null, ac.signal, 10_000);
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toBe("发送被取消");
  });
});

describe("fetchCatalog", () => {
  test("归供应商、排除 group/、带上账号与窗口", async () => {
    const gw = start({
      models: [
        { id: "openai/gpt-5", owned_by: "openai", reasoning: true, reasoning_levels: ["low", "high"] },
        {
          id: "openai/gpt-5-mini",
          owned_by: "openai",
          reasoning: true,
          reasoning_levels: ["disabled", "high"],
        },
        {
          id: "vertex/gemini-3-pro",
          owned_by: "google",
          reasoning: true,
          reasoning_levels: ["minimal", "low", "medium"],
        },
        { id: "group/auto", owned_by: "openai", reasoning: false },
      ],
      quotas: [
        {
          provider: "openai",
          user: "acct-1",
          name: "Yang",
          kind: "subscription",
          windows: [{ name: "5h", used: 2, resetsAt: FUTURE }],
        },
        { provider: "moonshot", user: "acct-9", name: "", windows: [] },
      ],
    });
    const catalog = await fetchCatalog(gw.base);
    expect(catalog.providers.map((p) => p.id)).toEqual(["google", "moonshot", "openai"]);

    const openai = catalog.providers.find((p) => p.id === "openai");
    if (!openai) throw new Error("缺 openai 供应商");
    expect(openai.models.map((x) => x.id)).toEqual(["openai/gpt-5", "openai/gpt-5-mini"]);
    expect(okPick(openai.models[0].effort).send).toBe("low");
    expect(okPick(openai.models[1].effort).send).toBe("none");
    // 订阅账号来自额度卡；没有模型缓存但 /v1/models 有模型 → 退化为全部模型、未按账号区分
    expect(openai.accounts).toEqual([
      {
        id: "acct-1", label: "acct-1", kind: "login",
        windows: [{ name: "5h", used: 2, resetsAt: FUTURE }],
        models: ["openai/gpt-5", "openai/gpt-5-mini"], perAccount: false,
        autoModel: "openai/gpt-5-mini",
      },
    ]);
    expect(openai.autoAccountModels).toEqual(["openai/gpt-5", "openai/gpt-5-mini"]);
    expect(openai.autoModel).toBe("openai/gpt-5-mini");

    const google = catalog.providers.find((p) => p.id === "google");
    if (!google) throw new Error("缺 google 供应商");
    // 供应商归属优先看 owned_by（真正接住请求的一方），id 前缀只做回退
    expect(google.models.map((x) => x.id)).toEqual(["vertex/gemini-3-pro"]);

    const moonshot = catalog.providers.find((p) => p.id === "moonshot");
    if (!moonshot) throw new Error("缺 moonshot 供应商");
    expect(moonshot.models).toEqual([]);
    expect(moonshot.accounts[0].id).toBe("acct-9");
  });

  test("quotas 挂了 → 目录仍可用（账号为空）", async () => {
    const gw = start({
      models: [{ id: "openai/gpt-5", owned_by: "openai", reasoning: false }],
      quotasStatus: 500,
    });
    const catalog = await fetchCatalog(gw.base);
    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0].accounts).toEqual([]);
  });

  test("key 限额卡只给 key 账号挂窗口用，自己不再是账号", async () => {
    const gw = start({
      models: [{ id: "office/gpt-5", owned_by: "office", reasoning: false }],
      quotas: [
        { provider: "office/~keys", user: "key-a", name: "Key A", windows: [] },
        { provider: "office/~keys", user: "key-b", name: "", windows: [] },
      ],
    });
    const catalog = await fetchCatalog(gw.base);
    expect(catalog.providers.map((p) => p.id)).toEqual(["office"]);
    // 临时 HOME 没有 providers.json：key 卡找不到对应的 key，不产生账号
    expect(catalog.providers[0].accounts).toEqual([]);
  });

  test("有模型缓存 → autoAccountModels 与 autoModel 按缓存算；无缓存的退化用全部模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "ww-catalog-"));
    cleanupDirs.push(root);
    await mkdir(join(root, "cfg", "magpie"), { recursive: true });
    await mkdir(join(root, "cache", "magpie", "models"), { recursive: true });
    await writeFile(
      join(root, "cache", "magpie", "models", "openai.json"),
      JSON.stringify({
        fetched: "2026-11-01T00:00:00Z",
        base: "https://x.test",
        models: [{ ID: "gpt-5.2" }, { ID: "gpt-5.2-mini" }, { ID: "gpt-5.2-turbo" }],
      }),
    );
    const savedConfig = process.env.XDG_CONFIG_HOME;
    const savedCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "cfg");
    process.env.XDG_CACHE_HOME = join(root, "cache");
    try {
      const gw = start({
        models: [
          { id: "openai/gpt-5.2", owned_by: "openai", reasoning: false },
          { id: "openai/gpt-5.2-mini", owned_by: "openai", reasoning: false },
          { id: "openai/gpt-5.2-turbo", owned_by: "openai", reasoning: false },
          { id: "moonshot/kimi", owned_by: "moonshot", reasoning: false },
        ],
        quotas: [{ provider: "moonshot", user: "acct-9", name: "", windows: [] }],
      });
      const catalog = await fetchCatalog(gw.base);
      const openai = catalog.providers.find((p) => p.id === "openai");
      const moonshot = catalog.providers.find((p) => p.id === "moonshot");
      if (!openai || !moonshot) throw new Error("缺供应商");
      expect(openai.autoAccountModels).toEqual([
        "openai/gpt-5.2",
        "openai/gpt-5.2-mini",
        "openai/gpt-5.2-turbo",
      ]);
      expect(openai.autoModel).toBe("openai/gpt-5.2-mini");
      // moonshot 没有缓存文件：退化为全部模型（/v1/models 里就是全部），autoModel 照常
      expect(moonshot.autoAccountModels).toEqual(["moonshot/kimi"]);
      expect(moonshot.autoModel).toBe("moonshot/kimi");
    } finally {
      if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedConfig;
      if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCache;
    }
  });

  test("网关不可达 → 抛底层原始错误", async () => {
    const gw = start();
    const base = gw.base;
    gw.stop();
    let raw = "";
    try {
      await fetch(`${base}/v1/models`);
    } catch (e) {
      raw = e instanceof Error ? e.message : String(e);
    }
    await expect(fetchCatalog(base)).rejects.toThrow(raw);
  });
});

describe("fetchQuotas", () => {
  test("返回快照时间与归一化条目", async () => {
    const gw = start({
      quotas: [
        {
          provider: "openai",
          user: "acct-1",
          name: "Yang",
          windows: [{ name: "5h", used: 2, resetsAt: FUTURE }],
        },
      ],
    });
    const snap = await fetchQuotas(gw.base);
    expect(snap.at).toBeInstanceOf(Date);
    expect(snap.entries).toEqual([
      {
        provider: "openai",
        account: "acct-1",
        label: "Yang",
        windows: [{ name: "5h", used: 2, resetsAt: FUTURE }],
        viaKey: false,
      },
    ]);
  });

  test("远程 key 限额卡：viaKey 标记 + provider 归一成 <p>，user 原样保留", async () => {
    const gw = start({
      quotas: [
        {
          provider: "office/~keys",
          user: "key-yang",
          name: "office @ yang",
          windows: [{ name: "5h", used: 1, resetsAt: FUTURE }],
        },
        { provider: "openai", user: "acct-1", name: "Yang", windows: [] },
      ],
    });
    const snap = await fetchQuotas(gw.base);
    expect(snap.entries).toEqual([
      {
        provider: "office",
        account: "key-yang",
        label: "office @ yang",
        windows: [{ name: "5h", used: 1, resetsAt: FUTURE }],
        viaKey: true,
      },
      { provider: "openai", account: "acct-1", label: "Yang", windows: [], viaKey: false },
    ]);
  });

  test("unlimited: true 的「不限额」占位不是窗口，读取时剔除", async () => {
    const gw = start({
      quotas: [
        {
          provider: "openai",
          user: "acct-1",
          name: "Yang",
          windows: [
            { name: "5h", used: 2, resetsAt: FUTURE },
            { name: "total", unlimited: true },
          ],
        },
      ],
    });
    const snap = await fetchQuotas(gw.base);
    expect(snap.entries[0].windows).toEqual([{ name: "5h", used: 2, resetsAt: FUTURE }]);
  });

  test("卡片的读取时刻 readAt 原样带出（纳秒精度的串也能解析）", async () => {
    const readAt = "2026-11-02T09:44:34.222418286+08:00";
    const gw = start({
      quotas: [{ provider: "zcode", user: "a@b.c", name: "Z", readAt, windows: [] }],
    });
    const snap = await fetchQuotas(gw.base);
    expect(snap.entries[0].readAt).toBe(readAt);
    expect(new Date(snap.entries[0].readAt!).toISOString()).toBe("2026-11-02T01:44:34.222Z");
  });
});

describe("refreshQuotaCard", () => {
  test("POST 单卡刷新接口，供应商与账号按查询参数编码", async () => {
    const gw = start();
    await refreshQuotaCard(gw.base, "zcode", "ho****ng@qq.com");
    const req = gw.requests.find((r) => r.path === "/v1/magpie/quotas/refresh");
    expect(req?.method).toBe("POST");
    const q = new URLSearchParams(req!.search);
    expect(q.get("provider")).toBe("zcode");
    expect(q.get("user")).toBe("ho****ng@qq.com");
  });

  test("接口报错如实抛出", async () => {
    const gw = start({ refreshStatus: 403 });
    await expect(refreshQuotaCard(gw.base, "zcode", "a")).rejects.toThrow("HTTP 403");
  });
});

describe("pickAutoModel", () => {
  const m = (id: string): RawModel => ({ id, owned_by: "p", reasoning: false });

  test("规格词排序 flash < lite < mini < nano < small < turbo", () => {
    const picked = pickAutoModel([
      m("p/turbo"),
      m("p/small"),
      m("p/nano"),
      m("p/mini"),
      m("p/lite"),
      m("p/flash"),
    ]);
    expect(picked?.id).toBe("p/flash");
  });

  test("按单词匹配且不区分大小写：Mini 命中、minimax 不算 mini", () => {
    expect(pickAutoModel([m("p/gpt-5-Mini"), m("p/gpt-5")])?.id).toBe("p/gpt-5-Mini");
    // 两个都不含规格词 → 都排最后，比较落到数字感知降序
    expect(pickAutoModel([m("p/minimax"), m("p/gpt-6"), m("p/gpt-5")])?.id).toBe("p/gpt-6");
  });

  test("都不含规格词的排最后；同档按 id 数字感知降序（新版本优先）", () => {
    expect(pickAutoModel([m("p/gpt-5"), m("p/gpt-5.2"), m("p/gpt-4")])?.id).toBe("p/gpt-5.2");
    expect(pickAutoModel([m("p/model-9"), m("p/model-10")])?.id).toBe("p/model-10");
  });

  test("规格词只看 id 的最后一段", () => {
    expect(pickAutoModel([m("turbo/flash"), m("p/turbo")])?.id).toBe("turbo/flash");
    expect(pickAutoModel([m("flash/turbo"), m("p/flash-lite")])?.id).toBe("p/flash-lite");
  });

  test("空列表 → null", () => {
    expect(pickAutoModel([])).toBeNull();
  });
});

describe("modelProvider", () => {
  test("owned_by 优先（真正接住请求的一方），其次 id 首段，都没有则空", () => {
    expect(modelProvider({ id: "a/b", owned_by: "x" })).toBe("x");
    expect(modelProvider({ id: "a/b" })).toBe("a");
    expect(modelProvider({ id: "bare" })).toBe("");
  });
});

describe("额度兜底读取（kept 为空时读完整接口）", () => {
  const ENTRY = { provider: "openai", user: "acct-1", name: "A", windows: [] };
  function fakeClock(): { now: () => Date; tick: (ms: number) => void } {
    let t = 1_700_000_000_000;
    return { now: () => new Date(t), tick: (ms: number) => { t += ms; } };
  }
  const fulls = (gw: FakeGateway) =>
    gw.requests.filter((r) => r.path === "/v1/magpie/quotas" && r.search === "");
  const kepts = (gw: FakeGateway) =>
    gw.requests.filter((r) => r.path === "/v1/magpie/quotas" && r.search === "?kept=1");

  test("kept 有数据 → 只读缓存，不触发完整读取", async () => {
    const gw = start({ keptQuotas: [ENTRY] });
    const read = createQuotaReader(fakeClock());
    const snap = await read(gw.base);
    expect(snap.entries).toHaveLength(1);
    expect(fulls(gw)).toHaveLength(0);
    expect(kepts(gw)).toHaveLength(1);
  });

  test("kept 为空 → 完整读取一次；5 分钟内再读不重复；跨过 5 分钟才再读", async () => {
    const clock = fakeClock();
    const gw = start({ keptQuotas: [], quotas: [ENTRY] });
    const read = createQuotaReader({ now: clock.now });

    const first = await read(gw.base);
    expect(first.entries).toEqual([
      { provider: "openai", account: "acct-1", label: "A", windows: [], viaKey: false },
    ]);
    expect(fulls(gw)).toHaveLength(1);

    const second = await read(gw.base);
    expect(second.entries).toHaveLength(1);
    expect(fulls(gw)).toHaveLength(1); // 仍在 5 分钟内：复用完整读取结果
    expect(kepts(gw)).toHaveLength(2); // kept 是便宜读，每次照常
    expect(second.at.getTime()).toBe(first.at.getTime()); // 缓存快照保留原读取时刻

    clock.tick(5 * 60_000 + 1);
    await read(gw.base);
    expect(fulls(gw)).toHaveLength(2);
  });

  test("完整读取失败 → 5 分钟内不再发起尝试（没有上次成功就当空），跨过 5 分钟才重试", async () => {
    const clock = fakeClock();
    const opts: FakeGatewayOpts = { keptQuotas: [], quotas: [ENTRY] };
    const gw = start(opts);
    const read = createQuotaReader({ now: clock.now });

    opts.fullQuotasStatus = 500;
    await expect(read(gw.base)).rejects.toThrow(/500/); // 首次尝试如实报错
    const second = await read(gw.base); // 窗口内：不重试，也没有上次成功 → 空条目
    expect(second.entries).toEqual([]);
    expect(fulls(gw)).toHaveLength(1);

    opts.fullQuotasStatus = 200;
    const third = await read(gw.base); // 仍在窗口内：上游已恢复也不会立刻被打
    expect(third.entries).toEqual([]);
    expect(fulls(gw)).toHaveLength(1);

    clock.tick(5 * 60_000 + 1);
    const fourth = await read(gw.base); // 跨过 5 分钟：重试并拿到数据
    expect(fourth.entries).toHaveLength(1);
    expect(fulls(gw)).toHaveLength(2);
  });

  test("完整读取失败 → 5 分钟内复用上一次成功结果", async () => {
    const clock = fakeClock();
    const opts: FakeGatewayOpts = { keptQuotas: [], quotas: [ENTRY] };
    const gw = start(opts);
    const read = createQuotaReader({ now: clock.now });

    const good = await read(gw.base); // 成功一次
    expect(good.entries).toHaveLength(1);

    opts.quotas = []; // 上游真坏了：即便重试也拿不到数据
    opts.fullQuotasStatus = 500;
    clock.tick(5 * 60_000 + 1);
    await expect(read(gw.base)).rejects.toThrow(/500/); // 窗口外重试失败
    const fallback = await read(gw.base); // 窗口内：用上次成功，不再打上游
    expect(fallback.entries).toHaveLength(1);
    expect(fallback.at.getTime()).toBe(good.at.getTime());
    expect(fulls(gw)).toHaveLength(2); // 失败后的窗口内没有第三次尝试
  });

  test("kept 为空时并发兜底读取合并为一次完整读取", async () => {
    const gw = start({ keptQuotas: [], quotas: [ENTRY], fullQuotasDelayMs: 50 });
    const read = createQuotaReader(fakeClock());
    const [a, b, c] = await Promise.all([read(gw.base), read(gw.base), read(gw.base)]);
    expect(fulls(gw)).toHaveLength(1);
    expect(a.entries).toEqual(b.entries);
    expect(b.entries).toEqual(c.entries);
    expect(a.entries).toHaveLength(1);
  });
});

// ---------- 统一账号规则（src/accounts.ts，目录与调度器共用） ----------

describe("accountsOf", () => {
  const fp = (key: string): string =>
    createHash("sha256").update(key, "utf8").digest("hex").slice(0, 10);
  // 夹具假 key
  const K_GLM = "sk-test-AAAA11";
  const K_FREE = "sk-test-BBBB22";
  const K_OTHER = "sk-test-CCCC33";
  const FP = { glm: fp(K_GLM), free: fp(K_FREE), other: fp(K_OTHER) };
  const P = "remote-magpie";
  const M_FLASH = "remote-magpie/group/glm-5.3-flash";
  const M_GLM = "remote-magpie/group/glm-5.3";
  const M_QWEN = "remote-magpie/qwen-token-plan/qwen3.8-flash";

  const keyDir = (): Map<string, KeyDirectoryEntry> =>
    new Map([
      [
        P,
        {
          keys: [
            { fingerprint: FP.free, name: "免费flash" },
            { fingerprint: FP.glm, name: "GLM" },
            { fingerprint: FP.other, name: "除GLM外其他" },
          ],
          accountModels: { [FP.glm]: ["group/glm-5.3"], yang: ["group/glm-5.3"] },
        },
      ],
    ]);
  const cache = (): CachedModel[] => [
    { id: "group/glm-5.3-flash", keys: [FP.free, FP.glm] },
    { id: "group/glm-5.3", keys: [FP.glm] },
    { id: "qwen-token-plan/qwen3.8-flash", keys: [FP.other] },
  ];
  const models = (): string[] => [M_FLASH, M_GLM, M_QWEN];
  const quotas = (): QuotaEntry[] => [
    {
      provider: P, account: "免费flash", label: "免费flash", viaKey: true,
      windows: [{ name: "5h", used: 1, resetsAt: null }],
    },
    {
      provider: P, account: "GLM", label: "GLM", viaKey: true,
      windows: [
        { name: "5h", used: 2, resetsAt: FUTURE },
        // unlimited 是「不限额」占位，不是窗口：cast 塞进去验证账号侧同样剔除
        { name: "week", used: 0, resetsAt: null, unlimited: true } as unknown as QuotaWindow,
      ],
    },
    {
      provider: P, account: "除GLM外其他 · sk-…ab", label: "除GLM外其他 · sk-…ab", viaKey: true,
      windows: [{ name: "5h", used: 4, resetsAt: null }],
    },
    {
      provider: P, account: "Yang", label: "Yang 主账号", viaKey: false,
      windows: [{ name: "5h", used: 3, resetsAt: FUTURE }],
    },
  ];

  const accountOf = (accounts: CatalogAccount[], id: string): CatalogAccount => {
    const a = accounts.find((x) => x.id === id);
    if (!a) throw new Error(`缺账号 ${id}`);
    return a;
  };

  test("本机实况夹具：三个 key 账号各自的可选模型、窗口与自动模型", () => {
    const { accounts, autoAccountModels } = accountsOf(P, {
      models: models(), quotas: quotas(), keyDir: keyDir(), cache: cache(),
    });
    expect(accounts.map((a) => a.id).sort()).toEqual([FP.free, FP.glm, FP.other, "Yang"].sort());

    const free = accountOf(accounts, FP.free);
    expect(free).toEqual({
      id: FP.free, label: "免费flash", kind: "key",
      windows: [{ name: "5h", used: 1, resetsAt: null }],
      models: [M_FLASH], perAccount: true, autoModel: M_FLASH,
    });
    // GLM：accountModels 限定 glm-5.3；~keys 卡的 unlimited 窗口被剔除
    expect(accountOf(accounts, FP.glm)).toEqual({
      id: FP.glm, label: "GLM", kind: "key",
      windows: [{ name: "5h", used: 2, resetsAt: FUTURE }],
      models: [M_GLM], perAccount: true, autoModel: M_GLM,
    });
    // 除GLM外其他：卡名是「名字 · 打码」形态，仍按前缀挂上
    expect(accountOf(accounts, FP.other)).toEqual({
      id: FP.other, label: "除GLM外其他", kind: "key",
      windows: [{ name: "5h", used: 4, resetsAt: null }],
      models: [M_QWEN], perAccount: true, autoModel: M_QWEN,
    });
    // 订阅账号：accountModels 按小写名过滤（键 yang，账号 Yang）
    expect(accountOf(accounts, "Yang")).toEqual({
      id: "Yang", label: "Yang", kind: "login",
      windows: [{ name: "5h", used: 3, resetsAt: FUTURE }],
      models: [M_GLM], perAccount: true, autoModel: M_GLM,
    });
    expect(autoAccountModels).toEqual([M_FLASH, M_GLM, M_QWEN].sort());
  });

  test("没有额度卡对应的 key 不产生账号；key 卡本身不变成登录账号", () => {
    const { accounts } = accountsOf(P, {
      models: models(),
      quotas: [
        { provider: P, account: "ghost-key", label: "ghost", viaKey: true, windows: [] },
        { provider: P, account: "ghost-acct", label: "ghost", viaKey: false, windows: [] },
      ],
      keyDir: keyDir(),
      cache: cache(),
    });
    expect(accounts.map((a) => a.id).sort()).toEqual([FP.free, FP.glm, FP.other, "ghost-acct"].sort());
  });

  test("缓存缺失退化：/v1/models 有模型 → 全部模型不按账号区分（第 1 层跳过），perAccount false", () => {
    const { accounts, autoAccountModels } = accountsOf(P, {
      models: models(), quotas: quotas(), keyDir: keyDir(), cache: null,
    });
    for (const id of [FP.free, FP.glm, FP.other, "Yang"]) {
      const a = accountOf(accounts, id);
      // 第 2 层（accountModels）仍然生效：GLM 与 Yang 仍被限定
      if (id === FP.glm || id === "Yang") {
        expect(a.models).toEqual([M_GLM]);
      } else {
        expect(a.models).toEqual([M_FLASH, M_GLM, M_QWEN].sort());
      }
      expect(a.perAccount).toBe(false);
      expect(a.autoModel).toBe(a.models!.length === 1 ? M_GLM : "remote-magpie/group/glm-5.3-flash");
    }
    expect(autoAccountModels).toEqual([M_FLASH, M_GLM, M_QWEN].sort());
  });

  test("缓存与 /v1/models 模型都没有 → models null（提示 B、自动模型失败）", () => {
    const { accounts, autoAccountModels } = accountsOf(P, {
      models: [], quotas: quotas(), keyDir: keyDir(), cache: null,
    });
    for (const a of accounts) {
      expect(a.models).toBeNull();
      expect(a.perAccount).toBe(false);
      expect(a.autoModel).toBeNull();
    }
    expect(autoAccountModels).toBeNull();
  });

  test("窗口匹配：未命名 key 接受无窗口；同名两把 key 都挂「名字 · 打码」卡", () => {
    const fpA = fp("sk-test-AAAA11");
    const fpB = fp("sk-test-BBBB22");
    const fpC = fp("sk-test-CCCC33");
    const win = [{ name: "5h", used: 7, resetsAt: null }];
    const { accounts } = accountsOf(P, {
      models: models(),
      quotas: [
        { provider: P, account: "GLM · sk-…9f", label: "GLM · sk-…9f", viaKey: true, windows: win },
        { provider: P, account: "sk-…cd", label: "sk-…cd", viaKey: true, windows: win },
      ],
      keyDir: new Map([
        [P, {
          keys: [
            { fingerprint: fpA, name: "" },
            { fingerprint: fpB, name: "GLM" },
            { fingerprint: fpC, name: "GLM" },
          ],
          accountModels: {},
        }],
      ]),
      cache: cache(),
    });
    // 没起名：卡名是打码后的样子，插件算不出来 → 无窗口
    expect(accountOf(accounts, fpA).windows).toEqual([]);
    // 同名两把：都挂到「GLM · 打码」那张卡
    expect(accountOf(accounts, fpB).windows).toEqual(win);
    expect(accountOf(accounts, fpC).windows).toEqual(win);
  });
});

describe("pinFor", () => {
  const fp = (key: string): string =>
    createHash("sha256").update(key, "utf8").digest("hex").slice(0, 10);
  const P = "remote-magpie";
  const keyDir = (names: string[]): Map<string, KeyDirectoryEntry> =>
    new Map([
      [P, {
        keys: names.map((name, i) => ({ fingerprint: fp(`sk-test-${i}-key`), name })),
        accountModels: {},
      }],
    ]);

  test("空账号 → null", () => {
    expect(pinFor(P, "", keyDir(["a", "b"]), [])).toBeNull();
  });

  test("启用 key ≥2 把 → P#指纹；只有 1 把 → null（候选 ID 就是供应商 id）", () => {
    const fp0 = fp("sk-test-0-key");
    expect(pinFor(P, fp0, keyDir(["a", "b"]), [])).toBe(`${P}#${fp0}`);
    expect(pinFor(P, fp0, keyDir(["a"]), [])).toBeNull();
  });

  test("订阅账号名原样；形如 10 位 hex 的订阅名也在账号列表里 → 仍原样", () => {
    const quotas: QuotaEntry[] = [
      { provider: P, account: "Yang", label: "Y", viaKey: false, windows: [] },
      { provider: P, account: "abc1234567", label: "h", viaKey: false, windows: [] },
    ];
    expect(pinFor(P, "Yang", keyDir(["a", "b"]), quotas)).toBe("Yang");
    expect(pinFor(P, "abc1234567", keyDir(["a", "b"]), quotas)).toBe("abc1234567");
  });

  test("目录读不出且账号是 10 位小写 hex → 按 ≥2 处理，发 P#账号", () => {
    expect(pinFor(P, "abc1234567", null, [])).toBe(`${P}#abc1234567`);
    expect(pinFor(P, "ABC1234567", null, [])).toBe("ABC1234567"); // 大写不是指纹形态，原样
  });

  test("供应商在目录里但认不出这把 key：按该供应商的启用 key 数走指纹规则", () => {
    expect(pinFor(P, "abc1234567", keyDir(["a", "b"]), [])).toBe(`${P}#abc1234567`);
    expect(pinFor(P, "abc1234567", keyDir(["a"]), [])).toBeNull();
  });

  test("旧任务里存的 key 名 → 原样发头", () => {
    expect(pinFor(P, "免费flash", keyDir(["免费flash"]), [])).toBe("免费flash");
  });
});
