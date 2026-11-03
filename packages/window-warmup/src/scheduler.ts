// 调度器：任务的时间计算交给 rules，网关交互交给 gateway（可注入假件）。
// 并发模型：所有会改状态的入口（tick/upsert/remove/runNow）都过同一操作队列串行执行，
// 发送本体游离在队列外但登记在 inflight 里 —— 同一任务不重叠、删除/停用能等到收尾，
// 收尾写回前再查任务是否存在，杜绝「删除后异步完成把记录加回来」。
// 单个定时器，延迟 = min(最近到期 − now, 10 分钟)，每次醒来重算（抵御睡眠与改系统时间）。
import { randomUUID } from "node:crypto";
import { modelsForAccount, pinFor, pickAutoModel, windowsForAccount } from "./accounts";
import { fetchModels, fetchQuotas, modelProvider, pickEffort, refreshQuotaCard, send } from "./gateway";
import {
  readDefaultKeyDirectory,
  readDefaultModelCache,
  type CachedModel,
  type KeyDirectoryEntry,
} from "./magpie-files";
import { hourFloorISO, lastDue, nextDaily, nextEvery, upcoming, windowDue } from "./rules";
import type { Store, TaskMarks } from "./store";
import {
  errText,
  type QuotaEntry,
  type QuotaWindow,
  type RawModel,
  type Run,
  type SendResult,
  type Task,
} from "./types";

/** 单个定时器的最长睡眠：醒来重算，弥补系统睡眠/时钟跳变 */
const TIMER_CAP_MS = 600_000;
/** 窗口额度快照的刷新节奏：每 10 分钟及每次到期后 */
const QUOTA_REFRESH_MS = 600_000;
/**
 * 发送后多久的读数才算「开窗后」：厂商记账有延迟，刚发完立刻读可能仍是空闲。
 * 早于「上次发送 + 这段」的空闲读数不可信（见 staleIdle），发送后也按这个点去重读卡
 */
const POST_SEND_SETTLE_MS = 60_000;
/** 窗口到期要发送时，卡片读数超过这个年龄就先让 magpie 重读一次 */
const CARD_FRESH_MS = 60_000;
/** 同一张卡两次重读请求的最小间隔（magpie 侧另有 30 秒限频） */
const CARD_REFRESH_GAP_MS = 60_000;
const HOUR_MS = 3_600_000;
/** snapshot 时间轴只画未来 24 小时 */
const DAY_MS = 24 * HOUR_MS;

const INTERRUPTED_REASON = "Magpie 在发送中途退出，结果未知";
const OVERLAP_REASON = "上一次发送还没结束，本次跳过";
const DISABLED_REASON = "任务已停用，发送被取消";
const DELETED_REASON = "任务已删除，发送被取消";
/** HTTP 409：立即发送撞上正在进行的发送 */
export const CONFLICT_MESSAGE = "上一次发送还没结束，请稍后再试";
/** HTTP 404：任务不存在或已删除 */
export const NOT_FOUND_MESSAGE = "任务不存在";

export type SendFn = typeof send;
export type QuotasFn = typeof fetchQuotas;
export type RefreshCardFn = typeof refreshQuotaCard;
/** 取模型元数据；signal 在停用/删除时传入，中止进行中的请求（测试假件可不实现） */
export type ModelsFn = (base: string, signal?: AbortSignal) => Promise<RawModel[]>;
/** 读 providers.json 的 key 目录；null = 读不出（指纹账号按「≥2 把 key」处理） */
export type KeyDirFn = () => Promise<Map<string, KeyDirectoryEntry> | null>;
/** 读某供应商的模型缓存；null = 没有缓存文件 */
export type ModelCacheFn = (providerId: string) => Promise<CachedModel[] | null>;
/** 注册定时器，返回取消函数；测试注入假时钟时用它截取回调 */
export type TimerSetter = (fn: () => void, ms: number) => () => void;

/** 新建/全量更新的任务输入；id 缺省表示新建，档位永不入参（发送时现算） */
export type TaskInput = Omit<Task, "id" | "createdAt" | "updatedAt"> & { id?: string };

export interface SchedulerDeps {
  store: Store;
  /** Magpie 网关地址（gatewayBase 的产物） */
  base: string;
  now?: () => Date;
  setTimer?: TimerSetter;
  sendFn?: SendFn;
  quotasFn?: QuotasFn;
  refreshCardFn?: RefreshCardFn;
  modelsFn?: ModelsFn;
  /** key 目录与模型缓存的读取器；缺省与 /api/catalog 一样按默认位置读（readDefault*） */
  keyDirFn?: KeyDirFn;
  modelCacheFn?: ModelCacheFn;
}

export interface TimelinePoint {
  taskId: string;
  at: string;
}

/** snapshot() 的返回：页面状态的总览；window 任务的 next 依赖最新额度快照 */
export interface StateView {
  tasks: Task[];
  runs: Run[];
  /** taskId → 下一个执行点 ISO；停用任务为 null */
  next: Record<string, string | null>;
  /** 未来 24 小时内的计划点，按时间升序 */
  timeline: TimelinePoint[];
  /** 最近一次落盘失败的中文原因；成功保存后清除。非 null 时页面应提示「数据可能没保存」 */
  saveError: string | null;
}

type QuotaSnapshot = { at: Date; entries: QuotaEntry[] };
/** 窗口任务按当前快照算出的到期点与去重键 */
type WindowDue = { at: Date; resetKey: string };

interface Inflight {
  abort: AbortController;
  /** 停用/删除请求的取消标记；置位后收尾把记录改判 unknown */
  cancel: "disabled" | "deleted" | null;
  done: Promise<void>;
}

/** 白名单挑任务内容字段：档位等运行时字段永远进不了任务文件 */
function taskContent(input: TaskInput): Omit<Task, "id" | "createdAt" | "updatedAt"> {
  return {
    name: input.name,
    enabled: input.enabled,
    provider: input.provider,
    account: input.account,
    model: input.model,
    message: input.message,
    trigger: input.trigger,
  };
}

/** 一条刚开始的执行记录（running）；直接失败的记录在此基础上覆盖结果字段 */
function newRun(
  task: Task,
  at: Date,
  due: Date | null,
  source: Run["source"],
  resetKey: string | null,
): Run {
  return {
    id: randomUUID(),
    taskId: task.id,
    source,
    due: due?.toISOString() ?? null,
    startedAt: at.toISOString(),
    endedAt: null,
    outcome: "running",
    reason: "",
    effort: null,
    model: null,
    ms: null,
    resetKey,
  };
}

export class Scheduler {
  private readonly store: Store;
  private readonly base: string;
  private readonly nowFn: () => Date;
  private readonly setTimerFn: TimerSetter;
  private readonly sendFn: SendFn;
  private readonly quotasFn: QuotasFn;
  private readonly refreshCardFn: RefreshCardFn;
  private readonly modelsFn: ModelsFn;
  private readonly keyDirFn: KeyDirFn;
  private readonly modelCacheFn: ModelCacheFn;

  private started = false;
  /** 操作队列：串行执行所有改状态入口，前一个失败不阻塞后一个 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 游离的发送收尾，flush() 等它们 */
  private background: Promise<unknown>[] = [];
  private lastWrite: Promise<void> = Promise.resolve();
  private cancelTimer: (() => void) | null = null;
  /** 当前定时器为每个 daily/every 任务排的到期点；唤醒时与之比对区分 schedule/catchup */
  private armedFor = new Map<string, Date>();
  private inflight = new Map<string, Inflight>();
  private quota: QuotaSnapshot | null = null;
  /** key 目录的最近一次读取：窗口任务的账号→窗口映射（同步路径）要用 */
  private keyDirMap: Map<string, KeyDirectoryEntry> | null = null;
  /** 发送改变额度状态，或上次刷新失败 → 下一轮先刷新快照再判断 */
  private quotaStale = false;
  private quotaTried = false;
  /** 最近一次落盘失败的原始原因；成功保存后清除。snapshot().saveError 组合展示文案 */
  private saveError: string | null = null;
  /** 评估抛错的去重：taskId → 「小时|原因」，同一小时同一原因只记一条 */
  private lastErrKey = new Map<string, string>();
  /** 「供应商|账号」→ 上次请求重读该卡的时刻 */
  private lastCardRefresh = new Map<string, number>();

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.base = deps.base;
    this.nowFn = deps.now ?? (() => new Date());
    this.setTimerFn =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    this.sendFn = deps.sendFn ?? send;
    this.quotasFn = deps.quotasFn ?? fetchQuotas;
    this.refreshCardFn = deps.refreshCardFn ?? refreshQuotaCard;
    this.modelsFn = deps.modelsFn ?? fetchModels;
    // 缺省与 /api/catalog 读同一份 Magpie 文件；providers.json 损坏按「读不出」处理（null）
    this.keyDirFn = deps.keyDirFn ?? readDefaultKeyDirectory;
    this.modelCacheFn = deps.modelCacheFn ?? readDefaultModelCache;
  }

  /** 启动：把遗留的 running 记录改判 unknown，再排定时器。可重复调用 */
  start(): void {
    this.started = true;
    const now = this.nowFn();
    let dirty = false;
    for (const r of this.store.data.runs) {
      if (r.outcome === "running") {
        r.outcome = "unknown";
        r.reason = INTERRUPTED_REASON;
        r.endedAt = now.toISOString();
        dirty = true;
      }
    }
    if (dirty) void this.trackSave();
    this.rearm();
  }

  /** 停止排程（进行中的发送照常收尾记录） */
  stop(): void {
    this.started = false;
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.armedFor = new Map();
  }

  /** 新建或全量更新任务；进行中的发送遇 enabled→false 会被中止并改判 unknown */
  upsert(input: TaskInput): Promise<Task> {
    return this.queueOp(async () => {
      const now = this.nowFn();
      if (input.id) {
        const idx = this.store.data.tasks.findIndex((t) => t.id === input.id);
        if (idx < 0) throw new Error(NOT_FOUND_MESSAGE);
        const prev = this.store.data.tasks[idx];
        const next: Task = {
          id: prev.id,
          ...taskContent(input),
          createdAt: prev.createdAt,
          updatedAt: now.toISOString(),
        };
        this.store.data.tasks[idx] = next;
        const flight = this.inflight.get(next.id);
        if (prev.enabled && !next.enabled && flight && !flight.cancel) {
          flight.cancel = "disabled";
          flight.abort.abort();
          await flight.done;
        }
        await this.store.save();
        this.rearm();
        return next;
      }
      const task: Task = {
        id: randomUUID(),
        ...taskContent(input),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.store.data.tasks.push(task);
      this.store.data.marks[task.id] = { lastDue: null, resetKeys: [] };
      await this.store.save();
      this.rearm();
      return task;
    });
  }

  /** 删除任务、执行记录与 marks；进行中的发送先中止并等收尾 */
  async remove(id: string): Promise<void> {
    await this.queueOp(async () => {
      const exists = this.store.data.tasks.some((t) => t.id === id);
      const flight = this.inflight.get(id);
      if (!exists && !flight) throw new Error(NOT_FOUND_MESSAGE);
      if (flight) {
        flight.cancel = "deleted";
        flight.abort.abort();
        await flight.done;
      }
      this.store.data.tasks = this.store.data.tasks.filter((t) => t.id !== id);
      this.store.data.runs = this.store.data.runs.filter((r) => r.taskId !== id);
      delete this.store.data.marks[id];
      this.lastErrKey.delete(id);
      await this.store.save();
      this.rearm();
    });
  }

  /** 立即发送一次（source=manual），不动计划与 resetKey；正在发送时视为冲突抛错 */
  runNow(id: string): Promise<Run> {
    return this.queueOp(async () => {
      const task = this.store.data.tasks.find((t) => t.id === id);
      if (!task) throw new Error(NOT_FOUND_MESSAGE);
      if (this.inflight.has(id)) throw new Error(CONFLICT_MESSAGE);
      return this.fire(task, null, "manual", null);
    });
  }

  /** 页面状态总览（同步读，不发请求）；window 任务的 next 依赖已缓存的额度快照 */
  snapshot(): StateView {
    const now = this.nowFn();
    const next: Record<string, string | null> = {};
    const timeline: TimelinePoint[] = [];
    for (const task of this.store.data.tasks) {
      if (!task.enabled) {
        next[task.id] = null;
        continue;
      }
      // 与 tick/rearm 同策略：单个坏任务（如时区库变更后 state.json 里的旧时区失效）
      // 不能拖垮整页状态——否则 GET /api/state 500，用户连删除它的入口都没有。
      // 它的下次执行点置空、不进时间轴，失败本身由 tick 的评估记录
      const points: TimelinePoint[] = [];
      try {
        this.snapshotTask(task, now, next, points);
      } catch {
        next[task.id] = null;
        continue;
      }
      timeline.push(...points);
    }
    timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return {
      tasks: [...this.store.data.tasks],
      runs: [...this.store.data.runs],
      next,
      timeline,
      saveError: this.saveError === null ? null : `状态文件写不进去：${this.saveError}`,
    };
  }

  /** 单任务的下次执行点与 24 小时时间轴点；时区/规则抛错时由调用方兜成「无计划」 */
  private snapshotTask(
    task: Task,
    now: Date,
    next: Record<string, string | null>,
    points: TimelinePoint[],
  ): void {
    if (task.trigger.kind === "window") {
      const due = this.currentWindowDue(task, now);
      let at: Date | null = null;
      if (due && !this.tried(task, due)) {
        // 空闲窗口且本轮没发过：快照新鲜就立即发（调度器会在到点前先刷新快照），
        // 快照过期/缺失才按刷新节奏等下一轮——保存即符合条件不该再等 10 分钟
        if (due.at.getTime() > now.getTime()) at = due.at;
        else at = this.snapshotFresh(now) ? now : new Date(now.getTime() + QUOTA_REFRESH_MS);
      }
      next[task.id] = at ? at.toISOString() : null;
      if (at && at.getTime() > now.getTime() && at.getTime() <= now.getTime() + DAY_MS) {
        points.push({ taskId: task.id, at: at.toISOString() });
      }
    } else {
      const base = this.pendingFixedDue(task, now) ?? now;
      const at =
        task.trigger.kind === "daily" ? nextDaily(task.trigger, base) : nextEvery(task.trigger, base);
      next[task.id] = at.toISOString();
      for (const p of upcoming(task.trigger, now, 25)) {
        if (p.getTime() > now.getTime() + DAY_MS) break;
        points.push({ taskId: task.id, at: p.toISOString() });
      }
    }
  }

  /** 等待排队中的操作与发送收尾全部落盘（测试与优雅退出用） */
  async flush(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const bg = [...this.background];
      if (bg.length > 0) {
        // 有的发送（假件或极端网络）可能永不返回：等不动就先走
        await Promise.race([Promise.allSettled(bg), new Promise((r) => setTimeout(r, 0))]);
      }
      await this.chain.catch(() => {});
      await this.lastWrite;
      await new Promise((r) => setTimeout(r, 0));
      if (this.background.length === 0) {
        await this.chain.catch(() => {});
        await this.lastWrite;
        return;
      }
    }
  }

  private queueOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private track(p: Promise<unknown>): void {
    const wrapped = p.catch(() => {}).finally(() => {
      this.background = this.background.filter((x) => x !== wrapped);
    });
    this.background.push(wrapped);
  }

  /**
   * 落盘并如实上报本次成败（false = 失败）：调度内部不能吞掉保存错误——
   * 「发送前持久化成功」是发请求的前提，错误同时记入 saveError 供 snapshot 暴露。
   */
  private trackSave(): Promise<boolean> {
    const p = this.store.save().then(
      () => {
        this.saveError = null;
        return true;
      },
      (e) => {
        this.saveError = errText(e);
        return false;
      },
    );
    this.lastWrite = p.then(() => {});
    return p;
  }

  private marksOf(id: string): TaskMarks {
    let m = this.store.data.marks[id];
    if (!m) {
      m = { lastDue: null, resetKeys: [] };
      this.store.data.marks[id] = m;
    }
    return m;
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    const now = this.nowFn();
    const tasks = this.store.data.tasks;
    const hasWindow = tasks.some((t) => t.enabled && t.trigger.kind === "window");
    // 评估前先把快照刷到最新（refreshQuotas 对新鲜快照是空操作）：
    // 拿过期快照评估会在睡眠醒来、手动发送刚开窗之后，按旧的空闲窗口再发一次
    if (hasWindow) {
      await this.refreshQuotas();
      if (await this.readCards(now)) {
        this.quotaStale = true;
        await this.refreshQuotas();
      }
    }
    for (const task of [...tasks]) {
      if (!task.enabled) continue;
      try {
        if (task.trigger.kind === "window") await this.evaluateWindow(task, now);
        else await this.evaluateFixed(task, now);
      } catch (e) {
        // 单个任务评估出错不拖垮其他任务；同一小时同一原因只记一条，别每个 tick 刷屏
        const reason = `调度出错：${errText(e)}`;
        const key = `${hourFloorISO(now)}|${reason}`;
        if (this.lastErrKey.get(task.id) !== key) {
          this.lastErrKey.set(task.id, key);
          this.appendFailure(task, now, null, reason, null, "schedule");
        }
      }
    }
    if (hasWindow) await this.refreshQuotas(); // 到期后/每 10 分钟刷新，供下轮判断
    this.rearm();
  }

  /**
   * daily/every 任务已消费到哪一刻：上次执行的到期点与最后一次编辑取较晚者。
   * 只有严格晚于它的应到点才有效——编辑之前错过的点不补，已执行的点不重发。
   */
  private fixedConsumedUntil(task: Task): number {
    const last = this.store.data.marks[task.id]?.lastDue;
    const updated = new Date(task.updatedAt).getTime();
    return last ? Math.max(new Date(last).getTime(), updated) : updated;
  }

  /** daily/every 任务待补发的最近应到点（还没消费过）；没有为 null */
  private pendingFixedDue(task: Task, now: Date): Date | null {
    const recent = lastDue(task.trigger, now);
    return recent && recent.getTime() > this.fixedConsumedUntil(task) ? recent : null;
  }

  /** 评估 daily/every 任务：最近应到点若晚于上次执行且晚于 updatedAt，就发一次 */
  private async evaluateFixed(task: Task, now: Date): Promise<void> {
    const due = this.pendingFixedDue(task, now);
    if (!due) return;
    const armed = this.armedFor.get(task.id) ?? null;
    const source: Run["source"] =
      armed !== null && armed.getTime() === due.getTime() ? "schedule" : "catchup";
    await this.fire(task, due, source, null);
  }

  private async evaluateWindow(task: Task, now: Date): Promise<void> {
    // 拿不到窗口不记失败：额度卡时有时无（插件供应商的用量读取会瞬断、刚刷新时缓存
    // 短暂缺卡），按失败上报只会刷一屏红字。等下一轮刷新，页面上的账号/窗口下拉会
    // 显示当前实际有哪些；账号或窗口被永久删掉时，编辑区能看出来
    const due = this.currentWindowDue(task, now);
    if (!due || !this.windowReady(task, due, now)) return;
    const marks = this.marksOf(task.id);
    marks.resetKeys.push(due.resetKey);
    // 同一实际重置只花一次额度：把本次到期所在小时的 idle key 一并消费，
    // 免得缓存随后丢掉 resetsAt 时，同一小时里又被当成新的空闲事件发一次
    const companion = `idle:${hourFloorISO(due.at)}`;
    if (companion !== due.resetKey) marks.resetKeys.push(companion);
    this.quotaStale = true; // 发送改变额度状态，下一轮先刷新快照再判断
    await this.fire(task, due.at, "schedule", due.resetKey);
  }

  /** 这个 resetKey 已经尝试过（同一 resetKey 最多尝试一次，成功失败未知都算） */
  private tried(task: Task, due: WindowDue): boolean {
    return this.marksOf(task.id).resetKeys.includes(due.resetKey);
  }

  /** 已过 resetsAt+30s（或空闲立即到期）且本轮还没尝试过：该发了 */
  private windowReady(task: Task, due: WindowDue, now: Date): boolean {
    return due.at.getTime() <= now.getTime() && !this.tried(task, due);
  }

  /** 任务所选窗口在当前快照里的样子；无快照、没账号、额度里找不到账号/窗口都是 undefined */
  private quotaWindow(task: Task): QuotaWindow | undefined {
    if (task.trigger.kind !== "window" || !this.quota || !task.account) return undefined;
    const name = task.trigger.window;
    // 账号 → 窗口走统一账号列表：key 账号用指纹反查 key 名再匹配 ~keys 卡（accounts.ts 共用实现）
    const windows = windowsForAccount(task.provider, task.account, this.quota.entries, this.keyDirMap);
    return windows?.find((w) => w.name === name);
  }

  /**
   * 记下各窗口任务最近见到的重置时间（变了才落盘）：额度卡瞬断丢了 resetsAt 时，
   * currentWindowDue 靠它分辨真假空闲。额度快照或 key 目录一更新就要补记，新建/编辑任务后也要。
   */
  private recordResets(): void {
    let dirty = false;
    for (const task of this.store.data.tasks) {
      if (!task.enabled) continue;
      const raw = this.quotaWindow(task)?.resetsAt;
      if (!raw || Number.isNaN(new Date(raw).getTime())) continue;
      const mark = this.marksOf(task.id);
      if (mark.lastReset !== raw) {
        mark.lastReset = raw;
        dirty = true;
      }
    }
    if (dirty) void this.trackSave();
  }

  /**
   * 用当前快照判断窗口任务的到期点与去重键；null 表示这一轮当没数据，等下一轮刷新
   * （无快照、找不到账号或窗口、读数不可信）。纯计算，不改任何状态。
   */
  private currentWindowDue(task: Task, now: Date): WindowDue | null {
    const win = this.quotaWindow(task);
    if (!win || !this.quota) return null;
    const due = windowDue(win, this.quota.at);
    if ("error" in due) return null;
    // 空闲读数早于上次发送：那是发送前读的（magpie 只在路由请求那一刻读卡），当没数据，
    // 等 readCards 拿到发送后的读数再判断——否则跨整点 idle key 一变就会再发一次
    if (due.resetKey.startsWith("idle:") && this.staleIdle(task)) return null;
    const raw = win.resetsAt;
    if (raw && !Number.isNaN(new Date(raw).getTime())) {
      // 只要窗口带着可解析的 resetsAt，key 就用 resetsAt 本身：与重置发送同 key，消费过
      // 就绝不再发（刷新/跨小时/重启都一样），出现新 resetsAt 才是新事件；
      // truthy 但解析不了的 resetsAt 当缺失处理，保留按小时限频。
      return { at: due.at, resetKey: raw };
    }
    // resetsAt 缺失或解析不了——两种可能：真空闲（没开始/上一轮已过），或卡瞬断。
    // 之前见过且还没到的重置时间说明窗口其实在计时，这轮当没数据，静默等下一轮刷新；
    // 已消费过的未来 resetsAt 同理（重启后 lastReset 还没补上时兜一道）。
    // idle: 等非时间形态的 key 解析出 NaN，比较恒为假，不用单独排除
    const mark = this.marksOf(task.id);
    const isFuture = (iso: string | null | undefined): boolean =>
      !!iso && new Date(iso).getTime() > now.getTime();
    if (isFuture(mark.lastReset) || mark.resetKeys.some(isFuture)) return null;
    return due;
  }

  /** 任务账号的订阅卡（本机可重读的那种）；key 卡来自远程 magpie，返回 null */
  private loginCard(task: Task): QuotaEntry | null {
    return (
      this.quota?.entries.find(
        (q) => q.provider === task.provider && !q.viaKey && q.account === task.account,
      ) ?? null
    );
  }

  /** 窗口任务上次真正发出的收尾时刻（毫秒）；没有为 NaN */
  private lastSentMs(task: Task): number {
    const v = this.store.data.marks[task.id]?.lastSent;
    return v ? new Date(v).getTime() : NaN;
  }

  /** 卡片读数早于「上次发送 + 记账余量」；拿不到 readAt（旧版 magpie）时不设门槛 */
  private staleIdle(task: Task): boolean {
    const readAt = new Date(this.loginCard(task)?.readAt ?? "").getTime();
    const sent = this.lastSentMs(task);
    return Number.isFinite(readAt) && Number.isFinite(sent) && readAt < sent + POST_SEND_SETTLE_MS;
  }

  /**
   * 该重读的订阅卡让 magpie 现读一次，返回是否发起过。kept 缓存只在 magpie 路由请求那一刻
   * 更新（无托盘的 magpie web 平时不读卡），两种时机需要新读数：
   * - 窗口按当前快照到期、马上要发：读数超过 1 分钟就先重读，别按旧空闲白发；
   * - 发送已满记账余量、读数还早于那时：拿开窗后的 resetsAt，定时器才能精确排到重置点。
   * 重读失败不记失败：staleIdle 门槛兜着，下一轮再试
   */
  private async readCards(now: Date): Promise<boolean> {
    let asked = false;
    for (const task of this.store.data.tasks) {
      if (!task.enabled || task.trigger.kind !== "window") continue;
      const card = this.loginCard(task);
      if (!card) continue;
      const readAt = new Date(card.readAt ?? "").getTime();
      const settled = this.lastSentMs(task) + POST_SEND_SETTLE_MS;
      const afterSend = now.getTime() >= settled && readAt < settled;
      const due = this.currentWindowDue(task, now);
      // readAt 缺失时是 NaN，「足够新」比较为假，照样算需要重读
      const readFresh = now.getTime() - readAt <= CARD_FRESH_MS;
      const dueNow = due !== null && this.windowReady(task, due, now) && !readFresh;
      if (!afterSend && !dueNow) continue;
      const key = `${card.provider}|${card.account}`;
      const last = this.lastCardRefresh.get(key);
      if (last !== undefined && now.getTime() - last < CARD_REFRESH_GAP_MS) continue;
      this.lastCardRefresh.set(key, now.getTime());
      asked = true;
      await this.refreshCardFn(this.base, card.provider, card.account).catch(() => {});
    }
    return asked;
  }

  /** 额度快照是否新鲜：没过期且不是上次发送刚弄脏的 */
  private snapshotFresh(now: Date): boolean {
    return (
      this.quota !== null &&
      !this.quotaStale &&
      now.getTime() - this.quota.at.getTime() < QUOTA_REFRESH_MS
    );
  }

  private async refreshQuotas(): Promise<void> {
    const now = this.nowFn();
    const quotaFresh = this.snapshotFresh(now);
    // 快照还新鲜但 key 目录没读到（上轮失败）：也要再补读，指纹账号的窗口映射等着它
    if (quotaFresh && this.keyDirMap !== null) return;
    this.quotaTried = true;
    // key 目录与额度快照一起等完再返回：currentWindowDue 是同步路径，只等额度的话，
    // key 目录（真实文件 I/O）后到会让指纹账号在首轮误报「额度里没有账号」。
    // key 目录读失败保留旧值（可能仍是 null），不拿失败结果盖掉上一次的好数据
    const [keyDir, snap] = await Promise.all([
      this.keyDirFn().then(
        (m) => m,
        () => this.keyDirMap,
      ),
      quotaFresh
        ? Promise.resolve(this.quota)
        : this.quotasFn(this.base).catch(() => null),
    ]);
    this.keyDirMap = keyDir;
    if (snap) {
      this.quota = snap;
      this.quotaStale = false;
    } else if (!quotaFresh) {
      // 刷新失败保留旧快照，下个周期再试；额度读不到不值得记一条失败记录
      this.quotaStale = true;
    }
    this.recordResets();
  }

  /** 发送一次：先落盘 running 与 lastDue，再解析档位、调用 sendFn；收尾游离，返回 running 记录 */
  private async fire(
    task: Task,
    due: Date | null,
    source: Run["source"],
    resetKey: string | null,
  ): Promise<Run> {
    const now = this.nowFn();
    if (this.inflight.has(task.id)) {
      // 同一任务不重叠：本次到期点作废，但仍算已消费，避免反复记「跳过」
      if (due && task.trigger.kind !== "window") this.marksOf(task.id).lastDue = due.toISOString();
      return this.appendFailure(task, now, due, OVERLAP_REASON, resetKey, source);
    }
    if (due && task.trigger.kind !== "window") this.marksOf(task.id).lastDue = due.toISOString();
    const run = newRun(task, now, due, source, resetKey);
    this.store.data.runs.push(run);
    const abort = new AbortController();
    const entry: Inflight = { abort, cancel: null, done: Promise.resolve() };
    this.inflight.set(task.id, entry);
    const savedRunning = this.trackSave(); // 本次落盘的成败决定能不能发（见 sendAndFinalize）
    entry.done = this.sendAndFinalize(task, run, entry, savedRunning);
    this.track(entry.done);
    await savedRunning;
    return run;
  }

  /**
   * 发送前解析当次的账号头与模型（每次发送现取 /v1/models、key 目录与该供应商的模型缓存，
   * 配置变了下一次发送自动跟随）。固定模型只校验仍在 /v1/models，不校验账号权限（交给服务器）；
   * 自动模型按统一账号规则取该账号（或「自动选账号」）的可选模型列表现选。
   */
  private async resolveSend(
    task: Task,
    models: RawModel[],
  ): Promise<{ id: string; model: RawModel; pin: string | null } | { error: string }> {
    const [keyDir, cache] = await Promise.all([
      this.keyDirFn().catch(() => null),
      this.modelCacheFn(task.provider).catch(() => null),
    ]);
    const pin = pinFor(task.provider, task.account, keyDir, this.quota?.entries ?? []);
    if (task.model) {
      const model = models.find((m) => m.id === task.model);
      return model
        ? { id: task.model, model, pin }
        : { error: `模型 ${task.model} 已不在 Magpie 的模型列表里` };
    }
    const ids = models.filter((m) => modelProvider(m) === task.provider).map((m) => m.id);
    const list = modelsForAccount(task.provider, task.account, { models: ids, keyDir, cache }).list;
    if (list === null) {
      return { error: `供应商 ${task.provider} 还没有模型列表，无法自动选模型` };
    }
    if (list.length === 0) return { error: `账号 ${task.account || "自动"} 没有可用模型` };
    const chosen = pickAutoModel(list.map((id) => ({ id })));
    if (!chosen) return { error: `账号 ${task.account || "自动"} 没有可用模型` };
    const model = models.find((m) => m.id === chosen.id);
    // list 由第 3 层过滤过，一定还在 /v1/models 里；兜底防夹具不一致
    if (!model) return { error: `模型 ${chosen.id} 已不在 Magpie 的模型列表里` };
    return { id: chosen.id, model, pin };
  }

  private async sendAndFinalize(
    task: Task,
    run: Run,
    entry: Inflight,
    savedRunning: Promise<boolean>,
  ): Promise<void> {
    try {
      // 持久化是发送的前提：running 记录与已消费的 marks 没落盘就不发请求——
      // 否则进程一旦退出，磁盘上的到期点还没消费，重启会对同一点再发一次
      const persisted = await savedRunning;
      let effort: string | null = null;
      let result: SendResult;
      let sent = false;
      if (!persisted) {
        result = {
          outcome: "failed",
          reason: `状态文件写不进去，本次不发送：${this.saveError ?? "未知原因"}`,
          ms: 0,
        };
      } else {
        try {
          const models = await this.modelsFn(this.base, entry.abort.signal);
          const resolved = await this.resolveSend(task, models);
          if ("error" in resolved) {
            result = { outcome: "failed", reason: resolved.error, ms: 0 };
          } else {
            const pick = pickEffort(resolved.model);
            if ("error" in pick) {
              result = { outcome: "failed", reason: pick.error, ms: 0 };
            } else {
              effort = pick.send;
              run.model = resolved.id;
              sent = true;
              result = await this.sendFn(
                this.base,
                { id: task.id, model: resolved.id },
                resolved.pin,
                effort,
                entry.abort.signal,
              );
            }
          }
        } catch (e) {
          result = { outcome: "failed", reason: errText(e), ms: 0 };
        }
      }
      run.effort = effort;

      if (entry.cancel === "disabled") {
        run.outcome = "unknown";
        run.reason = DISABLED_REASON;
      } else if (entry.cancel === "deleted") {
        run.outcome = "unknown";
        run.reason = DELETED_REASON; // remove 随后会清掉它，进程若在这里崩掉也能对上账
      } else {
        run.outcome = result.outcome;
        run.reason = result.reason;
      }
      run.ms = result.ms;
      run.endedAt = this.nowFn().toISOString();
      // 收尾与删除竞态的最后一道闸：任务已不在就什么都不写
      if (!this.store.data.tasks.some((t) => t.id === task.id)) return;
      // 真正发出去（含结果未知）就算开过窗：此前的空闲读数作废，并排一次发送后的重读
      const opened = sent && !entry.cancel && result.outcome !== "failed" && task.trigger.kind === "window";
      if (opened) this.marksOf(task.id).lastSent = run.endedAt;
      await this.trackSave();
      if (opened) this.rearm();
    } finally {
      this.inflight.delete(task.id);
    }
  }

  private appendFailure(
    task: Task,
    at: Date,
    due: Date | null,
    reason: string,
    resetKey: string | null,
    source: Run["source"],
  ): Run {
    const run: Run = {
      ...newRun(task, at, due, source, resetKey),
      endedAt: at.toISOString(),
      outcome: "failed",
      reason,
      ms: 0,
    };
    this.store.data.runs.push(run);
    this.trackSave();
    return run;
  }

  /** 重排唯一定时器：延迟 = min(各任务最近到期 − now, 10 分钟)；窗口任务没算得出到期点时按刷新节奏回头 */
  private rearm(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.armedFor = new Map();
    if (!this.started) return;
    this.recordResets(); // 新建/编辑的窗口任务要赶在下一次额度刷新前记下当前重置点
    const now = this.nowFn();
    let minDelay = Infinity;
    for (const task of this.store.data.tasks) {
      if (!task.enabled) continue;
      if (task.trigger.kind === "window") {
        const settled = this.lastSentMs(task) + POST_SEND_SETTLE_MS;
        if (settled > now.getTime()) minDelay = Math.min(minDelay, settled - now.getTime());
        const due = this.currentWindowDue(task, now);
        if (due && due.at.getTime() > now.getTime()) {
          minDelay = Math.min(minDelay, due.at.getTime() - now.getTime());
        } else if (due && this.windowReady(task, due, now) && this.snapshotFresh(now)) {
          // 空闲窗口、本轮没发过、快照新鲜：立即唤醒去发（每小时最多一次，evaluateWindow 去重）。
          // 快照过期时不走这条——先等一轮刷新，拿新数据再决定，免得按旧快照白发
          minDelay = Math.min(minDelay, 0);
        } else {
          // 拿不到到期点（无快照/出错/刚发过）：按刷新节奏回头再看（从未取到过快照时尽快取一次）
          minDelay = Math.min(minDelay, this.quotaTried ? QUOTA_REFRESH_MS : 0);
        }
      } else {
        // 已执行点之后、编辑点之后的第一个到期点才有效，否则会围着作废点空转
        const base = new Date(this.fixedConsumedUntil(task));
        let due: Date;
        try {
          due =
            task.trigger.kind === "daily" ? nextDaily(task.trigger, base) : nextEvery(task.trigger, base);
        } catch {
          // 单个坏任务（如时区库变更）不能打断重排——整个定时器排不出来等于调度停摆；
          // 它的失败已由 tick 的评估记录，这里跳过即可
          continue;
        }
        if (due.getTime() > now.getTime()) {
          this.armedFor.set(task.id, due);
          minDelay = Math.min(minDelay, due.getTime() - now.getTime());
        } else {
          // 已过期的应到点（服务中断/睡眠）：立即唤醒去补发评估
          minDelay = Math.min(minDelay, 0);
        }
      }
    }
    if (Number.isFinite(minDelay)) {
      const delay = Math.min(Math.max(minDelay, 0), TIMER_CAP_MS);
      this.cancelTimer = this.setTimerFn(() => {
        void this.queueOp(() => this.tick()).catch(() => {});
      }, delay);
    }
  }
}
