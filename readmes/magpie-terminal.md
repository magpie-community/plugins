# magpie-terminal（终端）

在 [magpie](https://usemagpie.ai) 窗口里放一个真终端，右侧配一个会说中文的 AI 命令助手。
A real terminal inside the magpie window, with a Chinese-speaking AI command assistant.

---

## 这是什么

magpie 侧栏多一页「终端」，整页是一个真正的 TTY：多标签、每个标签独立 shell 与工作目录，右侧一栏用中文说需求就能拿到命令，只读命令自动跑、会改东西的命令弹确认卡。
产品形态参考 [github.com/chaterm/Chaterm](https://github.com/chaterm/Chaterm)，只借鉴「每步可审核」的交互，未移植任何代码。

## 功能

- **真 TTY**：基于 `node-pty`，`vim`、`top` 这类全屏程序正常工作。多标签，每个标签独立 shell 与 cwd。
- **终端自选**：自动探测本机可用的 shell（Git Bash、PowerShell、cmd、WSL 发行版…），按实际安装情况列出，不是写死的固定几项。
- **AI 命令助手**（右侧抽屉）：说中文需求 → 结合当前 cwd 与终端最近输出给出命令 → 只读命令自动执行，破坏性命令弹确认卡并用人话解释「要做什么 / 执行后会怎样」。
- **分级执行**：命令按安全等级分流——只读白名单自动跑，黑名单与灾难级命令永远要你点确认。白名单可在设置页查看、增删、改、一键恢复默认。
- **文件面板**：浏览终端当前目录，支持单选/多选，选中后批量移动、删除、下载；一键定位到终端所在文件夹。
- **远程主机**：保存 SSH 主机并在标签里连上去。
- **主题跟随 magpie**：深/浅色与强调色都用 magpie 下发的 token，不是自己写死的一套配色。
- **Markdown 渲染**：AI 回复按 Markdown 渲染（marked + DOMPurify 净化），不是原文照贴。
- **日志导出**：设置页可导出日志用于排查问题，日志只存本机，导出前自动去掉 token、密码与完整路径，不含你在终端里输入的内容。

## 安装

```bash
magpie plugin add magpie-terminal
magpie plugin list                 # 确认列表里出现 magpie-terminal
```

装完在 magpie 侧栏点「终端」图标进入。依赖随包安装，不需要本地编译。

### 三种安装方式

| 方式 | 命令 | 更新方式 |
|---|---|---|
| npm registry（推荐） | `magpie plugin add magpie-terminal` | `magpie plugin update` |
| GitHub 直装 | `magpie plugin add github:guofengli1214-cmd/magpie-terminal` | 重新 `add` 同一 spec |
| 本地目录（开发用） | `magpie plugin add /绝对路径/magpie-terminal` | `cd` 进去 `git pull`，再重启 magpie |

本地目录安装时设置页会写明「本地目录安装：在仓库里 `git pull` 后重启 magpie 即可」——插件自己**不会**发请求检查更新，因为它不知道你有没有拉过新代码。

registry 安装时设置页的「检查更新」会去问 GitHub Releases 看有没有新版本；GitHub 直装同理（仓库地址是同一个），但它不会随 `magpie plugin update` 自动升级，要重新 `add` 同一 spec。

### 从旧版本升级（0.1.x → 0.2.x）

旧版是从裸目录或单文件 `add` 进来的，插件标识可能与现在的包名不同，所以**不能只 `update`**，要走一遍「先摘干净、再按新方式装」：

1. 先记下现在是怎么装的：`magpie plugin list`，找到终端插件的 spec。
2. 移除旧条目：`magpie plugin rm magpie-terminal`。如果你的旧条目是裸路径而不是包名，`rm` 时就用那个名称/路径；同名有多条时 `rm` 一次只删一条，重复执行直到 `list` 里没有为止。
3. 按新方式装回去：`magpie plugin add magpie-terminal`（或上面表格里的另两种）。
4. **完全退出 magpie 再打开**——不是关窗口，是退出进程。旧进程还占着端口，会和新宿主冲突。
5. 打开终端面板确认能开出 shell；设置页「关于」里的版本应显示 `0.2.2`。

升级会丢掉正在运行的终端会话（magpie 的插件宿主机制决定，非本插件可控），有正在跑的命令先跑完再升。

### 更新

```bash
magpie plugin update               # 把每个插件升到最新版
```

`magpie plugin update` 只对 registry / npm 安装生效；本地目录安装请用 `git pull`；想知道自己装的是哪种，看设置页「关于」里的「安装方式」。

插件重启后终端会话会重建（这是 magpie 的插件宿主机制，非本插件控制）。

### 卸载

```bash
magpie plugin rm magpie-terminal
```

### 端口

默认 `3480`（`3425` 网关、`3477` page-chat、`3488` agent-console、`3496` model-quota 已占用）。

改端口有两条途径，两处必须改成同一个值：

1. 编辑 `package.json` 的 `magpie.options.port`（`magpie.page.service.port` 要一致）；
2. 已装好的插件用 `magpie plugin options` 改选项，不必重新 `add`。

改完要完全退出 magpie 再打开：旧进程还占着 3480 时新服务绑不上端口。

## 健康检查

- 插件页内：设置 → 日志，查看最近错误。
- 宿主日志：`%LOCALAPPDATA%\magpie\logs\app.log`，找这一行：

```
plugin: [magpie-terminal] listening on http://127.0.0.1:3480
```

没有这一行 = 服务没起来。有这一行但页面空白，见「常见故障」。

- 自检脚本：`node scripts/doctor.mjs`。

## 安全说明

一句话版：这个服务只给本机的这个窗口用，别的网页碰不到；AI 只能自动跑只读命令，会改东西的命令一定要你点「执行」。

展开说：

- **只听本地。** 服务绑定 `127.0.0.1:3480`，不监听 `0.0.0.0`。
- **每个请求都验 token 与 Host。** 进程启动时生成 32 字节随机 hex 写进页面，所有 `/api/*` 与 WebSocket 升级都要带，服务端用 `timingSafeEqual` 比对；`Host` 必须是 `127.0.0.1:3480` 或 `localhost:3480`（防 DNS 重绑定）；`Origin` 只接受 `undefined`、字面量 `"null"`（沙箱 iframe 的 opaque origin）或自身。所有 `/api` 失败一律 403（不返 401，401 会触发浏览器凭据弹窗）。
- **只读命令自动跑。** 分级器按 `&& || ; |` 切段，每段命令头命中只读白名单才自动执行。
- **危险命令必须点确认。** 灾难级命令（提权、格式化、关机、删根/家目录、管道喂解释器、注册表删除…）永远人工确认；其余按 AI 审阅是否与对话意图一致裁决。
- **你手敲的命令直接执行。** 那是你自己的终端，不经过分级器——分级器只约束 AI 生成的命令。
- **密钥不落盘、不进日志。** SSH 凭据与服务 token 不入日志；日志导出前再跑一遍脱敏。

## 依赖

| 依赖 | 说明 |
|---|---|
| magpie | `>= 0.1.1340`（`package.json` 的 `engines.magpie`） |
| Node.js | `>= 20`（插件代码按 Node 20 的 API 面写） |
| node-pty | `1.2.0-beta.15`，随 `npm install` 装到插件自己的 `node_modules`，带各平台预编译二进制，不需要 node-gyp / VS Build Tools |

不需要另外装 Bun：magpie 自己带。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 进程/组件关系、关键时序、模块边界、关键设计决策 |
| `docs/platform-notes.md` | magpie 平台事实、页面插件机制、`package.json` 字段、`index.mjs` 契约、WebView2 故障专章、端口 |
| `docs/security.md` | 安全模型与威胁边界 |
| `docs/pty-notes.md` | node-pty 实测记录与必修坑 |
| `docs/roadmap.md` | 排期与依赖 |
| `docs/dev-log/` | 开发过程记录归档（任务书、报告、验收记录），不是事实源 |

代码与文档冲突时，先改文档再改代码。

## 常见故障

**所有插件页同时报「此页面已停止工作」，magpie 自带页正常、宿主日志健康**
→ 是 WebView2 把沙箱 iframe 隔离成 OOPIF，跟本插件无关，别改插件文件也别重装插件。症状指纹、根因、规避命令与撤销方法见 `docs/platform-notes.md` 的「WebView2 已知故障」章节。

## 许可证

MIT，见 `LICENSE`。

产品形态参考 chaterm/Chaterm，未移植任何代码——因此不需要单独建 `NOTICE`，致谢只写在这一段。
