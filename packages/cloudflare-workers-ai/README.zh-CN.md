# @magpie-community/opencode-cloudflare-workers-ai-auth

[English](README.md) | 简体中文 | [日本語](README.ja.md)

[![npm version](https://img.shields.io/badge/npm%20version-0.0.1-EA4335.svg)](https://www.npmjs.com/package/@magpie-community/opencode-cloudflare-workers-ai-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-FBBC05.svg)](https://opensource.org/licenses/MIT)

面向 [OpenCode](https://opencode.ai) 1.x 和 [magpie](https://usemagpie.ai) 的供应商插件：
用你的 API Token 登录 **Cloudflare Workers AI**，让它成为所有 Agent 都能选的供应商。
从 [models.dev](https://models.dev) 实时发现 28+ 个模型，付费专属模型自动标注，
付费专属模型自动打标，`magpie quota` 显示每日 Neurons 额度窗口。

> 与 Cloudflare 无隶属或背书关系。

## 前置要求

| 项目 | 在哪里找 |
|---|---|
| Cloudflare Account ID | 控制台首页（Account home）右侧栏，32 位十六进制 |
| Cloudflare API Token | 控制台 → 头像 → **My Profile** → API Tokens → 创建 **Custom Token**，授权 `Account → Workers AI → Edit`（想让 `magpie quota` 显示套餐名，再加 `Account Settings → Read`） |
| magpie | 0.1.1110 及以上，或 OpenCode 1.x |

Token 不需要选择任何 Zone。Free 与 Paid 两个计划均含 **每日 10,000 Neurons** 免费额度；
有 8 个前沿模型需要 Workers Paid 或 AI Gateway 预充值（下文有标注）。

## 在 magpie 中安装

```sh
magpie plugin add @magpie-community/opencode-cloudflare-workers-ai-auth   # 从 npm
magpie plugin add /path/to/folder                                        # 本地副本
```

然后登录：

```sh
magpie plugin login cloudflare-workers-ai
```

| 提示 | 填什么 |
|---|---|
| API Token | 上表中的 Workers AI:Edit token |
| Account ID（可选） | 32 位十六进制；留空则使用插件 options 里的 `accountId` |

- 每次登录 = 一个账号。再登录一次即可添加新账号（比如 Free 账号 + Paid 账号）——
  magpie 会在它们之间自动故障切换（failover），`magpie quota` 会分账号显示。
- 用相同 Account ID 再次登录会替换该账号（例如轮换 token）。登录信息只保存在
  magpie 自己的账号存储里，不会写到其他地方。
- 如果 Cloudflare 拒绝 token，magpie 会标记该账号并提示重新登录。

## 你实际会用到的命令

```sh
magpie providers                                                          # 已登录？
magpie provider test cloudflare-workers-ai                                # 一条小请求（沙盒约 300 ms）
magpie provider test cloudflare-workers-ai @cf/meta/llama-3.3-70b-instruct-fp8-fast
magpie quota                                                              # 套餐 + Neurons/日 窗口
magpie claude cloudflare-workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast   # 让 Claude Code 用上
magpie codex cloudflare-workers-ai/@cf/openai/gpt-oss-120b                    # Codex 同理
magpie plugin logout cloudflare-workers-ai                                # 删除登录
```

模型命名为 `cloudflare-workers-ai/@cf/<org>/<model>`——ID 与
[models.dev](https://models.dev) 中该供应商的目录一致，每小时刷新。

### 在 OpenCode 1.x 中使用

`opencode.json`：

```json
{ "plugin": ["@magpie-community/opencode-cloudflare-workers-ai-auth"] }
```

然后 `opencode auth login` → Cloudflare Workers AI（同样的两个字段）。

## 付费专属模型

8 个模型被 Cloudflare 限制在 Workers Paid 或 AI Gateway 预充值之后，名字中标注 **(Paid)**：

`@cf/moonshotai/kimi-k2.6`、
`@cf/moonshotai/kimi-k2.7-code`、`@cf/zai-org/glm-5.2`、`@cf/zai-org/glm-5.3`、
`@cf/zai-org/glm-5.3-flash`、`@cf/deepseek-ai/deepseek-v4-flash-0731`、
`@cf/deepseek-ai/deepseek-v4.1-flash-1017`、
`@cf/deepseek-ai/deepseek-v4-pro-0813`

其余模型只消耗共享的每日 10,000 Neurons 额度（Paid 计划超出部分会计费），
因此设计上不给任何模型打 free 徽章。

## 插件选项

```sh
magpie plugin options opencode-cloudflare-workers-ai-auth '{"accountId": "…", "discoveryTTLMs": 1800000}'
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `accountId` | — | 登录时留空所用的默认 Account ID |
| `apiKey` | — | 默认 token（登录时的 key 优先） |
| `baseTemplate` | `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1` | 插值模板 |
| `discoveryTTLMs` | `3600000` | 目录刷新间隔 |

## 排障

| 你看到 | 意味着 |
|---|---|
| 模型列表为空 / 供应商没出现 | 重新 `magpie plugin add .`，再看 `magpie plugin --json` 的 `error` 字段（目录拉取失败或 token 被拒） |
| `magpie: the sign-in failed: 需要 API Token` | token 输入框留空了——重新执行 `magpie plugin login cloudflare-workers-ai` |
| `provider test` 返回 401 `Authentication error` | token 被拒：核对权限（`Workers AI:Edit`）或重新登录 |
| `provider test` 返回 403 | token 与 Account ID 不匹配 |
| 400 `No route for that URI` | 重新 `plugin add` 后仍出现，说明插件是旧版本——现版本代理已做 URL 归一化，可提 issue |
| `Model … absent from the current catalog` | 模型 ID 不在 models.dev 的 cloudflare-workers-ai 分节里，请从列表中选择 |
| (Paid) 模型返回 400 | 你的计划是 Free，该模型需要 Workers Paid 或 AI Gateway 预充值 |
| quota 行显示套餐兜底文案 | token 缺 `Account Settings → Read`；仅影响显示，Neurons 窗口照常展示 |

## 开发

```sh
node --check src/index.mjs       # 语法防线（本 fork 起初修的核心 bug）
node --test                      # 11 项测试，无需联网
sh scripts/sandbox.sh login      # 在一个用完即弃的 HOME 里跑 magpie
sh scripts/sandbox.sh test       # 沙盒内 provider test
sh scripts/sandbox.sh json       # 沙盒内 plugin --json
```

`scripts/sandbox.sh` 的 HOME 固定在 `.sandbox/`（已 git-ignore），不会碰你真实
的 magpie、Agent 和登录信息。

## 插件契约要点

- 单一 async 插件函数；导出 `config`、`auth.methods`（带 `password` prompts 的单一
  `api` 方式）、`auth.loader`、`auth.usage`、`provider.models`
- `loader(getAuth, provider)` 按契约账号形态读取（`auth.key`、
  `auth.metadata.accountId`）；兼容 OpenCode 旧的多方法形态
- `authorize` 返回 `{ type: "success", key, metadata }` / `{ type: "failed", error }`
- 目录拉取失败时，`config()` 降级为空模型列表而不是抛错；随后账号级
  `provider.models` 提供缓存目录
- 单文件、零运行时依赖、ESM，`node >= 20`

## 版本 / 许可证

| | |
|---|---|
| **版本** | [`0.0.1`](CHANGELOG.md) |
| **许可证** | [MIT](LICENSE) — Copyright (c) 2026 Guislabert |
| **运行时** | Node.js >= 20，仅 ESM |
| **作者** | [@Guislabert](https://github.com/Guislabert) |
| **语言** | [English](README.md) · [日本語](README.ja.md) |

MIT © [Guislabert](https://github.com/Guislabert)
