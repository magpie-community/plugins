# Chatbox AI 免费额度 for magpie

**把 Chatbox 桌面端已经登录的 Chatbox AI 接进 magpie / OpenCode：26 个免费模型、最高 105 万上下文，本机一键导入，不用粘贴 key、不用开浏览器。**

Chatbox 是那个跨平台 AI 客户端（`Chatbox.exe`）。它自带一整套云端模型服务：登录后拿到一个 license，免费计划每天有 token 额度，
可以调 Chatbox AI 自己的模型目录 —— DeepSeek、GLM、Kimi、Qwen、豆包、MiniMax、GPT、Claude、Gemini 都在里面。
这个插件把「你的 Chatbox license」接成 magpie 的一个供应商：模型、额度、图片能力、工具调用都进 magpie 的卡片，
对话原样发往 `api.chatboxai.app` 的四条原生网关，不缓存、不改写你的对话内容。

```
26 个免费模型         DeepSeek V4.1、GLM-5.3、Kimi K2.7 Code、Qwen3.8、豆包、MiniMax、GPT-6 Luna、Claude Haiku
63 个目录条目         平台上下架的都在，跟着你的 license 实时拉取
10,000 tokens / 天    免费计划每日额度，北京时间 0 点重置，进度条直接显示
3 条登录路            本机导入 / 粘贴 license key / 邮箱验证码
```

---

## 功能

- **本机一键导入** —— 直接读本机 Chatbox 客户端已经登录的 license（只读 `config.json`，不弹浏览器、不碰客户端数据）。
- **三种登录方式** —— 本机导入 / 粘贴 license key / 邮箱验证码（两步：发码、填码），没装客户端也能用。
- **63 个模型的实时目录** —— 上下文窗口、能不能收图、要不要思考档，全部来自平台自己的 `model_list`，不是抄的静态表。
- **四条原生网关** —— 按模型的 `apiStyle` 自动分流到 Chat Completions / Responses / Anthropic Messages / Gemini，工具调用与思考档按官方协议下发。
- **每日额度上卡片** —— 免费计划每天 10,000 tokens，进度条、重置时间、生图额度都在；透支会如实显示超过 100%。
- **收图能力按目录拦** —— 给一个不收图的模型发图片时插件直接拒绝，而不是让上游复读把额度打穿。
- **错误分得清** —— 登录失效落 401、模型不可用落 404、额度用完落 429、网关超时落 504，每条都带稳定 `code` 和上游原文。
- **不做的事** —— 没有签到（Chatbox 本来就没有）；不领任何奖励额度；不写 Chatbox 的目录、不改你的客户端配置。

---

## 模型

**DeepSeek / 智谱 GLM / 月之暗面 Kimi / 阿里 Qwen / 字节豆包 / MiniMax / OpenAI GPT / Anthropic Claude / Google Gemini / xAI Grok** —— 各家最新的一版都在；登录后跟随平台目录上下架。

| 发行商 | 代表模型 | 上下文 | 收图 | 倍率 | 说明 |
|---|---|---|---|---|---|
| DeepSeek | `deepseek-v4.1-flash` | 1.02M | ✓ | 0.50x | 免费计划可用，思考档齐全 |
| DeepSeek | `deepseek-v4-pro` | 1.02M | ✗ | 2.19x | 免费计划可用 |
| 智谱 | `glm-5.3` | 1M | ✗ | 3.78x | 免费计划可用 |
| 月之暗面 | `kimi-k2.7-code` | 1M | ✓ | 3.17x | 免费计划可用，写代码向 |
| 阿里 | `qwen3.8-flash` | 1M | ✓ | 0.38x | 免费计划可用 |
| 字节 | `doubao-seed-2-1-pro` | 256K | ✓ | 3.08x | 免费计划可用 |
| OpenAI | `gpt-6-luna` | 1.05M | ✓ | 0.33x | 免费计划可用 |
| Anthropic | `claude-haiku-5-5` | 1M | ✓ | 0.33x | 免费计划可用 |
| OpenAI | `gpt-6-astra` | 1.05M | ✓ | 33.30x | **需要付费计划**（免费调会提示升级） |
| Anthropic | `claude-opus-5-5` | 1M | ✓ | 13.32x | **需要付费计划** |
| Google | `gemini-4-argon` | 1.05M | ✓ | 6.66x | **需要付费计划** |
| xAI | `grok-4.7` | 1M | ✓ | 6.66x | **需要付费计划** |

> 倍率的基准是 **Chatbox AI 3.5 = 1.00x**：同样一句话，这个模型比基准多烧几倍「计算点」。
> 数字来自平台自己的 `tokensPerComputePoint`（每 1 计算点能换多少 token），
> 与官方美元价是同一件事的两种写法 —— **它是消耗倍数，不是折扣**。

> 免费计划能调的是平台 `basic` 组里的 26 个模型；`advanced` 组（GPT-6 旗舰、Claude Opus、Gemini 4 等）需要升级，
> 插件会把上游的「该模型需要更高套餐」原样报出来，并且只搁置这一个模型，不影响账号和其他模型。
> 全量表以 `magpie plugin list` 或应用内模型列表为准 —— 平台随时上下架，抄进 README 一个月就过期。

---

## 额度

免费计划每天 10,000 tokens（北京时间 00:00 重置），按所有模型共享。进度条显示「今日额度」，
生图额度单独一行（每月 5 张）。额度透支后上游会拒绝继续生成，插件把它报成「额度已用完，等重置」，
不会把这个账号标成登录失效。

**Chatbox 自己的付费计划按「计算点」计费**，1 计算点 = 官方成本 $0.000001，所以点数和 token 的换算是：

| 计划 | 计算点 / 月 | `deepseek-v4.1-flash` 输入 tokens | 折合输出 tokens |
|---|---|---|---|
| Lite | 2,000,000 | 约 1,330 万 | 约 330 万 |
| Pro | 12,000,000 | 约 8,000 万 | 约 2,000 万 |
| Pro+ | 30,000,000 | 约 2 亿 | 约 5,000 万 |

换算口径：1 计算点 = 6.67 个 `deepseek-v4.1-flash` 输入 token；输出按官方价 4 倍折算 ≈ 1.67 个。
换其他模型时把 6.67 换成该模型的 `tokensPerComputePoint` 即可（倍率列的倒数关系）。

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `Chatbox AI`，点**安装**。

安装后：**设置 → 供应商 → Chatbox AI 免费额度 → 添加账号**，选第一条「从本机 Chatbox 客户端导入」。
本机 Chatbox 已经登录过就会直接成功；没装客户端的话用「粘贴 license key」或「邮箱验证码登录」。

命令行（可选）：

```bash
magpie plugin add MYCF711/magpie-chatbox-ai
```

---

## 常见问题

**为什么选 `gpt-6-astra` 报「该模型需要更高的套餐」？**
免费计划只覆盖 `basic` 组。`advanced` 组的模型会返回 `license_upgrade_required`，插件把它翻译成「模型不可用」，
只搁置这一个模型；去 Chatbox 里升级计划后自动恢复。

**卡片显示额度超过 100%？**
上游的额度账本会变负（超过上限的请求已经发出去了）。插件如实显示，等北京时间 0 点重置。

**给模型发图片，怎么被插件拦了？**
Chatbox 服务端**不校验**模型能不能收图：给一个 text-only 模型发图片，它不报错，会无边界复读，
一天额度几分钟就没了（2026-11-03 实测）。所以插件按平台目录里的 `capabilities` 先拦一道。
换 `deepseek-v4-flash-vision`、`gpt-6-luna`、`claude-haiku-5-5` 这类带 vision 的模型即可。

**「从本机导入」提示找不到客户端？**
插件读的是 `%APPDATA%\xyz.chatboxapp.app\config.json`（macOS 是 `~/Library/Application Support/xyz.chatboxapp.app/`，
Linux 是 `~/.config/xyz.chatboxapp.app/`）。先在 Chatbox 里登录一次，再回来点继续。

**会不会有账号风险？**
插件只读本机客户端的 license、只往 Chatbox 自己的网关发请求，不修改客户端数据、不代理到第三方。
但它是非官方插件，Chatbox 的服务条款是否允许第三方客户端接入，请你自己确认。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [Chatbox](https://github.com/chatboxai/chatbox)（客户端，MIT） | 网关路径、鉴权头、`model_list` / `license detail` 的字段语义，从 1.23.5 的 `app.asar` 反查 |
| [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 插件骨架、九钩子契约、`src/` 里的通用协议模块（SSE / 额度窗口 / 缓存 / 并发闸） |
| [magpie-community/plugins](https://github.com/magpie-community/plugins)（MIT） | SSE 折叠与 tool_calls 合并思路（`src/openai-sse.mjs`） |

协议取证与实现细节在 [docs/internals.md](./docs/internals.md)。

## 许可

[MIT](./LICENSE)。与 Chatbox / Chatbox AI 官方无关，非官方插件。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)
