# 会话守护 · Session guard

magpie 的一个页面插件：盯住 **Codex 桌面端**的登录态文件，在你被登出、侧边栏项目全空的时候，一键把项目与会话归属还回去；顺便把 codex 的 5 小时 / 7 天额度、各家供应商、当前路由摆在同一页。

> **English** — A page plugin for magpie that watches **Codex desktop's** account-state file. Signing out rewrites `.codex/.codex-global-state.json` as an anonymous copy with no projects, so the sidebar shows nothing even though no conversation was deleted; this page tells which state the file is in, snapshots it, and restores it in one click (or by itself every 20 seconds). It also shows the codex account's 5-hour and 7-day windows, every provider's accounts and windows, and the routing in effect.

## 它解决的问题

Codex 把「项目」和「会话归属」写在 `.codex/.codex-global-state.json`，而且**按登录态分两份**：

| 状态 | 顶层键 | 项目 | 会话归属 |
| --- | --- | --- | --- |
| 已登录（健康） | 43 左右 | 14 | 500+ |
| 已登出（匿名） | 25~27 | 0 | 0 |

一旦登出，Codex 会把这份文件（连 `.bak` 一起）改写成没有项目的匿名版，于是侧边栏只剩散落的会话、项目分组全空——**会话数据本身从没被删**。本页面判断当前是哪种状态，并提供快照与恢复。

## 页面里有什么

- **顶部**：状态徽章（正常 / 匿名 / 不完整）、项目数、会话归属数、5h 与 7d 剩余；处于匿名态且存在健康快照时，右上出现「立即还原登录态」。
- **登录态卡片**：顶层键、项目、会话归属、工作区根四个指标，加上文件路径、大小、修改时间与判定说明。
- **快照与恢复**：下拉选快照 → 恢复（恢复前自动把当前文件存进 `pre-restore-<时间>`）；新建快照；立即恢复最近健康快照；清空日志。
- **codex 额度**：每个 codex 账号的 5 小时 / 7 天进度条，剩余 ≤1% 标红、≤15% 标黄，附重置券数量与重置时间。
- **供应商**：magpie 里登记的所有供应商与账号（codex、幻灵、灵序、通通、极智……），带 provider 色标、账号标签与窗口。
- **路由现状**：生效的组、routing 名（例如 `floor/keep`）、粘性、分类器，成员按**供应商**分组展示。
- **侧边栏配置**：自动恢复开关、magpie 网关地址、体检间隔（20 秒）、服务端口 / Codex 目录 / 备份目录（可复制）。

## 安全边界

- 页面本身**没有网络**（magpie 给页面的 frame 是 opaque sandbox + `connect-src none`，也没有 inline script），所有事都由本地服务做。
- 本地服务只绑 `127.0.0.1`，校验 `Host`；每个页面拿一个随机 token（`x-codex-guard-token`），`/api/*` 无 token 一律 401；只回 `Origin: null`，别的来源 403。
- 恢复只写 `.codex-global-state.json` 与它的 `.bak`，写之前先存 `pre-restore-<时间>`（保留最近 10 份）；会拒绝恢复「看起来是登出态」的快照（顶层键 < 20，或项目 0 且键 < 35）。
- 快照名走白名单 `^[A-Za-z0-9._-]{1,64}$`，解析后必须落在备份目录内。
- 自动恢复默认**关闭**；打开后每 20 秒体检一次，发现匿名态就用最近健康快照恢复（60 秒冷却）。
- 权限声明为 `[]`：这个页面不读 magpie 的任何受限资源。

## 安装

从 GitHub 装（推荐，别人也用同一条命令）：

```bash
magpie plugin add "github:InvisibleGuardian007/magpie-codex-guard"
```

这个仓库打了 `magpie-plugin` 标签，会出现在 magpie 的「发现 → 非官方插件 · GitHub」里（未审阅），卡片名「会话守护 Session Guard」。

从本地目录装（开发时用）：

```bash
magpie plugin add 'D:\\数据\\AI\\magpie-codex-guard'
```

插件列表里会出现 `page  会话守护 (reads nothing)`。首次打开页面若显示"本地服务没有在运行"，重启 magpie 即可。改完代码要 `magpie plugin off <路径>` / `on <路径>` 才会重新加载服务。

### 选项

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `port` | `4391` | 本地服务端口（只绑 127.0.0.1） |
| `autoRestore` | `false` | 初始的自动恢复开关（之后以页面里的开关为准） |
| `gateway` | `http://127.0.0.1:3425` | magpie 网关，用于读 `/v1/magpie/quotas` |
| `codexHome` | 空 | 留空则用 `CODEX_HOME` 或 `~/.codex` |

注意：按路径安装的插件只能用**路径**当名字：

```bash
magpie plugin options 'D:\\数据\\AI\\magpie-codex-guard' '{"port":4391,"autoRestore":false}'
```

## 结构

```
package.json      magpie.page / options / permissions
index.mjs         page.service 入口：{ id, server }
lib/codex.mjs     判定登录态、快照、恢复、pre-restore
lib/quota.mjs     读网关 /v1/magpie/quotas?kept=1
lib/routing.mjs   读 providers.json / plugins.json 里的组与中间件选项
lib/server.mjs    loopback 服务：token、Host/Origin 校验、CSP、watchdog
page/             引导页 + boot.js（等 bridge → 取 port → 跳本地服务）
ui/               真正的界面：index.html / style.css / app.js
test/             node --test（判定、服务、页面约束）
```

## 测试

```bash
node --test test/*.test.mjs
```

15 项用例覆盖：健康/匿名/缺失判定、快照→恢复→pre-restore、拒绝恢复登出态快照、路径逃逸、token 与 Host/Origin、页面不得触网、manifest 声明。

## 截图

| 浅色 | 深色 |
| --- | --- |
| ![浅色](screenshots/light.png) | ![深色](screenshots/dark.png) |

| 合并前（登录态被清） | 合并后（还原项目） |
| --- | --- |
| ![merge](screenshots/merge.png) | ![name](screenshots/name.png) |

## 版本

每次改动都前进一版，逐版条目见 [CHANGELOG.md](CHANGELOG.md)。当前 0.2.1。

## 许可

MIT © 2026 InvisibleGuardian007
