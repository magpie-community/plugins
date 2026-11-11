# magpie-logins-sync

把 magpie 插件的**登录态**（`plugin-auth.json`）单向备份到一个 GitHub 仓库，换机器时再拉回来。

magpie 自己的备份与 WebDAV/S3 同步刻意**不包含**插件登录（见 magpie 的 `internal/backup/backup.go` 与 `docs/reference.md` 中的 *Subscriptions are not in it*）。所以用插件供应商（WorkBuddy、ZCode、MiniMax、Trae…）的机器，每换一台都要重新登录一次。这个插件只补这一块。

- 支持 **macOS / Linux / Windows**
- 单向上传，不会自动把远端写回本机
- 推送与拉取都**先分析**，再由你决定

## 功能

- **推送前分析**：远端是否更新、是否会丢掉账号、是否会覆盖更新的 token
- **拉取前分析**：新增 / 更新 / 冲突分别列出，由你选合并方式
- **页面看板**：本机账号数、远端账号数、上次分析时间、远端更新时间、各供应商明细
- **不碰 magpie 自己的同步**：不动其它插件，不动 `backup`/WebDAV/S3 配置

## 安全模型

| 项目 | 做法 |
| --- | --- |
| 上传内容 | 加密密文（AES-256-GCM，密钥由 PBKDF2-SHA256 从同步口令派生） |
| 密钥来源 | 你填的**同步口令**（≥12 位）。不是 GitHub token——token 会轮换，轮换不该让你打不开自己的备份 |
| 口令存放 | 只在本机 `plugin-auth.json`（POSIX 权限 600），不进 `plugins.json` |
| 明文 | 不上传。远端只有密文 + 一个不含任何秘密的 `manifest.json` |
| GitHub 权限 | 只需目标仓库的 **Contents: read and write** |
| 拉取写入 | 走 `client.auth.set`（magpie 自己加锁、备份、原子写的路径），不直写文件 |

> **口令丢了就打不开已上传的备份。** 请另外保存一份。恢复办法：从一台还保留口令的机器重新推送。

## 远端布局

```
<path>/manifest.json   # 明文：计数与供应商 id，不含账号名/令牌
<path>/logins.enc      # 密文：全部登录态
```

默认 `<path>` = `magpie/logins`。

`manifest.json` 只回答两个问题：远端是不是比我新、推送会不会删账号。真正的权威数据在密文里；两者不一致时以密文为准。

## 推送的判断

| 判断 | 含义 | 是否允许 |
| --- | --- | --- |
| `first` | 远端还没有备份 | ✅ |
| `fast-forward` | 远端是上次推送的版本，本机更新 | ✅ |
| `up-to-date` | 两边完全一致 | ⛔ 不上传 |
| `remote-ahead` | 上次推送后远端被改过 | ⛔ 先拉取 |
| `diverged` | 两边都有改动 | ⛔ 先拉取 |
| `would-lose` | 远端有本机没有的账号 | ⛔ 先拉取 |

会覆盖已有 token 的推送需要二次确认（「推送（已确认）」）。

## 拉取的判断

| 方式 | 行为 |
| --- | --- |
| `仅新增`（默认） | 只写本机没有的账号 |
| `新增 + 远端更新时更新` | 同账号只有远端 token 更新时才覆盖 |
| `远端覆盖同账号` | 同账号一律用远端 |
| `只预览` | 只列出计划，不写 |

不同身份的账号**永远不会**被覆盖：即便 key 相同，也会追加成 `<provider>#<随机6位>`。

## 安装

### 从 GitHub（推荐）

```bash
magpie plugin add github:<you>/magpie-logins-sync
```

### 从本地文件夹

```bash
magpie plugin add /path/to/magpie-logins-sync
```

Windows:

```powershell
magpie plugin add C:\path\to\magpie-logins-sync
```

> 路径必须指向**包含 `package.json` 的那一层目录**。

### 安装后

在 magpie 的 **插件 → 已安装** 里找到 **登录备份** 那一行：

1. 点 **保存设置**，依次填 `owner/repo`、分支、目录、GitHub token、同步口令
2. 点 **分析远端**，确认本机 / 远端的账号数
3. 点 **推送到 GitHub**
4. 换机器装同一个插件、填同一仓库与**同一口令**，点 **拉取（先分析）**

页面（侧栏 **登录备份**）可以看状态并触发同样的操作；token 与口令只经过插件行的输入框，不写进页面能读到的 `options`。

## GitHub 准备

1. 新建一个**私有**仓库（不要用公开仓库）
2. 建一个 fine-grained token，权限只要该仓库的 **Contents: Read and write**
3. 把 token 填进插件的「保存设置」

## 页面能显示什么

magpie 的插件页面跑在只允许脚本的沙箱里：没有网络、读不到账号、读不到 `plugin-auth.json`。它能拿到的是：

- `magpie.read("providers:list")` — 供应商 id 与名称
- `magpie.options.get()/set()` — 本插件在 `plugins.json` 里的 options

所以页面上的数字来自插件写回 options 的 `status`（每次分析 / 推送 / 拉取后由插件原子写入），不是页面自己去查的。真正的网络请求都发生在插件（Bun）进程里。

## 限制

- **只备份插件登录**：Codex / Claude / Antigravity / Factory 的订阅账号在别的存储，请用 `magpie accounts import`
- **部分供应商绑机器**：token 搬过去仍可能要求重新登录，这是厂商行为
- **不自动同步**：没有后台定时器，只在页面按钮、插件行方法、或 `magpie plugin login logins-sync` 时动作
- **两台机器并行使用同一批账号会互相踢下线**：OAuth 的 refresh token 通常单次有效。建议一台保持登录并定期推送，另一台只做恢复 / 迁移
- **并发写入**：两台机器同时推送时，条件写会让后到的那次失败并提示重新分析，不会静默覆盖

## Windows 说明

代码已按 Windows 处理：

- 配置目录用 magpie 传入的 `input.directory`（`%USERPROFILE%\.config\magpie`，或 portable 模式的 `data\`），不依赖 `~/.config`
- 文件写入是「临时文件 + rename」，并对 `EPERM / EBUSY / EACCES` 重试（Windows 上文件被读时会短暂拒绝改名）
- 路径全部走 `node:path`
- `chmod` 在 Windows 上是无害空操作

## 测试

```bash
npm test
```

纯逻辑 + 模拟 GitHub 的端到端测试：不联网、不读写真实配置。

## 许可

MIT
