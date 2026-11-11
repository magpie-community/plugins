# magpie-amd-cloud

[English](README.en.md) | 中文

把 [AMD Radeon Cloud](https://amd-aim.github.io/radeon-cloud-docs/)（AMD GPU Cloud）的**免费共享模型 API** 接入 [magpie](https://usemagpie.ai/)，变成一个供应商插件。接入后 Claude Code、Codex、OpenCode 等所有 Agent 都能通过 magpie 用 `amd-cloud/<模型>` 调用 Radeon GPU 上的模型，额度直接显示在 magpie 里。

插件本身零依赖、零构建：一个 OpenCode v1 形式的供应商插件，magpie 直接以文件夹加载。

## 接入后可以看到什么

- **插件 → 已安装**：AMD Cloud 卡片（图标、版本）。
- **供应商行**：`amd-cloud (AMD Cloud, N models)  signed in`。多把 key 重复登录即多账号。
- **账号额度卡片 + `magpie quota`**：「点数（24h 滚动）」窗口——已用百分比、`已用 / 上限 pts`、重置倒计时（滚动周期：从本周期首次计费起 24 小时后重置，非固定零点）；账号旁显示组织 ID（`oneclick-org-…`）。控制台把这套数字叫 **pts（点数）**，官方明示是免费服务的配额计量而非真实费用；API 字段名叫 `daily_cost_*_usd`，数值与 pts 完全一致（1 pt ≡ 1 名义美元），插件按 pts 口径展示。
- **模型选择器 / Agent**：`amd-cloud/DeepSeek-V4-Flash`、`amd-cloud/Qwen3.8-Flash-Next` 等全部聊天模型——模型列表登录后运行时从 `GET /v1/models` 拉取，不写死，新模型上架自动出现。
- **网关 `GET /v1/magpie/quotas`**：暴露同样的额度信息给外部工具。
- 401 自动标记账号需要重登、429/5xx 自动故障切换到其他账号或模型，均为 magpie 原生行为，插件不掺和。

## 如何接入

前置条件：一个已过审的 AMD Radeon Cloud 账户（待审核账户不会签发 API 密钥）。

1. **拿 key**：登录 Radeon Cloud 控制台，第一次打开 Token Factory 或启动实例时会自动签发；key 显示在模型详情对话框和 Profile 页面，形如 `rc-` + 48 位十六进制。
2. **添加插件**：
   ```sh
   magpie plugin add /path/to/magpie-amd-cloud   # 文件夹就地加载
   # 或在应用里：插件 → 添加插件 → 填文件夹路径
   ```
3. **登录**：
   ```sh
   magpie plugin login amd-cloud    # 粘贴 rc-… key
   ```
4. **验证**：
   ```sh
   magpie provider test amd-cloud   # 每个模型发一个很小的请求
   magpie quota                     # 花费窗口
   ```

之后 Agent 里直接选 `amd-cloud/DeepSeek-V4-Flash` 等模型即可。多账号就再跑一次 `magpie plugin login amd-cloud` 换一把 key。

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
| 401 / 提示重新登录 | key 无效或已被轮换（控制台重新签发会立刻作废旧 key），重新 `magpie plugin login amd-cloud` |
| 频繁 429 | 先看 `code`：`model_concurrency_rate_limit_exceeded` = 该模型共享并发满，换个模型；`token_*`/`ip_*` = 密钥或 IP 的 RPM/并发限制；给供应商配置多个账号（多把 key）可让 magpie 分流 |
| 模型调用报 `Requested model … not supported` | 模型名不在共享目录里；`magpie plugin` 里看本插件实际拉到的列表 |

## 隐私与安全

- key 保存在 magpie 配置目录的 `plugin-auth.json`（权限 600）。
- 插件只把请求发往**一个**官方域名：`developer.amd.com.cn`（推理、模型目录与额度 `/v1/usage`）。它能看到的内容 = 发给供应商的请求本身（对话、工具及其结果），不会另外记录或上传。

## 开发

```sh
node --test test/amd-cloud.test.mjs   # 21 个单测：目录映射/聊天过滤/用量映射 + fetch 封装（桩替换 globalThis.fetch）
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
- 静态兜底只收录文档详测的两个模型；其余模型登录后由实时目录提供。

## 许可证

MIT
