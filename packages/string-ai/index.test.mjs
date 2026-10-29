import { test } from "bun:test"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// 使用当前运行时启动隔离进程，避免 mock fetch 及其它测试的 PATH 改动相互污染。
test("String AI 登录、密钥同步、路由和余额回归", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("./test.mjs", import.meta.url))], { stdio: "pipe", timeout: 25_000 })
}, 30_000)
