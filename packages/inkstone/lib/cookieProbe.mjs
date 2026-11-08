// #840/#847：非 Windows 的完成信号——轮询 profile 的 Cookies sqlite。
//
// Chrome/Chromium 把 cookie 存在 <profile>/Default/Cookies 的 sqlite 里；
// name 与 host_key 列是明文（value 才加密），所以判断「控制台会话写进来了」
// 不需要解密。
//
// **只认本次启动后新增的行**（#847 blocking 1）：keep_sign_in 默认开着，
// profile 里留着上次登录的 uaa-token 行；只查「有没有这一行」会让重登
// （页面不写新 cookie 时）在 0–1ms 内误判完成、提前关窗、随后 headless
// 读到旧 token。所以调用方先取基线（启动前该 cookie 的行元组集合），
// 之后只接受不在基线里、未过期、且 host_key 属于控制台域的行。
//
// 控制台写入时 Chrome 持有库锁，只读连接常失败——所以每次轮询**先拷贝再查**
// （拷到 profile 目录自己的 0700 里，不放系统 temp：那里是明文 cookie 副本）。
// 拷不到（文件锁住）就静默等下一轮——Chrome 大约每 30 秒把 cookie 写盘。
import { copyFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"

// Chromium 的时间是「自 1601-01-01 起的微秒」。Unix 毫秒 = 微秒/1000 - 11644473600000。
const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000
export const chromiumMicros = (unixMs = Date.now()) => (unixMs + CHROMIUM_EPOCH_OFFSET_MS) * 1000
const unixMsOf = (chromiumUs) => Number(chromiumUs) / 1000 - CHROMIUM_EPOCH_OFFSET_MS

/** host_key 是否属于 cookieDomain（`intern-ai.org.cn`）：精确、点前缀或子域。 */
export function hostMatches(hostKey, cookieDomain) {
  const h = String(hostKey ?? "")
    .replace(/^\./, "")
    .toLowerCase()
  const d = String(cookieDomain ?? "").toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

/** 一行的身份：Chrome 覆写 cookie 时保留 creation_utc、更新 last_update_utc。 */
const rowKey = (r) => `${r.host_key}\u0000${r.creation_utc}\u0000${r.last_update_utc}`

/**
 * 只读地读出 profile 的 Cookies 里所有行（拷贝一份再查，避免 Chrome 的写锁）。
 * 无库 / 锁住 / 非 sqlite / 无 sqlite 运行时时返回 []——调用方按「还没有」处理。
 */
export function cookieRows(profile, { sqliteOpen } = {}) {
  const db = join(profile, "Default", "Cookies")
  if (!existsSync(db)) return []
  const open = sqliteOpen ?? defaultSqliteOpen
  let tmp = ""
  try {
    // 0700 的 profile 目录内（N6）：明文 cookie 副本不落系统 temp
    tmp = join(profile, `.inkstone-cookie-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    copyFileSync(db, tmp)
    return open(tmp)
  } catch {
    return [] // 库锁住 / sqlite 不可用：当作还没写入，等下一轮
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
    }
  }
}

/**
 * 基线：启动登录窗口之前，`name` 且 host_key 属于 `domain` 的所有行元组。
 * 空 profile（首次登录）天然得到空集合。
 */
export function cookieBaseline(profile, name, domain, opts = {}) {
  const rows = cookieRows(profile, opts)
  return rows.filter((r) => r?.name === name && hostMatches(r.host_key, domain)).map(rowKey)
}

/**
 * 登录是否完成：存在一行 `name`（host_key 属于 domain）、未过期、且不在
 * baseline 里。`nowMs` 便于测试固定时间。
 */
export function profileHasNewCookie(profile, name, baseline = [], domain = "", { sqliteOpen, nowMs = Date.now() } = {}) {
  const seen = new Set(baseline)
  const now = nowMs
  return cookieRows(profile, { sqliteOpen }).some((r) => {
    if (r?.name !== name) return false
    if (!hostMatches(r.host_key, domain)) return false
    if (seen.has(rowKey(r))) return false // 启动前就在：旧会话，不算
    const expires = Number(r.expires_utc ?? 0)
    // 0 是会话 cookie（关窗即失效）——有效；有值的必须还没过期
    return !expires || unixMsOf(expires) > now
  })
}

/** 默认的 sqlite 打开器：bun:sqlite 只读，返回行对象。测试注入假实现。 */
function defaultSqliteOpen(dbPath) {
  // bun:sqlite 是内置模块，动态引（避免顶层 import 在无 sqlite 的构建上报错）
  const { Database } = require("bun:sqlite")
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query("SELECT host_key, name, creation_utc, last_update_utc, expires_utc FROM cookies").all()
  } finally {
    db.close()
  }
}
