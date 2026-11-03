// 和 Magpie 网关说话的客户端：列模型、读额度、发预热消息。
// 一切请求只打本地网关（base 由 gatewayBase 从 MAGPIE_ADDR 推出），超时都偏短：
// 网关不可达时调度层要把失败写进执行记录，而不是被挂住的请求拖死。

import { accountsOf, pickAutoModel } from "./accounts";
import { readDefaultKeyDirectory, readDefaultModelCache } from "./magpie-files";
import { WARMUP_MESSAGE } from "./rules";
import {
  errText,
  type Catalog,
  type CatalogProvider,
  type EffortPick,
  type QuotaEntry,
  type QuotaWindow,
  type RawModel,
  type SendResult,
  type Task,
} from "./types";

// 自动选模型的规则在 accounts.ts、探活消息在 rules.ts；这里转出保持既有公开 API 不变
export { pickAutoModel, WARMUP_MESSAGE };

/** MAGPIE_ADDR 缺省时的老端口 */
const DEFAULT_GATEWAY = "http://127.0.0.1:3425";
/** 单次发送的 token 上限：预热消息只是探活，不追求完整回答 */
const SEND_MAX_TOKENS = 16;
/** 发送超时；超了只能记 unknown（请求可能已送达上游） */
const SEND_TIMEOUT_MS = 30_000;
/** 目录/额度的读取超时：页面加载与调度刷新都不该被挂死的网关拖住 */
const READ_TIMEOUT_MS = 10_000;
/**
 * 完整额度读取（不带 kept）的超时。这一路会问上游要最新余额，magpie 侧自身限 12 秒
 * （internal/gateway/gateway.go quotas 的 ctx timeout），放宽到 15 秒兜住网络往返。
 */
const FULL_QUOTAS_TIMEOUT_MS = 15_000;
/** 单卡刷新的超时：magpie 侧给这次上游读取 30 秒（gateway.go quotaCardsRefresh），再放宽兜住往返 */
const CARD_REFRESH_TIMEOUT_MS = 35_000;
/** 两次完整额度读取的最小间隔：kept 缓存空窗期（magpie 刚启动）内的兜底读取不许每次都打 */
const MIN_FULL_GAP_MS = 5 * 60_000;
/** 上游错误原因截断长度，避免个别上游把整页 HTML 塞进 error.message */
const REASON_MAX = 200;

/** 超时属于「结果未知」：请求可能已被网关受理，不能当失败自动重发。文案带实际时长，测试注入短超时时不会谎报 30 秒 */
function timeoutReason(timeoutMs: number): string {
  const duration = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`;
  return `${duration}内没有结果，可能已发送`;
}

export function gatewayBase(env: Record<string, string | undefined> = process.env): string {
  const addr = env.MAGPIE_ADDR?.trim().replace(/\/+$/, "");
  if (!addr) return DEFAULT_GATEWAY;
  // 容忍直接给完整地址（含 https:// 的远程网关）
  if (/^https?:\/\//.test(addr)) return addr;
  return `http://${addr}`;
}

/** 已知名档的优先序；纯数字档（思考预算）低于所有命名档，未知名排在已知名之后 */
const KNOWN_EFFORT_RANK: Record<string, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/** "disabled"/"off" 是「支持关闭」的写法，归一成 none 才能参与档位比较；发送值保留模型原样 */
function normalizeLevel(s: string): string {
  const t = s.trim();
  const low = t.toLowerCase();
  if (low === "disabled" || low === "off") return "none";
  return t;
}

/**
 * 取模型的档位列表：reasoning_levels 优先，否则 supported_reasoning_levels[].effort
 * （字段形状随模型而变，这里运行时校验）。字段存在却提不出任何档位视为数据损坏。
 */
function levelList(model: RawModel): string[] | { error: string } {
  const raw = model.reasoning_levels;
  if (raw !== undefined && raw !== null) {
    // 宁可报错也不能把坏数据误判成「模型不思考」——那会漏发 reasoning_effort
    if (!Array.isArray(raw)) return { error: "模型的思考档位数据无法识别" };
    const list = raw.filter((s): s is string => typeof s === "string");
    if (raw.length > 0 && list.length === 0) return { error: "模型的思考档位数据无法识别" };
    return list;
  }
  const supported = model.supported_reasoning_levels;
  if (supported !== undefined && supported !== null) {
    if (!Array.isArray(supported)) return { error: "模型的思考档位数据无法识别" };
    const list = supported
      .map((x) => (typeof x === "object" && x !== null ? (x as { effort?: unknown }).effort : null))
      .filter((s): s is string => typeof s === "string");
    if (supported.length > 0 && list.length === 0) return { error: "模型的思考档位数据无法识别" };
    return list;
  }
  return [];
}

/**
 * 每次发送前从当次模型列表现算思考档位（任务不存档位，模型配置变了自动跟随）：
 * - reasoning 为假或列表为空 → 模型不思考，不带 reasoning_effort
 * - 含 none → 能关就关
 * - 否则取该模型自己的最低一档（必须思考就开最低）
 */
export function pickEffort(model: RawModel): EffortPick {
  const levels = levelList(model);
  if ("error" in levels) return levels;
  if (!model.reasoning || levels.length === 0) {
    return { send: null, label: "不适用" };
  }
  const normalized = levels.map(normalizeLevel).filter((s) => s !== "");
  if (normalized.length === 0) return { send: null, label: "不适用" };
  if (normalized.some((s) => s.toLowerCase() === "none")) {
    return { send: "none", label: "关闭（模型支持关闭）" };
  }
  // 稳定排序键：组别 → 组内次序 → 列表原序（未知名保持模型给出的顺序）
  const decorated = normalized.map((s, i) => {
    if (/^\d+$/.test(s)) return { s, group: 0, rank: Number(s), i };
    const known = KNOWN_EFFORT_RANK[s.toLowerCase()];
    return { s, group: known === undefined ? 2 : 1, rank: known ?? i, i };
  });
  decorated.sort((a, b) => a.group - b.group || a.rank - b.rank || a.i - b.i);
  const lowest = decorated[0].s;
  const allUnknown = decorated.every((d) => d.group === 2);
  return {
    send: lowest,
    label: allUnknown ? `${lowest}（按模型列表第一档）` : `${lowest}（模型必须思考，已用最低档）`,
  };
}

/** 提取上游错误说明；不是 JSON 就原样截断 */
function errorReason(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const msg = parsed?.error?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, REASON_MAX);
  } catch {
    /* 非 JSON 响应体 */
  }
  return text.trim().slice(0, REASON_MAX) || "上游未返回错误说明";
}

async function requestJSON(
  base: string,
  path: string,
  signal?: AbortSignal,
  timeoutMs: number = READ_TIMEOUT_MS,
  method: "GET" | "POST" = "GET",
): Promise<unknown> {
  // 外部 signal（发送被停用/删除）与读超时一并生效，取元数据阶段也能被立即中止。
  // 连接失败不包装：底层原始错误如实抛给上层显示
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(base + path, {
    method,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}：${errorReason(text)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Magpie 返回的不是 JSON（${path}）`);
  }
}

/** 兼容裸数组与 {data:[...]} 两种包法 */
function dataArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: unknown[] }).data;
  }
  return [];
}

function coerceWindows(list: unknown): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const w of Array.isArray(list) ? list : []) {
    const raw = typeof w === "object" && w !== null ? (w as Record<string, unknown>) : {};
    // unlimited: true 是「不限额」占位，不是窗口（magpie 额度卡用来补齐总余额），剔除
    if (raw.unlimited === true) continue;
    out.push({
      name: typeof raw.name === "string" ? raw.name : "",
      used: typeof raw.used === "number" ? raw.used : null,
      resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : null,
    });
  }
  return out;
}

/**
 * 远程 magpie 给每把网关 key 单独发一张限额卡，provider 记作 "<p>/~keys"、user 是 key 名
 * 或打码形态（magpie internal/provider/remote_key_limits.go 的 remoteKeyCard）。条目保留
 * 这层来历：viaKey 标记 + provider 归一成 <p>——key 卡只能挂到 providers.json 里对应的那把
 * key 上（账号统一规则在 accounts.ts），不能再像 0.1 那样直接变成供应商账号。
 */
function parseQuotas(data: unknown): QuotaEntry[] {
  const entries: QuotaEntry[] = [];
  for (const item of dataArray(data)) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    const rawProvider = typeof q.provider === "string" ? q.provider : "";
    const viaKey = rawProvider.endsWith("/~keys");
    const provider = viaKey ? rawProvider.slice(0, -"/~keys".length) : rawProvider;
    const user = typeof q.user === "string" ? q.user : "";
    if (!provider || !user) continue;
    const readAt = typeof q.readAt === "string" && q.readAt ? q.readAt : null;
    entries.push({
      provider,
      account: user,
      label: typeof q.name === "string" && q.name ? q.name : user,
      windows: coerceWindows(q.windows),
      viaKey,
      ...(readAt ? { readAt } : {}),
    });
  }
  return entries;
}

export type QuotasFn = (base: string) => Promise<{ at: Date; entries: QuotaEntry[] }>;

/**
 * 额度读取：平时 ?kept=1 只读缓存（绝不触发上游探测）。magpie 刚启动时缓存为空，
 * 这时兜底读一次不带 kept 的完整接口（只读余额，不发模型请求，15 秒超时）。
 * 完整读取按「尝试时刻」节流：任何一次尝试（成功或失败）之后 5 分钟内不再发起新的尝试，
 * 期间直接用上次成功结果，没有就当空——否则 magpie 不可达时，页面 60 秒的目录轮询
 * 与调度器刷新会反复重打上游，还要各自等满 15 秒超时。失败同样吃节流，但发起那次
 * 的错误如实抛给调用方（页面目录兜成空账号，调度器保留旧快照）。
 * 并发的兜底读取合并成同一次尝试，保证「至少间隔 5 分钟」在并发下同样成立。
 * 目录（fetchCatalog）与调度器的窗口评估都走这里，共用同一份缓存。
 */
export function createQuotaReader(opts: { now?: () => Date } = {}): QuotasFn {
  const nowFn = opts.now ?? (() => new Date());
  /** base → 上次成功读到的额度：节流窗口内的兜底结果 */
  const lastGood = new Map<string, { at: Date; entries: QuotaEntry[] }>();
  /** base → 上次完整读取的尝试时刻（成功失败都记）：节流按尝试计，不看成败 */
  const lastAttempt = new Map<string, number>();
  const inflight = new Map<string, Promise<{ at: Date; entries: QuotaEntry[] }>>();
  return async (base) => {
    const kept = parseQuotas(await requestJSON(base, "/v1/magpie/quotas?kept=1"));
    if (kept.length > 0) return { at: nowFn(), entries: kept };
    // 正在进行的那次尝试不算新请求：先并入它，节流判断只管要不要「另起一次」
    let pending = inflight.get(base);
    if (!pending) {
      const now = nowFn().getTime();
      const attempted = lastAttempt.get(base);
      if (attempted !== undefined && now - attempted < MIN_FULL_GAP_MS) {
        return lastGood.get(base) ?? { at: nowFn(), entries: [] };
      }
      // 尝试时刻先记账再发请求：失败也吃节流，不许立刻重试
      lastAttempt.set(base, now);
      pending = requestJSON(base, "/v1/magpie/quotas", undefined, FULL_QUOTAS_TIMEOUT_MS)
        .then((data) => {
          const fresh = { at: nowFn(), entries: parseQuotas(data) };
          lastGood.set(base, fresh);
          return fresh;
        })
        .finally(() => {
          inflight.delete(base);
        });
      inflight.set(base, pending);
    }
    return pending;
  };
}

/**
 * 让 magpie 去上游重读一张订阅卡（用量页单卡「刷新」按钮的同一路径），重读结果进 kept 缓存，
 * 下一次 ?kept=1 即可读到。magpie 按卡限频 30 秒，限频内不报错只是不重读——调用方靠
 * 卡片的 readAt 判断是否真拿到了新读数。响应体是另一种卡片形态，这里不解析。
 */
export async function refreshQuotaCard(base: string, provider: string, user: string): Promise<void> {
  const q = new URLSearchParams({ provider, user });
  await requestJSON(base, `/v1/magpie/quotas/refresh?${q}`, undefined, CARD_REFRESH_TIMEOUT_MS, "POST");
}

/** 默认读取器：进程内唯一，目录与调度器（未注入 quotasFn 时）共用同一份完整读取缓存 */
export const fetchQuotas: QuotasFn = createQuotaReader();

/**
 * 拉取原始模型列表（不做目录归并）：调度器每次发送前用它现算该模型的思考档位，
 * 模型配置变了下一次发送自动跟着变。路由组 group/ 一律不接受。
 * signal：调度器在停用/删除任务时传入，中止进行中的取元数据请求。
 */
export async function fetchModels(base: string, signal?: AbortSignal): Promise<RawModel[]> {
  const data = await requestJSON(base, "/v1/models", signal);
  const out: RawModel[] = [];
  for (const item of dataArray(data)) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as RawModel;
    if (typeof m.id !== "string" || !m.id || m.id.startsWith("group/")) continue;
    out.push(m);
  }
  return out;
}

/** 模型归属的供应商 id：owned_by 优先（真正接住请求的一方），否则取 id 首段 */
export function modelProvider(m: RawModel): string {
  const owner = typeof m.owned_by === "string" ? m.owned_by.trim() : "";
  return owner || (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : "");
}

/**
 * 模型目录：模型按 owned_by（真正接住请求的一方）或 id 前缀归供应商，路由组 group/ 一律不列出。
 * 账号、窗口与每账号可选模型走统一账号规则（accounts.ts）：key 账号来自 providers.json 的
 * 指纹，订阅账号来自额度卡，key 卡只用来给 key 账号挂窗口。providers.json 读不出 → key
 * 账号为空，目录照常返回；额度接口挂了不连累模型目录（照搬 fingerprint 的取舍）。
 * autoModel 用与调度器同一套规则在服务端算好，页面直接显示。
 */
export async function fetchCatalog(base: string): Promise<Catalog> {
  const [models, quotas] = await Promise.all([
    fetchModels(base),
    fetchQuotas(base).catch(() => ({ at: new Date(), entries: [] as QuotaEntry[] })),
  ]);
  const providers = new Map<string, CatalogProvider>();
  const rawModels = new Map<string, RawModel[]>();
  const ensure = (id: string): CatalogProvider => {
    let p = providers.get(id);
    if (!p) {
      p = { id, accounts: [], models: [], autoAccountModels: null, autoModel: null };
      providers.set(id, p);
    }
    return p;
  };
  for (const m of models) {
    const pid = modelProvider(m);
    // 归不到供应商的模型建不了任务（provider 必填），列出来只会是死选项
    if (!pid) continue;
    ensure(pid);
    const raws = rawModels.get(pid);
    if (raws) raws.push(m);
    else rawModels.set(pid, [m]);
  }
  for (const q of quotas.entries) ensure(q.provider);
  // providers.json 与各供应商的模型缓存现读（调度器发送前读的是同一份）；读不出按「没有」处理，不让整个目录 502
  const keyDir = await readDefaultKeyDirectory();
  const list = [...providers.values()];
  for (const p of list) {
    const raws = rawModels.get(p.id) ?? [];
    p.models = raws
      .map((m) => ({ id: m.id, effort: pickEffort(m) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const built = accountsOf(p.id, {
      models: raws.map((m) => m.id),
      quotas: quotas.entries,
      keyDir,
      cache: await readDefaultModelCache(p.id),
    });
    p.accounts = built.accounts;
    p.autoAccountModels = built.autoAccountModels;
    p.autoModel = built.autoAccountModels
      ? (pickAutoModel(built.autoAccountModels.map((id) => ({ id })))?.id ?? null)
      : null;
  }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { providers: list };
}

/** 2xx 的 chat 响应体必须是 JSON 对象；Bun 在流中断时 text() 可能不抛错而返回占位内容，形状校验兜住 */
function usableChatBody(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}


/**
 * 发一次预热消息。pin 是调度器按统一账号规则算好的账号头值（null = 不带头，网关自动选）。
 * 只有一次请求，成败都如实上报：
 * - 2xx 且响应体是 JSON 对象 → ok
 * - HTTP 错误 → failed（原因 = 状态码 + 上游 error.message）
 * - 连不上 → failed（原因是底层原始错误）
 * - 超时 / 外部取消 / 2xx 但响应体读不出来 → unknown（请求可能已送达，不允许上层据此自动重发）
 */
export async function send(
  base: string,
  task: Pick<Task, "id" | "model">,
  pin: string | null,
  effort: string | null,
  signal: AbortSignal,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<SendResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timer]);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-magpie-session": `window-warmup/${task.id}`,
  };
  if (pin) {
    // 头值只能按 latin-1 写上线路：含非 ASCII（如中文账号名）时改存 UTF-8 字节，
    // 网关侧按字节收到原文（HTTP 头按字节透传）
    headers["x-magpie-account"] = /[^\x00-\x7F]/.test(pin)
      ? Buffer.from(pin, "utf8").toString("latin1")
      : pin;
  }
  const body: Record<string, unknown> = {
    model: task.model,
    messages: [{ role: "user", content: WARMUP_MESSAGE }],
    max_tokens: SEND_MAX_TOKENS,
    stream: false,
  };
  if (effort) body.reasoning_effort = effort;

  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (e) {
    // 外部取消优先于超时上报；连接被重置说明请求多半已送达、响应丢了，
    // 属「结果未知」而不是「连不上」；都未触发才是连接层失败（原始错误如实上报）
    if (signal.aborted) return { outcome: "unknown", reason: "发送被取消", ms: elapsed() };
    if (timer.aborted) return { outcome: "unknown", reason: timeoutReason(timeoutMs), ms: elapsed() };
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ECONNRESET" || code === "EPIPE") {
      return { outcome: "unknown", reason: "连接中断，结果未知（可能已发送）", ms: elapsed() };
    }
    return { outcome: "failed", reason: errText(e), ms: elapsed() };
  }
  let text = "";
  let bodyBroken = false;
  try {
    text = await res.text();
  } catch {
    bodyBroken = true;
    if (signal.aborted) return { outcome: "unknown", reason: "发送被取消", ms: elapsed() };
    if (timer.aborted) return { outcome: "unknown", reason: timeoutReason(timeoutMs), ms: elapsed() };
  }
  if (res.ok) {
    // 状态码到了但响应体没读出来/不完整：大概率已发送，但无法确认，不能记 ok
    return !bodyBroken && usableChatBody(text)
      ? { outcome: "ok", reason: "", ms: elapsed() }
      : { outcome: "unknown", reason: `HTTP ${res.status}，响应体读取失败，结果未知`, ms: elapsed() };
  }
  return { outcome: "failed", reason: `HTTP ${res.status}：${errorReason(text)}`, ms: elapsed() };
}
