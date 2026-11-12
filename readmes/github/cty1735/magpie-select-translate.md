# magpie 划词翻译（helper + magpie 插件）

选中文字 → 按热键 → 鼠标旁弹出浮窗，流式显示 magpie 网关的译文。
取词走「模拟 Ctrl+C + 全量剪贴板还原」，浮窗是纯 Win32 无焦点窗口，翻译走
`{gateway}/v1/chat/completions`（SSE、`temperature:0`、`reasoning_effort:low`）。

技术方案见 `docs/magpie-select-translate.md`、`docs/IMPLEMENTATION.md`；
测试方案与实测结果见 `docs/TEST-PLAN.md`。

## 环境要求

- Windows 10/11 x64
- Go 1.21+（编译用；产物是单文件 exe，无运行时依赖）
- 本机 magpie 在跑，网关默认 `http://127.0.0.1:3425`
- 不需要 WebView2 Runtime（浮窗不用它）

## 编译与安装

```powershell
# 只编译
go build -ldflags "-H windowsgui -s -w" -o bin\magpie-translate-helper.exe ./cmd/helper

# 编译 + 落地到 %LOCALAPPDATA%\magpie-translate + 写启动文件夹自启 + 立即启动
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# 卸载（停进程、删自启、删目录）
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

自启是启动文件夹里的 `start-magpie-translate.vbs`（CRLF，双击无黑框）。

## 用法

1. 在任意程序里选中文字（浏览器网页、记事本、Word、VS Code……）。
2. 按 `Alt+D`，浮窗在鼠标右下方出现，逐字出译文。
3. 浮窗可见时按 `Esc` 关闭；点「复制」把译文写进剪贴板。

`Windows Terminal` / `conhost` / 远程桌面 / 密码管理器 / 资源管理器默认在黑名单里
（Ctrl+C 在这些程序里有副作用），命中时浮窗只提示「该应用不支持划词取词」。

## 命令行参数

| 参数 | 说明 |
|---|---|
| `--port` | 本地 HTTP 端口，默认 3477；端口占用即视为已有实例，直接退出 |
| `--gateway` | magpie 网关地址，留空自动发现 |
| `--model` | 模型 id，留空用 `/v1/models` 的第一个 |
| `--target` | `zh` / `en` 强制目标语言，默认自动判定 |
| `--hotkey` | 全局热键，默认 `Alt+D`（支持 `Ctrl+Shift+T`、`Win+F12`） |
| `--blacklist` | 逗号分隔的进程名黑名单，覆盖默认值 |
| `--glossary-file` | 术语表，每行 `原文=译文`，拼进 user 消息尾部 |
| `--no-restore-clipboard` | 取词后不还原剪贴板（手滑时用来验证取词） |
| `--debug` | 日志带微秒 |
| `--version` | 版本号 |

## 每用户配置

`%LOCALAPPDATA%\magpie-translate\settings.json`（可用 `PUT /api/settings` 或 magpie 插件设置页改）：

```json
{
  "port": 3477,
  "gateway": "",
  "model": "",
  "target": "auto",
  "hotkey": "Alt+D",
  "trigger": "hotkey",
  "blacklist": "mstsc.exe,windowsterminal.exe,...",
  "glossaryFile": "",
  "restoreClipboard": true
}
```

改 `hotkey` / `port` 需要重启 helper；改 `model` / `target` / `blacklist` / `glossaryFile` 立即生效。

## 本地接口（只绑 127.0.0.1，校验 Host）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` | 探活，`{ok,version,port,gateway,hotkey}` |
| POST | `/api/translate` | `{text,target,model}` → `text/event-stream`：`data:{"delta":...}` … `data:{"done":{...}}`；出错 `data:{"error":{code,message}}` |
| GET | `/api/selection` | 触发一次取词（调试用） |
| GET/PUT | `/api/settings` | 读写配置 |
| POST | `/api/clipboard` | `{text}` 写剪贴板 |
| POST | `/api/hide` | 关闭浮窗 |

## magpie 插件

```powershell
magpie plugin add <仓库路径>\plugin
```

插件只做三件事：出现设置页（热键/模型/目标语言/术语表）、`server` 钩子探活并
`spawn` helper、helper 缺失时给出提示。**翻译逻辑不在插件里**，插件被禁用也不影响
helper 自启（启动文件夹独立）。

## 日志

`%LOCALAPPDATA%\magpie-translate\helper.log`：只记时间、事件、耗时、字数，
**不记原文**（`grep` 可自查）。

## 已知取舍

- 取词只有剪贴板法（UIA TextPattern 留到 v1.1）：Electron 应用（VS Code、QQ）里 UIA 也不一定可靠。
- 剪贴板只还原 HGLOBAL 型格式；复制图片后划词会丢图。
- `Esc` 关闭靠浮窗可见期临时挂的 LL 键盘钩子，个别安全软件可能报毒。
- 前端无「点击外部关闭」，只有 `Esc` 和 ✕ 按钮。
- 单次翻译上限 5000 字、超时 55s；超时/断流保留已收到的半截内容。
