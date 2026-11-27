#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
const userDir = join(appData, "qianfan-desktop-app")
const authPath = resolve(process.argv[2] || join(userDir, "auth.json"))
const keyPath = resolve(process.argv[3] || join(userDir, ".cookie-key"))
const outPath = resolve(process.argv[4] || join(process.cwd(), "dumate-import.json"))

const authJson = readFileSync(authPath, "utf8")
const cookieKey = readFileSync(keyPath).toString("base64")
writeFileSync(outPath, JSON.stringify({ authJson, cookieKey }, null, 2) + "\n", { mode: 0o600 })

console.log(`wrote ${outPath}`)
console.log("在 Magpie 的“从文件导入账号…”里选择这个 JSON 文件")
