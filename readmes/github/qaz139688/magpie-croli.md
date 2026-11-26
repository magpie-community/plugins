# Croli 免费模型 Croli Free Models for magpie

> 本项目基于 [MYCF711/magpie-croli](https://github.com/MYCF711/magpie-croli) 二次修改并维护，由 qaz139688 发布。原项目采用 MIT License，详见 [NOTICE.md](./NOTICE.md)。

**4 个已验证模型，一把 API Key，0 个官方客户端进程，0 条注入提示词。**

把 Croli 网关变成 magpie 里的原生 OpenAI 兼容供应商；调用时不启动 Croli、不经过 Agent，日常模型请求不依赖官方客户端登录文件。

```text
4 个流式对话模型
4 个图片输入实测通过
1 次导入，长期保存独立网关 Key
0 条附加 system / developer / instructions
```

---

## 功能

- **原生 API Key** —— 直接粘贴 `csk_...`，或由本机登录态一次性换取，之后脱离官方客户端。
- **四模型直通** —— 只展示已实测可用的 DeepSeek、GPT、Claude、Grok，不带入隐藏或失效别名。
- **提示词零注入** —— 不添加 Croli 客户端提示词，也不增删调用方的 system、messages、tools 或 schema。
- **流式原样返回** —— SSE 交给 magpie 转发，支持 `[DONE]`、Token usage、思考内容与工具调用。
- **图片输入** —— 四个模型均通过同一测试图识别验证。
- **错误正确分流** —— 登录失效、模型错误、限流、超时和上游不可用分别处理。
- **真实额度可选** —— 一次性导入时显示积分和每日试用额度；纯 API Key 模式不伪造额度读数。
- **自动签到与任务** —— 置顶开关控制每日签到和每日首聊，只有真实对话完成后才上报。
- **自动邀请链接** —— 置顶开关控制官方邀请链接展示；只缓存邀请码，不缓存或展示 token。
- **安全续期** —— 账户 JWT 由 Clerk 公共客户端续期，refresh token 仅保存在 Magpie 凭证库。

---

## 模型

**DeepSeek / OpenAI / Anthropic / xAI** —— 只保留以下四条已验证路由，实际上游可能经 OpenRouter、OpenCode 或 Magpie 中转。

| 发行商 | 模型 ID | 上下文 | 最大输出 | 文本 / 图片 |
|---|---|---:|---:|---|
| DeepSeek | `DeepSeek-V4.1-Flash` | 1,048,576 | 384,000 | ✓ / ✓ |
| OpenAI | `gpt-6-luna` | 1,050,000 | 128,000 | ✓ / ✓ |
| Anthropic | `claude-opus-5.5` | 1,000,000 | 128,000 | ✓ / ✓ |
| xAI | `grok-4.6` | 500,000 | 450,000 | ✓ / ✓ |

声明 `low / medium / high` 思考档；调用方也可以直接传原生 `reasoning_effort`。试用额度用完后可能消耗 Croli 积分，因此插件不会把这些模型误标成永久免费。

---

## 签到 / 每日任务 / 邀请

- **每日签到**：每天 100 积分，连续签到另有奖励；由 Magpie 按北京时间调用，重复执行保持幂等。
- **每日首次对话**：每天 200 积分，非流式确认 choices 或 SSE 完整结束后才上报。
- **一次性导入会话**：首次导入本地会话 100 积分，只读取状态，不伪造导入。
- **邀请链接**：每个 Croli 账号一个稳定官方链接，可重复分享；插件只用 `rotate:false` 读取或首次生成，不自动轮换。
- **首选邀请源**：默认把 Magpie 首选账号排在下拉第一项，可选最新账号、指定账号或手动邀请码，并记住选择。关闭开关时自动使用最近首次见到的账号；手动预留码不被自动覆盖。

「首选账号作为邀请源」「自动签到与每日任务」「回传 Token 用量」都显示完整说明，暂位于模型下方，避开 Magpie 置顶容器与页头 `.top` 的 46px 限高冲突。账户功能需要一次性导入的 Clerk 凭证；纯 API Key 聊天不受影响。

---

## 安装

源码与版本 Release 托管于 [qaz139688/magpie-croli](https://github.com/qaz139688/magpie-croli)，未发布 npm 包。

```bash
magpie plugin add github:qaz139688/magpie-croli
```

然后三选一：

1. **一次性导入**：在 Croli 供应商卡片选择「从本机 Croli 登录态导入 API Key」。导入只发生一次，之后不再读取客户端。
2. **邀请注册**：选择「使用邀请链接注册并导入」，在 `inviteSource` 下拉中选择最新账号、指定账号或手动邀请码；默认首选账号并记住选择，仅新注册账号有效。
3. **手动粘贴**：选择「Croli 网关 API Key」，粘贴 `csk_...`。

也可使用命令行进入登录流程：

```bash
magpie plugin login croli
```

验证安装：

```bash
magpie plugin list
curl http://127.0.0.1:3425/v1/models
```

---

## 常见问题

**运行时还需要打开 Croli 吗？** 不需要。保存的是独立网关 Key，插件不启动、不连接官方客户端。

**会不会把官方客户端的系统提示词带给模型？** 不会。调用链不经过客户端；插件自己也不添加或改写提示词。

**会不会删除 DSH 或其他调用方的 system prompt？** 不会。零注入不等于删除调用方上下文，原有 messages 和 tools 会原样保留。

**纯 API Key 为什么看不到积分、签到和邀请？** 这些账户接口使用另一套 Clerk JWT。插件会明确提示，而不是编造读数；重新一次性导入即可启用。

**邀请链接会泄露 token 吗？** 不会。链接只包含可公开分享的邀请码；JWT、refresh token 和网关 Key 不会进入链接、邀请缓存或验证报告。

**Key 失效怎么办？** 账户 JWT 会自动续期；网关 Key 被吊销或轮换时重新一次性导入或更换即可。目录返回 401 时只会标记这个账号，不影响其他供应商。

**这是官方直连吗？** 不是。它是 Croli 网关的独立客户端，网关还会连接上游服务商。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [MYCF711/magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 仓库结构、九钩子、通用模块、检查器与测试契约 |
| [Croli 0.0.17](https://www.croli.net/) 本地解包与接口实测 | 网关地址、四个可用模型、鉴权与上游证据 |
| [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) | DeepSeek 版本与输出上限交叉核对 |
| [OpenCode Console Models](https://opencode.ai/docs/console/models/) / [OpenRouter Models](https://openrouter.ai/api/v1/models) | 模型 ID、上下文与能力交叉核对 |

实现与验证细节见 [`docs/internals.md`](./docs/internals.md)。

---

> 更新记录：[`CHANGELOG.md`](./CHANGELOG.md)

## 许可

MIT。
