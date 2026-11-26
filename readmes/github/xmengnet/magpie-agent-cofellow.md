# magpie-agent-cofellow

让 **Magpie** 驱动 **CoFellow** 的模型。

装好之后，Magpie 的 Agents 页会出现一行 CoFellow。在 Magpie 里给它选任意模型
（DeepSeek、Kimi、GLM、Qwen、Claude/ChatGPT 订阅……），Magpie 会改写
`~/.cofellow/config.json`，CoFellow 自动热加载——正在跑的会话不需要重启。

> 让每个 agent 都能用每个模型：CoFellow 只是 Magpie 支持的 agent 之一。

## 要求

- **CoFellow**：配置 schema v2（顶层 `provider` / `models` 按 id 命名，
  2026-11-26 之后的版本）。旧版 `providers` 数组会在 `LoadConfig` 时报错，
  按提示迁移即可。
- **Magpie**：支持 agent 插件的版本。
- CoFellow 的数据目录是 `~/.cofellow`（可用 `COFELLOW_HOME` 重定向）。

## 安装

从文件夹（开发时）：

```bash
magpie plugin add ./magpie-agent-cofellow
```

从 GitHub：

```bash
magpie plugin add github:<owner>/magpie-agent-cofellow
```

发布到 npm 后：

```bash
magpie plugin add magpie-agent-cofellow
```

在 GitHub 仓库上打 `magpie-plugin` topic，它会出现在 Magpie 的
Plugins → Discover → Unofficial。

## 使用

```bash
magpie cofellow deepseek/deepseek-chat   # 让 CoFellow 用这个模型
magpie cofellow default                  # 退出，恢复 CoFellow 原来的模型
```

也可以在 Magpie 窗口的 Agents 页里选模型 / 关掉开关。CoFellow 端的模型胶囊、
上下文窗口、思考档位会跟着更新。

## 它往 config.json 里写了什么

只写 Magpie 自己的三块，**不碰用户已有的 provider**：

```json
{
  "provider": {
    "magpie": {
      "name": "magpie",
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:3425/v1",
      "apiKey": "…",
      "enabled": true,
      "models": {
        "deepseek/deepseek-chat": {
          "name": "DeepSeek Chat",
          "contextWindow": 128000,
          "maxOutputTokens": 8192,
          "supportsTools": true,
          "reasoningLevels": ["low", "medium", "high"],
          "enabled": true
        }
      }
    }
  },
  "selection": {
    "providerId": "magpie",
    "modelId": "deepseek/deepseek-chat",
    "reasoningLevel": "high"
  },
  "model": {
    "baseUrl": "http://127.0.0.1:3425/v1",
    "apiKey": "…",
    "modelName": "deepseek/deepseek-chat",
    "providerId": "magpie",
    "protocol": "openai"
  }
}
```

- `provider.magpie`：Magpie 的全部模型（含窗口、输出上限、视觉、思考档位）。
- `selection`：让 CoFellow 的 `ResolveSelection` 解析到 Magpie。
- `model`：保证**冷启动**也直接走 Magpie（Magpie 自己写 `model.modelName`）。
- 卸载时 Magpie 会删除 `provider.magpie` 并恢复 `selection` / `model`，
  CoFellow 回到自己的 provider。

## Library

插件把 Magpie Library 接到 CoFellow 实际读取的位置：

| Library | CoFellow |
| --- | --- |
| Instructions | `~/.cofellow/AGENTS.md` |
| Skills | `~/.cofellow/skills` |
| MCP servers | `~/.cofellow/config.json` 的 `mcpServers`（`claude` 格式，逐条写入） |

## 切回 CoFellow 自己的模型

Magpie 的模型选择器里也会列出 CoFellow 自己的模型（`own`）：

- 同一个 provider 内换模型：直接选，CoFellow 会采用只改 `model.modelName`
  的那次写入。
- 跨 provider 或完全退出：`magpie cofellow default`，或关掉 Agents 页的开关。
  Magpie 会把整个 `provider` / `selection` / `model` 恢复原样。

## 限制

- CoFellow 的模型记忆是**会话级**的：显式选过模型的会话保留自己的选择；
  跟随全局模型的会话会跟着 Magpie 切换。需要所有会话都跟随，请在
  CoFellow 里不要给会话单独选模型。
- Magpie 的「切回自有模型」只在目标模型属于当前 provider 时生效；跨 provider
  请用 `magpie cofellow default`。

## 开发

```bash
bun test                 # agent 描述 / connect / own 的单元测试
bash scripts/try.sh      # 临时 HOME 里的 magpie 端到端（不碰真实配置）
```

`agent.js` 运行在 Magpie 的 moejs 里：没有 Node API、没有定时器、不能 import
包外文件。新增逻辑请保持这个边界。

## English

Magpie agent plugin for CoFellow: pick any magpie model for CoFellow in the
Agents page. magpie writes one `provider.magpie` entry plus `selection` and
`model` into `~/.cofellow/config.json`, and CoFellow hot-reloads it. Unwiring
restores the file. Requires a CoFellow build with the v2 config schema
(`provider` / `models` keyed by id). Library instructions, skills and MCP
servers are wired to `~/.cofellow/AGENTS.md`, `~/.cofellow/skills` and the
config's `mcpServers`.

## License

MIT