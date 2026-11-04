// 诊断导出（GET /api/diagnostics）：把排查「选不到账号/模型、窗口不触发、发送失败」要用的现场
// 打成一个 JSON，用户可直接附在 issue 里。导出是只读的：不发模型请求、不写状态。
//
// 隐私：账号名、key 指纹、key 名、任务名、额度卡显示名一律不出现。账号换成 acct-N、key 换成 key-N，
// 同一份导出内一一对应（同一个邮箱在两个供应商下是同一个别名，能看出串号）；自由文本（执行记录
// 原因、上游报错、路径）先替换已知账号与指纹，再按规则抹掉邮箱、key 形态串、口令参数与家目录。
// 体积：列表与文本都有上限，截掉的部分记在 truncated 里，常见规模在几十 KB。
import { version } from "../package.json";
import { fetchCatalog, fetchModels, fetchQuotas, modelProvider } from "./gateway";
import {
  magpieDirs,
  readDefaultModelCache,
  readKeyDirectory,
  type KeyDirectoryEntry,
} from "./magpie-files";
import type { Scheduler } from "./scheduler";
import type { TaskMarks } from "./store";
import { errText, type QuotaEntry, type RawModel, type Run, type Task } from "./types";

export const DIAGNOSTICS_SCHEMA = "window-warmup-diagnostics/1";
/** 单个列表（某供应商的模型、某任务的执行记录等）最多导出的条数 */
const LIST_MAX = 200;
/** 每个任务导出的最近执行记录条数（store 每任务留 50 条，排错看最近的就够） */
const RUNS_PER_TASK = 20;
/** 自由文本（原因、报错）的字数上限 */
const TEXT_MAX = 400;
/** 已知账号原文短于这个长度时不在自由文本里替换：太短的名字会误伤模型 id（如 key 名 GLM） */
const SCRUB_MIN_LEN = 4;
/** magpie 额度卡里同名多把 key 的「名字 · 打码」分隔 */
const MASKED_SEP = " · ";

export interface DiagnosticsInput {
  base: string;
  /** 插件数据目录（state.json 所在），只导出脱敏后的路径 */
  dir: string;
  tasks: Task[];
  runs: Run[];
  marks: Record<string, TaskMarks>;
  /** fatal / 只读实例时为 null */
  scheduler: Scheduler | null;
  fatal: string | null;
  lockedBy: number | null;
  now?: Date;
}

/** 账号与 key 的别名表：原文 → 别名，全份导出共用 */
class Aliases {
  private readonly byRaw = new Map<string, string>();
  private acctN = 0;
  private keyN = 0;

  key(fingerprint: string, name: string): string {
    let alias = this.byRaw.get(fingerprint);
    if (!alias) {
      alias = `key-${++this.keyN}`;
      this.byRaw.set(fingerprint, alias);
    }
    // key 名也指向同一别名：~keys 额度卡的 user 就是 key 名
    if (name && !this.byRaw.has(`name:${name.toLowerCase()}`)) this.byRaw.set(`name:${name.toLowerCase()}`, alias);
    return alias;
  }

  /** 订阅账号或任务里存的账号值；指纹形态先查 key 表 */
  account(raw: string): string {
    if (!raw) return "";
    const hit = this.byRaw.get(raw) ?? this.byRaw.get(`login:${raw.toLowerCase()}`);
    if (hit) return hit;
    const alias = `acct-${++this.acctN}`;
    this.byRaw.set(`login:${raw.toLowerCase()}`, alias);
    return alias;
  }

  /** ~keys 卡的 user：key 名，或同名多把时的「名字 · 打码」；打码部分是 key 的片段，不导出 */
  keyCard(user: string): string {
    const name = user.includes(MASKED_SEP) ? user.slice(0, user.indexOf(MASKED_SEP)) : user;
    return this.byRaw.get(`name:${name.toLowerCase()}`) ?? this.account(user);
  }

  /** accountModels 的键：key 指纹或小写账号名 */
  accountKey(k: string): string {
    return this.byRaw.get(k) ?? this.account(k);
  }

  /** 自由文本里要替换的原文（长的先换，免得子串先被换掉） */
  raws(): [string, string][] {
    return [...this.byRaw]
      .map(([k, v]): [string, string] => [k.replace(/^(login|name):/, ""), v])
      .filter(([k]) => k.length >= SCRUB_MIN_LEN)
      .sort((a, b) => b[0].length - a[0].length);
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 自由文本脱敏：已知账号/指纹换别名，再抹通用的敏感形态，最后截断 */
function scrubber(aliases: Aliases): (s: string) => string {
  const known = aliases.raws().map(([raw, alias]) => [new RegExp(escapeRe(raw), "gi"), alias] as const);
  return (s) => {
    let out = s;
    for (const [re, alias] of known) out = out.replace(re, alias);
    out = out
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
      .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/\b(sk|pk|rk|ak|key)-[\w-]{8,}/gi, "<key>")
      .replace(/([?&](?:key|api_?key|token|access_token|auth|sig|signature|cookie)=)[^&\s"']+/gi, "$1<redacted>")
      // 长串不透明口令（cookie、JWT 段等）；模型 id 带点和斜杠，不会被整段吞掉
      .replace(/[A-Za-z0-9_-]{32,}/g, "<token>")
      .replace(/(\/home|\/Users)\/[^/\s"']+/g, "$1/<user>")
      .replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, "$1<user>");
    return out.length > TEXT_MAX ? `${out.slice(0, TEXT_MAX)}…（截断，原长 ${out.length}）` : out;
  };
}

/** 网关地址只在是本机回环时原样导出（端口有用），否则只说明是远程 */
export function baseView(base: string): string {
  try {
    const u = new URL(base);
    return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ? `${u.protocol}//${u.host}` : "<非本机地址>";
  } catch {
    return "<无法解析>";
  }
}

export async function buildDiagnostics(input: DiagnosticsInput): Promise<Record<string, unknown>> {
  const now = input.now ?? new Date();
  const truncated: string[] = [];
  const cap = <T>(list: T[], path: string, max = LIST_MAX): T[] => {
    if (list.length <= max) return list;
    truncated.push(`${path}：共 ${list.length} 条，只导出前 ${max} 条`);
    return list.slice(0, max);
  };
  const settle = <T>(p: Promise<T>): Promise<{ ok: T } | { error: string }> =>
    p.then((ok) => ({ ok }), (e: unknown) => ({ error: errText(e) }));

  const dirs = magpieDirs();
  const [models, quotas, keyDir, catalog] = await Promise.all([
    settle(fetchModels(input.base)),
    settle(fetchQuotas(input.base)),
    // 直接调 readKeyDirectory 区分「没有文件」与「读不出」；报错是固定文案，不夹带文件内容
    settle(readKeyDirectory(dirs.config)),
    settle(fetchCatalog(input.base)),
  ]);
  const dir: Map<string, KeyDirectoryEntry> | null = "ok" in keyDir ? keyDir.ok : null;
  const quotaEntries: QuotaEntry[] = "ok" in quotas ? quotas.ok.entries : [];
  const rawModels: RawModel[] = "ok" in models ? models.ok : [];

  // 先登记所有 key，再登记订阅账号：任务与卡片里的指纹/key 名才能落到同一个 key 别名上
  const aliases = new Aliases();
  for (const entry of dir?.values() ?? []) for (const k of entry.keys) aliases.key(k.fingerprint, k.name);
  const cardAlias = (q: QuotaEntry): string => (q.viaKey ? aliases.keyCard(q.account) : aliases.account(q.account));
  for (const q of quotaEntries) cardAlias(q);
  for (const t of input.tasks) aliases.account(t.account);
  for (const q of input.scheduler?.quotaEntries() ?? []) cardAlias(q);
  const scrub = scrubber(aliases);

  const pids = new Set<string>([
    ...rawModels.map(modelProvider).filter(Boolean),
    ...quotaEntries.map((q) => q.provider),
    ...(dir?.keys() ?? []),
    ...input.tasks.map((t) => t.provider),
  ]);
  const catalogById = new Map(("ok" in catalog ? catalog.ok.providers : []).map((p) => [p.id, p]));
  const providers = await Promise.all(
    [...pids].sort().map(async (pid) => {
      const entry = dir?.get(pid);
      const v1 = rawModels.filter((m) => modelProvider(m) === pid);
      const cache = await readDefaultModelCache(pid).catch(() => null);
      const cat = catalogById.get(pid);
      const path = `providers.${pid}`;
      return {
        id: pid,
        v1Models: cap(
          v1.map((m) => ({
            id: m.id,
            owned_by: m.owned_by,
            reasoning: m.reasoning,
            reasoning_levels: m.reasoning_levels,
            supported_reasoning_levels: m.supported_reasoning_levels?.map((l) => l.effort),
          })),
          `${path}.v1Models`,
        ),
        // providers.json 里的启用清单（chosen）与 key 概况；null = providers.json 没有这个供应商
        providersJson: entry
          ? {
              chosen: cap(entry.models, `${path}.chosen`),
              keys: entry.keys.map((k) => ({ alias: aliases.key(k.fingerprint, k.name), named: k.name !== "" })),
              accountModels: Object.fromEntries(
                Object.entries(entry.accountModels).map(([k, v]) => [aliases.accountKey(k), v]),
              ),
            }
          : null,
        // Magpie 模型缓存文件；null = 没有缓存文件（插件型订阅供应商本来就不写）
        modelCache: cache
          ? cap(
              cache.map((c) => ({ id: c.id, keys: c.keys.map((fp) => aliases.accountKey(fp)) })),
              `${path}.modelCache`,
            )
          : null,
        quotaCards: quotaEntries
          .filter((q) => q.provider === pid)
          .map((q) => ({ account: cardAlias(q), viaKey: q.viaKey, readAt: q.readAt ?? null, windows: q.windows })),
        // 页面 /api/catalog 此刻给出的结果（与下拉框所见一致）；null = 目录里没有这个供应商
        catalog: cat
          ? {
              accounts: cat.accounts.map((a) => ({
                id: a.kind === "key" ? aliases.accountKey(a.id) : aliases.account(a.id),
                kind: a.kind,
                windows: a.windows.map((w) => w.name),
                models: a.models === null ? null : cap(a.models, `${path}.catalog.accounts.models`),
                perAccount: a.perAccount,
                autoModel: a.autoModel,
              })),
              autoAccountModels:
                cat.autoAccountModels === null ? null : cap(cat.autoAccountModels, `${path}.catalog.autoAccountModels`),
              autoModel: cat.autoModel,
            }
          : null,
      };
    }),
  );

  const scheduler = input.scheduler;
  const next = scheduler?.snapshot().next ?? {};
  const tasks = await Promise.all(
    input.tasks.map(async (t) => {
      const preview = scheduler ? await scheduler.previewSend(t) : { error: "调度器未运行" };
      const marks = input.marks[t.id];
      return {
        id: t.id,
        enabled: t.enabled,
        provider: t.provider,
        account: aliases.account(t.account),
        accountKind: /^[0-9a-f]{10}$/.test(t.account) ? "key" : t.account ? "login" : "",
        model: t.model || "<自动>",
        trigger: t.trigger,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        next: next[t.id] ?? null,
        marks: marks
          ? { ...marks, resetKeys: marks.resetKeys.slice(-5).map(scrub) }
          : null,
        // 按发送前同一套规则此刻会怎么发（不真的发）
        sendPreview:
          "error" in preview
            ? { error: scrub(preview.error) }
            : { ...preview, pin: preview.pin === null ? null : scrub(preview.pin) },
      };
    }),
  );

  const runs = input.tasks.flatMap((t) =>
    input.runs
      .filter((r) => r.taskId === t.id)
      .slice(-RUNS_PER_TASK)
      .map((r) => ({ ...r, reason: scrub(r.reason) })),
  );

  return {
    schema: DIAGNOSTICS_SCHEMA,
    note: "账号与 key 已换成别名（acct-N / key-N），任务名与额度卡显示名未导出，自由文本已脱敏",
    generatedAt: now.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    plugin: { version, bun: Bun.version, platform: `${process.platform}-${process.arch}` },
    gateway: {
      base: baseView(input.base),
      models: "ok" in models ? `ok（${models.ok.length} 个）` : scrub(models.error),
      quotas: "ok" in quotas ? `ok（${quotas.ok.entries.length} 张卡）` : scrub(quotas.error),
      catalog: "ok" in catalog ? "ok" : scrub(catalog.error),
    },
    files: {
      configDir: scrub(dirs.config),
      cacheDir: scrub(dirs.cache),
      dataDir: scrub(input.dir),
      providersJson: "ok" in keyDir ? (keyDir.ok.size > 0 ? `ok（${keyDir.ok.size} 个供应商）` : "没有文件或为空") : keyDir.error,
    },
    service: {
      fatal: input.fatal === null ? null : scrub(input.fatal),
      lockedBy: input.lockedBy,
      saveError: scrub(scheduler?.snapshot().saveError ?? "") || null,
      scheduler: scheduler?.debugView() ?? null,
    },
    tasks,
    runs,
    providers,
    truncated,
  };
}
