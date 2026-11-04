// 读 Magpie 自己的配置与缓存文件：providers.json（key 指纹与账号模型）与模型缓存。
// 红线：providers.json 里的 key 原文只允许在 readKeyDirectory 内「读文件 → 算指纹」这一步存在，
// 算完即丢——绝不进入返回值、错误信息或缓存（JSON.parse 的报错会夹带文件片段，必须换成固定文案）。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, { join, resolve } from "node:path";

/**
 * 本插件在 Magpie 配置目录里的安装位置特征（moduleDir 的末尾几段）：
 * 现在的作用域包名装成 node_modules/@magpie-community/page-window-warmup/dist；
 * 旧独立包名（≤0.3.7）还可能留在 node_modules/magpie-window-warmup/dist。
 */
const PLUGIN_DIR_TAILS = [
  ["plugins", "node_modules", "@magpie-community", "page-window-warmup", "dist"],
  ["plugins", "node_modules", "magpie-window-warmup", "dist"],
];
/** providers.json 解析失败的固定文案：原异常信息可能夹带文件内容（含 key 原文），不能透传 */
export const BROKEN_PROVIDERS_MESSAGE = "Magpie 的供应商配置文件读不出来";

/** 读取结果进程内缓存的时长：页面目录轮询与调度器发送都会反复读盘，5 秒内共用一次读取 */
const READ_CACHE_MS = 5_000;

export interface KeyDirectoryEntry {
  /** 启用的 key（按指纹去重）；只有指纹与名字，绝无 key 原文 */
  keys: { fingerprint: string; name: string }[];
  /** <小写账号名或 key 指纹> → 模型 id 列表（不带供应商前缀） */
  accountModels: Record<string, string[]>;
  /** 该供应商当前启用的模型 id（不带前缀，providers.json 的 models 即 chosen）；
   * 模型被路由组 unlists 藏出 /v1/models 时，这是唯一还知道它在的来源 */
  models: string[];
}

/** 模型缓存里的一个模型：id 不带供应商前缀，keys 是能看到它的 key 指纹（空 = 所有 key） */
export interface CachedModel {
  id: string;
  keys: string[];
}

/**
 * Magpie 的配置与缓存目录。插件装在 <配置目录>/plugins/node_modules/<包名>/dist
 * 时（按 PLUGIN_DIR_TAILS 判定，兼容 Windows 反斜杠），配置目录就是上溯到 plugins 的上一级；
 * 它与安装版配置目录相同 → 缓存用安装版缓存目录，否则是便携版 data 目录，缓存跟配置走
 * （<data>/cache）。位置对不上（源码态开发、别的宿主）时用安装版两个目录。
 * XDG 变量只在是绝对路径时才算数（对齐 magpie internal/appdir/env.go 的 rooted），
 * home 取 os.homedir()。
 */
export function magpieDirs(
  env: Record<string, string | undefined> = process.env,
  moduleDir: string = import.meta.dir,
  p: typeof path = path,
): { config: string; cache: string } {
  const installConfig = p.resolve(xdgConfigHome(env, p), "magpie");
  const installCache = p.resolve(rooted(env.XDG_CACHE_HOME, p) ?? p.join(homedir(), ".cache"), "magpie");
  const segments = moduleDir.split(p.sep === "\\" ? /[\\/]/ : p.sep).filter((s) => s !== "");
  const tail = PLUGIN_DIR_TAILS.find((t) => {
    if (segments.length < t.length) return false;
    const got = segments.slice(-t.length);
    return t.every((seg, i) => got[i] === seg);
  });
  if (!tail) return { config: installConfig, cache: installCache };
  const config = p.resolve(moduleDir, ...tail.map(() => ".."));
  return {
    config,
    cache: p.resolve(config) === installConfig ? installCache : p.join(config, "cache"),
  };
}

/** XDG 变量留白或相对路径都视为没设（magpie 的 rooted 语义） */
function rooted(v: string | undefined, p: typeof path): string | null {
  const t = v?.trim();
  return t && p.isAbsolute(t) ? t : null;
}

/**
 * XDG 配置根目录（不含 magpie 段）：插件数据目录、旧包迁移来源与 Magpie 配置目录
 * 都从这里推，三者必须用同一语义，否则相对路径的 XDG_CONFIG_HOME 会让它们各指一处。
 */
export function xdgConfigHome(
  env: Record<string, string | undefined> = process.env,
  p: typeof path = path,
): string {
  return rooted(env.XDG_CONFIG_HOME, p) ?? p.join(homedir(), ".config");
}

// 目录（/api/catalog）与调度器都经下面两个入口按默认位置读 Magpie 文件。
// 位置每次现推（纯字符串运算）：环境变量在进程内可能被改（测试即如此），不做缓存。

/** 按默认位置读 providers.json；读不出（损坏/权限）按 null 处理，调用方当「没有 key 目录」 */
export function readDefaultKeyDirectory(): Promise<Map<string, KeyDirectoryEntry> | null> {
  return readKeyDirectory(magpieDirs().config).catch(() => null);
}

/** 按默认位置读某供应商的模型缓存；没有缓存为 null */
export function readDefaultModelCache(providerId: string): Promise<CachedModel[] | null> {
  return readModelCache(magpieDirs().cache, providerId);
}

/**
 * providers.json 的 key 指纹，与 magpie internal/provider/keys.go keyID 同一算法：
 * sha256(key 原文 UTF-8) 前 5 字节的小写 hex（10 字符）。
 */
function keyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 10);
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/** 单个 provider 的目录条目；key 原文只在入参处短暂存在，离开本函数前只剩指纹 */
function entryOf(raw: unknown): KeyDirectoryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const pr = raw as Record<string, unknown>;
  if (typeof pr.id !== "string" || !pr.id) return null;
  const keys: KeyDirectoryEntry["keys"] = [];
  const seen = new Set<string>();
  const push = (key: unknown, name: unknown): void => {
    if (typeof key !== "string" || !key) return;
    const fingerprint = keyFingerprint(key); // 到这里为止 key 原文已用完
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    keys.push({ fingerprint, name: typeof name === "string" ? name : "" });
  };
  push(pr.key, pr.keyName);
  if (Array.isArray(pr.keys)) {
    for (const k of pr.keys) {
      if (typeof k !== "object" || k === null) continue;
      const rec = k as Record<string, unknown>;
      if (rec.off === true) continue; // 停用的 key 不列
      push(rec.key, rec.name);
    }
  }
  const accountModels: Record<string, string[]> = {};
  if (typeof pr.accountModels === "object" && pr.accountModels !== null) {
    for (const [k, v] of Object.entries(pr.accountModels)) {
      const list = asStringArray(v);
      if (list) accountModels[k] = list;
    }
  }
  return { keys, accountModels, models: asStringArray(pr.models) ?? [] };
}

// 读取缓存：只存解析成功且非空的结果（键是文件路径），损坏/缺失每次现读，便于夹具与排错
const readCache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string, load: () => Promise<T>, worth: (v: T) => boolean): Promise<T> {
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_MS && worth(hit.value as T)) {
    return Promise.resolve(hit.value as T);
  }
  return load().then((value) => {
    if (worth(value)) readCache.set(key, { at: Date.now(), value });
    return value;
  });
}

/**
 * 读 providers.json → 供应商 id → key 目录（指纹、key 名、accountModels）。
 * 文件不存在 → 空 Map；解析失败 → 固定文案（原异常可能夹带 key 原文，绝不透传）。
 */
export function readKeyDirectory(configDir: string): Promise<Map<string, KeyDirectoryEntry>> {
  const file = resolve(join(configDir, "providers.json"));
  return cached(
    file,
    async () => {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
        throw new Error(BROKEN_PROVIDERS_MESSAGE);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(BROKEN_PROVIDERS_MESSAGE);
      }
      const map = new Map<string, KeyDirectoryEntry>();
      const providers = (parsed as { providers?: unknown } | null)?.providers;
      if (Array.isArray(providers)) {
        for (const item of providers) {
          const entry = entryOf(item);
          if (entry) {
            const id = (item as { id: string }).id;
            const prev = map.get(id);
            // 同 id 出现两次时合并 key（按指纹去重），accountModels 与 models 后者胜
            if (prev) {
              for (const k of entry.keys) {
                if (!prev.keys.some((x) => x.fingerprint === k.fingerprint)) prev.keys.push(k);
              }
              Object.assign(prev.accountModels, entry.accountModels);
              prev.models = entry.models;
            } else {
              map.set(id, entry);
            }
          }
        }
      }
      return map;
    },
    (v) => v.size > 0,
  );
}

/**
 * 读某供应商的模型缓存 <缓存目录>/models/<供应商id>.json。
 * 不存在 / 解析失败 / 形状不对 → null；providerId 含路径分隔符或 .. → null（防路径穿越）。
 */
export function readModelCache(
  cacheDir: string,
  providerId: string,
): Promise<CachedModel[] | null> {
  if (
    !providerId ||
    providerId.includes("/") ||
    providerId.includes("\\") ||
    providerId.includes("..")
  ) {
    return Promise.resolve(null);
  }
  const file = resolve(join(cacheDir, "models", `${providerId}.json`));
  return cached(
    file,
    async () => {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      const models = (parsed as { models?: unknown } | null)?.models;
      if (!Array.isArray(models)) return null;
      const out: CachedModel[] = [];
      for (const item of models) {
        if (typeof item !== "object" || item === null) return null;
        const rec = item as Record<string, unknown>;
        if (typeof rec.ID !== "string" || !rec.ID) return null;
        const keys = rec.Keys === undefined || rec.Keys === null ? [] : asStringArray(rec.Keys);
        if (!keys) return null;
        out.push({ id: rec.ID, keys });
      }
      return out;
    },
    (v) => v !== null,
  );
}
