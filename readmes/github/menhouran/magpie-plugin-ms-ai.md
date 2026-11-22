# magpie-plugin-ms-ai

魔搭国际站（modelscope.ai）API-Inference 的 magpie / OpenCode provider 插件：注册
`modelscope-ai` 供应商，提供模型列表与推理，并处理每日魔粒签到与余额窗口。

## 功能

- **供应商注册**：`modelscope-ai`，`@ai-sdk/openai-compatible`，`https://api-inference.modelscope.ai/v1`。用户已自定义的 provider 配置不会被覆盖。
- **模型**：登录后从 `GET /v1/models` 拉取账号可见模型，按 OpenCode 完整形态返回（limit / capabilities / api / release_date）。拉不到时用实测可用的内置列表。模型名由 id 推导（`deepseek-ai/DeepSeek-V4.1-Flash-1017` → `DeepSeek V4.1 Flash 1017`），`created` 填成 `release_date`。实测不可调用的条目标 `deprecated`，宿主会过滤掉。
- **推理**：转发时加 `Authorization: Bearer`，上游响应原样返回，故障转移交给 magpie。
- **每日签到**：每账号每北京日调一次 `GET /api/v1/users/login/info`，该请求即发放触发（服务端幂等）。签到前后读 `/openapi/v1/magicubes/transactions` 校验到账，结果分 `claimed`（新到账）/ `done`（今日已有）/ `inactive`（已触达但无到账）/ `failed`（账单读不到，宿主 30 分钟后重试）。
- **余额与窗口**：`GET /openapi/v1/magicubes/balance` 取 `available_balance`；卡面按 `expire_days` 分桶报「今日发放」「长期魔粒」，外加参与路由的「合计」。
- **鉴权口径**：余额走官方 Bearer（`/.well-known/openapi.json` 的 Magicube 板块），被拒回落会话 Cookie；账单与签到是网站内部接口，只能 Cookie。
- **账号显示名**：先用官方 `/openapi/v1/users/me`（Bearer、无副作用）把用户名写回账号，答不出才回落 `login/info`（它会顺带触发签到）。多账号不会显示成 `API key …xxxx`。

## 额度规则现状（2026-11-22 实测）

国际站自 **2026-11-19** 起不再发放绑定阿里云账号的每日 50 魔粒：五个账号账单同日齐刷刷只剩
`daily_active` 200，11-18 及以前均为 200 + 50。接口没有变（`login/info` 仍 200 并触发发放），
是上游停发而非插件故障。`DAILY_RULES` 保留 `aliyun_bindlogin`，厂商恢复即自动重新计入。

## 内置模型

未登录或拉取失败时的兜底只有一款——实测可调用的 `deepseek-ai/DeepSeek-V4.1-Flash-1017`
（1,048,576 上下文 / 393,216 输出）。兜底列表越短越不容易过期，所以不堆。

`/v1/models` 列出的模型并非都可用。2026-11-22 对国际站 37 个 id 逐个打最小请求复测，
响应分三类：

- **429 insufficient balance** — 路由存在，只是账号余额为 0，可调用；
- **400 has no provider supported / Invalid model id** — 目录还在，路由已撤；
- **403 your current account does not have access** — 账号无权限（Ambassador 档）。

可调用的（429）：

| 模型 | 上下文 | 备注 |
| --- | --- | --- |
| deepseek-ai/DeepSeek-V4.1-Flash-1017 | 1,048,576 | 多模态，思考 + 工具 |
| deepseek-ai/DeepSeek-V4-Pro-0813 | 1,048,576 | 思考 + 工具 |
| zai-org/GLM-5.2 | 1,048,576 | 思考 + 工具 |
| zai-org/GLM-4.7-Flash | 1,048,576 | 思考 + 工具 |
| Qwen/Qwen3.5-27B | 262,144 | 小模型，同样 262k 窗口 |
| Qwen/Qwen3.5-35B-A3B | 262,144 | |
| Qwen/Qwen3.8-27B | 262,144 | |
| Qwen/Qwen3.5-122B-A10B | 262,144 | |
| Qwen/Qwen3.5-397B-A17B | 262,144 | |
| nex-agi/Nex-N2.5-Pro | 262,144 | |
| nex-agi/Nex-N2.5-mini | 262,144 | 小模型 |
| PaddlePaddle/ERNIE-4.5-0.3B-PT | 131,072 | 最小的一档 |
| PaddlePaddle/ERNIE-4.5-21B-A3B-PT | 131,072 | |
| PaddlePaddle/ERNIE-4.5-300B-A47B-PT | 131,072 | |
| PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT | 131,072 | 多模态 |
| iic/Tongyi-DeepResearch-30B-A3B | 131,072 | |
| Shanghai_AI_Laboratory/Intern-S1 | 65,536 | 多模态 |
| Shanghai_AI_Laboratory/Intern-S1-mini | 65,536 | 小模型 |
| OpenGVLab/InternVL3_5-241B-A28B | 40,960 | 多模态 |
| opencompass/CompassJudger-1-32B-Instruct | 32,768 | |
| Qwen-Ambassador/Qwen4-Max | 262,144 | 唯一可用的 Ambassador 档 |

上下文长度取自各模型自己的 `config.json`（`max_position_embeddings`），不是猜的；输出长度
在厂商没公布时取保守值，避免卡面承诺超过模型实际的窗口。

不可调用的 id 标为 deprecated（精确匹配，不是前缀——`DeepSeek-V4-Pro` 死了但
`DeepSeek-V4-Pro-0813` 可用；`Qwen-Ambassador/Qwen4-Max` 能用，但同档其余全部 403）：

`deepseek-ai/DeepSeek-V4-Pro`、`deepseek-ai/DeepSeek-V4.1-Flash`、`deepseek-ai/DeepSeek-V4-Flash-0731`、
`zai-org/GLM-5.3`、`zai-org/GLM-5.3-Flash`、`stepfun-ai/Step-5-Preview`、`stepfun-ai/Step-3.5-Flash`、
`MiniMax/MiniMax-M3`、`moonshotai/Kimi-K3.1-Pro`、`Menlo/Jan-nano`、`early-access/EA-29B-A4B`，
以及 `Qwen-Ambassador/` 下除 `Qwen4-Max` 外的全部条目。厂商随时可能上下架，启用新模型前仍应实测。

## 行为契约（踩过的坑，别改回去）

- **`amount` 是已用量，`limit` 是总量，绝不是剩余量**。宿主 `plugin_usage.go` 在插件没给 `used`
  时按 `Amount / Limit * 100` 反推百分比，GUI 聚合（`mergeQuotas`）也按窗口名把各账号的
  `amount` / `limit` 分别相加再取占比。把剩余量填进 `amount` 的必然结果是卡片显示「230 / 230」、
  聚合显示「已用 100%」，而 `magpie quota` 读显式 `used` 看着是 0%——只拿 CLI 验证发现不了。
- **窗口名固定，数字只进 `display`**。额度历史（`quota-history.json`）按窗口名分线记录，名字里
  带「剩 230」会让每个数值都成为一条新历史线。窗口名恒为 `今日发放` / `长期魔粒` / `合计`。
- **`aside: true` 的窗口不参与路由**。宿主 `allowanceOf` 跳过 aside，所以只有「合计」进
  `For` / `Count` / `Pace`。它的 `limit` 是余额 + 当日已用，`span: 86400` 与次日北京 00:35 的
  `resetsAt` 让 90% 保留线落在总余额上；余额归零时 `used: 100`，宿主停用到下次发放。有余额时
  百分比压在 99，避免宿主只看 `used >= 100` 误停还有钱的账号。
- **当日魔粒 24 小时滚动过期，不结转**。`runsOutAt` / `runsOut` 只报当日发放那部分
  （`min(余额, 当日剩余)`），长期池不跟着过期。
- **账单按 `expire_days` 分桶**：1 天是当日发放，90 天是长期奖励。余额 138 可能是当日剩 16 +
  昨日滚过来的 22 + 长期 100，单看余额说不清。
- **额度读取节奏**：余额与账单各有锚点，最多每账号每半小时各读一次，且只在卡片被问时读；
  两次读之间按旗舰档 2 魔粒/次估算，只会高估消耗、不会高估余额。估算吃掉锚点 80% 或余额 ≤ 4
  时立即回厂商重读。429 原样交回、不读余额。
- **登录判定**：401 判令牌失效；402（额度）、403（风控 / 模型无权限）、429（限流）都标 `kept`，
  不误伤账号。网页接口同理，只有 401 算过期。
- **模型列表的 403 保留内置列表**，不标过期（是 scope / 风控，不是丢令牌）。
- **时区**：账本 `gmt_created` 是北京钟面字符串（`2026-10-29 01:02:24`），读成 UTC 会让到期早 8 小时；统一按北京解析后转 ISO。
- **并发**：每账号 2 路（`magpie.maxConcurrency: 2`）。厂商标称单并发，但 11 天生产日志（3134 次、
  96.5% 成功）零 429；真瓶颈是单账号日耗 93% 额度。再现 429 峰值可降回 1。
- 所有网络调用 20 秒超时；状态按令牌为键并限量修剪（256），常驻宿主不会无限增长。

## 安装

在线（GitHub）：

```sh
magpie plugin add menhouran/magpie-plugin-ms-ai
magpie plugin login modelscope-ai
magpie quota
```

本地文件夹：`magpie plugin add ./magpie-ModelScope-ai`（路径按实际情况替换）。

## 登录

粘贴账号在 [modelscope.ai](https://www.modelscope.ai) 个人中心生成的 `ms-` 访问令牌。同一令牌用于两处：

- 推理请求：`Authorization: Bearer <token>`
- 网页接口（签到 / 账单 / 余额）：`Cookie: m_session_id=<token>`；余额亦尝试官方 Bearer

令牌保存在 magpie 的 `plugin-auth.json`，插件不做服务端校验。

## 开发

```sh
bun test        # 56 个用例，全部离线
bunx tsc --noEmit
```

测试用本地 fake server 覆盖：信封双大小写、签到四档结果（含账单校验与 1.5s 重试）、余额窗口分桶
与 aside、Bearer/Cookie 双鉴权回落、401/402/403/429 各自的语义、模型拉取与完整形态回退、
30 分钟缓存与估算。运行时不访问外网（`nonet.ts` 拦截）。入口与测试都是 TypeScript，Bun 直接加载。

插件契约：`index.ts` 默认导出 `ModelScopeAuthPlugin`（`config` / `auth` / `provider` 三个钩子），
测试用的内部函数放在导出的 `_internal` **对象**里——magpie 把每个导出的*函数*当插件，对象不会
被误认。`package.json` 的 `magpie.maxConcurrency` 声明每账号在途数。

## 范围

只做插件内动作：签到触发、账单与余额查询、推理转发。不包含注册自动化、账号密码登录流或社区互动自动化。

## License

MIT
