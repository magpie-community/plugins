# MClaw（中国移动云）

把中国移动云 **MClaw**（移动云盘 App 内的智能体，`ai.yun.139.com`）作为一个 OpenAI 兼容供应商接进 [magpie](https://usemagpie.ai) 与 OpenCode：一次浏览器登录同时拿到 **chat**（llm 开放接口）、**模型**（账号实际可用清单与积分倍率）与**用量**（aitokens 池）。装好后所有 agent（Claude Code、Codex、openclaw 等）都能通过 magpie 用 `mclaw/<model>` 访问 MClaw 的模型，并享受 magpie 的用量统计与故障切换。

> 非官方插件，风险自负。本包与中国移动或 magpie 官方无隶属关系。接口协议 2026-11-04 从移动云盘 App 13.2.5 抓包逆向，平台未公开，随时可能变化或失效；本插件不绕过验证码、限流或任何平台限制。登录凭证只存 magpie 的 `plugin-auth.json`（600），插件目录不落任何凭证。

## 安装

```bash
magpie plugin add @magpie-community/opencode-mclaw-auth
magpie plugin login mclaw
```

（从源码跑：`git clone https://github.com/joey-41/opencode-mclaw-auth.git MClaw && magpie plugin add ./MClaw`）

## 登录

浏览器登录，一次登录凭证全自动，**没有任何要填的输入**：选「浏览器登录」→ 插件弹出一个**专用 Chrome 窗口**（每次登录一个全新 profile，不影响日常浏览器）→ 在窗口里登录移动云 `yun.139.com`（网页支持验证码、密码、扫码等多种方式，任选）→ 插件自动收走 `authorization` Cookie（= `pc:` 票，30 天期），其余全自动：llm chat key（`na-…`）与模型倍率表自动取回，openclawId 与账号实际模型清单自动发现，vip 会话由换票链自动维持（`toSourceId 001005`，与 App vip 会员中心同渠道；进程内复用，24h 期，失败 30 分钟冷却），用量窗口（含「重置于」与逐条明细）自动接上；账号显示名 = 掩码手机号（票里解出）。**票到期前 3 天自动续期**：headless 复开该账号自己的 profile（目录存在账号 metadata 里，多账号互不串票，续期时会校验收割到的票属于本账号），网页会话自己刷新后重新收割，票换了顺手刷新 key。

## 模型

登录后模型目录与倍率**自动发现**（agent/list + config/get），无需硬编码 ID；下表是未登录时的静态目录。

| 模型 ID（`mclaw/…`） | 名称 | 倍率 | 备注 |
|---|---|---|---|
| `blian_qwen38_flash` | Qwen3.8-Flash | 0.18 | 推理；并行工具调用实测 8/8 |
| `blian_qwen38_max` | Qwen3.8-Max | 1.5 | 推理 |
| `huoshan_glm_5_3` | GLM-5.3 | 3.5 | 推理 |
| `blian_qwen37_plus` | Qwen3.7-Plus | 1.5 | 推理 |
| `blian_qwen36_plus` | Qwen3.6-Plus | 1.0 | |
| `blian_qwen35_plus` | Qwen3.5-Plus | 0.6 | 多模态 |
| `blian_deepseek_v4_pro` | DeepSeek-V4-Pro | 2.5 | 推理 |
| `vlm_huoshan_2_0_lite_thinking_vision` | Seed-2.0-Lite | 1.0 | 推理+视觉 |
| `vlm_huoshan_2_0_mini_thinking_vision` | Seed-2.0-Mini | 0.3 | 推理+视觉 |
| `huoshan_deepseek_v4_1_flash` | DeepSeek-V4.1-Flash | 未知 | 计费表未列出 |

`rate` 是 App 的 tokenRatio 计费倍率（如 flash 0.18×），不是美元价格。上下文/输出上限 App 未暴露，插件按 200k/32k 声明，仅作调度参考，以上游实际判定为准。

## 用量

aitokens 池窗口：总量、已用、剩余与「重置于」。重置于来自消耗明细里的权威 `endTime`（当前周期终点）；vip 会话由插件自动维持（SSO 换票链，`toSourceId 001005`），没有可用会话时不显示重置时间——上游不给周期起止，插件不用别的账号的周期猜。上游报「无效的ApiKey」时插件转成明确的登录失效（401），重新登录即可。

## Options

```bash
magpie plugin options mclaw '{"base": "https://ai.yun.139.com/api/llm/102001"}'
```

环境变量（浏览器登录相关）：`MCLAW_CHROME_PATH`（Chrome 可执行文件路径，默认按平台探测）、`MCLAW_BROWSER_PROFILE`（登录 profile 目录的根，每个账号用其下的独立子目录，默认 `~/.config/magpie/mclaw-browser-profiles/`）。

## 许可证

MIT
