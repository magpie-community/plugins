# Tern for magpie

把 **Tern** 加到 magpie 的 Agents 页。Tern 的 agent 面板启动的是 `omp`（oh-my-pi）；这个插件让 magpie 选的模型真正能被 `omp` 用起来：

- 在 `~/.omp/agent/models.yml` 里写入 `providers.magpie`（gateway 地址、`openai-completions`、`auth: none` 和模型列表）；
- 在 `~/.omp/agent/config.yml` 里写入 `modelRoles.default`，值为 `magpie/<provider>/<model>`；
- 由 `sync.mjs` 做两件 omp 自己不会做的事：旧 `config.yaml` 迁移，以及已有 `enabledModels` 列表时补上 `magpie/**`。

只写 `modelRoles.default` 是不够的：omp 必须先在 `models.yml` 里看到 `magpie` provider，才能解析 `magpie/...` 模型。本插件会写这两个文件。

## 它写到哪里

| 项 | 值 |
| --- | --- |
| 插件 id | `tern` |
| 显示名 | Tern |
| CLI | `magpie tern`（别名 `magpie tern-terminal`） |
| 检测命令 | `tern` |
| 模型 provider | `~/.omp/agent/models.yml` 的 `providers.magpie` |
| 启动模型 | `~/.omp/agent/config.yml` 的 `modelRoles.default` |
| 模型前缀 | `magpie/` |

设置成功后大致是：

```yaml
# ~/.omp/agent/config.yml
modelRoles:
  default: magpie/iteracompute-3000/deepseek/deepseek-v4.1-flash-1017
```

```yaml
# ~/.omp/agent/models.yml
providers:
  magpie:
    baseUrl: http://127.0.0.1:3425/v1
    api: openai-completions
    auth: none
    models:
      - id: iteracompute-3000/deepseek/deepseek-v4.1-flash-1017
        name: DeepSeek V4.1 Flash 1017 · IteraCompute 3000 万 /月
        contextWindow: 1048576
        maxTokens: 384000
        reasoning: true
        thinking:
          mode: effort
          efforts:
            - low
            - high
            - max
```

`baseUrl` 是 magpie 当前 gateway 的 `/v1` 地址，端口随 magpie 设置变化。`contextWindow` / `maxTokens` 只在 magpie 知道该模型元数据时写入；`thinking.efforts` 只保留 omp 认识的级别（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。

插件不写 Tern 自己的 `settings.json`：Tern 只负责启动 `omp`，模型和 provider 都属于 `omp`。

## 和 magpie 内置 `omp` 行的冲突（重要）

magpie 自带一个 `omp` agent 行。它和本插件写的是**同一组文件**：

- `~/.omp/agent/models.yml` 的 `providers.magpie`
- `~/.omp/agent/config.yml` 的 `modelRoles.default`

因此：

- **只选一行用。** 推荐用 Tern 行就只用 Tern 行；不需要 Tern 行就用内置 `omp` 行。
- **不要先运行 `magpie omp default` 再切到 Tern。** 这个命令会把 `models.yml` 里的 `magpie` provider 移除（常见结果是 `providers: {}`），omp 立刻没有任何 magpie 模型；Tern 行随后也会失效。
- 不要在 `omp` 行和 Tern 行上同时选不同模型：它们写同一个 `modelRoles.default`，后写的覆盖先写的。
- 关闭其中一行（在 Agents 页切回默认，或 `magpie <行> default`）会移除共享的 `modelRoles.default` / `providers.magpie`，另一行可能因此回到“没有模型”的状态。切换前先备份，见下文。
- 如果之前已经用内置 `omp` 行选过模型，直接改用 Tern 行时**不要清理 `omp` 行**；在 Tern 行重新选一个模型即可，它会重写同一个 provider 和 default。确认不再使用 `omp` 行后，可以在 Agents 页把它留在原样（不要点 Disconnect）。

## `sync.mjs` 自动处理的两件事

插件的 Bun main 是 `sync.mjs`。它在 magpie 启动后约 500 ms 跑第一次，之后每 10 秒检查一次；插件模块被 magpie 加载时也会先跑一次（命令行插件宿主很短命，这一步保证迁移/合并不会漏掉）。也可以用 `TERN_SYNC_DISABLE=1` 完全关闭（测试用）。

### 1. `config.yaml` → `config.yml`

omp 18.x 读 `config.yml`。如果用户目录里只有旧版留下的 `~/.omp/agent/config.yaml`，而 magpie 又新建了 `config.yml`，omp 会读新文件，原有 `plan`、`theme`、`modelRoles` 等设置就像“消失”了。

`sync.mjs` 的规则：

1. 只有 `config.yaml` 存在、且 `config.yml` 不存在时才迁移；
2. 先把原文件备份为 `config.yaml.magpie-backup`；
3. 再把 `config.yaml` 原样改名为 `config.yml`（内容不变）；
4. `config.yml` 已存在时不动，不覆盖用户现在的配置。

### 2. `enabledModels` 合并

如果 `config.yml` 里已经有**非空**的 `enabledModels` 列表，`omp` 只显示列表内的模型。为了让 magpie 模型出现在其中，`sync.mjs` 会追加 `magpie/**`：

```yaml
enabledModels: [openai/*]   # 用户原有内容
# 变成
enabledModels: [openai/*, magpie/**]   # 用户原有内容
```

- 支持 flow 列表（`[a, b]`）和块列表（每行 `- item`）。
- 保留原有条目、引号和注释；只插入一行/一项，不重写整个文件。
- 如果 `enabledModels` 不存在或为空（`enabledModels: []`），**不会创建**它。空列表在 omp 里表示“不过滤”，创建它反而会把非 magpie 模型全部藏起来。
- 已经是 `magpie/**` 时不会重复追加。
- 格式无法识别（例如未闭合的 flow 列表、块标量条目）时直接跳过，不破坏文件。

## 安装与使用

见 [INSTALL.md](./INSTALL.md)。简述：

1. `magpie plugin add "<本目录>"`（或在 magpie 的插件页选择本机文件夹）；
2. 在 Agents 页找到 **Tern**，选一个 magpie 模型；等价的命令行是 `magpie tern <provider>/<model>`；
3. 回到 Tern，关闭已经打开的 agent 块，再新建一个；或重启 Tern。`omp` 只在启动时读取配置；
4. 用 `magpie tern` 和 `omp models` 确认。

## 关闭、还原与卸载

### 切回 Tern 自带的默认

```powershell
magpie tern default
```

在 magpie 0.1.4266 上实测：它会把 `modelRoles.default` 恢复成设置前的值（例如 `old/model`），保留 `plan`、`theme`、`defaultThinkingLevel` 和注释，同时移除 `models.yml` 里的 `providers.magpie`（文件可能只剩 `providers: {}`）。更早的 magpie 版本可能删除该键而不是恢复原值；不确定时先备份。

### 备份与还原

设置或关闭前，把整个配置目录复制一份即可：

```powershell
Copy-Item -Recurse "$HOME\.omp\agent" "$HOME\.omp\agent.backup"
```

还原时先退出 Tern / omp，再把 `config.yml`、`models.yml` 和 `config.yaml` 拷回 `~/.omp/agent`。`config.yaml.magpie-backup` 是迁移前的原文件，也可以直接改回 `config.yaml` 使用。

### 卸载插件

先把模型还原，再移除插件：

```powershell
magpie tern default
magpie plugin rm "C:\path\to\magpie-plugin-tern"
```

`magpie plugin rm` 只认安装时记录的目录路径。用 `magpie plugin --json` 查看 `plugins[].spec`，原样复制那个路径；在 Windows 上优先用反斜杠的 `C:\...`。只移除插件不会自动删除已经写入 `~/.omp/agent` 的模型和 provider，所以建议先执行 `magpie tern default`。

## 已知限制

- **只对 Tern 默认的 omp agent 生效。** 如果你在 Tern 的 `agents.custom` 里换了别的 agent，或改掉了 agent command，本插件不管理那个 agent 的模型。
- **只写默认 profile。** 设置了 `OMP_PROFILE` 或 `PI_PROFILE` 时，omp 会改读 `~/.omp/profiles/<名字>/agent/config.yml`；本插件只写 `~/.omp/agent/`。可用 `omp config path` 确认 omp 实际读取的位置。
- **omp 在启动时读配置。** Tern 里已经打开的 agent 块不会热更新；关闭后重新打开 agent 块（或重启 Tern）才生效。
- **不管理登录和 key。** `providers.magpie` 使用 `auth: none`，请求发到本机 magpie gateway；模型由 magpie 路由。插件不写 `omp` 的登录状态或其他 provider。
- **共享文件冲突。** 与内置 `omp` 行共用 `models.yml` 和 `config.yml`；处理方式见上文。内置 `omp` 行写出的 provider 还带 `compat.promptCacheSessionHeader`、`headers.User-Agent: omp` 等字段；本插件的 `connect` 只写 `baseUrl`/`api`/`auth`/`models`，从内置行切到 Tern 行时这些字段会丢失（模型仍可用，但少了缓存/UA 细节）。
- **`magpie tern default` 的残留。** 它会移除 `modelRoles.default` 和 `models.yml` 的 `providers.magpie`，但 `enabledModels` 里已经追加的 `magpie/**` 会保留。通常无害；介意的话手动删掉那一项。
- **配置文件格式随 omp 变化。** 已在 omp 18.20.2 上验证；omp 大版本升级后，`models.yml` 字段（如 `thinking`）可能需要更新插件。

## 兼容性

- magpie 0.1.4266（`startup`、`prefix`、`connect` 均可用）
- omp 18.20.2（Tern 0.9.21 自带）
- Tern 0.9.21

## 包名与发布

当前包名是 `magpie-agent-tern`。这是个人发布，不是 magpie 官方组件；GitHub 仓库 `0723hehehe-cloud/magpie-agent-tern` 带 topic `magpie-plugin`，magpie 的 Discover 会以未审核卡片显示，也可以 `magpie plugin add github:0723hehehe-cloud/magpie-agent-tern` 直接安装。

## License

MIT。见 [LICENSE](./LICENSE)。
