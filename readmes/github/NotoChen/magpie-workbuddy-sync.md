# Magpie WorkBuddy Sync

把 **WorkBuddy / WorkBuddy AI 账号**从一台 Magpie 主机同步到其他 Magpie 从机。

它不替代 [@magpie-community/opencode-workbuddy-auth](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)：官方插件继续负责登录、模型、请求、用量和刷新；本插件只负责把账号凭据从主机带到从机。

## 为什么需要它

Magpie 的 `signIns` 同步会排除 `rotating` 插件。WorkBuddy 插件声明了：

```js
rotating: true
```

WorkBuddy 的 refresh token 被消费后会换新；两台机器各持一份 refresh token 时，两边会竞争刷新，其中一台会收到 `invalid_grant`，账号被标记失效。上游 issue [#5583](https://github.com/yetone/magpie/issues/5583) 因此让 WorkBuddy 账号只属于一台电脑。

本插件把“只属于一台电脑”变成可用的主从方案：

- **主机（master）**：官方 WorkBuddy 插件原样使用，是 refresh token 的唯一持有者；
- **从机（slave）**：只接收 access token，不接收 refresh token，也不会向 WorkBuddy 发起刷新；
- 主从判断直接复用 Magpie 的 `sync.json`：
  - `followServer: true` → 从机；
  - 其余 → 主机。

## 安装

### 从 GitHub 安装

```sh
magpie plugin add github:NotoChen/magpie-workbuddy-sync
```

仓库按本机 GitHub 账号 `NotoChen` 预填；如果你用别的账号，替换成实际 owner。

### 在 Magpie 中检索

仓库需要：

1. 是 **public** 仓库（Magpie 的 Discover 只会列出公开仓库）；
2. 在 GitHub 仓库的 **Topics** 中添加 `magpie-plugin`；
3. 根目录的 `package.json` 包含有效的 `name`、`version`、`main` 和 `magpie.page`。

Magpie 的检索逻辑在 `internal/plugin/github.go`：用 GitHub Search 查 `topic:magpie-plugin archived:false fork:false`，读取仓库的 `package.json`，并把 `magpie.page.file` 作为页面插件的入口。本仓库已经按这个结构准备好。

如果之后发布到 npm，npm 包的 `repository` 指向本仓库，Magpie 会优先安装 npm 版本；否则安装 `github:NotoChen/magpie-workbuddy-sync`。

## 使用前

主机和从机都要：

1. 安装官方 WorkBuddy 插件，并正常登录 WorkBuddy / WorkBuddy AI；
2. 已经在 Magpie 设置中启用 GitHub 同步（`sync.json` 存在，且地址是 `github://owner/repo`）；
3. 主机把 `sync.json` 的 `followServer` 保持关闭；从机打开“跟随服务器”。

本插件不需要额外的 GitHub token，也不需要额外的加密口令：它直接复用 `sync.json` 的：

- `url`（`github://owner/repo[/folder]`）
- `password`（GitHub token）
- `passphrase`（Magpie 同步口令）
- `branch`（可空，默认分支）

> 主机上要共享的账号请使用官方 WorkBuddy 插件的“WorkBuddy account（browser）”登录；桌面版 `source: "desktop"` 是这台电脑的 app 自己的登录标记，本插件不会搬运。

## 工作方式

```text
主机 Magpie
  plugin-auth.json ──watch──▶ 提取 workbuddy / workbuddy-ai
                               │
                               ▼
                     AES-256-GCM（magpie-data）
                               │
                               ▼
           GitHub 私有仓库: <prefix>/workbuddy/workbuddy-auth.magpie-data
                               │
                               ▼
从机 Magpie                poll / decrypt
                               │
                               ▼
                     plugin-auth.json（只写 access）
```

### 从机写什么

```json
{
  "workbuddy": {
    "type": "oauth",
    "access": "<master 的 access token>",
    "uid": "<uid>",
    "accountId": "<账号名>",
    "domain": "<domain>",
    "tokenType": "Bearer",
    "enterpriseId": "<如果有>",
    "expires": 0
  }
}
```

- **移除** `refresh`
- **移除** `refreshExpiresAt`
- **移除** `source: "desktop"`
- `expires: 0` 让 Magpie host 的 `renewAt()` 不触发，官方插件的 `fresh()` 也不会把账号当成到期。

### 多账号

`plugin-auth.json` 里 `workbuddy`、`workbuddy#xxxxxx`、`workbuddy-ai`、`workbuddy-ai#xxxxxx` 都会按原 key 对齐：

- 主机有几个账号，从机就有几个；
- 主机删除一个账号，从机下次拉取时删除；
- 从机的 WorkBuddy Plus 能看到这些账号，但不要开启它的定时任务（任务只在主机跑）。

## 页面

插件在 Magpie 侧栏提供「WorkBuddy Sync」页面：

- 每 20 秒自动刷新状态，不需要手动点“重新读取”；
- 页面里的“角色”可以直接切换 `自动 / 主机 / 从机`，应用后写入本机 `workbuddy-sync.json`，不会改变其他机器；
- “立即同步”会重载插件并马上执行一次发布/拉取；
- 状态区显示账号数、generation、最后发布/拉取时间和错误信息。
- Magpie 可能同时启动多个插件宿主（窗口、页面、CLI）；只有拿到 `workbuddy-sync.lock` 的宿主会写状态，其他宿主静默重试，不会把 “another process” 覆盖到页面。

## 配置

一般情况下不需要配置文件。需要覆盖时，在 Magpie 配置目录（通常是 `~/.config/magpie`）新建 `workbuddy-sync.json`：

```json
{
  "role": "master",
  "pollSeconds": 30
}
```

可选字段：

| 字段 | 说明 |
| --- | --- |
| `role` | `master` / `slave`；省略时按 `sync.json.followServer` 自动判断 |
| `pollSeconds` | 拉取/检查间隔，10–3600 秒；默认从机 30、主机 15 |
| `path` | 覆盖快照文件路径；默认 `<prefix>/workbuddy/workbuddy-auth.magpie-data` |
| `branch` | 覆盖分支 |
| `token` | 覆盖 GitHub token |
| `passphrase` | 覆盖加密口令（主机和从机必须一致） |
| `allowEmpty` | 主机没有 WorkBuddy 账号时也发布空快照；默认 `false` |

`workbuddy-sync.json` 是本机文件，不会进入 Magpie 的同步。整个同步链路只应有一台 `master`；多台主机同时发布会产生 generation 竞争，请只在主机上设 `master`。

## 安全

- 快照用 **AES-256-GCM** 加密，格式与 Magpie 的 `internal/backup/data.go` 的 `SealData` / `OpenData` 完全一致（`magpie-data`、PBKDF2-SHA256 600,000 次、12 字节 nonce）。
- 复用 `sync.json.passphrase`。如果你的 Magpie 同步口令很短，建议在 `workbuddy-sync.json` 中为 WorkBuddy 快照单独指定一个长口令（所有机器保持一致）。
- 只写 GitHub 私有仓库；Magpie 的 GitHub 同步本身已要求仓库为 private。
- 从机永远不保存 refresh token；即使有人在从机点“重新登录”，插件也会在下一轮把它移除，只留下 access token。
- 从机不要登录 WorkBuddy 桌面版同一账号：`source: "desktop"` 会让官方插件读取桌面 app 自己的 token，绕过本插件的约束。

## 限制

- v1 只支持 Magpie 的 GitHub 同步（`github://`）。WebDAV / S3 需要后续加 transport。
- 主机必须至少运行一次并保持 Magpie 的 GitHub 同步可用；主机的 access token 刷新后，从机在下一次拉取时更新。
- 从机请求仍受 WorkBuddy 服务端的并发/额度规则约束；本插件只解决凭据同步，WorkBuddy 的配额规则不变。
- `plugin-auth.json` 是 Magpie 的内部格式；Magpie 或 WorkBuddy 插件升级后如果字段变化，需要回归测试。

## 开发

```sh
npm test
```

测试覆盖：

- `magpie-data` 格式的加密/解密；
- 多账号 key 对齐；
- 从机 access-only 清理；
- 主机发布 → 从机应用的完整流程（内存 GitHub store）。

## 发现与发布

Magpie 的“非官方”插件来源是 GitHub topic `magpie-plugin`。仓库发布后：

1. **Settings → Topics** 添加 `magpie-plugin`；
2. 确认 `package.json` 的 `magpie.page.file` 指向存在的页面；
3. 在 Magpie 的 Plugins 页面点 Discover，搜索 “WorkBuddy Sync”；
4. 或直接运行 `magpie plugin add github:NotoChen/magpie-workbuddy-sync`。

也可以运行 `scripts/tag-repo.sh owner/repo`（需要 `gh` 已登录）一次性设置这些 topic。

npm 发布是可选的：

```sh
npm publish --access public
```

如果 npm 包的 `repository` 指向本仓库，Magpie 会优先安装 npm 版本。

## License

MIT
