# Magpie 账号备份插件 / Magpie Account Backup

给 [Magpie](https://github.com/yetone/magpie) 用的独立页面插件：导出 `.magpie-backup` 时，按**供应商**或**账号**挑选要带走的登录信息，其余照旧由 Magpie 自己的备份写入。

An independent page plugin for [Magpie](https://github.com/yetone/magpie): pick which subscription and plugin sign-ins a `.magpie-backup` carries — by vendor or by account — while everything else is written by Magpie's own backup.

---

## 中文

### 这是什么

Magpie 自带的「设置 → 同步与备份 → 导出」只能整机全带。这个插件补上选择：

- 供应商行三态勾选（全选 / 部分 / 未选），可展开逐个账号勾
- 搜索供应商或账号；`已选 N/M`；全选 / 全不选只作用于当前可见项
- 灰显账号列出但不带走，并给出原因：一次性刷新令牌、Agent 原生登录、独立 Agent 目录、已隐藏、已退休内置、插件账号的本机记录、身份不明确
- 导出后仍用 Magpie 原生的「导入」还原，文件格式不变

### 安装

Magpie → Plugins → 安装框，三种任选：

1. **GitHub**（推荐）
   ```
   github:zzc485924/magpie-account-backup
   ```
2. **本机文件夹**：填这个目录的绝对路径（Windows 形如 `C:\path\to\magpie-account-backup`，WSL 里用 `/mnt/c/...`）
3. **npm**：`magpie-account-backup`（尚未发布）

装完侧栏出现「账号备份 / Account Backup」。

### 用法

1. 打开「账号备份」。
2. 三个开关决定带什么：供应商与 API Key、资源库、登录信息。
3. 勾选登录信息后展开账号列表，按供应商或账号挑。
4. 输入口令两次（长度不限，留空也可以），点「导出 · N 个账号」。
5. 导出后卡片上有「下载到本机（一次性链接，10 分钟内有效）」和可复制的地址：
   - 本机运行时文件同时落在下载目录，`magpie-YYYY-MM-DD.magpie-backup`；
   - Magpie 跑在云服务器上时，点那个链接或把地址粘到新标签打开，文件就下到你自己的电脑，服务器上不留副本（`saveOnServer=false`）。
6. 到新机器用 Magpie 的「导入」还原，口令相同。

### 它是怎么做出这份文件的

不是自造格式，而是：

1. 调用 Magpie 自己的命令行 `magpie backup [--sign-ins] [--no-keys] [--no-library] <临时文件>`，供应商、密钥、设置、profiles、资源库全由核心写入；
2. 用同一口令解开这份临时文件，只保留勾中的 `signIns.logins` / `signIns.plugins`，未勾 Codex 时清空 `signIns.codex`；
3. 重新封成 `.magpie-backup`（AES-256-GCM + PBKDF2-SHA256 600,000 轮，新 salt/nonce，头部字段进 AAD）写入下载目录，权限 0600；临时文件当场删除。

所以导入端不需要本插件：Magpie 原生导入直接吃这份文件。

### 带什么，不带什么

| 项目 | 说明 |
|---|---|
| 供应商、密钥、设置、profiles、agent 模型设置 | 由 `--no-keys` 控制 |
| 资源库 | 由 `--no-library` 控制 |
| 订阅账号凭证、插件账号凭证 | 只带勾中的；插件凭证来自 `plugin-auth.json` |
| Codex 当前登录标记 | 只在选中该 Codex 账号时写入 |
| 插件账号的本机记录（`plugin:<id>` 行） | 不在列表里：那是 Magpie 自己的顺序/开关/标签记录，凭证随插件账号走，导入端也会重建 |
| 账号顺序 / 启用状态 | **不带**（内置账号的 `order` 也不随备份走） |
| 一次性刷新令牌的供应商 | 列出但不可选（两台机器同用会互相踢下线） |

### 安全

- 服务只监听 `127.0.0.1`，只接受自己的 Host/Origin；页面用一次性随机令牌调用 API，别的页面猜不到
- 口令只经 POST body，不落盘、不进日志
- 导出文件 0600；中间的完整备份（含全部凭证）在结束时删除
- 「下载到本机」的地址是一个 32 位随机 id，只能用一次、10 分钟过期，第一次下载后即作废
- 账号列表接口只返回脱敏名（`a***@example.com`）与原因码，不含凭证

### 选项

在 Magpie 的插件设置里填：

| 选项 | 默认 | 作用 |
|---|---|---|
| `port` | `39872` | 本地服务端口 |
| `magpieBin` | 自动查找 | 指向 magpie 可执行文件；自动查安装目录、`/opt/magpie`、`/snap/bin`、PATH、WSL 的 `/mnt/c` |
| `exportDir` | 下载目录 | 导出文件写到哪里 |
| `saveOnServer` | `true` | 服务器部署时设 `false`：导出文件不落服务器磁盘，只经一次性链接交给你 |
| `retiredProviders` | 内置表 | 追加已退休的内置供应商 id |
| `rotatingProviders` | 内置表 | 追加一次性刷新令牌的供应商 id |

### 兼容性

| 场景 | 结果 |
|---|---|
| 桌面窗口（Windows，0.1.3410 实测） | 可用。该版本页面策略不给页面目录脚本来源，插件用无脚本刷新进服务页，并由服务页补发 hello，页面不会被判「没有响应」 |
| `magpie web`（浏览器，0.1.3410 实测） | 可用，走 Magpie 的 `_magpie/service/` 代理 |
| 0.1.2862 web | 可用（实测）；桌面窗口未单独实测 |
| macOS / Linux 窗口 | 未执行实测 |

### 自测

```bash
node test/selftest.mjs
```

覆盖：账号清单与原因码、供应商/账号交集、空选择拒绝、裁剪只留选中项、Codex 标记随选中走、错口令/篡改/截断拒绝、HTTP 服务（令牌、Host、CORS、预检、成功与失败不落文件）。

### 已知限制

- 兜底刷新里端口写死 `39872`；改了 `port` 后，只有「脚本被页面策略挡住的桌面窗口」会指向旧端口。
- 导入仍用 Magpie 原生流程；本插件不提供导入界面。
- 账号顺序与启用状态不迁移，需要的话在新机器上手工调一次。

---

## English

### What it is

Magpie's own **Settings → Sync & backup → Export** carries the whole machine. This plugin adds a picker:

- tri-state vendor rows (all / some / none), each expandable to individual accounts
- search by vendor or account; `Selected N/M`; select all / none act on what is visible
- blocked accounts are listed with a reason instead of being silently dropped: one-time refresh token, the agent's own sign-in, a separate agent home, hidden, retired built-in, a plugin account's local record, ambiguous identity
- the file is still a plain `.magpie-backup`, restored by Magpie's own **Import**

### Install

Magpie → Plugins → the install box:

1. **GitHub** (recommended)
   ```
   github:zzc485924/magpie-account-backup
   ```
2. **A folder on this computer**: the absolute path of this directory (`C:\path\to\magpie-account-backup` on Windows, `/mnt/c/...` inside WSL)
3. **npm**: `magpie-account-backup` (not published yet)

The sidebar then shows **Account Backup / 账号备份**.

### Using it

1. Open **Account Backup**.
2. Three switches decide what travels: providers & API keys, the library, the sign-ins.
3. With sign-ins on, pick vendors or accounts.
4. Enter the passphrase twice (any length, empty included), then **Export · N accounts**.
5. The result card offers **Download to this computer** (a one-use link, good for 10 minutes) and the same address to copy:
   - on a local magpie the file is also in Downloads as `magpie-YYYY-MM-DD.magpie-backup`;
   - with magpie on a server, open that link (or paste the address into a new tab) and the file lands on your computer, with no copy left on the server (`saveOnServer=false`).
6. Restore it on the other machine with Magpie's **Import**, same passphrase.

### How the file is made

Not a private format:

1. run Magpie's own CLI — `magpie backup [--sign-ins] [--no-keys] [--no-library] <tmp file>` — so providers, keys, settings, profiles and the library come from the core;
2. open that file with the same passphrase, keep only the picked `signIns.logins` / `signIns.plugins`, and drop `signIns.codex` unless that Codex account was picked;
3. seal it again as `.magpie-backup` (AES-256-GCM, PBKDF2-SHA256 600,000 rounds, fresh salt/nonce, header in the AAD) into Downloads with mode 0600, and delete the staged file.

So importing needs nothing but Magpie itself.

### What travels, what does not

| Item | Notes |
|---|---|
| Providers, keys, settings, profiles, agent models | `--no-keys` decides |
| Library | `--no-library` decides |
| Subscription and plugin credentials | only the picked ones; plugin credentials come from `plugin-auth.json` |
| Codex's current sign-in marker | only when that Codex account is picked |
| A plugin account's local record (the `plugin:<id>` row) | not listed at all: it is magpie's own order/on-off/label bookkeeping, its credential travels with the plugin account, and the importer rebuilds it |
| Account order / enabled state | **not carried** (a built-in's `order` never travels in a backup either) |
| Vendors with a one-time refresh token | listed, not selectable (two machines would sign each other out) |

### Security

- the service binds `127.0.0.1` only and answers its own Host/Origin; the page calls it with a per-run random token, so another page cannot
- the passphrase travels in a POST body only; never logged, never written
- the exported file is 0600; the intermediate full backup (every credential) is deleted when the export ends
- the download address is a 32-hex random id, good once and for 10 minutes; it is spent by the first download
- the account list exposes masked names (`a***@example.com`) and reason codes, never a credential

### Options

| Option | Default | Meaning |
|---|---|---|
| `port` | `39872` | local service port |
| `magpieBin` | found automatically | the magpie executable; searched next to Bun, the usual install folders, `/opt/magpie`, `/snap/bin`, PATH and WSL's `/mnt/c` |
| `exportDir` | Downloads | where exports are written |
| `saveOnServer` | `true` | on a server set `false`: no file is left on that server's disk, it only leaves through the one-use link |
| `retiredProviders` | built-in list | extra retired built-in provider ids |
| `rotatingProviders` | built-in list | extra vendors with a one-time refresh token |

### Compatibility

| Where | Result |
|---|---|
| Desktop window (Windows, 0.1.3410 tested) | works — that build's page policy lets no script of the page folder run, so the plugin opens the service with a script-free refresh and the service page says hello itself; the window never shows "stopped working" |
| `magpie web` (browser, 0.1.3410 tested) | works, through Magpie's `_magpie/service/` proxy |
| 0.1.2862 web | works (tested); its desktop window was not tested separately |
| macOS / Linux window | not run |

### Self-test

```bash
node test/selftest.mjs
```

Covers: the catalog and its reason codes, provider/account intersection, an empty selection refused, trimming to exactly the picked accounts, the Codex marker following its account, a wrong passphrase / tampering / truncation refused, and the HTTP service (token, Host, CORS, preflight, no file left behind on failure).

### Known limits

- the fallback refresh hardcodes port `39872`; after changing `port`, only a desktop window whose scripts are blocked would point at the old port
- importing is still Magpie's own; the plugin has no import screen
- account order and enabled state are not migrated — set them once on the new machine
