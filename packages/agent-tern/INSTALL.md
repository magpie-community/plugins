# 安装 Tern for magpie

这个插件给 magpie 的 Agents 页增加一行 **Tern**。Tern 的 agent 面板启动的是 `omp`（oh-my-pi）；插件把 magpie 里选的模型写进 `omp` 的 `models.yml` 和 `config.yml`，并处理旧配置迁移与 `enabledModels` 列表。

## 前提

- 已安装 **Tern 0.9.21 或更新版本**，并且 `tern` 在 PATH 中。
- Tern 自带的 `omp` 已安装并在 PATH 中，通常是：
  - Windows：`%LOCALAPPDATA%\Tern\omp\bin\omp.exe`
  - macOS / Linux：随 Tern 安装，`omp` 在 PATH 中
- 已安装 **magpie 0.1.4266 或更新版本**，能打开 Agents 页。
- 本目录包含 `package.json`、`tern.agent.js`、`sync.mjs`、`README.md`、`INSTALL.md`、`LICENSE`。

> 如果刚装完 Tern，`tern` 或 `omp` 还不在当前终端里，先新开一个终端（Windows 需要重新登录或刷新用户 PATH）。用 `where tern`（PowerShell：`Get-Command tern`）和 `omp --version` 确认。

## 安装

### 方式 A：magpie 应用

打开 magpie → 插件 → 添加插件 → 本机文件夹，选择本目录（包含 `package.json` 的那一层）。

### 方式 B：命令行

```powershell
magpie plugin add "C:\path\to\magpie-plugin-tern"
```

成功时输出类似：

```text
✓ added C:\path\to\magpie-plugin-tern
C:\path\to\magpie-plugin-tern  on
```

第一次安装可能会等 magpie 准备 Bun 运行时；如果卡住，先打开一次 magpie 应用，或确认 `magpie plugin` 的其他命令能正常工作。

> `magpie plugin add <目录>` 记录的是**该目录的路径引用**，不会把文件复制进 magpie。安装后不要移动或删除这个目录，否则下次加载会失败；需要换位置时重新 `plugin add`。

## 确认加载

```powershell
magpie plugin --json
magpie agents
magpie ls
```

`magpie plugin --json` 里应能看到 `plugins[].spec` 指向你安装的目录，且 `loaded[]` 里没有 `error`。本插件同时带一个 Bun main（`sync.mjs`），所以它也会作为插件模块被加载；这是正常的。

`magpie agents` 末尾应出现：

```text
Tern                      —                         C:\Users\<你>\.omp\agent\models.yml
```

`magpie ls` 里也应有 `Tern` 行。

## 选择模型

### Agents 页

1. 打开 magpie → Agents。
2. 找到 **Tern** 行。
3. 选择一个 magpie 模型。

### 命令行

```powershell
magpie tern iteracompute-3000/deepseek/deepseek-v4.1-flash-1017
```

把模型换成 `magpie models` 里任意一个 `provider/model` 即可。成功时输出：

```text
✓ Tern model magpie/iteracompute-3000/deepseek/deepseek-v4.1-flash-1017
  ↻ omp 在启动时读取配置：重新打开 Tern 的 agent 块后生效。
```

插件会写：

- `~/.omp/agent/models.yml` 的 `providers.magpie`（gateway `baseUrl`、`openai-completions`、`auth: none`、模型列表）；
- `~/.omp/agent/config.yml` 的 `modelRoles.default: magpie/<model>`。

### 让 Tern 用上新模型

`omp` 在启动时读取配置。回到 Tern，**关闭已经打开的 agent 块，再新建一个**；或者重启 Tern。已经打开的块不会热更新。

## 和内置 `omp` 行的冲突（必读）

magpie 自带一个 `omp` agent 行，它和 Tern 行写同一组文件：

- `~/.omp/agent/models.yml` → `providers.magpie`
- `~/.omp/agent/config.yml` → `modelRoles.default`

所以：

- **只选一行用。** 用 Tern 行就不要再在 `omp` 行上选模型；用 `omp` 行就不需要用本插件。
- **不要先执行 `magpie omp default` 再切到 Tern。** 该命令会从 `models.yml` 移除 `magpie` provider（常见结果是 `providers: {}`），omp 会立刻没有 magpie 模型，Tern 行也会随之失效。
- 如果之前已经用 `omp` 行选过模型，直接到 Tern 行重新选一个模型即可；不要清理 `omp` 行。
- 两行同时选不同模型时，后写的覆盖先写的；关闭其中一行会删掉共享的键，另一行可能变回“没有模型”。

## `sync.mjs` 会改什么

插件安装后会运行 `sync.mjs`：magpie 加载插件模块时先跑一次，启动约 500 ms 后再跑一次，之后每 10 秒一次。

1. **`config.yaml` 迁移**：如果 `~/.omp/agent/config.yaml` 存在且 `config.yml` 不存在，先备份为 `config.yaml.magpie-backup`，再把原文件改名为 `config.yml`（内容不变）。`config.yml` 已存在时不动。
2. **`enabledModels` 合并**：只有列表已经存在且非空时，才追加 `magpie/**`；保留原条目、引号和注释。列表不存在或为空时不创建。支持 flow（`[a, b]`）和块（`- a`）两种写法；格式不认识时直接跳过，不破坏文件。

测试或排查时可以设置 `TERN_SYNC_DISABLE=1` 完全关闭它。

## 验证

```powershell
magpie tern
magpie tern model

# 用真实的 omp 看模型目录（在临时 HOME 下也可以）
omp models
omp models --json
```

`magpie tern` 应显示当前模型和配置文件路径。`omp models` 里应出现 `magpie (<数量>)`，其中有你选的模型；`omp models --json` 的 `selector` 应是 `magpie/<provider>/<model>`。

## 关闭与还原

```powershell
magpie tern default
```

在 magpie 0.1.4266 上实测：该命令会把 `modelRoles.default` 恢复成设置前的值，保留 `plan`、`theme`、`defaultThinkingLevel` 和注释，同时从 `models.yml` 移除 `providers.magpie`（可能留下 `providers: {}`）。更早的 magpie 版本可能删除该键而不是恢复旧值；升级 magpie 或先备份。

备份：

```powershell
Copy-Item -Recurse "$HOME\.omp\agent" "$HOME\.omp\agent.backup"
```

还原：退出 Tern / omp，把备份里的 `config.yml`、`models.yml`、`config.yaml` 拷回 `~/.omp/agent`。`config.yaml.magpie-backup` 是迁移前的原文件。

## 卸载

先还原模型，再移除插件：

```powershell
magpie tern default
magpie plugin rm "C:\path\to\magpie-plugin-tern"
```

`magpie plugin rm` 只认安装时记录的目录路径。用 `magpie plugin --json` 的 `plugins[].spec` 原样复制；Windows 上优先用反斜杠的 `C:\...`（`C:/...`、`/c/...`、相对路径可能报 `no plugin`）。只删插件不会删除 `~/.omp/agent` 里已写入的模型和 provider。

## 常见问题

**Agents 页没有 Tern**

- 确认安装的是包含 `package.json` 的目录，且 `package.json` 里有 `"magpie": { "agent": "./tern.agent.js" }`。
- 运行 `magpie plugin --json` 看 `loaded[].error`；运行 `magpie agents` 看是否被其他插件占用了 `tern` id。

**`magpie tern` 提示 unknown agent**

插件没有加载成功。检查 `magpie plugin --json`，确认路径仍存在；移动过插件目录就重新 `plugin add`。

**Tern 里还是旧模型**

关闭已经打开的 agent 块，重新新建一个；或重启 Tern。`omp` 只在启动时读取配置。

**omp 说没有模型 / `providers.magpie` 不见了**

通常是执行过 `magpie omp default`（或手动删了 `models.yml` 的 `providers.magpie`）。重新在 Tern 行选一次模型，插件会重建 provider。

**设置了 `OMP_PROFILE` / `PI_PROFILE`**

omp 会改读 `~/.omp/profiles/<名字>/agent/config.yml`，本插件只写默认的 `~/.omp/agent/`。取消该环境变量，或手动把模型和 provider 写到对应 profile 的配置里。可用 `omp config path` 确认。

**`enabledModels` 里没有 `magpie/**`**

只有列表非空时才会追加。如果列表为空或不存在，omp 表示“不过滤”，插件不会创建。确认 `sync.mjs` 没有被 `TERN_SYNC_DISABLE=1` 关掉，并等待最多 10 秒或重启 magpie。

**升级 magpie / omp 后不工作**

`models.yml` 的字段由 omp 定义。已在 omp 18.20.2、magpie 0.1.4266 上验证；升级大版本后如果 schema 变了，需要更新插件。先查看 `omp models` 是否报 `validation failed`，再反馈日志。
