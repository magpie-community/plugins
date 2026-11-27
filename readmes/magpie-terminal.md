# magpie-terminal（终端）

在 [magpie](https://usemagpie.ai) 窗口里连 SSH 主机的终端，右侧配一个会说中文的 AI 命令助手。Windows / macOS / Linux 都能用。
A terminal for SSH hosts inside the magpie window, with a Chinese-speaking AI command assistant.

---

## 这是什么

magpie 侧栏多一页「终端」。先在「主机」里添加一台 SSH 主机，连上之后整页就是那台主机的终端：多标签、每个标签一条独立会话，右侧一栏用中文说需求就能拿到命令，只读命令自动跑、会改东西的命令弹确认卡。

**0.3.0 起不再提供本机终端。** 本机要当主机用，请自行在系统里装好 sshd，再作为一台普通主机添加进来。
产品形态参考 [github.com/chaterm/Chaterm](https://github.com/chaterm/Chaterm)，只借鉴「每步可审核」的交互，未移植任何代码。

## 功能

- **SSH 多主机管理**：保存主机（地址 / 端口 / 用户名 / 密码或私钥），列表里直接连；首次连接核对 SHA256 指纹，之后指纹变了会中止连接而不是默默接受。
- **多标签终端**：每条标签对应一台主机的一条 shell 通道，`vim`、`top` 这类全屏程序正常工作；关标签即关闭该通道。
- **AI 命令助手**（右侧抽屉）：说中文需求 → 结合当前目录与终端最近输出给出命令 → 只读命令自动执行，破坏性命令弹确认卡并用人话解释「要做什么 / 执行后会怎样」。
- **分级执行**：命令按安全等级分流——只读白名单自动跑，黑名单与灾难级命令永远要你点确认。白名单（用户自定义 + 内置只读清单）可在设置页查看、增删、改、一键恢复默认。
- **远程文件面板**：跟随当前会话的目录，浏览、查看、编辑、重命名、删除、上传、下载，支持单选/多选批量操作；一键定位回终端所在目录。
- **下载到本机**：主机上的文件可以下载到设置页指定的下载目录；没设目录时交给浏览器默认下载目录。
- **主题跟随 magpie**：深/浅色与强调色都用 magpie 下发的 token，不是自己写死的一套配色。
- **Markdown 渲染**：AI 回复按 Markdown 渲染（marked + DOMPurify 净化），不是原文照贴。
- **日志导出**：设置页可导出日志用于排查问题，日志只存本机，导出前自动去掉 token、密码与完整路径，不含你在终端里输入的内容。

## 安装

```bash
magpie plugin add magpie-terminal
magpie plugin list                 # 确认列表里出现 magpie-terminal
```

装完在 magpie 侧栏点「终端」图标进入，第一次会看到空态提示——先去「主机」面板加一台 SSH 主机。依赖随包安装，不需要本地编译。

### 三种安装方式

| 方式 | 命令 | 更新方式 |
|---|---|---|
| npm registry（推荐） | `magpie plugin add magpie-terminal` | `magpie plugin update` |
| GitHub 直装 | `magpie plugin add github:guofengli1214-cmd/magpie-terminal` | 重新 `add` 同一 spec |
| 本地目录（开发用） | `magpie plugin add /绝对路径/magpie-terminal` | `cd` 进去 `git pull`，再重启 magpie |

本地目录安装时设置页会写明「本地目录安装：在仓库里 `git pull` 后重启 magpie 即可」——插件自己**不会**发请求检查更新，因为它不知道你有没有拉过新代码。

registry 安装时设置页的「检查更新」会去问 GitHub Releases 看有没有新版本；GitHub 直装同理（仓库地址是同一个），但它不会随 `magpie plugin update` 自动升级，要重新 `add` 同一 spec。

### 从旧版本升级

**0.2.x → 0.3.0（破坏性）**：0.3.0 删掉了本机终端与本机文件面板，终端只能连 SSH 主机用。升级后：

1. 已有的主机条目、设置、白名单都保留；老配置里的 `defaultShell` 字段会被静默忽略，不用手工清理。
2. 以前靠「打开就有本机终端」用的，现在要先把想连的机器加成主机（本机也是：装好 sshd 再添加 `127.0.0.1`）。
3. 设置页「关于」里的版本应显示 `0.3.0`。

**0.1.x → 0.2.x 及更早**：旧版是从裸目录或单文件 `add` 进来的，插件标识可能与现在的包名不同，所以**不能只 `update`**，要走一遍「先摘干净、再按新方式装」：

1. 先记下现在是怎么装的：`magpie plugin list`，找到终端插件的 spec。
2. 移除旧条目：`magpie plugin rm magpie-terminal`。如果你的旧条目是裸路径而不是包名，`rm` 时就用那个名称/路径；同名有多条时 `rm` 一次只删一条，重复执行直到 `list` 里没有为止。
3. 按新方式装回去：`magpie plugin add magpie-terminal`（或上面表格里的另两种）。
4. **完全退出 magpie 再打开**——不是关窗口，是退出进程。旧进程还占着端口，会和新宿主冲突。

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

## 平台支持

| 平台 | 状态 |
|---|---|
| Windows 11 | 已实测：全量测试通过 |
| Linux（WSL Ubuntu） | 已实测：全量测试通过 |
| macOS | 未在本机实测，只做静态审查；由仓库自带的 GitHub Actions CI（三平台 × Node 20/22/24）覆盖 |

日志目录按平台标准位置落盘（`MAGPIE_TERMINAL_LOG_DIR` 可覆盖）：

| 平台 | 目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\magpie\logs`（没有 `LOCALAPPDATA` 时回落 `~/magpie/logs`） |
| macOS | `~/Library/Logs/magpie` |
| Linux | `$XDG_STATE_HOME/magpie/logs`，未设则为 `~/.local/state/magpie/logs` |

日志文件名 `show-terminal.log`，单文件超 2MB 轮转成 `.1`（只留一份）。

配置文件（主机、白名单、下载目录等）三平台一致，都在 `~/.config/magpie-terminal/config.json`；同目录下还有 `secrets.json`（主机凭据，加密存储）与 `known_hosts.json`（主机指纹）。

## 健康检查

- 插件页内：设置 → 日志，查看最近错误。
- 插件自己的日志：上面「平台支持」表里的目录，文件名 `show-terminal.log`。
- 宿主日志（Windows）：`%LOCALAPPDATA%\magpie\logs\app.log`，找这一行：

```
plugin: [magpie-terminal] listening on http://127.0.0.1:3480
```

没有这一行 = 服务没起来。有这一行但页面空白，见「常见故障」。macOS / Linux 的宿主日志位置见 magpie 自己的文档。

- 自检脚本：`node scripts/doctor.mjs`。

## 安全说明

一句话版：这个服务只给本机的这个窗口用，别的网页碰不到；AI 只能自动跑只读命令，会改东西的命令一定要你点「执行」。

展开说：

- **只听本地。** 服务绑定 `127.0.0.1:3480`，不监听 `0.0.0.0`。
- **每个请求都验 token 与 Host。** 进程启动时生成 32 字节随机 hex 写进页面，所有 `/api/*` 与 WebSocket 升级都要带，服务端用 `timingSafeEqual` 比对；`Host` 必须是 `127.0.0.1:3480` 或 `localhost:3480`（防 DNS 重绑定）；`Origin` 只接受 `undefined`、字面量 `"null"`（沙箱 iframe 的 opaque origin）或自身。所有 `/api` 失败一律 403（不返 401，401 会触发浏览器凭据弹窗）。
- **主机凭据加密落盘。** 密码与私钥不在 `config.json` 里，单独存 `secrets.json` 并用本地密钥加密；日志与导出都不含凭据。
- **只读命令自动跑。** 分级器按 `&& || ; |` 切段，每段命令头命中只读白名单才自动执行。
- **危险命令必须点确认。** 灾难级命令（提权、格式化、关机、删根/家目录、管道喂解释器、注册表删除…）永远人工确认；其余按 AI 审阅是否与对话意图一致裁决。
- **你手敲的命令直接执行。** 那是你自己的终端，不经过分级器——分级器只约束 AI 生成的命令。
- **密钥不落盘、不进日志。** SSH 凭据与服务 token 不入日志；日志导出前再跑一遍脱敏。

## 依赖

| 依赖 | 说明 |
|---|---|
| magpie | `>= 0.1.1340`（`package.json` 的 `engines.magpie`） |
| Node.js | `>= 20`（插件代码按 Node 20 的 API 面写） |

运行时依赖只有纯 JS 包（`ssh2`、`ws`、`zod`、`ai` / `@ai-sdk/openai-compatible`），**没有原生模块**：不需要 node-gyp、VS Build Tools，也不需要本地编译，三个平台装完即用。

不需要另外装 Bun：magpie 自己带。

## 文档

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | 进程/组件关系、关键时序、模块边界、关键设计决策 |
| `docs/platform-notes.md` | magpie 平台事实、页面插件机制、`package.json` 字段、`index.mjs` 契约、WebView2 故障专章、端口 |
| `docs/security.md` | 安全模型与威胁边界 |
| `docs/roadmap.md` | 排期与依赖 |
| `docs/dev-log/` | 开发过程记录归档（任务书、报告、验收记录），不是事实源 |

代码与文档冲突时，先改文档再改代码。

## 常见故障

**所有插件页同时报「此页面已停止工作」，magpie 自带页正常、宿主日志健康**
→ 是 WebView2 把沙箱 iframe 隔离成 OOPIF，跟本插件无关，别改插件文件也别重装插件。症状指纹、根因、规避命令与撤销方法见 `docs/platform-notes.md` 的「WebView2 已知故障」章节。

**打开是空态，没有终端**
→ 0.3.0 起终端只能连 SSH 主机用。点空态里的「添加主机」，或右上角「+」菜单里选一台已存的主机。

## 许可证

MIT，见 `LICENSE`。

产品形态参考 chaterm/Chaterm，未移植任何代码——因此不需要单独建 `NOTICE`，致谢只写在这一段。
