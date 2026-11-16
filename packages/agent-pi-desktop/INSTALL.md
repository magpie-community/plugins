# 安装 PI-Desktop 的 magpie Agent 插件

本插件把 **PI-Desktop** 加到 magpie 的 Agents 页。安装后：magpie 选模型 → 写入 `~/.pi-desktop/magpie-agent.json` → `sync.mjs` 同步进 `~/.pi-desktop/pi.sqlite` → 在 PI-Desktop 里刷新模型列表/开新会话即可（不需要重启）。

## 前置条件

- magpie 已安装，版本支持 Agent 插件（`magpie agents` 可用）。
- PI-Desktop 已安装，默认数据目录是：
  - Windows：`C:\Users\<你>\.pi-desktop`
  - macOS / Linux：`~/.pi-desktop`
  - 如果设置了 `PI_DESKTOP_DATA_DIR`，数据库在它下面；开发构建（`PI_DESKTOP_DEV=1`）在 `~/.pi-desktop-dev`。
- 不需要单独安装 Bun，magpie 的插件宿主会按需准备。

## 安装前建议

- 退出 PI-Desktop，把 `~/.pi-desktop/pi.sqlite` 复制一份到安全位置。PI-Desktop 在 WAL 模式下运行时直接拷贝可能不完整，退出后再拷最稳妥。
- `sync.mjs` 第一次写库前也会自动在 `~/.pi-desktop/magpie-backups/` 留一份完整数据库副本（最多 10 份）。注意备份里可能含会话和个人数据，不要随意分享。

## 方式一：在 magpie 应用里导入

1. 打开 magpie，进入 **插件** 页。
2. 点 **添加插件**，选择 **本机文件夹**。
3. 选中 `magpie-plugin-pi-desktop` 目录（包含 `package.json`、`pi-desktop.agent.js`、`sync.mjs` 的那一层），确认。
4. 插件列表里出现 `@magpie-community/agent-pi-desktop`（或该文件夹的路径）且没有报错，说明加载成功。

> 文件夹插件直接从该目录加载。导入后不要移动或删除这个目录；要换位置，请重新添加。

## 方式二：命令行（文件夹）

```bat
magpie plugin add "C:\path\to\magpie-plugin-pi-desktop"
```

把路径换成你实际存放该目录的位置。成功后检查：

```bat
magpie plugin --json
magpie agents
```

`magpie agents` 里应出现 `PI-Desktop`（id：`pi-desktop-app`，别名：`pi-desktop`、`pidesktop`）。

> magpie 把 `pi-desktop` 这个 id 预留给了自己的 PI-Desktop 会话集成，插件不能直接占用，所以这里用 `pi-desktop-app`；`pi-desktop` 和 `pidesktop` 都注册为别名，命令行里 `magpie pi-desktop` 一样能用。

## 方式三：npm（发布之后）

插件发布到 npm 后可以按包名安装：

```bat
magpie plugin add @magpie-community/agent-pi-desktop
```

本仓库的 `package.json` 使用社区 scope `@magpie-community/agent-pi-desktop`，仓库指向 `magpie-community/plugins`。如果你从自己的账号发布，请先改掉 `name` / `repository` / `homepage` / `bugs`，并确认 npm 上的包名可用。

## 启用并选模型

1. 打开 magpie 的 **Agents** 页。
2. 找到 **PI-Desktop** 行，打开开关。
3. 在它的模型选择器里选一个 magpie 的模型。
4. 让 magpie 保持运行几秒（`sync.mjs` 的 watcher 会检查并落库），然后在 PI-Desktop 里重新打开设置页/模型选择器，或直接开一个新会话。不需要完全退出 PI-Desktop。

PI-Desktop 会使用 magpie 的网关地址和刚选的模型：provider 走 loopback，`auth_kind='none'`，不会把 `apiKey` 写进数据库。

第一次同步会新建 `magpie-pi-desktop` provider，并把 PI-Desktop 的应用默认 provider 指向它（否则新会话仍会用你原来的模型）；之后如果你在 PI-Desktop 里改选别的默认 provider，插件不会抢回，只会继续保证 magpie 这一行是启用的。

如果 `magpie agents` 里没有 `PI-Desktop`：

- 看 `magpie plugin --json` 里的 `errors`，确认 `pi-desktop.agent.js` 存在且 `package.json` 的 `magpie.agent` 指向它；
- 确认没有另一个插件占用了 `pi-desktop-app`；
- 关掉再打开该插件，让 magpie 重启插件宿主。

如果模型已选但 PI-Desktop 里看不到：

- 确认 `~/.pi-desktop/pi.sqlite` 存在（路径见上）；
- 在 PI-Desktop 里刷新模型列表/开新会话；
- 检查 magpie 日志里的 `[magpie-pi-desktop]` 行，`syncOnce` 的 `reason` 会说明是 `no-db`、`no-config`、`db-busy` 还是其他原因。

## 卸载

1. 在 magpie 的 **Agents** 页关闭 `PI-Desktop` 行，或选回它自己的模型（这会还原 `magpie-agent.json` 里的键；但 `pi.sqlite` 里已经写入的 provider / 模型行**不会**自动回滚）。
2. 移除插件。文件夹方式添加的，`plugin rm` 认的是文件夹路径，不是包名：

   ```bat
   magpie plugin rm "C:\path\to\magpie-plugin-pi-desktop"
   ```

   用 `magpie plugin --json` 可以确认当前记录的 `spec`。只有 npm 方式安装的插件才能用包名：

   ```bat
   magpie plugin rm @magpie-community/agent-pi-desktop
   ```

3. 在 PI-Desktop 里刷新模型列表。

如果 `~/.pi-desktop/magpie-agent.json` 残留，可以直接删除。要让数据库也回去：退出 PI-Desktop，把 `~/.pi-desktop/magpie-backups/pi.sqlite.<时间戳>.bak` 复制回 `~/.pi-desktop/pi.sqlite`，并删掉同目录的 `pi.sqlite-wal`、`pi.sqlite-shm`；或者在 PI-Desktop 里手动删除 `magpie-pi-desktop` provider 并把默认模型改回去。

`~/.pi-desktop/pi.sqlite.v*.bak` 是 PI-Desktop 自己的版本迁移备份，不是本次改动的回滚点；本次改动的备份在 `magpie-backups/` 下。

## 安全与隐私

- `magpie-agent.json` 里的 `apiKey` 是明文；它只用于 loopback 网关，`sync.mjs` 不会写进 `pi.sqlite`，也不会打印到日志。排查问题时不要把该文件原样贴出。
- `magpie-backups/` 里是完整数据库副本，可能包含会话、项目路径和其他 provider 的元数据；分享前先确认。
- 插件只改 `providers` / `models` / `kv` 中与当前模型有关的最小字段；用户已有 provider 的 `auth_kind`、`secret_ref`、`base_url` 等不会被改动。
