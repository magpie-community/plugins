# magpie-amd-cloud

[English](README.en.md) | 中文

把 AMD 的**两个免费共享模型 API 站点**接入 [magpie](https://usemagpie.ai/)，变成供应商插件：

| 供应商 | 站点 | id | 模型写法 |
|---|---|---|---|
| 国内站 · Radeon Cloud（Token Factory） | developer.amd.com.cn | `amd-cloud` | `amd-cloud/DeepSeek-V4-Flash` |
| 国际站 · TokenLab（AI Notebooks） | api.tokenlab.amd.com | `amd-cloud-lab` | `amd-cloud-lab/DeepSeek-V4-Flash` |

接入后 Claude Code、Codex、OpenCode 等所有 Agent 都能通过 magpie 调用 Radeon GPU 上的模型，额度直接显示在 magpie 里。插件本身零依赖、零构建：一个 OpenCode v1 形式的供应商插件，magpie 直接以文件夹加载。

## 接入后可以看到什么

- **插件 → 已安装**：AMD Cloud 卡片（图标、版本），一行供应商一个站点。
- **供应商行**：`amd-cloud (AMD Cloud, N models)  signed in` / `amd-cloud-lab (AMD Cloud Lab, N models)  signed in`。多把 key 重复登录即多账号。
- **账号额度卡片 + `magpie quota`**：
  - `amd-cloud`（国内站）：「点数（24h 滚动）」窗口——已用百分比、`已用 / 上限 pts`、重置倒计时（滚动周期：从本周期首次计费起 24 小时后重置，非固定零点）；账号旁显示组织 ID（`oneclick-org-…`）。
  - `amd-cloud-lab`（国际站）：无用量 API，额度处显示个人页链接 + **本地预估已用**（插件从每次响应的 `usage.cost` 自行累计的进程内计数，标注“本地预估”——装插件前/进程重启前的消耗不含在内）。**Points 是 30 天接入期的总量（10 pts），不是每日重置**——与国内站完全不同；**实际计算与余额以 [TokenLab 个人页](https://notebooks.amd.com/profile) 为准**。
  - 两站都把这套数字叫 **pts（点数）**，官方明示是免费服务的配额计量而非真实费用；国内站 API 字段名叫 `daily_cost_*_usd`，数值与 pts 完全一致（1 pt ≡ 1 名义美元），插件按 pts 口径展示。
- **模型选择器 / Agent**：`amd-cloud/...` 与 `amd-cloud-lab/...` 各自站点目录里的全部聊天模型——模型列表登录后运行时从各自的 `GET /v1/models` 拉取，不写死，新模型上架自动出现。
- **网关 `GET /v1/magpie/quotas`**：暴露同样的额度信息给外部工具。
- 401 自动标记账号需要重登、429/5xx 自动故障切换到其他账号或模型，均为 magpie 原生行为，插件不掺和。

## 如何接入

### 国内站 `amd-cloud`

前置条件：一个已过审的 AMD Radeon Cloud 账户（待审核账户不会签发 API 密钥）。

1. **拿 key**：登录 [Radeon Cloud 控制台](https://developer.amd.com.cn/radeon/tokenfactory)，第一次打开 Token Factory 或启动实例时会自动签发；key 显示在模型详情对话框和 Profile 页面，形如 `rc-` + 48 位十六进制。
2. **添加插件并登录**：
   ```sh
   magpie plugin add /path/to/magpie-amd-cloud   # 文件夹就地加载
   magpie plugin login amd-cloud                 # 粘贴 rc-… key
   ```
3. **验证**：
   ```sh
   magpie provider test amd-cloud   # 每个模型发一个很小的请求
   magpie quota                     # 点数窗口
   ```

### 国际站 `amd-cloud-lab`

前置条件：[AMD AI Developer Program](https://developer.amd.com/)（国际站）账号，能登进 [notebooks.amd.com/tokenlab](https://notebooks.amd.com/tokenlab)。

1. **拿 key**：登录控制台（AMD 企业 SSO），主页 "Your API key" 区签发 API key（`tl-` 前缀）。**key 随接入期 30 天有效**，过期/被 Regenerate 后 magpie 会标 401，重新 `magpie plugin login amd-cloud-lab` 粘新 key 即可。
2. **登录并验证**：
   ```sh
   magpie plugin login amd-cloud-lab   # 粘贴 tl-… key
   magpie provider test amd-cloud-lab  # 可选：小请求验证
   ```

**Points 生命周期（控制台 FAQ 写死的规则，2026-11-13 实录）**：

- Points 总量 10 pts，覆盖整个 30 天接入期（本期至 2026-12-13），**用完即停服直到重置**，无付费通道。
- **Extend by 15 days**：只加接入期不加 points、只能用一次；仅当前周期**最后 5 天内**可申请。
- **Request more points**：再申请一份 10 points；仅到期前**最后 7 天内**、或剩余 points **≤ 2** 时可申请。
- 用量明细（Points by model / Points history）与续期按钮都在[个人页](https://notebooks.amd.com/profile)。

两站可以同时登录、同时使用，模型 id 不冲突。

## 模型（2026-11-01 与实时目录对账：15 个条目，其中 10 个聊天模型；以 `GET /v1/models` 实时为准）

控制台目录里还有 5 个非聊天条目——Clef/d3/d3-flash 是 Model Ops 内部路由决策服务（输出 `decision`）、OmniVoice 语音（`audio`）、MinerU2.5-Pro 文档解析（`ocr`）。插件按「输出模态含 text 且声明了请求参数」自动过滤，只暴露聊天模型。

| 模型 | 上下文 | 图像输入 | 价 $/M（输入/输出） |
| --- | --- | --- | --- |
| DeepSeek-V4.1-Flash | 1,048,576 | ✅ | 0.28 / 0.56 |
| DeepSeek-V4-Flash | 1,048,576 | ❌ | 0.14 / 0.28 |
| GLM-5.3-Flash | 262,144 | ❌ | 0.28 / 0.56 |
| MiMo-V2.6-Flash | 1,048,576 | ✅ | 0.14 / 0.28 |
| Qwen3.8-Flash-Next | 262,144 | ✅ | 0.14 / 0.28 |
| Qwen3.8-27B | 262,144 | ✅ | 0.035 / 0.07 |
| Gemma-4-31B-IT | 262,144 | ✅ | 0.035 / 0.07 |
| MiniCPM-V-4.7-1B | 262,144 | ✅ | 0.035 / 0.07 |
| MiniCPM-V-4.7-35B-A3B | 262,144 | ✅ | 0.035 / 0.07 |
| MiniCPM5-2B | 131,072 | ❌ | 0.035 / 0.07 |

推理档位（`reasoning_effort` → magpie `variants`，模型选择器里切换）：DeepSeek-V4-Flash 六档（minimal→max，默认不思考）、Qwen3.8-Flash-Next 四档（none/low/medium/xhigh，**默认 xhigh 思考**）——其中 `medium`/`low` 已实测接受。其余模型按目录元信息映射（上下文/价格/能力位），目录暂不提供档位信息。

### 国际站 `amd-cloud-lab` 模型（2026-11-13 与控制台对账：10 个条目，7 个聊天模型；以 `GET /v1/models` 实时为准）

控制台另有 Clef/d3/d3-flash 三个 aux 路由决策服务（非聊天），插件按「输出模态含 text 且声明了请求参数」自动过滤。目录无 pricing 字段，价目全部来自控制台逐卡确认的静态表：

| 模型 | 上下文 | 图像输入 | 价 pts/M（输入/输出/缓存读） |
| --- | --- | --- | --- |
| DeepSeek-V4-Flash | 1,048,576 | ❌ | 0.14 / 0.28 / 0.0028 |
| DeepSeek-V4.1-Flash | 1,048,576 | ✅ | 0.28 / 0.56 / 0.0056 |
| Gemma-4-31B-IT | 262,144 | ✅ | 0.035 / 0.07 / 0.0007 |
| Qwen3.8-27B | 262,144 | ✅ | 0.035 / 0.07 / 0.0007 |
| MiniCPM-V-4.7-1B | 262,144 | ✅ | 0.035 / 0.07 / 0.0007 |
| MiniCPM-V-4.7-35B-A3B | 262,144 | ✅ | 0.035 / 0.07 / 0.0007 |
| MiniCPM5-2B | 131,072 | ❌ | 0.035 / 0.07 / 0.0007 |

价目与国内站同模型完全一致（pts 同一套体系）；控制台显示名带的 0731/1017 是构建版本后缀，API id 不含。DeepSeek-V4-Flash 的目录在这里声明了 `reasoning_effort`（国内站目录未列），档位映射同上。与国内站的差异：**没有** GLM-5.3-Flash、MiMo-V2.6-Flash、Qwen3.8-Flash-Next；无 `/v1/usage`（points 总量与明细只在[个人页](https://notebooks.amd.com/profile)显示）；key 随 30 天接入期有效。

**国际站特有约束**（2026-11-13 控制台实录）：

- **Points 是 30 天周期总量**（10 pts），非每日重置；用完停服直到重置，无付费通道。
- **限速 20 requests per minute**——全账号、按模型计（FAQ 原文），比国内站更紧；并发上限页面未写，插件沿用 8 路并发。
- **决策模型 Clef/d3/d3-flash 走 `/v1/systemone`**（`state` + `questions` 请求体），不是 chat 模型——插件已过滤，不会出现在模型选择器里。
- 模型卡片上的「x% used」**不是**本账号用量（含义页面未解释），勿当额度参考。
- 错误语义：402/403 常见于 points 用尽或权限问题，401 是 key 过期/无效——都到个人页处理。

**价格口径与校验**：models.dev 与 magpie 的 `cost` 同为「每百万 token 美元」，本插件把 AMD 目录的每 token 价 ×1e6 换算，并已用 `/v1/usage` 实际计费逐模型核验（输入/输出/缓存读/推理 token 全部与目录价一致；Qwen 的 reasoning token 计入输出计费但在 `completion_tokens` 外单列）。models.dev 的 `amd` 条目价格字段全为 0（未维护），其 `deepseek` 下同名模型是 DeepSeek 官方 API 价（$0.15/$0.60），均与 AMD 云不同——价格以 AMD 目录为准。额度按控制台的 **pts 点数**口径展示（与 API 的 `*_usd` 字段同值，1 pt ≡ 1 名义美元，非真实费用）。

## 行为差异与已知约束（官方文档 + 实测，接入前值得知道）

- **请求体会被网关重建**：共享端点只接受固定字段（`temperature`、`max_tokens`、`top_p`、`tools` 等）；`stop`、`seed`、`top_k`、`logit_bias` 等会被**静默丢弃**，不报错也不生效。
- **Qwen3.8-Flash-Next 的 `system` 消息只能放第一条、只能有一条**，角色名必须是 `system`（不能用 `developer`）；DeepSeek 系无此限制。
- **Qwen3.8-Flash-Next 不传 `reasoning_effort` 时默认思考（xhigh）**，不是不思考；想关掉要显式选 `none` 档。
- **仅支持 chat completions**：共享端点没有 `/v1/responses`、embeddings、图像生成。
- 非流式请求最长 10 分钟；流式按「两个分片之间的间隔」计 10 分钟。
- 限流：每密钥 30 RPM / 8 并发（插件的 `maxConcurrency` 已设为 8），每账户 20 RPM（`/v1/usage` 的 `rpm_limit`），另有滚动周期花费上限；429 带 `Retry-After`，magpie 会自动转移到下一个账号/模型。
- **单个模型还有自己的共享并发上限**（如 GLM-5.3-Flash 为 32），满了返回 `model_concurrency_rate_limit_exceeded`——换个模型即可，不是你的账号被限。
- 模型目录外的名字由网关直接 `400` 拒绝，请求不会到后端。
- **额度端点以实测为准**：文档写的 Platform API `/api/profile/model-usage` 不收 API 密钥（401，仅浏览器会话）；插件实际走 Model API 主机的 `GET /v1/usage`，「每日」实为 24h 滚动周期（`daily_reset_timezone: null`）。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 额度显示「账户尚未签发 API 密钥」 | 账户还没有 key：去控制台 Token Factory / Profile 页生成 |
| 403 `account_not_verified` | 账户还在审核；过审前不发 key |
| 401 / 提示重新登录（amd-cloud） | key 无效或已被轮换（控制台重新签发会立刻作废旧 key），重新 `magpie plugin login amd-cloud` |
| 401（amd-cloud-lab） | **key 随 30 天接入期到期**，或已被 Regenerate：到 [notebooks.amd.com/tokenlab](https://notebooks.amd.com/tokenlab) 重新生成，重新 `magpie plugin login amd-cloud-lab` |
| lab 请求 402/403 | Points 用尽（30 天周期总量，用完停服）或权限不足：到[个人页](https://notebooks.amd.com/profile)看 Points 余额；到期前最后 7 天（或剩余 ≤2 pts）可申请 more points |
| 频繁 429 | 先看 `code`：`model_concurrency_rate_limit_exceeded` = 该模型共享并发满，换个模型；`token_*`/`ip_*` = 密钥或 IP 的 RPM/并发限制；给供应商配置多个账号（多把 key）可让 magpie 分流 |
| 模型调用报 `Requested model … not supported` | 模型名不在共享目录里；`magpie plugin` 里看本插件实际拉到的列表 |

## 隐私与安全

- key 保存在 magpie 配置目录的 `plugin-auth.json`（权限 600）。
- 插件只把请求发往两个官方域名：`developer.amd.com.cn`（国内站：推理、模型目录与额度 `/v1/usage`）与 `api.tokenlab.amd.com`（国际站：推理与模型目录）。它能看到的内容 = 发给供应商的请求本身（对话、工具及其结果），不会另外记录或上传。

## 开发

```sh
node --test test/amd-cloud.test.mjs   # 24 个单测：双供应商工厂/目录映射/聊天过滤/用量映射 + fetch 封装（桩替换 globalThis.fetch）
```

沙箱验证（不碰真实 magpie 配置）：

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache USERPROFILE=$sb MAGPIE_ADDR=127.0.0.1:3499 MAGPIE_PLUGIN_MARKET=off magpie "$@"; }
m plugin add /path/to/magpie-amd-cloud
m plugin --json
```

### 假设与待实测项

- `limit.output = 16384` 为保守假设，官方未公布最大输出 token 数。
- 推理档位：DeepSeek `medium`、Qwen3.8-Flash-Next `low` 已实测接受（2026-11-01）；其余档位按官方模型页登记，未逐一实测。
- 静态兜底收录文档/控制台确认的模型（国内站 2 个、国际站 7 个）；其余模型登录后由实时目录提供。
- 国际站 points 的精确换算公式页面未给（仅定性说明按 token 与模型费率计）；并发上限数字未公布。

## 许可证

MIT
