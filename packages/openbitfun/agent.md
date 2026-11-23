# OpenBitFun 插件：关键信息档案

给后续会话和协作者的工程记录。面向用户的部分在 README.md，本文件只记「为什么这样做」和「改动前必须知道的硬约束」。

## 目标

让 OpenBitFun 出现在 magpie 的 Agents 页。打开开关后，magpie 的模型目录进入 OpenBitFun 的模型设置，可直接选用；关掉开关后，OpenBitFun 的配置文件逐字还原。不改动 OpenBitFun 上游。

## 两个进程，各写一半

magpie 写不了这一步，原因在它的写入方式。它按「键路径」逐条编辑配置文件，而 OpenBitFun 把所有模型放在一个数组 `ai.models` 里。用一条键整组写入会覆盖用户自己的条目，所以分工如下。

1. `openbitfun.agent.js` 跑在 moejs 里（magpie 进程内，单文件，无 import，无 Node API）。它是开关型 agent（没有 `model` 键），`connect` 只写 magpie 自己的文件 `~/.config/magpie-openbitfun/bridge.json`，一个键 `bridge` 装全套内容。
2. `index.mjs`（Bun，插件 host 里的 `main`）起一个桥，读那个文件，把条目合并进 OpenBitFun 的 `app.json`。`bridge.mjs` 是它全部逻辑所在，纯函数、可单测。

`bridge.json` 的键 `bridge` 存在即「已连接」，不存在即「已关闭」。这是唯一的连接状态，不另存标志。

## 硬约束与出处

改动下列任何一条前，先读 OpenBitFun 源码里的对应文件。

| 事实 | 出处 |
|---|---|
| OpenBitFun 已有 `magpie` 供应商预设，`requires_api_key: false` | `src/shared/ai-provider-catalog/providers.json` |
| 模型目录从网关活取，探活先 GET `/api/hello` 要求 `name == "magpie"`，再 GET `/v1/models` | `src/crates/adapters/ai-adapters/src/magpie.rs` |
| 用户在 OpenBitFun 里手动连 magpie 的产物就是往 `ai.models` 追加条目 | `src/web-ui/src/infrastructure/config/services/magpieModels.ts` 的 `mergeMagpieModels` |
| 条目靠 `metadata.model_source === "magpie"` 识别，靠 `provider_instance_id` 分组 | `src/web-ui/src/infrastructure/config/services/modelConfigs.ts` |
| 模型 id 用模型名，冲突加 `-2` 后缀，`primary`/`fast`/`auto`/`default` 是保留字 | `modelConfigs.ts` 的 `allocateModelConfigId` |
| context 小于 32000 或数值非法的模型不导入 | `magpieModels.ts` 的 `magpieModelImportIssue` |
| `max_tokens` 不超过 context 的 40%，context 未知时按 128128 算 | `magpieModels.ts`；`config-contracts/src/types.rs` 的 `MAX_CONFIGURED_OUTPUT_TOKENS_RATIO_PERCENT` |
| 配置路径 `dirs::config_dir()/openbitfun/config/app.json`，`data_namespace()` 恒为 `openbitfun` | `app_paths/path_manager.rs`；`core-types/src/product_identity.rs` |
| 外部改动会被热加载，不需要重启 OpenBitFun | `config/service.rs` 的 `reload_if_changed_on_disk`，测试 `reload_if_changed_on_disk_picks_up_external_edits_only` |
| magpie 的 agent 契约：`magpie.agent`、开关型无 `model`、`connect` 键路径写入、关闭时还原、带定时器或文件操作时加 Bun `main` | <https://usemagpie.ai/docs/plugins>，先例 `packages/kimi-desktop`、`packages/zycode` |

## 我们自己定的

- **实例标记** `provider_instance_id` 固定为 `magpie-openbitfun`。OpenBitFun 自己的导入器用随机 UUID，所以两边永不互相误认。
- **`function_calling` 一律标上**。magpie 的 agent 目录不告诉插件模型是否支持工具调用，而 magpie 网关对每个供应商都翻译工具调用。这是与 OpenBitFun 原生导入的一处已知差异，写在 README 里。
- **模型从目录消失就从列表移除**，对齐「镜像 magpie」这个目的。但 magpie 报空目录时什么都不动，因为空目录意味着 magpie 还没算好，不是它一个模型都没有。
- **原文快照** `state.json` 存首次写入前的 `app.json` 原文。还原时若语义等价就整段写回原文，避免 `1.0` 被重新序列化成 `1` 这类数字写法差异。用户中途手改过就按条目还原，牺牲写法保内容。
- **`app.json` 绝不新建**。OpenBitFun 从没运行过时明确拒绝，不造半截配置。

## 资源库（Library）

magpie 的资源库能给 agent 三样东西，`agent.library` 声明收件路径。这里逐项说明，因为三样里只通了两样。

**skills 通。** `library.skills` 指向 `$APPDATA/openbitfun/skills`，就是 OpenBitFun 的 `user_skills_dir()`（`path_manager.rs`，Windows 用 `dirs::data_dir()`，macOS 用 `~/Library/Application Support`，Linux 用 `~/.local/share`）。布局两边一致，`<root>/<name>/SKILL.md`（OpenBitFun 侧见 `skills/registry.rs`，它是第一等技能根，优先级 0）。声明的是 Windows 形状，因为 `agent` 是静态对象，没法按平台分支。

**mcp 通，走一次中转。** OpenBitFun 把 MCP 服务器存在 `app.json` 的 `mcp_servers.mcpServers` 里（`mcp/config/json_config.rs` 自己说是 Cursor 格式），magpie 只能给 agent 一个文件。所以 `library.mcp` 指向本插件自己的 `~/.config/magpie-openbitfun/library/mcp.json`，`mcpFormat: "cursor"`，由桥合并进 `app.json`，命名冲突时记下用户原值，关闭时原样还回。

**instructions 不通。** OpenBitFun 的指令只按工作区读（`workspace_instructions.rs`：`AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules`），没有全局用户级指令文件；`data/rules/` 目录建了却没有任何读取方。magpie 的共享指令是写进一个固定文件给 agent 每次会话读，OpenBitFun 没有这样的文件，所以不声明 `instructions`。硬塞会导致“声明了却读不到”，比不声明更糟。

## 已知边界

- `app.json` 由两个进程写：桥和 OpenBitFun 自己。写入用临时文件加原子重命名，窗口极短，最坏是同一瞬间用户的一次设置保存被覆盖。首次连接建议先退出 OpenBitFun。
- **解析降级**：`bridge.json` 与 `library/mcp.json` 若不是合法 JSON（手改或半写），按「未连接」处理——`sync()` 返回 `disconnected`，OpenBitFun 的文件原样保留。桥是每秒轮询的读侧，降级让桥继续工作；若抛 `SyntaxError`，会被 `startBridge` 的 `.catch` 吞掉并打一行 pause，桥整体停摆。`wanted()` 顶部注释的既定语义就是「半写或手坏的文件让 OpenBitFun 独自留着」。
- **符号链接纪律**：`read()` 显式拒绝符号链接（`!isFile() || isSymbolicLink()`），与 `packages/deepzora`、`packages/reasonix-desktop` 逐字对齐；`write()` 用 `lstatSync` 取 mode，不跟随链接，与读侧纪律一致。写路径本身（临时文件 + `flag:"wx"` + `renameSync`）不跟随链接，rename 替换的是路径本身、不写穿目标，是安全的。这是本地写入守卫，不是 OS 沙箱，也不做 nanobot 式的父目录 `realpathSync` 解析与写入前后 TOCTOU 复查——这些目录由系统/应用管理，父目录被替换成链接的概率极低，引入会增加一次 FS 调用和 TOCTOU 窗口。
- **条目校验**：`wanted()` 过滤掉非对象的模型条目（`null`、字符串、数字、数组）。`mergeModels` 的契约是「接收已校验的 want」，它对每个条目直接读 `.context`/`.output`，`null` 会抛 `TypeError`。类型过滤集中在 `wanted()` 这个「检查是否为有效指令」的入口，与 `capabilities()` 对网关条目逐项校验的纪律一致。
- `dir` 写的是 `$LOCALAPPDATA/OpenBitFun`，只是个「已安装」提示。非 Windows 上 `$LOCALAPPDATA` 为空，不影响功能。
- 桥每秒轮询一次，与 `zycode` 同节奏。
- 空 `mcpServers` 视为“收回”，而空模型目录视为“还不知道”，两者不同：magpie 清空资源库时会保留 `mcp.json` 并写空对象。

## 本地验证

```sh
# 单测（32 项，无网络、不碰真实配置）
~/.bun/bin/bun test packages/openbitfun/openbitfun.test.mjs

# 仓库检查
~/.bun/bin/bun scripts/check.mjs openbitfun

# 沙箱 magpie
MAGPIE="$APPDATA/magpie.exe" scripts/try.sh openbitfun
```

真机验证要跑一次往返：连接、看 OpenBitFun 出模型、发一次真实对话、关闭、比对 `app.json` 与连接前逐字一致。
