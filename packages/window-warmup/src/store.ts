// 状态持久化与单实例锁。
// - state.json 用「临时文件 + rename」原子落盘；打开时校验 JSON/version/结构，损坏即拒绝启动且绝不覆盖原文件。
// - service.lock 用原子排他创建（link）+ pid 活性判断：持有者存活则不启动，确认已死才接管；
//   活性不明（内容读不出/解析不了）一律不抢占。
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { xdgConfigHome } from "./magpie-files";
import { errText, type Run, type Task } from "./types";

/** 每个任务保留的执行记录上限（超出丢最旧的） */
const RUNS_PER_TASK = 50;
/** 每个任务记住的 resetKey 上限（窗口去重用，超出丢最旧的） */
const RESET_KEYS_PER_TASK = 20;
const STATE_FILE = "state.json";
const LOCK_FILE = "service.lock";
/** 旧包（定时消息）的数据目录名；包改名为窗口预热后做一次性数据迁移 */
const LEGACY_DIR_NAME = "scheduled-messages";

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface TaskMarks {
  /** 最近一次计划执行的到期点（ISO）；窗口任务不用它 */
  lastDue: string | null;
  /** 已尝试过的窗口 resetKey（成功/失败/未知都算），最多留最近 20 个 */
  resetKeys: string[];
  /** 这个任务的窗口最近一次见到的重置时间（ISO）：额度卡瞬断丢了 resetsAt 时，
   * 用它区分「窗口其实在计时」和「真空闲」；旧数据没有这个字段照常加载 */
  lastReset?: string | null;
  /** 窗口任务最近一次真正把消息发出去的收尾时刻（ISO）：此前读到的空闲是发送前的旧读数，不可信 */
  lastSent?: string | null;
}

export interface StateFile {
  version: 1;
  tasks: Task[];
  runs: Run[];
  marks: Record<string, TaskMarks>;
}

export interface Store {
  readonly data: StateFile;
  /** 全量原子写入；并发调用在内部串行化，总是把最新内存状态写进文件 */
  save(): Promise<void>;
}

function isStr(x: unknown): x is string {
  return typeof x === "string";
}

function isStrOrNull(x: unknown): x is string | null {
  return x === null || typeof x === "string";
}

function checkTask(t: unknown, at: string): string | null {
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    return `状态文件结构不对：${at} 必须是对象`;
  }
  const o = t as Record<string, unknown>;
  for (const k of ["id", "name", "provider", "account", "model", "message", "createdAt", "updatedAt"]) {
    if (!isStr(o[k])) return `状态文件结构不对：${at}.${k} 必须是字符串`;
  }
  if (typeof o.enabled !== "boolean") return `状态文件结构不对：${at}.enabled 必须是布尔值`;
  const trig = o.trigger;
  if (typeof trig !== "object" || trig === null || Array.isArray(trig)) {
    return `状态文件结构不对：${at}.trigger 必须是对象`;
  }
  const tv = trig as Record<string, unknown>;
  switch (tv.kind) {
    case "window":
      if (!isStr(tv.window)) return `状态文件结构不对：${at}.trigger.window 必须是字符串`;
      break;
    case "daily":
      if (!isStr(tv.time) || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(tv.time)) {
        return `状态文件结构不对：${at}.trigger.time 需为 24 小时制 HH:MM`;
      }
      if (!isStr(tv.timeZone) || !tv.timeZone) {
        return `状态文件结构不对：${at}.trigger.timeZone 必须是字符串`;
      }
      break;
    case "every":
      if (typeof tv.hours !== "number" || !Number.isFinite(tv.hours) || tv.hours <= 0) {
        return `状态文件结构不对：${at}.trigger.hours 必须是正数`;
      }
      if (!isStr(tv.anchor) || Number.isNaN(new Date(tv.anchor).getTime())) {
        return `状态文件结构不对：${at}.trigger.anchor 必须是可识别的时间`;
      }
      break;
    default:
      return `状态文件结构不对：${at}.trigger.kind 必须是 window、daily 或 every`;
  }
  return null;
}

function checkRun(r: unknown, at: string): string | null {
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    return `状态文件结构不对：${at} 必须是对象`;
  }
  const o = r as Record<string, unknown>;
  for (const k of ["id", "taskId", "startedAt"]) {
    if (!isStr(o[k])) return `状态文件结构不对：${at}.${k} 必须是字符串`;
  }
  if (o.source !== "schedule" && o.source !== "catchup" && o.source !== "manual") {
    return `状态文件结构不对：${at}.source 无法识别`;
  }
  if (o.outcome !== "ok" && o.outcome !== "failed" && o.outcome !== "unknown" && o.outcome !== "running") {
    return `状态文件结构不对：${at}.outcome 无法识别`;
  }
  if (!isStr(o.reason)) return `状态文件结构不对：${at}.reason 必须是字符串`;
  for (const k of ["due", "endedAt", "effort", "resetKey"]) {
    if (!isStrOrNull(o[k])) return `状态文件结构不对：${at}.${k} 必须是字符串或 null`;
  }
  // model 是改版新增字段：旧 state.json 的记录没有它，缺省按 null 加载，不得拒绝启动
  if (o.model !== undefined && !isStrOrNull(o.model)) {
    return `状态文件结构不对：${at}.model 必须是字符串或 null`;
  }
  if (o.ms !== null && typeof o.ms !== "number") {
    return `状态文件结构不对：${at}.ms 必须是数字或 null`;
  }
  return null;
}

/** 返回错误描述（中文、带位置）；null 表示结构完好 */
function validateState(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return "状态文件结构不对：顶层必须是 JSON 对象";
  }
  const o = v as Record<string, unknown>;
  if (o.version !== 1) {
    return `状态文件版本不认识：${JSON.stringify(o.version) ?? "缺失"}（本程序只支持版本 1）`;
  }
  if (!Array.isArray(o.tasks)) return "状态文件结构不对：tasks 必须是数组";
  for (let i = 0; i < o.tasks.length; i++) {
    const problem = checkTask(o.tasks[i], `tasks[${i}]`);
    if (problem) return problem;
  }
  if (!Array.isArray(o.runs)) return "状态文件结构不对：runs 必须是数组";
  for (let i = 0; i < o.runs.length; i++) {
    const problem = checkRun(o.runs[i], `runs[${i}]`);
    if (problem) return problem;
  }
  const marks = o.marks;
  if (typeof marks !== "object" || marks === null || Array.isArray(marks)) {
    return "状态文件结构不对：marks 必须是对象";
  }
  for (const [id, value] of Object.entries(marks)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `状态文件结构不对：marks.${id} 必须是对象`;
    }
    const m = value as Record<string, unknown>;
    if (!isStrOrNull(m.lastDue)) return `状态文件结构不对：marks.${id}.lastDue 必须是字符串或 null`;
    if (!Array.isArray(m.resetKeys) || m.resetKeys.some((k) => !isStr(k))) {
      return `状态文件结构不对：marks.${id}.resetKeys 必须是字符串数组`;
    }
  }
  return null;
}

/** 截断到上限：每任务最近 50 条 run、最近 20 个 resetKey，保持原有先后顺序 */
function truncateState(data: StateFile): void {
  const counts = new Map<string, number>();
  const kept: Run[] = [];
  for (let i = data.runs.length - 1; i >= 0; i--) {
    const r = data.runs[i];
    const n = (counts.get(r.taskId) ?? 0) + 1;
    counts.set(r.taskId, n);
    if (n <= RUNS_PER_TASK) kept.push(r);
  }
  data.runs = kept.reverse();
  for (const m of Object.values(data.marks)) {
    if (m.resetKeys.length > RESET_KEYS_PER_TASK) m.resetKeys = m.resetKeys.slice(-RESET_KEYS_PER_TASK);
  }
}

class StoreImpl implements Store {
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly data: StateFile,
    private readonly path: string,
  ) {}

  save(): Promise<void> {
    // 写入串行化，且 JSON.stringify 放进队列里执行：并发保存不会交错临时文件，
    // 后一次总是带走前一次已落进内存的改动（防写入丢失）；顺带截断，常驻进程内存不无界增长。
    // 注意没有 fsync：进程崩溃靠 rename 的原子性兜底，断电极端情况可能留下空/半截文件，
    // openStore 会拒绝启动并保留原样，由用户手动处理（已知边界，见包 README「数据在哪」）。
    const next = this.writing.then(async () => {
      truncateState(this.data);
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.writing = next.then(() => {}, () => {});
    return next;
  }
}

/**
 * 打开数据目录里的 state.json：没有就给全新状态；
 * JSON/version/结构任一损坏 → StoreError（含中文原因），原文件一个字节都不动。
 */
export async function openStore(dir: string): Promise<Store> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, STATE_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return new StoreImpl({ version: 1, tasks: [], runs: [], marks: {} }, path);
    }
    throw new StoreError(`状态文件读不出来：${errText(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StoreError(`状态文件不是合法的 JSON：${errText(e)}`);
  }
  const problem = validateState(parsed);
  if (problem) throw new StoreError(problem);
  const data = parsed as StateFile;
  for (const r of data.runs) {
    if (r.model === undefined) r.model = null;
  }
  truncateState(data);
  return new StoreImpl(data, path);
}

/**
 * 旧包（定时消息）的一次性数据迁移：新目录还没有 state.json 而旧目录有 → 把这一个文件
 * 复制过来（service.lock 属于旧目录的进程语义，绝不跟过来）。复制而非移动：旧文件保持
 * 原样，用户回退旧版也不丢数据；新目录已有 state.json 就什么都不做（哪怕它是坏的——
 * 坏文件该由 openStore 报给用户，不能被迁移悄悄盖掉）。条件本身保证了只做一次。
 */
export async function migrateLegacyState(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const statePath = join(dir, STATE_FILE);
  try {
    await readFile(statePath);
    return; // 新目录已有状态（含读不出权限问题的情形）：一律不动
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  const legacy = join(xdgConfigHome(env), "magpie", LEGACY_DIR_NAME, STATE_FILE);
  let raw: string;
  try {
    raw = await readFile(legacy, "utf8");
  } catch {
    return; // 没有旧数据：无事发生
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // 复制失败不挡启动：旧数据仍在原处，下次启动（state.json 仍缺）还有机会
  await writeFile(statePath, raw, { mode: 0o600 }).catch(() => {});
}

function parsePid(raw: string): number | null {
  const t = raw.trim();
  if (/^\d+$/.test(t)) return Number(t);
  try {
    const j = JSON.parse(t) as unknown;
    if (typeof j === "object" && j !== null && typeof (j as { pid?: unknown }).pid === "number") {
      return (j as { pid: number }).pid;
    }
  } catch {
    /* 不是 JSON 也正常，锁内容就是裸 pid 文本 */
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 说明进程存在但属于别人，同样算活着
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 只在自己仍是持有者时删除锁文件；锁已被别人接管/换内容时不动它 */
async function releaseLock(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  if (parsePid(raw) === process.pid) await unlink(path).catch(() => {});
}

export type LockResult = { ok: true; release: () => Promise<void> } | { ok: false; pid: number };

export interface AcquireLockOptions {
  /**
   * 锁冲突且 pid 存活时的二次确认：持有者是否真的在服务。
   * 容器/整机重启后 pid 会被无关进程复用，持久卷上的旧锁就成了假阳性——
   * 只有确认不过的才当陈旧锁接管；不传则维持原行为（pid 活着就算被占）。
   */
  confirmAlive?: (pid: number) => Promise<boolean> | boolean;
}

/**
 * 原子排他创建 service.lock（写入本进程 pid）：
 * - 已存在且持有者确认在服务 → {ok:false, pid}
 * - 已存在且 pid 确认不存在，或 pid 被复用但确认不过（持有者并未在服务）→ 接管（删旧文件重抢）
 * - 已存在但内容读不出/解析不了（活性不明）→ 不抢占，{ok:false, pid:0}
 */
export async function acquireLock(dir: string, opts: AcquireLockOptions = {}): Promise<LockResult> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, LOCK_FILE);
  // 上一次持有者在 writeFile 与 link 之间崩溃会留下 *.tmp 残骸，永不自清；入口顺带扫掉
  const leftovers = await readdir(dir).catch(() => [] as string[]);
  for (const name of leftovers) {
    if (/^service\.lock\.\d+\.[0-9a-f-]+\.tmp$/.test(name)) {
      await unlink(join(dir, name)).catch(() => {});
    }
  }
  for (let round = 0; round < 3; round++) {
    const tmp = join(dir, `${LOCK_FILE}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, String(process.pid), { mode: 0o600 });
    try {
      await link(tmp, path);
      await unlink(tmp).catch(() => {});
      return { ok: true, release: () => releaseLock(path) };
    } catch (e) {
      await unlink(tmp).catch(() => {});
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`无法创建单实例锁：${errText(e)}`);
      }
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      // 上一持有者刚好 release、锁文件已消失：回循环顶重抢，而不是误报「另一实例运行中」
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { ok: false, pid: 0 };
    }
    const pid = parsePid(raw);
    if (pid === null) return { ok: false, pid: 0 };
    if (pidAlive(pid)) {
      const confirmed = opts.confirmAlive ? await opts.confirmAlive(pid) : true;
      if (confirmed) return { ok: false, pid };
      // pid 被复用而持有者并未在服务：不认这把锁，落到下面的接管路径
    }
    try {
      await unlink(path);
    } catch {
      /* 可能刚被别人接管，下一轮重试 */
    }
  }
  throw new Error("单实例锁被占用且无法接管");
}
