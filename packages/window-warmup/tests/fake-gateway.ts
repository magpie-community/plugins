// 测试与 --serve 演示共用的假 Magpie 网关：只在本机回环上应答，不发任何真实请求。
// 请求全部按到达顺序记进 requests，供断言请求体与请求头。
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试进程绝不读真实用户的 Magpie 配置：把目录推导用的 XDG 钉到临时位置
// （fetchCatalog 与调度器的兜底读取会走 magpieDirs 的默认路径）
process.env.XDG_CONFIG_HOME = join(tmpdir(), "window-warmup-test-magpie-config");
process.env.XDG_CACHE_HOME = join(tmpdir(), "window-warmup-test-magpie-cache");

export interface FakeChatReply {
  status?: number;
  body?: unknown;
  /** 延迟应答毫秒数，用于模拟超时与外部取消 */
  delayMs?: number;
  /** 模拟 2xx 响应体不完整：truncate=半截 JSON；reset=流中途断开（客户端收到 ECONNRESET） */
  breakBody?: "truncate" | "reset";
}

export interface FakeRequest {
  method: string;
  path: string;
  /** 查询串原样（如 "?kept=1"），用于区分额度缓存读取与完整读取 */
  search: string;
  headers: Record<string, string>;
  /** /v1/chat/completions 的 JSON 请求体；其余请求为 null */
  body: unknown;
}

export interface FakeGatewayOpts {
  models?: unknown[];
  /** 额度完整读取（不带 kept）的应答；kept=1 缺省也用它（缓存里就是最新读数） */
  quotas?: unknown[];
  /** ?kept=1 的独立应答，模拟「缓存为空」触发兜底完整读取 */
  keptQuotas?: unknown[];
  /** /v1/models 的状态码，模拟模型目录接口故障 */
  modelsStatus?: number;
  /** 额度缓存读取（kept=1）的状态码，模拟额度接口故障 */
  quotasStatus?: number;
  /** 完整读取（不带 kept）的状态码；缺省跟随 quotasStatus（额度接口挂了两种读法都挂） */
  fullQuotasStatus?: number;
  /** 单卡刷新（POST /v1/magpie/quotas/refresh）的状态码 */
  refreshStatus?: number;
  /** 完整读取（不带 kept）的延迟毫秒数，用于并发合并测试 */
  fullQuotasDelayMs?: number;
  /** chat 端点的固定应答，或按请求体动态应答 */
  chat?: FakeChatReply | ((body: unknown, req: Request) => FakeChatReply | Promise<FakeChatReply>);
}

export interface FakeGateway {
  base: string;
  requests: FakeRequest[];
  stop: () => void;
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEFAULT_CHAT_BODY = {
  id: "chatcmpl-fake",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

export function fakeGateway(opts: FakeGatewayOpts = {}): FakeGateway {
  const requests: FakeRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const entry: FakeRequest = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(req.headers.entries()),
        body: null,
      };
      requests.push(entry);
      if (url.pathname === "/v1/models") {
        return reply(opts.modelsStatus ?? 200, { data: opts.models ?? [] });
      }
      if (url.pathname === "/v1/magpie/quotas/refresh" && req.method === "POST") {
        return reply(opts.refreshStatus ?? 200, { data: [] });
      }
      if (url.pathname === "/v1/magpie/quotas") {
        const kept = url.searchParams.get("kept") === "1";
        const status = kept
          ? opts.quotasStatus ?? 200
          : opts.fullQuotasStatus ?? opts.quotasStatus ?? 200;
        if (!kept && opts.fullQuotasDelayMs) await Bun.sleep(opts.fullQuotasDelayMs);
        return reply(status, { data: kept ? opts.keptQuotas ?? opts.quotas ?? [] : opts.quotas ?? [] });
      }
      if (url.pathname === "/v1/chat/completions") {
        const raw = await req.text();
        try {
          entry.body = JSON.parse(raw);
        } catch {
          entry.body = raw;
        }
        const conf =
          typeof opts.chat === "function" ? await opts.chat(entry.body, req) : (opts.chat ?? {});
        if (conf.delayMs) await Bun.sleep(conf.delayMs);
        if (conf.breakBody) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":"chatcmpl-fake"'));
              if (conf.breakBody === "reset") controller.error(new Error("连接中断"));
              else controller.close();
            },
          });
          return new Response(stream, {
            status: conf.status ?? 200,
            headers: { "content-type": "application/json" },
          });
        }
        return reply(conf.status ?? 200, conf.body ?? DEFAULT_CHAT_BODY);
      }
      return reply(404, { error: { message: `假网关没有 ${url.pathname}` } });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

// bun tests/fake-gateway.ts --serve：以示例数据常驻并打印地址，供页面联调与截图（长驻，勿在测试里跑）
if (import.meta.main && process.argv.includes("--serve")) {
  const in2h = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const gw = fakeGateway({
    models: [
      {
        id: "openai/gpt-5.2",
        owned_by: "openai",
        reasoning: true,
        reasoning_levels: ["minimal", "low", "medium", "high"],
      },
      { id: "openai/gpt-5.2-chat", owned_by: "openai", reasoning: false },
      {
        id: "anthropic/claude-opus-4",
        owned_by: "anthropic",
        reasoning: true,
        reasoning_levels: ["disabled", "low", "high", "max"],
      },
      {
        id: "google/gemini-3-pro",
        owned_by: "google",
        reasoning: true,
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      },
      { id: "deepseek/deepseek-v4", owned_by: "deepseek", reasoning: true, reasoning_levels: ["8192", "2048"] },
      { id: "group/auto", owned_by: "openai", reasoning: false },
    ],
    quotas: [
      {
        provider: "openai",
        user: "acct-yang",
        name: "Yang 主账号",
        kind: "subscription",
        windows: [
          { name: "5h", used: 2, resetsAt: in2h },
          { name: "week", used: 31, resetsAt: null },
        ],
      },
      {
        provider: "anthropic",
        user: "acct-team",
        name: "Team 席位",
        kind: "subscription",
        windows: [{ name: "5h", used: 0, resetsAt: null }],
      },
    ],
  });
  console.log(`fake gateway: ${gw.base}`);
}
