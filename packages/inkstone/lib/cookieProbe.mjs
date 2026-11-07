// #840 之①：非 Windows 的完成信号——轮询 profile 的 Cookies sqlite。
//
// Chrome/Chromium 把 cookie 存在 <profile>/Default/Cookies 的 sqlite 里；
// name 列是明文（value 才加密），所以「有没有 uaa-token 行」不需要解密。
// 控制台写入时 Chrome 持有库锁，只读连接常失败——所以每次轮询**先拷贝到
// 临时文件再查**，拷不到（文件锁住）就静默等下一轮。
//
// 与 waitForConsoleWindow 的关系：Windows 继续用窗口标题；非 Windows 在原
// 「只认进程退出」之上加这个信号——登录完成即自动关窗（不再要求 Cmd+Q），
// 关不掉时用户照旧可以自己关（进程退出仍算结束）。轮询器由参数注入，
// 生产路径传真的实现，测试传假实现。
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * 只读地查 profile 的 Cookies 里有没有 `name === cookieName` 的行。
 * 先拷贝（Chrome 锁库时只读连接大概率失败），拷不动或查不动都算「还没有」。
 */
export function profileHasCookie(profile, cookieName, { sqliteOpen } = {}) {
  const db = join(profile, "Default", "Cookies")
  if (!existsSync(db)) return false
  const open = sqliteOpen ?? defaultSqliteOpen
  let tmp = ""
  try {
    tmp = join(tmpdir(), `inkstone-cookie-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    copyFileSync(db, tmp)
    return open(tmp).some((row) => row?.name === cookieName)
  } catch {
    return false // 库锁住 / sqlite 不可用：当作还没写入，等下一轮
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { force: true })
      } catch {}
    }
  }
}

/** 默认的 sqlite 打开器：bun:sqlite 只读，返回 [{name}]。测试注入假实现。 */
function defaultSqliteOpen(dbPath) {
  // bun:sqlite 是内置模块，动态引（避免顶层 import 在无 sqlite 的构建上报错）
  const { Database } = require("bun:sqlite")
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query("SELECT name FROM cookies").all()
  } finally {
    db.close()
  }
}
