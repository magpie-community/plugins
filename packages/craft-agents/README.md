# magpie-agent-craft-agents

## 接入方式与已知限制

Craft Agents 使用两套模型后端：Anthropic 连接使用 Claude Agent SDK；其他兼容连接使用 Pi。本插件通过 Pi 兼容连接接入 Magpie。

目前 Craft Agents 向 Magpie 发送请求时，不会携带 Craft Agents 的专属应用标识。因此，通过本插件发出的请求将会被 Magpie 识别为 Pi，在路由、用量统计等界面中无法单独显示为 Craft Agents，并可能与其他 Pi 请求合并统计。这一限制需要 Craft Agents 官方适配，当前无法仅通过本插件解决，请在使用时留意。

此限制不影响模型调用，模型、Token 用量和费用仍按实际请求统计。

## Connection behavior and known limitation

Craft Agents uses two model backends: Anthropic connections use the Claude Agent SDK; other compatible connections use Pi. This plugin connects to Magpie through a Pi-compatible connection.

Craft Agents currently does not send a Craft Agents-specific application identifier with its requests to Magpie. Requests made through this plugin are therefore identified as Pi. They cannot appear separately as Craft Agents in routing, usage statistics, and related views, and may be grouped with other Pi requests. Resolving this limitation requires support from Craft Agents upstream; it cannot currently be solved by this plugin alone. Please keep this in mind when using the plugin.

This limitation does not affect model calls. Models, token usage, and costs are still recorded according to the actual requests.

## 中文说明

本插件将 Craft Agents 添加到 Magpie 的 Agents 页面。安装后，在 Craft Agents 对应行选择 Magpie 模型即可接入本地网关。

本地安装：`magpie plugin add /path/to/magpie-agent-craft-agents`。社区发布后安装：`magpie plugin add @magpie-community/agent-craft-agents`。

插件修改 `~/.craft-agent/config.json` 中的 `llmConnections` 和 `defaultLlmConnection`，写入网关地址、选定模型及模型列表；其他配置保持不变。原连接列表由 Magpie 备份，选择恢复默认配置时还原。接入期间请避免直接编辑被接管的连接列表，恢复操作会使用备份内容。

连接使用 `pi_compat` 和 `openai-completions`。本地端点使用占位 key `not-needed`，不读取或修改 Craft 的加密凭据文件。本插件不声明 Library 指令同步能力。请在新会话中确认模型选择生效。

开发时可使用 `magpie plugin add .` 安装本目录，使用 `magpie craft-agents magpie/<provider>/<model>` 选择模型，使用 `magpie craft-agents default` 恢复原连接。连接配置测试位于社区仓库的 `craft.test.mjs`。图标嵌入 `icon.js`，加载不需要联网。

作者：[HiJizo](https://github.com/HiJizo)。许可证：MIT。

## English

[Craft Agents](https://www.craft.do) (Craft's desktop agent app) as a magpie
agent. magpie has no setup of its own for Craft Agents; with this plugin it is
on magpie's Agents page like the agents magpie ships with: pick one of magpie's
models in its row and Craft Agents talks to magpie's gateway.

```sh
magpie plugin add /path/to/magpie-agent-craft-agents
```

or, once it is on npm:

```sh
magpie plugin add @magpie-community/agent-craft-agents
```

Then pick one of magpie's models in Craft Agents' row, or

```sh
magpie craft-agents magpie/deepseek/deepseek-flash
```

magpie writes into `~/.craft-agent/config.json` — the connection Craft Agents
then uses, with magpie's address, the picked model, and magpie's model list:

```json
{
  "llmConnections": [
    {
      "slug": "magpie",
      "name": "Magpie",
      "providerType": "pi_compat",
      "authType": "none",
      "baseUrl": "http://127.0.0.1:3425/v1",
      "defaultModel": "deepseek/deepseek-flash",
      "models": [{ "id": "deepseek/deepseek-flash", "name": "DeepSeek Flash", "contextWindow": 128000, "supportsImages": false }],
      "customEndpoint": { "api": "openai-completions" }
    }
  ],
  "defaultLlmConnection": "magpie"
}
```

Everything else in `config.json` — workspaces, sessions, migrations — is left
alone. Picking Craft Agents' own model again, or switching the plugin off,
puts every connection back as it was, in its original order.

## How it fits together

- `connect()` returns the whole `llmConnections` array, because Craft stores a
  connection as one object; magpie saves the array it replaces first, so the
  restore is exact.
- `authType: "none"` means no stored credential: Craft sends the placeholder
  `not-needed` to a localhost endpoint, which magpie's gateway accepts. Nothing
  in Craft's encrypted `credentials.enc` is touched.
- `customEndpoint.api: "openai-completions"` is what Craft's own "API Key"
  setup writes for an OpenAI-compatible endpoint. `pi_compat` connections get
  no default model list from Craft, so the list magpie writes stays.
- Craft reads the connection when a session starts and applies a model change
  to running sessions without a restart.
- Craft's backend sends pi's generic User-Agent (`pi (darwin …)`), which
  magpie's built-in Pi agent already claims, and `authType: "none"` sends no
  gateway key. So magpie's Usage lists Craft's requests under **pi**, not
  Craft Agents. The model, tokens and cost are right; only the agent name is.
  Declaring `ua: ["pi ("]` here does not fix it — magpie's own Pi agent
  matches first — and declaring an unrelated `ua` would never match at all.

## Develop

```sh
magpie plugin add .                       # install this checkout
magpie craft-agents magpie/<provider>/<model>
magpie craft-agents default               # put Craft's own connections back
```

`agent.config` must match `CONFIG_FILE` in `@craft-agent/shared/config/paths`.
The icon is embedded in `icon.js` so loading needs no network: it is Craft
Agents' own artwork rendered at 256×256 with the card full-bleed and the glyph
at 80% of the tile, so it carries the same visual weight as the built-in
agents' icons at the 16–20px magpie draws them at. (The app's `.icns` sits on
~9% transparent margin, which made it read a size smaller.) `icon-preview.png`
is that rendering next to the icon it replaced.

Avoid editing the managed connection list while connected: restoring defaults uses Magpie's saved snapshot. Library instruction synchronization is not advertised by this plugin. Verify model changes in a new session.

Author: [HiJizo](https://github.com/HiJizo). License: MIT.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
