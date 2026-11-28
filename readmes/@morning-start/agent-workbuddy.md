# Magpie Agent for WorkBuddy

[![npm](https://img.shields.io/npm/v/@morning-start/agent-workbuddy)](https://www.npmjs.com/package/@morning-start/agent-workbuddy)
[![license](https://img.shields.io/npm/l/@morning-start/agent-workbuddy)](LICENSE)
[![magpie-plugin](https://img.shields.io/badge/topic-magpie--plugin-3ddc97)](https://github.com/topics/magpie-plugin)

在 WorkBuddy（腾讯 WorkBuddy 桌面端）的模型菜单里用 [magpie](https://usemagpie.ai) 配置的模型和路由组。插件在 magpie 的 Agents 页新增一行 **WorkBuddy (Magpie)**，打开它，magpie 的模型目录就写进 `~/.workbuddy/models.json`；关掉它，写进去的条目原样撤回。

WorkBuddy 直接调用 magpie 的网关，所以没有本地代理、没有第二个端口，也不需要在 WorkBuddy 里手工填地址。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| WorkBuddy | 在 WorkBuddy 5.11.3（Windows，Electron 桌面端）上验证。模型条目按 WorkBuddy 自己的 `isValidLocalCustomModel` 规则生成。 |
| magpie | 需要支持 Agent 插件的 magpie。插件只写 `~/.workbuddy/models.json`，不读 WorkBuddy 的内部数据库。 |
| 平台 | Windows、macOS、Linux 都可以：只用 `~/.workbuddy` 下两个 JSON 文件。 |

`~/.workbuddy` 是 WorkBuddy 的数据目录；Windows 上是 `%USERPROFILE%\.workbuddy`。

## 安装

先在 magpie 里配好至少一个供应商（模型列表不是空的），再安装：

```sh
magpie plugin add npm:@morning-start/agent-workbuddy        # npm 上的最新版
magpie plugin add npm:@morning-start/agent-workbuddy@0.2.0  # 钉住某个版本
```

`npm:` 前缀让 magpie 直接去 npm 装，不先查社区插件列表 —— 网络读不到 `raw.githubusercontent.com` 时（国内常见），不带前缀的 `magpie plugin add @morning-start/agent-workbuddy` 会失败，加前缀就好。

从源码装（永远跟 `main` 最新）：

```sh
magpie plugin add github:morning-start/magpie-agent-workbuddy
```

在本仓库目录里开发时：

```sh
magpie plugin add .
```

## 使用

1. magpie → **Agents** → **WorkBuddy (Magpie)**，打开开关（列表里没有就展开底部「显示其余」）。
2. 插件把 magpie 的模型目录写进 `~/.workbuddy/models.json`，条目带 `vendor: "Custom"`。
3. 打开 WorkBuddy 的模型菜单，选 magpie 的模型，直接开始对话。

**打开着的模型菜单不会自己变。** 在 magpie 里加了或删了模型，等几秒同步完成，再关掉并重新打开菜单（或重启 WorkBuddy）。

### 和 magpie 自带的 WorkBuddy 行共存

较新的 magpie 自带一行 **WorkBuddy**（id `workbuddy`），也写同一个 `~/.workbuddy/models.json`。两行都开会让同一个模型出现两份，请只用其中一个：

- 用本插件：把 magpie 自带的 WorkBuddy 行关掉；
- 用自带那一行：本插件关掉即可，它会把自己写的条目全部撤回。

即使两行同时打开也不会互相破坏：本插件只改自己写过的条目，**已有的同名条目（自带行写的、你手写的）一律不动**，只做跳过。

## 能力

| 功能 | 行为 |
| --- | --- |
| 模型目录 | magpie 提供给这个 Agent 的模型和路由组，全部写进 `models.json` |
| 模型能力 | 图片、上下文长度、输出长度、思考档位（`none` 只映射成「可以关掉思考」，不进档位列表） |
| 请求转发 | WorkBuddy 直接请求 magpie 网关：流式、图片、工具调用、思考参数都交给网关处理 |
| 目录刷新 | 每 5 秒看一眼 magpie 写的连接文件；模型或网关密钥变了就更新 |
| 用户改动 | 在 WorkBuddy 里手改过的条目保持你的版本，插件不再覆盖 |
| 移除与断开 | 只删除插件新建的条目；没碰过的条目一律保留 |
| 资源库 | MCP 服务器写进 `~/.workbuddy/mcp.json`（`{"mcpServers": …}`），技能放进 `~/.workbuddy/skills` |

图片、工具和思考能力取决于所选上游；上游限流、余额不足和套餐到期照原样报错。

## 工作原理

`connect()` 在 `workbuddy.agent.js` 里，跑在 magpie 的 moejs 里：它返回网关地址、这个 Agent 自己的网关密钥和整个模型目录，magpie 把它们写进 **自己** 的文件 `~/.workbuddy/magpie-local.json`。这个文件由 magpie 负责写入和还原，关掉开关就恢复原样。

`index.mjs`（Bun 模块，跑在 magpie 的插件宿主里）读那个连接文件，把每个模型翻译成一条 WorkBuddy 模型条目，写进 `~/.workbuddy/models.json`：

```jsonc
{
  "id": "deepseek/deepseek-chat",   // magpie 的模型 id，原样交给网关
  "name": "DeepSeek Chat",
  "vendor": "Custom",
  "url": "http://127.0.0.1:3425/v1", // 网关 /v1 地址；WorkBuddy 自己接 /chat/completions
  "apiKey": "……",                   // 这个 Agent 自己的网关密钥，用量记在 workbuddy-local 名下
  "supportsToolCall": true,
  "supportsImages": true,
  "supportsReasoning": true,
  "useCustomProtocol": false,
  "reasoning": { "supportedEfforts": ["low", "high", "max"], "defaultEffort": "high", "canDisableThinking": true },
  "maxInputTokens": 131072,
  "maxOutputTokens": 8192
}
```

写入规则：

- **只碰自己写的条目。** 台账 `~/.workbuddy/magpie-local-managed.json` 记录插件新建了哪些 id、写进去的内容指纹是多少。没有台账记录的条目（自带 WorkBuddy 行写的、你手写的）永远不动。
- **`models.json` 永远是数组。** 写的时候整文件写成一个条目数组（WorkBuddy 自己的写法），你的条目和顺序都保留；`{"models": […]}` 这种外壳能被读进来，写回时规整成数组。写之前比对内容，没变化就不写。
- **不跟 WorkBuddy 抢着写。** 动手前再核对一次文件的修改时间和大小：如果规划这一轮的时候 WorkBuddy 自己写过它，这一轮就放弃，下一轮重新读、重新规划。
- **读不懂的 `models.json` 不动。** 解析失败只在状态里报 `models_unreadable`，绝不拿空列表覆盖它（UTF-8 BOM 会被容忍）。

## 诊断

```sh
magpie-workbuddy setup     # 目录在哪、文件在不在、上次同步什么状态
magpie-workbuddy status    # 上一次同步做了什么（就是 ~/.workbuddy/magpie-local-status.json）
magpie-workbuddy models    # models.json 里本插件写了哪些条目
magpie-workbuddy sync      # 立刻同步一次，不等 5 秒
magpie-workbuddy restore   # 立即撤回本插件写的条目（卸载前用）
```

`magpie-workbuddy` 来自包里的 `bin`。没在 PATH 上时，在插件目录里用 `node cli.mjs setup`、`node cli.mjs sync`。

| 文件 | 位置 | 谁写 |
| --- | --- | --- |
| 连接信息 | `~/.workbuddy/magpie-local.json` | magpie（`connect()`） |
| 模型台账 | `~/.workbuddy/magpie-local-managed.json` | 本插件 |
| 同步状态 | `~/.workbuddy/magpie-local-status.json` | 本插件 |
| WorkBuddy 模型 | `~/.workbuddy/models.json` | WorkBuddy 和本插件 |

连接信息里有网关密钥，**不要贴到 issue 里**。

## 卸载

1. magpie → Agents → 关掉 **WorkBuddy (Magpie)**，等状态变成 `disconnected`；
2. 想确认干净：`magpie-workbuddy status`，`removed` 里应列出它写过的 id；
3. `magpie plugin rm @morning-start/agent-workbuddy`。

如果先删了插件、条目还留在 WorkBuddy 里，直接在 WorkBuddy 的模型设置里删掉它们即可。

## 开发与验证

仓库里的 [AGENTS.md](AGENTS.md) 记了数据流、改代码的铁律、以及 WorkBuddy 5.11.3 里核对过的字段事实（改字段前请重新核对）。[CHANGELOG.md](CHANGELOG.md) 记每个版本。

```sh
bun test        # 29 个单元测试，不需要 magpie、WorkBuddy 或网络
```

测试覆盖：条目字段符合 WorkBuddy 的校验规则、`connect()` 的输出、目录变化/手改/跳过/撤回的每一条规则、WorkBuddy 自己写文件时的并发保护，以及用临时 home 跑完整同步流程。

在一个隔离的 magpie 沙箱里验过（自己的 HOME、自己的网关端口）：

```sh
magpie plugin add .
magpie workbuddy-local provider magpie     # 打开这一行，等价于界面上的开关
magpie agents                             # 看到 WorkBuddy (Magpie)
```

宿主日志里会打印 `[workbuddy-local] connected · N offered`，`~/.workbuddy/models.json` 里出现对应的条目；`magpie workbuddy-local default` 之后同一个文件回到 `[]`。

## 发布

版本号只改 `package.json`，tag 跟着它走：

```sh
git tag v0.1.1 && git push --follow-tags
```

[.github/workflows/publish.yml](.github/workflows/publish.yml) 会核对 tag 与版本、核对 `repository` 指向本仓库、跑 `bun test`，再 `npm publish --provenance`。首版在 npm 上还不存在，没有 trusted publisher 可用：二选一，给仓库加 `NPM_TOKEN` secret 照常打 tag，或本地 `npm publish --access public` 发一次。

让别人找到它：把 [registry-entry.json](registry-entry.json) 那一段加进 `magpie-community/plugins` 的 `registry.json`（提 PR），或者给 GitHub 仓库打 `magpie-plugin` topic，出现在「插件 → 发现 → 非官方插件 · GitHub」。

## 许可

MIT。