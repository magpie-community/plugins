#!/usr/bin/env node
// 只检查安装文件和目录；不读取 auth.json、cookie、plugin-auth 或浏览器资料。
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _internal } from "../index.mjs"
const pluginDir = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."))
let missing = 0
const check = (present, description) => {
  console.log(`${present ? "✓" : "·"} ${description}：${present ? "文件存在" : "未找到"}`)
  if (!present) missing++
}
check(existsSync(join(pluginDir, "index.mjs")), "插件入口")
check(existsSync(_internal.cliPath()), "CLI 可执行文件（未执行）")
check(existsSync(_internal.authPath()), "CLI auth.json（未读取内容）")
check(existsSync(_internal.cachePath()), "CLI 模型目录（未验证内容）")
console.log("以上只验证文件存在；尚未验证登录有效、插件登记、模型可用或用量会话。")
console.log("在 Magpie 连接账号；缺少用量时使用「重新 SSO / 补采集用量会话」。")
console.log("本检查不联网，不运行 CLI，不修改任何文件。")
if (missing) process.exitCode = 1

