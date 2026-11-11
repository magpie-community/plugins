# OhMyGame · Magpie Agent

把 OhMyGame 接进 Magpie 的 Agents 页：Magpie 统一分配语言模型、按专属网关密钥把请求归因成 OhMyGame，并在 Agents 页底部和侧栏提供生图模型勾选面板。

仅支持 macOS（OhMyGame 数据目录写死为 `~/Library/Application Support/OhMyGame`）。已在 Magpie 0.1.2891 与 OhMyGame beta.5.4 上验证。

## 安装

从 GitHub（建议固定版本 tag）：

```sh
magpie plugin add github:Triple3h/magpie-agent-ohmygame#v0.2.0
```

或指向本地目录：

```sh
magpie plugin add /path/to/magpie-plugins/magpie-agent-ohmygame
```

安装后 Magpie 的 Agents 页出现 **OhMyGame** 一行。CLI 只负责连接服务商：

```sh
magpie ohmygame provider magpie
```

选模型请在 Agents 页那一行操作；`magpie ohmygame <model>` 会断开连接。OhMyGame 需 ⌘Q 重启才会读取新配置。

## 生图模型

勾选入口有两个：Agents 页**最底部**（在「方案 / 保存当前」页脚下面）和侧栏「插件 → OhMyGame 生图模型」。前端只在页面加载时拉取一次插件页面/面板列表，新装或改过 `package.json` 后要刷新 Magpie 窗口。

- 候选：`workbuddy-ai/hy-image-3.5`、`workbuddy/hunyuan-image-alpha`。Magpie 的出图模型不在 `/v1/models`，所以是内置白名单。
- 勾选值存 `magpie plugin options`；Bun host 每 2 秒同步到 OhMyGame 的 `data/model-visibility.json`，写入 `customProviders.magpie`（`usages.image` / `openai-images`）。
- 同时把 `pi-agent/models.json` 的语言模型以 `usages.language` 合并进同一清单，避免 OhMyGame 的服务商页只剩图片模型。
- 断开 agent 时自动还原，原始值备份在 `data/.magpie-ohmygame-visibility.json`。
- **不改** `defaultImageModel`；要用 Magpie 出图，在 OhMyGame 设置的「图片」下拉里手动切。

改完必须 ⌘Q 重启 OhMyGame。

## 写了哪些文件

| 文件 | 谁写 | 内容 |
|---|---|---|
| `pi-agent/models.json` | agent 的 `connect()` | `providers.magpie`：网关地址、`magpie-ohmygame` 密钥、`compat.sendSessionAffinityHeaders`、语言模型 |
| `pi-agent/settings.json` | agent 的 `startup` | `defaultProvider` / `defaultModel` |
| `data/model-visibility.json` | Bun `main` host | `customProviders.magpie`（语言模型 + 勾选的出图模型） |

前两个文件由 Magpie 自动 stash / 还原；第三个由 host 自己备份还原。语言模型的 `contextWindow` / `maxTokens` 来自 Magpie 的 `/v1/models`，推理档位来自 Magpie catalog 的 `efforts`。

## 限制

- 请求靠密钥归因为 `ohmygame`，不靠 User-Agent（OhMyGame 用 Pi 运行时，UA 会说 `pi`）。
- `compat.sendSessionAffinityHeaders` 让 Pi 发 `x-session-affinity`，网关就能记会话标识；可读的会话名称仍需 OhMyGame 提供 `X-Magpie-Session` 或 Magpie 加标题读取器。
- `connect()` 拿不到 `reasoning` 字段，插件用 `efforts.length > 0` 推断；「支持推理但没列 efforts」的模型会被漏标。
- 出图模型的 `contextWindow` / `maxTokens` 是占位值：它走 `openai-images`，不经过 chat completions。
- 只验证过 macOS 单机；Windows / Linux 的 OhMyGame 数据目录不同。

## 开发

```sh
node --test ohmygame.test.mjs
magpie plugin add .
```

无运行时依赖，只用 Node / Bun 内置模块。测试用隔离 HOME 验证写入、幂等与断开还原，不碰真实 OhMyGame 配置。

## 许可证

MIT
