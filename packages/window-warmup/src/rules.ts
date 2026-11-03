// 纯规则：时间推算、窗口到期与任务校验。页面（web/app.ts）也直接打包本模块，
// 因此这里只许依赖 types，不能引入任何 node:* 或网关模块。
import type { QuotaWindow, Task, Trigger } from "./types";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** 额度重置宽限：到期点取 resetsAt + 30s，确保 Magpie 侧已完成重置 */
export const RESET_GRACE_MS = 30_000;
/** 预热消息固定为 hi：探活用，不可配置（页面与校验都不再收自定义消息） */
export const WARMUP_MESSAGE = "hi";
/** 补发判断向前回看 48 小时：跨夏令时的日间隔最多 25 小时，足以覆盖最近一个应到点 */
const LAST_DUE_LOOKBACK_MS = 48 * HOUR_MS;
/** 名称的长度上限按 Unicode 码点计，页面校验共用同一个值 */
export const NAME_MAX = 40;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // h23 避免 "24:xx" 式午夜；en-US 保证 formatToParts 字段稳定
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallOf(t: Date, timeZone: string): Wall {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(t)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute };
}

/** 时区偏移（毫秒，东正西负）。秒级截断，避免子秒噪声 */
export function offsetMs(t: Date, timeZone: string): number {
  const sec = Math.floor(t.getTime() / 1000) * 1000;
  const w = wallOf(new Date(sec), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, sec / 1000 % 60) - sec;
}

function sameWall(w: Wall, y: number, mo: number, d: number, hh: number, mm: number): boolean {
  return w.year === y && w.month === mo && w.day === d && w.hour === hh && w.minute === mm;
}

/**
 * 把某日期的墙上时刻（y-mo-d hh:mm）换算为 UTC 瞬间：
 * - 正常：唯一实例（回拨日取较早一次）
 * - 春令时被跳过：返回偏移跳变后的第一个有效时刻
 */
function resolveWallTime(y: number, mo: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  // 先按 guess 点的偏移猜 UTC，再用猜测点的偏移修正一次； 高偏移时区（如 UTC+13/14）会落到相邻日期，按日差平移
  let t = guess - offsetMs(new Date(guess), timeZone);
  t = guess - offsetMs(new Date(t), timeZone);
  for (let i = 0; i < 4; i++) {
    const w = wallOf(new Date(t), timeZone);
    if (sameWall(w, y, mo, d, hh, mm)) {
      return earliestInstanceOf(guess, t, y, mo, d, hh, mm, timeZone);
    }
    if (w.hour === hh && w.minute === mm) {
      t += Date.UTC(y, mo - 1, d) - Date.UTC(w.year, w.month - 1, w.day);
      continue;
    }
    // 墙上时刻不存在：在两个探测点之间二分找偏移跳变，跳变瞬间即跳变后第一个有效时刻
    const probe = guess - offsetMs(new Date(t), timeZone);
    let lo = Math.min(t, probe);
    const loOffset = offsetMs(new Date(lo), timeZone);
    let hi = Math.max(t, probe);
    if (offsetMs(new Date(hi), timeZone) === loOffset) return new Date(t);
    // 二分到 1ms：到期点必须精确落在跳变边界上，提前停会留下 ≤999ms 的漂移
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetMs(new Date(mid), timeZone) === loOffset) lo = mid;
      else hi = mid;
    }
    return new Date(hi);
  }
  return new Date(t);
}

/** 命中的实例若紧跟在回拨之后，可能是较晚的重复实例：向前探测偏移下降，换回较早一次 */
function earliestInstanceOf(
  guess: number, t: number, y: number, mo: number, d: number,
  hh: number, mm: number, timeZone: string,
): Date {
  const at = new Date(t);
  const oAt = offsetMs(at, timeZone);
  const back = t - 3 * HOUR_MS - MINUTE_MS;
  if (offsetMs(new Date(back), timeZone) === oAt) return at;
  let lo = back;
  let hi = t;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMs(new Date(mid), timeZone) === oAt) hi = mid;
    else lo = mid;
  }
  const oBefore = offsetMs(new Date(lo), timeZone);
  if (oBefore <= oAt) return at;
  const earlier = guess - oBefore;
  return sameWall(wallOf(new Date(earlier), timeZone), y, mo, d, hh, mm) ? new Date(earlier) : at;
}

/**
 * 该日期内目标墙上时刻的全部出现（升序）：被跳过时是 [跳变后首个有效时刻]，
 * 回拨日落在重复区间时是 [较早实例, 较晚实例]。
 */
function occurrencesOnDay(
  y: number, mo: number, d: number, hh: number, mm: number, timeZone: string,
): Date[] {
  const first = resolveWallTime(y, mo, d, hh, mm, timeZone);
  const out = [first];
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const oAt = offsetMs(first, timeZone);
  const probeEnd = first.getTime() + 3 * HOUR_MS + MINUTE_MS;
  if (offsetMs(new Date(probeEnd), timeZone) === oAt) return out;
  let lo = first.getTime();
  let hi = probeEnd;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMs(new Date(mid), timeZone) === oAt) lo = mid;
    else hi = mid;
  }
  const oAfter = offsetMs(new Date(hi), timeZone);
  if (oAfter >= oAt) return out;
  const second = guess - oAfter;
  if (second > first.getTime() && sameWall(wallOf(new Date(second), timeZone), y, mo, d, hh, mm)) {
    out.push(new Date(second));
  }
  return out;
}

function nextCalDay(y: number, mo: number, d: number): [number, number, number] {
  const t = new Date(Date.UTC(y, mo - 1, d + 1));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

export function nextDaily(t: { time: string; timeZone: string }, after: Date): Date {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t.time);
  if (!m) throw new Error("时间需为 24 小时制的 HH:MM");
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const start = wallOf(after, t.timeZone);
  let y = start.year;
  let mo = start.month;
  let d = start.day;
  for (let i = 0; i < 400; i++) {
    for (const occ of occurrencesOnDay(y, mo, d, hh, mm, t.timeZone)) {
      if (occ.getTime() > after.getTime()) return occ;
    }
    [y, mo, d] = nextCalDay(y, mo, d);
  }
  throw new Error("无法计算下一次执行时间");
}

export function nextEvery(t: { hours: number; anchor: string }, after: Date): Date {
  const anchor = new Date(t.anchor).getTime();
  if (Number.isNaN(anchor)) throw new Error("起点时间无法识别");
  // step 要做除数：hours<=0 会算出 Infinity/NaN 点，未校验来源一律拒绝
  if (!Number.isFinite(t.hours) || t.hours <= 0) throw new Error("间隔小时数必须为正数");
  if (after.getTime() < anchor) return new Date(anchor);
  const step = t.hours * HOUR_MS;
  // 到期点为 anchor + k·step（k 从 0 起），取第一个严格晚于 after 的点
  const k = Math.floor((after.getTime() - anchor) / step) + 1;
  return new Date(anchor + k * step);
}

export function lastDue(trigger: Trigger, before: Date): Date | null {
  if (trigger.kind === "window") return null;
  if (trigger.kind === "every") {
    const anchor = new Date(trigger.anchor).getTime();
    if (Number.isNaN(anchor) || before.getTime() < anchor) return null;
    if (!Number.isFinite(trigger.hours) || trigger.hours <= 0) return null;
    const step = trigger.hours * HOUR_MS;
    const k = Math.floor((before.getTime() - anchor) / step);
    return new Date(anchor + k * step);
  }
  // daily：从 48 小时前起顺序推进，收集 (before-48h, before] 内最后一个应到点
  let best: Date | null = null;
  let cursor = nextDaily(trigger, new Date(before.getTime() - LAST_DUE_LOOKBACK_MS));
  for (let i = 0; i < 6 && cursor.getTime() <= before.getTime(); i++) {
    best = cursor;
    cursor = nextDaily(trigger, cursor);
  }
  return best;
}

/** 快照时刻按小时取整的 ISO 形态：窗口 idle key 与调度器的 missing key 共用同一粒度 */
export function hourFloorISO(at: Date): string {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS).toISOString();
}

export function windowDue(
  win: QuotaWindow | undefined,
  snapshotAt: Date,
): { at: Date; resetKey: string } | { error: string } {
  if (!win) return { error: "账号的额度里没有这个窗口" };
  if (win.resetsAt) {
    const resetsAt = new Date(win.resetsAt);
    if (!Number.isNaN(resetsAt.getTime()) && resetsAt.getTime() > snapshotAt.getTime()) {
      return { at: new Date(resetsAt.getTime() + RESET_GRACE_MS), resetKey: win.resetsAt };
    }
  }
  // 空闲窗口立即到期；resetKey 按快照所在小时取整，保证同一小时内不会反复尝试
  return { at: new Date(snapshotAt.getTime()), resetKey: `idle:${hourFloorISO(snapshotAt)}` };
}

export function upcoming(trigger: Trigger, now: Date, n: number): Date[] {
  // 窗口触发的到期点依赖额度快照（resetsAt），调度层单独计算，几何推算不适用
  if (trigger.kind === "window") return [];
  const out: Date[] = [];
  let cursor = new Date(now.getTime());
  for (let i = 0; i < n; i++) {
    cursor = trigger.kind === "daily" ? nextDaily(trigger, cursor) : nextEvery(trigger, cursor);
    out.push(cursor);
  }
  return out;
}

function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateTask(
  input: unknown,
  now: Date,
): { task: Omit<Task, "id" | "createdAt" | "updatedAt"> } | { error: string; field: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "请求体必须是 JSON 对象", field: "body" };
  }
  const raw = input as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { error: "给任务起个名字", field: "name" };
  if ([...name].length > NAME_MAX) return { error: `名称不能超过 ${NAME_MAX} 字`, field: "name" };

  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  if (!provider) return { error: "必须选择供应商", field: "provider" };

  // "" 表示自动选模型：每次发送前由调度器按 pickAutoModel 现算，这里只拦路由组
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (model.startsWith("group/")) return { error: "不支持路由组模型", field: "model" };

  // 消息固定 hi（探活）：入参里的 message 忽略，字段只为旧数据兼容保留
  const message = WARMUP_MESSAGE;

  let enabled = true;
  if (raw.enabled !== undefined && raw.enabled !== null) {
    if (typeof raw.enabled !== "boolean") return { error: "启用状态必须是布尔值", field: "enabled" };
    enabled = raw.enabled;
  }

  let account = "";
  if (raw.account !== undefined && raw.account !== null) {
    if (typeof raw.account !== "string") return { error: "账号标识必须是文本", field: "account" };
    account = raw.account.trim();
  }
  // 账号必选：预热是发给具体账号/key 的，交给网关自动选就没有稳定的去重与窗口归属
  if (!account) return { error: "必须选择账号", field: "account" };

  const trig = raw.trigger;
  if (typeof trig !== "object" || trig === null || Array.isArray(trig)) {
    return { error: "缺少触发方式", field: "trigger" };
  }
  const tv = trig as Record<string, unknown>;
  let trigger: Trigger;
  switch (tv.kind) {
    case "window": {
      const win = typeof tv.window === "string" ? tv.window.trim() : "";
      if (!win) return { error: "必须填写额度窗口名", field: "window" };
      trigger = { kind: "window", window: win };
      break;
    }
    case "daily": {
      const time = typeof tv.time === "string" ? tv.time : "";
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        return { error: "时间需为 24 小时制的 HH:MM", field: "time" };
      }
      const timeZone = typeof tv.timeZone === "string" ? tv.timeZone : "";
      if (!isValidTimeZone(timeZone)) return { error: "无法识别的时区", field: "timeZone" };
      trigger = { kind: "daily", time, timeZone };
      break;
    }
    case "every": {
      const hours = tv.hours;
      if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 1 || hours > 168) {
        return { error: "间隔需为 1–168 小时", field: "hours" };
      }
      let anchor: string;
      if (tv.anchor === undefined || tv.anchor === null || tv.anchor === "") {
        anchor = new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS).toISOString();
      } else {
        if (typeof tv.anchor !== "string") return { error: "起点时间无法识别", field: "anchor" };
        const a = new Date(tv.anchor);
        if (Number.isNaN(a.getTime())) return { error: "起点时间无法识别", field: "anchor" };
        anchor = a.toISOString();
      }
      trigger = { kind: "every", hours, anchor };
      break;
    }
    default:
      return { error: "触发方式必须是 window、daily 或 every", field: "trigger" };
  }

  return { task: { name, enabled, provider, account, model, message, trigger } };
}
