// 统一账号规则：/api/catalog（fetchCatalog）与调度器共用同一份实现，禁止两处各写一套。
// 数据来源：providers.json 的 key 目录（指纹、key 名、accountModels）、额度卡（窗口）、
// 模型缓存（按账号的可见性）。自动选模型也归这里（pickAutoModel），目录与调度器才能算得一致。
import type { CachedModel, KeyDirectoryEntry } from "./magpie-files";
import type { CatalogAccount, QuotaEntry, QuotaWindow } from "./types";

/** key 指纹的形态：10 位小写 hex（sha256 前 5 字节），见 magpie internal/provider/keys.go keyID */
const FINGERPRINT_RE = /^[0-9a-f]{10}$/;

/** key 卡 user 里「名字 · 打码」的分隔（remote_key_limits.go：同名多把是「名字 · 打码」） */
const MASKED_SEP = " · ";

export const isFingerprint = (v: string): boolean => FINGERPRINT_RE.test(v);

// ---------- 自动选模型（自 gateway.ts 迁入，gateway 原样转出保持公开 API） ----------

/**
 * 自动选模型的规格词与优先序：越小越省额度（flash 最小），模型都不含的排最后。
 * 与 pickEffort 一样每次发送前现算，不落进任务。
 */
const AUTO_SPEC_WORDS = ["flash", "lite", "mini", "nano", "small", "turbo"] as const;
const AUTO_SPEC_RES = AUTO_SPEC_WORDS.map((w) => new RegExp(`\\b${w}\\b`, "i"));

/** id 最后一段命中了哪个规格档；单词匹配，"minimax" 不算 mini；都没命中返回词表长度 */
function specTier(id: string): number {
  const seg = id.slice(id.lastIndexOf("/") + 1);
  let best: number = AUTO_SPEC_WORDS.length;
  for (let i = 0; i < AUTO_SPEC_RES.length; i++) {
    if (i < best && AUTO_SPEC_RES[i].test(seg)) best = i;
  }
  return best;
}

/**
 * id 的数字感知比较（降序，新版本在前）：数字段按数值（10 > 9）、文本段按字典序，
 * 一方是另一方的前缀时更长（更具体/更新）的在前。
 */
function cmpNewerDesc(a: string, b: string): number {
  const ta = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const tb = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      // 数字相等（如 "5" 与 "5.2" 的前段）不算分出胜负，继续比后面的 token
      const d = Number(y) - Number(x);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return y < x ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 自动选模型：在（调用方已按供应商筛好的）候选里，按 id 最后一段的规格词
 * flash < lite < mini < nano < small < turbo 排序取第一个，都没有的排最后；
 * 同档按 id 数字感知降序（新版本优先）。选不到（空列表）返回 null。
 */
export function pickAutoModel<T extends { id: string }>(models: T[]): T | null {
  if (models.length === 0) return null;
  const decorated = models.map((m, i) => ({ m, tier: specTier(m.id), i }));
  decorated.sort((a, b) => a.tier - b.tier || cmpNewerDesc(a.m.id, b.m.id) || a.i - b.i);
  return decorated[0].m;
}

// ---------- 内部工具 ----------

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 「不限额」占位（unlimited: true）不是窗口，进入账号前剔除 */
function keepWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return windows.filter(
    (w) => (w as { unlimited?: unknown }).unlimited !== true,
  );
}

/**
 * 账号窗口归属：优先精确匹配订阅卡（user 原样），否则按 key 名匹配 key 卡
 * （user 与 key 名不分大小写相等，或以「名字 · 」开头——同名多把卡是打码形态）。
 * key 名来自指纹反查 keyDir；没起名的 key（卡名是打码的样子，插件算不出来）接受无窗口。
 * 返回 null = 账号不存在（既无订阅卡、指纹也解析不出 key 名）。
 */
export function windowsForAccount(
  provider: string,
  account: string,
  quotas: QuotaEntry[],
  keyDir: Map<string, KeyDirectoryEntry> | null,
): QuotaWindow[] | null {
  const login = quotas.find(
    (q) => q.provider === provider && !q.viaKey && q.account === account,
  );
  if (login) return keepWindows(login.windows);
  // key：先解析 key 名（旧任务里存的名字原样用；指纹经 keyDir 反查），再按卡名匹配
  const name = isFingerprint(account)
    ? keyDir?.get(provider)?.keys.find((k) => k.fingerprint === account)?.name ?? null
    : account;
  if (name === null) return null;
  if (name === "") return []; // 没起名的 key：接受无窗口
  const low = name.toLowerCase();
  const card = quotas.find(
    (q) =>
      q.provider === provider &&
      q.viaKey &&
      (q.account.toLowerCase() === low || q.account.startsWith(`${name}${MASKED_SEP}`)),
  );
  return card ? keepWindows(card.windows) : [];
}

// ---------- 可选模型（三层规则） ----------

export interface ModelsInput {
  /** /v1/models 中归属该供应商的完整模型 id */
  models: string[];
  keyDir: Map<string, KeyDirectoryEntry> | null;
  /** 该供应商的模型缓存；null = 缓存文件不存在或读不出 */
  cache: CachedModel[] | null;
}

/** 候选统一成 {full, bare}：bare 是不带供应商前缀的形态（accountModels 里的模型 id 形态） */
interface Candidate {
  full: string;
  bare: string;
  /** 只有缓存候选才有（key 指纹列表）；退化候选没有按账号的可见性 */
  keys: string[] | null;
}

function candidatesOf(provider: string, models: string[], cache: CachedModel[] | null): Candidate[] {
  if (cache) {
    return cache.map((c) => ({ full: `${provider}/${c.id}`, bare: c.id, keys: c.keys }));
  }
  // 退化：没有模型缓存（插件型订阅供应商不写这个文件）——直接用 /v1/models 的 id
  const prefix = `${provider}/`;
  return models.map((m) => ({
    full: m,
    bare: m.startsWith(prefix) ? m.slice(prefix.length) : m,
    keys: null,
  }));
}

export interface AccountModels {
  /** null = 该供应商既无缓存、/v1/models 里也没有它的模型（提示 B；自动模型失败） */
  list: string[] | null;
  /** false = 没有模型缓存，列出的是全部模型（未按账号区分） */
  perAccount: boolean;
}

/**
 * 账号的可选模型（三层规则的共用实现，accountsOf 与调度器都走这里）：
 * 第 1 层按 Keys 过滤（仅缓存模式、仅 key 账号）；第 2 层 accountModels[账号键]；
 * 第 3 层只留 /v1/models 里存在的。缓存缺失且有 /v1/models 模型时退化为全部模型。
 */
export function modelsForAccount(
  provider: string,
  account: string,
  input: ModelsInput,
): AccountModels {
  const hasCache = input.cache !== null;
  if (!hasCache && input.models.length === 0) return { list: null, perAccount: false };
  let cands = candidatesOf(provider, input.models, input.cache);
  if (hasCache && isFingerprint(account)) {
    // 第 1 层：Keys 为空 = 所有 key 可见，否则只留包含这把指纹的
    cands = cands.filter((c) => !c.keys || c.keys.length === 0 || c.keys.includes(account));
  }
  const filterKey = isFingerprint(account) ? account : account.toLowerCase();
  const allowed = input.keyDir?.get(provider)?.accountModels[filterKey];
  if (allowed && allowed.length > 0) {
    // 第 2 层：配置了账号的模型清单就只留列出的
    const set = new Set(allowed);
    cands = cands.filter((c) => set.has(c.bare));
  }
  const present = new Set(input.models);
  const list = cands
    .map((c) => c.full)
    .filter((id) => present.has(id))
    .sort();
  return { list, perAccount: hasCache };
}

// ---------- 账号列表与发送头 ----------

export interface AccountsInput extends ModelsInput {
  /** 归一后的额度条目（key 卡 viaKey=true、provider 已归一为 <p>） */
  quotas: QuotaEntry[];
}

/**
 * 供应商 P 的账号列表与「自动选账号」的可选模型：
 * - key 账号来自 providers.json 的启用 key（指纹去重），id = 指纹，label = key 名（无名用指纹）；
 * - 订阅账号来自额度卡（provider === P 且非 key 卡）的 user，去重，id = label = user；
 * - 所有窗口剔除 unlimited 占位；模型列表与自动模型按三层规则现算。
 */
export function accountsOf(
  provider: string,
  input: AccountsInput,
): { accounts: CatalogAccount[]; autoAccountModels: string[] | null } {
  const entry = input.keyDir?.get(provider) ?? null;
  const accounts: CatalogAccount[] = [];
  const seenFingerprints = new Set<string>();
  for (const k of entry?.keys ?? []) {
    if (seenFingerprints.has(k.fingerprint)) continue;
    seenFingerprints.add(k.fingerprint);
    accounts.push({
      id: k.fingerprint,
      label: k.name || k.fingerprint,
      kind: "key",
      windows: windowsForAccount(provider, k.fingerprint, input.quotas, input.keyDir) ?? [],
      ...pickModels(provider, k.fingerprint, input),
    });
  }
  const seenUsers = new Set<string>();
  for (const q of input.quotas) {
    if (q.provider !== provider || q.viaKey) continue;
    if (seenUsers.has(q.account)) continue;
    seenUsers.add(q.account);
    accounts.push({
      id: q.account,
      label: q.account,
      kind: "login",
      windows: windowsForAccount(provider, q.account, input.quotas, input.keyDir) ?? [],
      ...pickModels(provider, q.account, input),
    });
  }
  accounts.sort(byId);
  return { accounts, autoAccountModels: autoAccountModelsOf(provider, input) };
}

function pickModels(
  provider: string,
  account: string,
  input: AccountsInput,
): { models: string[] | null; perAccount: boolean; autoModel: string | null } {
  const pick = modelsForAccount(provider, account, input);
  return {
    models: pick.list,
    perAccount: pick.perAccount,
    autoModel: pick.list ? (pickAutoModel(pick.list.map((id) => ({ id })))?.id ?? null) : null,
  };
}

/** 「自动选账号」的可选模型：不做第 1、2 层（不按账号区分），只做第 3 层归属校验 */
function autoAccountModelsOf(provider: string, input: AccountsInput): string[] | null {
  if (input.cache === null && input.models.length === 0) return null;
  const present = new Set(input.models);
  return candidatesOf(provider, input.models, input.cache)
    .map((c) => c.full)
    .filter((id) => present.has(id))
    .sort();
}

/**
 * 发送时的账号头值（X-Magpie-Account）：
 * - "" → null（不带头，网关自动选）；
 * - 先查账号归属：额度卡里有这个 user 的订阅账号 → 原样发名字（哪怕恰好形似指纹）；
 *   是 P 的 key 指纹 → 启用 key ≥2 把（读不出目录时按 ≥2）发 `<P>#指纹`，只有 1 把不带头
 *   （此时候选 ID 就是供应商 id）；
 * - 查不到且形如 10 位小写 hex → 按指纹规则；其余（订阅名、旧任务存的 key 名）→ 原样。
 */
export function pinFor(
  provider: string,
  account: string,
  keyDir: Map<string, KeyDirectoryEntry> | null,
  quotas: QuotaEntry[] = [],
): string | null {
  if (!account) return null;
  const isLogin = quotas.some((q) => q.provider === provider && !q.viaKey && q.account === account);
  if (isLogin) return account;
  if (isFingerprint(account)) {
    // 指纹形态（目录读不出时也按 ≥2 处理）：启用 key ≥2 把才有 <P>#指纹 这个候选 ID
    const enabled = keyDir?.get(provider)?.keys.length ?? 2;
    return enabled >= 2 ? `${provider}#${account}` : null;
  }
  return account;
}
