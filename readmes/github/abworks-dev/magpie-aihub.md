# Magpie AIHub 自动路由

面向 **aihub.top 普通消费者** 的 Magpie Provider 插件。用自己的账户或分组 Key，在 Magpie 中提供一个 `aihub-auto` 上游入口，按倍率和延迟选组、保留会话线路、在首次响应前有限重试。

**版本：v0.3.3（预发布）。** 当前实现覆盖 `openai`、`deepseek`、`zhipu`、`kimi`、`grok`、`gemini` 六个平台；非 OpenAI 模型使用 `platform::model` 命名空间，仅在**同平台、同模型**的分组间 failover。Gemini 可显式选择 Responses 或原生 Gemini 协议，其他平台支持 Responses / Chat Completions。外部平台接口依据公开文档与公开代码核对，**不代表六平台真实调用均已实测**。v0.3.0 新增账户余额卡、每账户 Key 上限与余额阈值暂停建 Key；v0.3.1 在页面令牌过期时自动重载一次，并把服务端拒绝快照的 `error.code` 显示在监控页，便于区分令牌过期与入口代理改写。

已通过 192 项本地测试，并在隔离的官方 Magpie 0.1.3250 `magpie web` 实例中经真实浏览器打开：页面经插件服务代理加载、`magpie.ready` 连通、监控标签跳转到服务页并在沙箱 iframe 内读到 `/snapshot`。余额/消耗接口来自已登录 AIHub 页面的实际响应样本，但页面余额卡与 Key 上限保护只在合成快照和本地 Edge 渲染中验证。官方 Magpie 0.1.3250 隔离检查涵盖插件加载、合成凭据登录、六平台 8 个模型与三种 SDK 注册。真实生产实例联调、真实 AIHub 账户与计费推理仍未验证。独立 MIT 实现，不复制许可不明项目代码。图标取自 [AIHub 官方站点](https://aihub.top/) 公开页面的 PNG favicon，内嵌到元数据与页面；品牌图像权利归原站点。

## 安装

在 Magpie 插件管理页添加以下来源：

```text
github:abworks-dev/magpie-aihub
```

不带 `#ref` 的写法跟随仓库 main，Magpie 的「更新」按钮才会真正生效。需要复现某一版时写 `github:abworks-dev/magpie-aihub#v0.3.1`（本版起使用轻量标签）；固定 ref 的安装会持续显示「有新版本」——Magpie 用仓库 HEAD 与已装 commit 比较，而点更新也不会改变 pin，这是宿主行为（[yetone/magpie#6952](https://github.com/yetone/magpie/issues/6952)）。

也可使用经核对的 commit 或完整本地仓库。公开仓库无需 GitHub 私有仓库权限；运行 Magpie 的主机仍需能够访问 GitHub。无需编译；推理路由不依赖独立代理，页面与只读监控由插件自己的回环服务提供。详细步骤与限制见[安装与首次验收](documentation/installation.md)。

仓库打有 `magpie-plugin` GitHub topic，Magpie 的「插件 → 发现」会在“非官方插件”区按 star 降序列出本仓库；topic 生效后宿主的搜索结果会缓存约 10 分钟，重启 Magpie web 可立即刷新。本插件未发布到 npm，发现页的 npm 区不会出现。

本项目使用 [Magpie 插件接口](https://usemagpie.ai/docs/zh/plugins) 的密码提示、keyless API authorize、provider.models、静态页面 bridge 与 page.service。安装后仍需核对页面、认证和模型列表；[已有验证记录](documentation/tests.md)区分本版隔离检查与尚未完成的生产验收。

## 两种接入方式

### 1. 手工导入分组 Key（推荐首次验收）

在 `AIHub Auto` 的连接/认证界面选择“导入分组 Key”，在**保密输入框**填写 JSON 数组。例如以下全是假值：

```json
[
  {"groupId": 101, "platform": "openai", "key": "REPLACE_WITH_GROUP_101_KEY", "multiplier": 0.08, "models": ["YOUR_MODEL_ID"]},
  {"groupId": 202, "platform": "deepseek", "key": "REPLACE_WITH_GROUP_202_KEY", "multiplier": 0.12, "models": ["YOUR_DEEPSEEK_MODEL_ID"]}
]
```

- 每把 Key 应绑定一个固定分组，`platform` 必须与该组一致；旧导入省略平台时默认为 `openai`。`multiplier` 填实际账号倍率，组内 `models` 填上游原始模型 ID。
- `models` 可省略，此时通过该 Key 的 `/v1/models` 获取；提供时按声明的精确模型 ID 匹配。读取成功不保证推理可用。
- 此模式不登录控制台、不创建/删除/修改远程 Key，也不读取账号大厅；按声明倍率、实际首字节延迟和错误结果路由。
- `requirePassed` 必须关闭：手工模式没有可信的大厅检测结果。如果 AIHub 改价，需更新导入信息；这不是动态费用上限。

### 2. AIHub 账户模式

在认证界面输入 AIHub 邮箱和密码。密码仅用于登录，保存访问/刷新令牌；需要 2FA 或交互验证码时登录可能失败，可改用手工 Key。

登录后，模型列表留空即可从账号可用分组与供应商大厅发现模型，不需要先创建专用 Key。发现结果受启用平台、实际倍率、允许/排除分组、检测状态及组内模型限制筛选；目录未提供可识别模型时会提示错误，可手工指定准确 ID。显式配置模型优先于自动发现。

**获取模型与调用模型是两步。** 自动发现只读取目录，不调用推理、不创建 Key。若账户尚无本插件专用 Key，首次业务请求前仍需主动开启 `autoCreateKeys`，或改用手工导入分组 Key。自动发现使用默认 API，Gemini 自动发现固定使用 Responses，不凭模型名称猜协议；原生 Gemini 需显式指定。

此模式会：

1. 读取账号可用分组、专属倍率以及供应商大厅；优先使用 v2 大厅接口。
2. 按六平台目录识别分组，排除未启用平台、下架/不可见/明确检测失败、超倍率及人工排除的分组。
3. 在用户允许自动创建后，为选中的分组创建 `magpie-aihub-<instance>-g<id>` 专用 Key，上限由 `poolSize` 与 `maxKeysPerAccount` 共同控制；`minBalance` 大于 0 且读到的账户余额低于阈值时暂停新建。
4. 保存平台归属与未完成创建记录；未知创建结果只重新查询，不盲目重建。

**不会自动删除 Key，不会改绑现有 Key，也不会自动清理其他实例的 Key。** 没有验证 AIHub 建 Key 的额度参数，因此不会声称新 Key 自带消费限额。可在 AIHub 控制台为专用 Key 设置额度，关闭它的自动改组，并避免其他选组工具管理同一把 Key。

池满后继续用已建 Key；价格排名变化不会自动轮换/删除。创建结果不确定时，先查看 AIHub 中对应专用名称；自动恢复只接受精确匹配项。删除插件或重新登录不会撤销旧的远程 Key，请在 AIHub 手工核对、撤销不再使用的专用 Key。同一账户重新登录会退掉它自己的旧连接并沿用其已保存的专用 Key，同一分组不会再建第二把；换成别的账户时不沿用，两个账户各自保留连接，监控页按账号分卡列出。

## 六平台与模型协议

| 平台 | 对外模型 ID | 可选协议 |
|---|---|---|
| `openai` | `MODEL_ID` | `responses` / `chat` |
| `deepseek` | `deepseek::MODEL_ID` | `responses` / `chat` |
| `zhipu` | `zhipu::MODEL_ID` | `responses` / `chat` |
| `kimi` | `kimi::MODEL_ID` | `responses` / `chat` |
| `grok` | `grok::MODEL_ID` | `responses` / `chat` |
| `gemini` | `gemini::MODEL_ID` | `responses` / `gemini`（原生） |

设置页模型行可写 `deepseek::MODEL_ID|chat`、`gemini::MODEL_ID|gemini`；JSON 配置可写 `{ "id": "gemini::MODEL_ID", "api": "gemini" }`。非 OpenAI ID 必须标明平台，显式 `platform` 与 ID 命名空间须一致。上游把 `platform:model`（单冒号）或裸模型 ID 交给插件时同样可以路由：单冒号按平台命名空间解析，裸 ID 在已启用平台里按分组公布的模型查找；都找不到时 503 文案会带上各分组被排除的原因与计数（如 `over the multiplier cap ×8`），便于直接调整倍率。协议决定宿主 SDK 与请求形态，不做任意协议转换；远端是否支持该模型/协议需另行验证。插件发往上游前剥离内部命名空间，始终保持相同平台和原始模型 ID，不能以跨平台或换模型方式降级。

## 常用设置

插件自带中文静态配置页，仅保存非秘密选项。账号密码、令牌和 Key 均不应放进 options。

| 选项 | 默认 | 含义 |
|---|---|---|
| `platforms` | 六平台全部 | 启用平台列表；仍需有符合条件的组与模型 |
| `strategy` | `balanced` | `economy` 按名义倍率；`speed` 按首字节延迟；`balanced` 将倍率与延迟相乘评分；`price` 按真实价格排序，缺价的分组不参与，全部缺价时回退为 `economy`；`value` 用「价格 × 延迟惩罚 × 失败惩罚」算性价比（缺价时用名义倍率）；`reliable` 先按成功率排序，成功率相同时比价格 |
| `maxMultiplier` | `0.16` | 名义倍率硬上限，**0 表示只允许免费组** |
| `platformCaps` | `{}` | 按平台覆盖上面的上限，例如 `{"deepseek":1,"zhipu":1.2}`；没写到的平台沿用 `maxMultiplier` |
| `maxAttempts` | `3` | 每次请求最多推理尝试数，包含首次；范围 1–5 |
| `poolSize` | `4` | 托管专用 Key 数量上限，范围 1–8；手工导入可多于此值 |
| `allowedGroups` / `excludedGroups` | `[]` | 分组 ID 白名单/排除名单，排除优先 |
| `requirePassed` | `false` | 仅使用大厅 `passed` 分组；手工模式不支持 |
| `autoCreateKeys` | `false` | 允许账户模式按需创建 Key；关闭不撤销已有 Key |
| `maxKeysPerAccount` | `8` | 插件专用 Key 总数上限（1–32）；达到后不再新建，已有 Key 继续可用 |
| `minBalance` | `0` | 0 关闭；账户余额低于该值时暂停新建 Key，不删除已有 Key |
| `dailyBudget` | `0` | 每日花费上限（与「真实价格」同单位），按响应 `usage` 与分组真实价格累计；0 关闭；超限的请求直接返回 429 `daily_budget_exceeded` |
| `priceAlertRatio` | `0.2` | 分组真实价格相对上次观测变化超过该比例（0.2 = 20%）时在监控页提示；只提示，不参与路由 |
| `breakerWindowMs` / `breakerMinSamples` / `breakerFailureRate` | `300000` / `5` / `0.5` | 滑动窗口熔断：窗口内失败数达到样本下限且失败率超阈值才冷却该分组，避免一次抖动把好分组踢掉 |
| `defaultApi` | `responses` | 默认协议；可设 `chat`，Gemini 自动发现仍使用 Responses；原生 Gemini 须显式配置 |
| `models` | `[]` | 字符串 ID 或 `{id, platform?, api?, context?, output?}`；空列表自动发现 |
| `monitorPort` | `19871` | 页面服务与监控的回环端口；默认候选，**尚未在生产分配或确认可用** |
| `firstByteTimeoutMs` / `totalTimeoutMs` | `30000` / `90000` | 单次首字节期限 / 路由与首字节总预算；输出后不截断长流 |
| `refreshMs` / `maxStaleMs` | `60000` / `600000` | 按需目录刷新间隔 / 故障时旧目录可用上限 |
| `sessionTtlMs` | `86400000` | 内存会话保留时间 |

发现模型时上下文/输出默认 128000/16384，真实能力可能不同；可显式配置。模型成本字段的未知占位 0 不表示免费；实际计费以 AIHub 为准。监控缺失指标使用 `null`，不伪装为零。

## 页面、只读监控与密钥错误

设置和监控是**同一个页面**：Magpie 里打开的是静态设置页，它经 `bridge.service` 或监控标签跳到插件自己的回环服务（`127.0.0.1:<monitorPort>`），那里同时提供设置和只读监控。`magpie web` 会把该服务代理到插件页面路径下，所以从别的电脑经 Magpie 访问时不需要另开端口；桌面版 Magpie 不代理服务，页面会提示在本机打开 `http://127.0.0.1:19871/`。`monitorPort: 19871` 只是默认候选，须先核对目标主机端口和宿主服务桥接。

服务只监听回环，仅接受 GET/HEAD，并要求精确 `Host`、`Origin` 缺省或为 `null`、无请求体；快照还需要服务注入到页面里的进程级令牌（`x-aihub-service-token`），因此别的站点或被沙箱化的第三方页面无法读取。Cloud 当前仅批准四个静态资源，未批准 service 新路由，不能据此声称生产监控已接通。如果 `magpie web` 前面还有反向代理或入口（Caddy/Nginx/Cloudflare 等），它必须原样转发 `/_magpie/plugin/<32 位 token>/_magpie/service/` 及其下的 `snapshot`、`identity`、`metrics`，并且**不能剥离路径前缀**；只放行 `index.html`、`app.js`、`style.css`、`_magpie/bridge.js` 时，点「监控」会落到代理自己的 404 页（如 Caddy 的 `Not exposed by this Magpie entry.`），这不是插件渲染错误。

快照顶部为账户卡：余额、冻结金额、今日/本月消耗（按平台配额汇总）、累计请求、专用 Key 数量与上限、各平台日/月用量与限额，以及最近建 Key/阻止事件。余额数据以 60 秒间隔读取 `/api/v1/auth/me`、`/api/v1/usage/stats`、`/api/v1/user/platform-quotas`；读取失败时沿用上次快照（最多 10 分钟），并显示 `billing_unavailable`、`billing_access_denied` 或 `billing_sign_in_required` / `billing_session_expired`，不推断数值。接口正常但响应里没有余额字段时（组织或配额账号常见），余额仍显示 `—`，但卡片会标注“该账户未返回余额字段”，与读取失败区分开。分组表的“真实价格”由 AIHub 区间窗口的 `range_cache` 折算：窗口内 `input/cache_read/cache_creation` 的成本之和除以 Token 之和，再乘 1e6，得到每百万 Token 的美元价；窗口未就绪、已过期或 Token 为 0 时不显示，也不推断。`/api/v1/keys` 会返回明文 Key；插件只在恢复本实例创建的专用 Key 时读取该列表（按实例命名精确匹配），不做批量导出、不记录明文。账户卡标题显示脱敏标识（如 `ab***@example.test`），点标题旁的眼睛按钮时才向 `GET /identity` 取一次完整账号（同一页面令牌、只读、不写回快照），再点收起；快照本身始终不含完整标识。账户卡还带 Key 池清单（每把 Key 的来源与最近使用时间，从未使用的会标出），顶部有「今日花费 / 预算」与价格波动提示，分组表增加「平均」「使用」两列。`GET /metrics` 以 Prometheus 文本输出账户数、请求数、失败数、今日花费，与快照同样只在本机回环可达。

快照展示分组可用性/筛选原因、倍率、可得的成功率/TPS/缓存命中率/价格、目录新鲜度、Key 数量及最近 100 条内存路由结果。缺失、未就绪或不可信的指标为 `null`。快照不返回原始认证包、Key、Cookie、请求/响应 body 或会话 ID。监控读取可按需发起远端目录 GET，并可能触发管理令牌刷新与保存；**不会推理探测或创建 Key**（但若自动发现与 `autoCreateKeys` 同时开启，业务请求仍可能触发建 Key）。

Key 准备失败返回稳定的 `error.code` 和脱敏信息，停止本次请求，不盲目创建或重放：

| code | 处理方向 |
|---|---|
| `key_not_imported` / `key_creation_disabled` | 导入该组 Key，或确认后启用自动创建 |
| `key_pool_full` | 核对已有专用 Key 与池上限；插件不自动删除轮换 |
| `key_creation_pending` / `key_creation_incomplete` | 到 AIHub 核对专用名称与未知结果，避免重复建 Key |
| `key_duplicate` | 人工核对同名同组冲突，插件不自动选择或清理 |
| `key_sign_in_required` / `key_session_expired` / `key_access_denied` | 重新认证或核对账号权限 |
| `key_rate_limited` / `key_preparation_failed` | 按脱敏提示核对限流/管理接口状态，不公开原始响应 |

## 路由边界

- Magpie 会话 ID → 内部平台/模型会话映射；没有会话标识时每次独立选组。内部平台/会话头不会发给 AIHub。
- 同一会话在分组仍符合硬条件时优先保留原组。亲和仅在内存，宿主重载/重启会重置；不保证上游命中缓存。
- 推理限流、401/403、5xx、网络错误与首字节超时触发冷却，并在同平台同模型候选间切换；遵守 `Retry-After`。普通 400/404 不泛化重试。Key 准备错误直接停止。
- 已返回首字节后，流中断直接报错，不重放请求。首次响应前重试仍可能导致上游重复计费；与 Magpie 外层重试共同控制总预算。
- 客户端需发送完整对话历史。`previous_response_id` 和服务端 `conversation` 状态续接会明确拒绝。
- 远端固定 `https://aihub.top`：Responses / Chat Completions / models 使用 `/v1`；原生 Gemini 仅允许 `/v1beta/models/<model>:generateContent` 和 `:streamGenerateContent`，流式只接受可选 `alt=sse`。拒绝其他路径、query、重定向和自定义上游。
- 请求头按白名单重建；Bearer 分组 Key 或原生 Gemini 的 `x-goog-api-key` 仅在服务端注入，不转发客户端 Cookie、Magpie API Key 或管理令牌。
- 没有后台付费探测、外发遥测或自动计划任务；目录按需刷新，回环页面服务只提供只读视图。

## 出网代理

Magpie 把宿主代理以 `MAGPIE_HTTPS_PROXY` / `MAGPIE_HTTP_PROXY` / `MAGPIE_ALL_PROXY`（及对应小写形式和 `MAGPIE_NO_PROXY`）传给插件进程，普通 `HTTPS_PROXY` 并不保证存在。Bun 的 `fetch` 不会自己读取环境变量，所以插件的每个出站请求都显式带上 `proxy`：取值顺序 `MAGPIE_HTTPS_PROXY → HTTPS_PROXY → MAGPIE_ALL_PROXY → ALL_PROXY`，命中 `NO_PROXY` 时直连；未配置代理时行为不变（直连）。这解决的是容器直连 `aihub.top` 被投毒解析、连接被重置这类环境问题，不改变任何接口语义。

## 开发与验证

```sh
npm test
npm run check
npm pack --dry-run
```

源码为无依赖 ESM，测试使用 Node >=22 内置测试器；运行环境为 Magpie 的 Bun 插件宿主。CI 同时检查 Node、Bun 与 Windows 上的官方宿主和两项浏览器回归；v0.2.0 提交 `5795e41` 的[三个任务](https://github.com/abworks-dev/magpie-aihub/actions/runs/43917943251)均通过，v0.2.1/v0.2.2/v0.3.0/v0.3.1 的验证记录见[验证记录](documentation/tests.md)。没有下载后自动执行的安装脚本。

验收顺序：先导入两把同平台同模型、已限额的测试 Key → 核对命名空间与协议 → 少量真实对话 → 检查会话保持和失败场景 → 再考虑账户自动建 Key。真实模型测试会产生费用；local mock 与 Edge 合成代理不证明六平台真实接口、生产权限、费用或可用性。opc-agent 生产私有路径已被拒绝，不能通过其他路径或身份绕过。

发布约定：打**轻量标签**（`git tag v0.2.3`，不加 `-a`/`-m`）。Magpie 的 git 插件更新检查把 bun 记录的 ref 与仓库解析出的提交比较；注解标签会被 bun 记成标签对象 sha、被 Magpie 剥成提交，两者永不相等，插件页会一直显示“有新版本”而更新无效（[yetone/magpie#6952](https://github.com/yetone/magpie/issues/6952)）。已按 `#vX.Y.Z` 安装的用户可用 `#<40 位提交>` 重新安装来消除提示。

[架构与边界](documentation/architecture.md) · [认证/请求流程](documentation/flows.md) · [权限](documentation/permissions.md) · [配置与秘密](documentation/variables.md) · [自动化](documentation/automation.md) · [验证记录](documentation/tests.md)

## 来源与许可

本项目 MIT。根据公开接口文档与消费者 API 契约独立实现；未复制 `WSXYT/aihub-auto` 或未确认许可项目的实现。

参考：[Magpie 插件接口](https://usemagpie.ai/docs/zh/plugins)、[llm-retry-proxy 的 MIT 适配器与夹具](https://github.com/momijineko/llm-retry-proxy/tree/5ee295abba330078adee3a5e065459df36a38a11/retry_proxy/sync_adapters)。公开代码与消费者字段观测不等于 AIHub 官方稳定契约，也不等于六平台实测；接口变化会导致适配失败。
