# Magpie Prompt Hub

在 Magpie 侧栏里管理本机提示词：新建、编辑、分类、标签、收藏、搜索、一键复制，以及离线 JSON 备份的导出和合并导入。手动选择的浅色/深色主题会记住，也可随时恢复跟随 Magpie（脱离宿主时跟随系统）。

## 安装与加载

目标宿主为桌面版 Magpie。接口调研基线为 `v0.1.4685`；实际加载与验证使用 Windows Magpie `0.1.4424`。已实测范围是 Windows CLI 按目录加载、`magpie web` 的 Chromium 侧栏与 sandboxed iframe、服务端系统剪贴板、HTTP 导入导出和重启持久化；runtime 端口发现的最近一次复验在顶层 Chromium 沙箱页面完成。真实桌面 WebView2 窗口、沙箱内原生文件选择器、由界面按钮发起的复制，以及插件重载后的页面重连，仍未单独验收；`v0.1.4685` 只是调研基线，不是实测版本。

```sh
# 在插件目录中执行；Magpie 会按目录原地加载
magpie plugin add .
```

Windows 上 Magpie 可直接加载 WSL 中的插件目录（本次已在隔离配置中验证）：

```powershell
magpie plugin add \\wsl.localhost\<发行版>\home\<用户>\code\magpie-prompt-hub
```

也可以先把插件目录复制到 Windows 可见路径再添加。加载后打开 Magpie 侧栏的「插件」分组，进入「提示词仓库」。插件只注册一个页面和它的本地服务，不注册模型、网关钩子或遥测。

页面启动流程：`page/index.html` 通过 `_magpie/bridge.js` 取得主题。服务绑定成功后把实际端口、写入时间和心跳写到同目录的 `page/runtime.js`；启动页用同源脚本加载这个小文件（不 fetch 回环地址），只有心跳新鲜时才把 iframe 导航到实际端口。服务按 `port` 选项从首选端口开始尝试 10 个连续端口，因此首选端口被其他程序占用时页面仍能找到自己的服务；找不到时显示重试，而不会打开陌生服务。`runtime.js` 是运行时生成文件，不进入发布包。

## 开发

```sh
npm test        # node --test test/*.test.mjs
node dev.mjs    # 在普通浏览器中打开 http://127.0.0.1:3487/
```

零运行时依赖，使用 Node 兼容内置模块；Magpie 的 Bun 插件宿主可直接加载。`PORT` 环境变量可改开发端口。

## 数据与备份

- 数据文件：`$MAGPIE_PROMPT_HUB_DATA`，否则 `$XDG_CONFIG_HOME/magpie-prompt-hub`，否则 `~/.config/magpie-prompt-hub`；macOS 用 `~/Library/Application Support/magpie-prompt-hub`。Windows 上 `~` 为 `C:\Users\<用户>`，默认即 `C:\Users\<用户>\.config\magpie-prompt-hub`，与 Magpie 自己的 `.config\magpie` 相邻。
- 文件为 `prompts.json`，带 `schemaVersion`；每次保存先写同目录临时文件并原子替换，上一版保留为 `prompts.json.bak`。解析失败时停止读写，不覆盖原文件。
- 主题偏好单独保存在同目录的 `preferences.json`，只记录 `theme: null | "light" | "dark"`，不混入提示词数据。手动选择在重新打开页面、插件重新加载、本地服务重启或端口变化后恢复；`null` 表示跟随 Magpie，脱离宿主时跟随系统。快速跳转中提供“跟随 Magpie（或系统）主题”入口清除覆盖。一次保存未确认前再次切换会被忽略并提示正在保存，避免只存在于当前页面内存的选择在退出时丢失。写入失败会重新读取实际保存值再回退并提示；偏好文件损坏或版本不支持时读写均报错并保留原文件，不会把未保存的切换报告为已记住。
- 多个服务实例、开发入口或多个窗口共用数据目录时，用 `prompts.json.lock` 串行化写入，并在持有锁后重新读取最新文件再修改；写盘前校验完整最终状态，分类或提示词数量超限时写入失败并保留原文件。
- 导出：服务在 `~/Downloads`（可用 `MAGPIE_PROMPT_HUB_DOWNLOADS` 覆盖）创建 `magpie-prompt-hub-YYYYMMDD-HHmmss.json`，不覆盖已有文件。备份是明文 JSON。导出和导入共用 256 MiB 上限；超过上限的导出会失败且不写文件，避免生成无法恢复的备份。
- 导入：先校验版本、字段、ID 和分类引用，展示新增/跳过摘要，确认后按稳定 ID 合并；合并后的分类/提示词总数也会校验；重复导入同一备份不会重复新增。
- 容量：单条正文最多 2,000,000 个字符（按字符计），HTTP JSON 请求和剪贴板请求上限 16 MiB，覆盖 UTF-8/JSON 转义后的合法正文；导入/导出上限 256 MiB。

## 安全边界

- 服务只绑定 `127.0.0.1`，校验精确 `Host`，每次进程启动生成随机令牌；令牌只注入服务自己的 HTML，不放在 URL 或日志中。
- API 只接受无 `Origin`、`Origin: null`（沙箱 iframe）或服务自身源，处理预检；其他网页来源拒绝。主题偏好接口与其余 API 使用相同的 Host、Origin 和令牌校验，只接受 `null`、`light`、`dark`。
- 提示词正文按文本渲染；剪贴板通过系统工具以参数化进程和 stdin 写入，按退出码反馈；失败时界面提供可选中文本手动复制。
- 启动页只加载插件自身目录中的 `runtime.js`，该文件只含端口、实例标识和心跳时间，不含访问令牌；访问令牌仍只注入服务返回的 HTML。
- 核心流程离线，不发起外部网络请求。

## 已知限制

- 首版面向桌面窗口，不声明 `magpie.page.service`，因此 `magpie web` 的远程访问不在支持范围；同一台机器上的 `magpie web` 已验证。
- 主题在打开页面时随导航传入；宿主主题变化后仍需重新打开页面。手动浅色/深色选择会通过本地偏好恢复。
- 系统剪贴板依赖 `pbcopy`（macOS）、PowerShell（Windows）、`wl-copy` 或 `xclip`（Linux）；不可用时界面回退到手动复制。Windows 分支已通过服务端 API 实测，macOS/Linux 分支尚未实测；真实宿主中由界面按钮触发的复制尚未单独点击验收。
- Windows Magpie `0.1.4424` 已实测插件加载、`magpie web` 的 Chromium 侧栏页面、服务端系统剪贴板、HTTP 导入导出和重启持久化。真实桌面 WebView2 窗口、沙箱内原生文件选择器、插件重载后的页面重连尚未验收；`v0.1.4685` 是调研基线而非实测版本。
- 启动页依赖插件目录可写，以便服务生成 `page/runtime.js`；目录只读时启动页会显示重试。首选端口被占用时会改用后续端口，端口释放/插件重载后的自动重连只通过单元测试和隔离宿主启动日志验证，未做真实窗口的人工重连验收。

## 目录

```
index.mjs        宿主入口（OpenCode v1 的 export default { id, server }）
lib/             存储、校验、导入合并、剪贴板、HTTP 服务
page/            Magpie 启动页与图标；runtime.js 由服务在运行时生成
app/             本地服务提供的界面
test/            Node 内置测试运行器的测试
```

`docs/` 只保留本地调研与验证记录，不进入发布包。
