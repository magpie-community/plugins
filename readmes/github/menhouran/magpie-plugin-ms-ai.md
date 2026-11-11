# magpie-plugin-ms-ai

魔搭国际站（modelscope.ai）API-Inference 的 magpie / OpenCode 供应商插件：注册 `modelscope-ai` 供应商，提供模型列表与推理，并处理每日魔粒签到与余额显示。

## 功能

- **供应商注册**：`modelscope-ai`，`@ai-sdk/openai-compatible`，`https://api-inference.modelscope.ai/v1`。用户已自定义的 provider 配置不会被覆盖。
- **模型**：登录后从 `GET /v1/models` 拉取账号可见的全部模型；未登录或拉取失败时使用实测可用的内置列表。每个模型都按 OpenCode 完整模型形态返回（limit / capabilities / api / release_date），推理、工具调用、图像输入等能力如实标注。模型名的可读形式由 id 推导（`deepseek-ai/DeepSeek-V4.1-Flash-1017` → `DeepSeek V4.1 Flash 1017`），`created` 填成 `release_date`；实测不可调用的条目（`Qwen-Ambassador/*`、以及若干返回 400「has no provider supported」的 id）标为 `deprecated`，插件宿主会过滤掉，选择器和路由组都看不到。
- **推理**：以账号令牌添加 `Authorization: Bearer` 转发。上游响应（400/401/402/403/429 等）原样返回，故障转移交给 magpie。现行计费为魔粒按次扣（轻量 ~0.5 / 标准 ~1 / 旗舰 ~2 魔粒每次），额度即魔粒余额，见下。
- **每日签到**：magpie 每账号每北京日调用一次 `GET /api/v1/users/login/info`，该请求本身触发当日魔粒发放（服务端幂等）。插件在签到前后读取魔粒账单（`/openapi/v1/magicubes/transactions`）校验结果：今日已有 `daily_active` / `aliyun_bindlogin` 记录返回 `done` 并上报到账魔粒数；新到账返回 `claimed`。
- **余额与积分窗口**：`GET /openapi/v1/magicubes/balance` 读取 `available_balance`。窗口的 `display` 是「**剩余** / 发放」（如 `228 / 250 · 11 次调用`），而 `amount` / `limit` 两个字段按 magpie 的契约填「**已用** / 总量」——见《行为说明》的窗口字段契约。路由走「合计」窗口：`limit` 是余额 + 当日已用，路由页显示 `已用 / 总余额`。分母是账单里今日**全部** EARN 行的实际发放魔粒（社区奖励也算），不是 `total_balance`——后者官方定义是「可用 + 冻结」，跟已用无关。账单读不到时余额只以一个钱包窗口报（`balance`，不给百分比）。余额耗尽时「合计」报 100% 并给出次日发放时间，magpie 会将该账号停用到该时刻，签到发放后自动恢复。`runsOutAt` / `runsOut` 另报当日魔粒的到期时刻与到期损失量：发放后 24 小时滚动过期，与窗口重置是两件事。
- **鉴权口径**：余额走官方 Bearer（见 `/.well-known/openapi.json` 的 Magicube 板块），被拒时回落到网站会话 Cookie；账单与签到用的是网站内部接口，只能用 Cookie。
- **账号显示名**：优先用官方 `/openapi/v1/users/me`（Bearer、无副作用）把用户名写回账号（`client.auth.set`）；该接口答不出时才回落 `login/info`（它会顺带触发签到）。多账号不再显示为 `API key …xxxx`。

## 内置模型

未登录或拉取失败时的兜底，均为国际站实测可调用：

| 模型 | 上下文 | 输出 |
| --- | --- | --- |
| deepseek-ai/DeepSeek-V4.1-Flash-1017 | 1,048,576 | 393,216 |
| zai-org/GLM-5.2 | 1,048,576 | 131,072 |
| nex-agi/Nex-N2.5-Pro | 262,144 | 235,929 |

`/v1/models` 列出的模型并非都可用：`Qwen-Ambassador/*` 返回 403（账号无权限），部分条目返回 400「has no provider supported」。2026-11-02 用 `magpie provider test modelscope-ai <model>` 逐个复测后，以下 id 标为 deprecated（精确匹配，不是前缀——`DeepSeek-V4-Pro` 死了但 `DeepSeek-V4-Pro-0813` 可用，`DeepSeek-V4.1-Flash` 死了但 `-1017` 可用）：

`deepseek-ai/DeepSeek-V4-Pro`、`deepseek-ai/DeepSeek-V4.1-Flash`、`deepseek-ai/DeepSeek-V4-Flash-0731`、`zai-org/GLM-5.3`、`zai-org/GLM-5.3-Flash`、`stepfun-ai/Step-5-Preview`、`stepfun-ai/Step-3.5-Flash`、`MiniMax/MiniMax-M3`、`Menlo/Jan-nano`、`early-access/EA-29B-A4B`（403）。厂商随时可能上/下架，启用新模型前仍应实测。

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

令牌保存在 magpie 的 `plugin-auth.json`，插件不做服务端校验；401/403 会把账号标记为需要重新登录。

## 行为说明

- 额度卡片平时跑本地估算，几乎不打上游：**余额每 30 分钟读一次**，估算值按旗舰档 2 魔粒/次扣减（只会高估消耗、不会高估余额，安全方向）；估算余额 ≤ 4、**估算消耗过锚点的 80%**、或收到 402 时立即向厂商同步实数——80% 线是防"估算还剩不少"实际已见底，magpie 把账号误停到次日；**当日账单一天只读一次**（发放构成一天不变），签到到账即失效重读。纯 pull（magpie 展示卡片时才读）。读取先走官方 Bearer 契约，被拒回落 Cookie。429 是网关限流，原样交回、magpie 自行退避，插件不做任何余额读取。
- 推理响应的登录判定显式上报：401 标记登录过期（令牌被拒）；402（余额）、403（模型无权限）、429（网关闭流）标记为 kept，不误伤账号。网关不提供 Retry-After，退避完全由 magpie 处理。
- 网页接口（余额 / 账单 / 签到）的判定：**只有 401 判为令牌失效**；403 是魔搭风控（账号通常没事），当作可重试失败，交给 magpie 30 分钟后再试，不误把账号标记成需重登。
- **窗口字段契约：`amount` 是已用量，`limit` 是总量，绝不是剩余量**。magpie 宿主 `internal/provider/plugin_usage.go` 在插件没给 `used` 时按 `Amount / Limit * 100` 反推百分比，GUI 的多账号聚合（`mergeQuotas`，`quotaall.js`）也按窗口名把各账号的 `amount` 与 `limit` 分别相加再取占比。**把剩余量填进 `amount` 的必然结果**：单账号卡片显示「230 / 230」，聚合显示「合计 1,248 / 1,248 · 已用 100%」——而 `magpie quota` 读显式的 `used` 字段，看着是 0%，所以只拿 CLI 验证永远发现不了（这个 bug 就是这样活了 5 个版本）。三个窗口的字段：「今日发放」`amount` = 当日已用、`limit` = 当日发放；「长期魔粒」`amount` = 0、`limit` = 长期池；「合计」`amount` = 当日已用、**`limit` = 余额 + 当日已用**，即「每日 250 + 永久」的真实总量（早先按「当日发放 + 今天账单里的长期行」算，而永久奖励多半是往日到账、不在今天账单里，总量会算得比余额还小）。账单读不到时整卡只出一个钱包窗口（`balance`，无 `used` / `limit`）。
- 额度卡片的窗口（三个）：**「今日发放」**`display` 为 `剩余 / 今日发放 · N 次调用`，已用量取账单 `SPEND_CONFIRM` 行的实数（退款是负行，会夹到 0），并和「入账 − 余额」的差额取大者——扣费先冻结余额、账单后确认，两者取大才不会漏报在途扣费。分母是今日**全部** EARN 行（社区奖励也算）。**「合计」**是路由窗口：`amount` = 当日已用、`limit` = 余额 + 当日已用，带 `span: 86400` 与次日北京 00:35 的 `resetsAt`，magpie 的 90% 保留线因此按**总余额**算，而不是按当日发放算；余额归零时 `used: 100`，`heldUp` 把账号停到下次发放。有余额时百分比压在 99，避免 `heldUp` 只看 `used >= 100` 误停还有钱的账号。当日魔粒的 `expire_at`（北京钟面，转 ISO）在两个窗口上都走 `runsOutAt`；「合计」的 `runsOut` 只报其中当日发放的部分（`min(余额, 当日剩余)`），长期池不跟着过期。**「长期魔粒」**= 余额超出当日未耗发放的部分（一次性奖励、社区魔粒等，90 天过期）。
- **窗口名固定，数字只进 display**：magpie 的额度历史（`quota-history.json`）按窗口名分线记录，名字里带「剩 230」这种随用量变的数字会让每个数值都成为一条新历史线，曲线全碎。因此三个窗口名恒为 `今日发放` / `长期魔粒` / `合计`，剩余量在 `display`（`230 / 250 · 12 次调用`）里。
- **「今日发放」「长期魔粒」标 `aside: true`，路由只看「合计」**：magpie 组装 allowance 时直接跳过 aside（`allowanceOf`：`if w.Aside || w.Text { continue }`），所以只有「合计」参与 `For` / `Count` / `Pace`。「合计」带 `span: 86400` 与 `resetsAt`（次日 00:35），Pace 按日预算算 pace，`Count()` 也取到它的 `amount / limit`，**路由页每账号显示的就是 `已用 / 总余额`**（如 ydqwer `… / 350`），不再是永远 `/250`。90% 保留线（`routes.LowShare = 90`）因此落在总余额的 90%，结转和长期池也计入，不会出现"当日发放用到 90% 就被排后、账面还有钱"的浪费。没有当日发放、也没有长期池时，余额窗口是账号唯一的读数，此时不标 aside、照常路由。CodeArts（分解桶）与 WorkBuddy（额外积分）用的是同一手法。
- 所有网络调用 20 秒超时；挂起的厂商不会拖死额度读取或模型列表。
- 每账号状态（余额缓存、模型列表缓存、命名检查）按令牌为键并限量修剪，常驻宿主进程不会无限增长。
- 签到节奏由 magpie 调度：每账号每北京日一次，失败 30 分钟后自动重试；插件内不做额外节流。签到结果如实分三档：账单确认到账 `claimed`；账单可读但今日无到账记录 `inactive`（可能不在活动范围，不再重试）；账单本身读不到 `failed`（可能还在路上，30 分钟后重试）。不替用户领不存在的奖励。
- 魔粒每日发放后 24 小时滚动过期，不累积；调用计费为魔粒按次扣（官方三档：轻量 ~0.5、标准 ~1、旗舰 ~2 魔粒/次）。
- 协议转换、故障转移、代理与限流退避均由 magpie 负责，插件不实现代理逻辑。
- **并发**：每账号 2 路在途（`magpie.maxConcurrency: 2`）。厂商承诺单并发，但 2026-11-02 复盘 11 天生产日志（3134 次，96.5% 成功）真实流量零 429，且单账号日耗 93% 额度才是真瓶颈——放 2 路把排队时间换吞吐；若再现 429 峰值可降回 1。

## 开发

```sh
bun test        # 55 个用例，全部离线
bun x tsc       # 严格模式类型检查
```

测试通过本地 fake server 覆盖信封双大小写、签到结果（含账单校验）、余额窗口（发放口径）、Bearer/Cookie 双鉴权回落、429 直通不读余额、模型拉取与完整形态回退，运行时不访问外部网络（`nonet.ts` 拦截）。入口、测试与 fake server 均为 TypeScript，Bun 直接加载，无需构建步骤。

## 范围

只做插件内动作：签到触发、账单与余额查询、推理转发。不包含注册自动化、账号密码登录流或社区互动自动化。

## License

MIT
