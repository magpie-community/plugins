# AgentRouter

> ⚠️ **重要说明**：npm 上的 [`opencode-agentrouter-auth`](https://www.npmjs.com/package/opencode-agentrouter-auth) **不是本仓库的正规发布**，也不是本插件；请勿用它安装本插件。本仓库的 npm 包名是 `opencode-agentrouter-auth1`。

Magpie 的 AgentRouter 供应商插件：五种独立登录方式、原生多账号与智能路由、可选每日签到，以及跨协议的请求保护。请求保护由供应商的 `auth.loader.fetch` 执行，不启动独立代理，不改 Codex 配置或本地会话，不给其他供应商套全局拦截器。

运行时使用 JavaScript、标准 Web API 和 Node 兼容的只读文件 API（自带图标及模型注册表），跑在 Magpie 的 Bun 插件宿主上，不依赖外部 shell 命令，不分 Windows、macOS、Linux。设计与验收标准见 [DESIGN.md](DESIGN.md)，来源与许可见 [UPSTREAM.md](UPSTREAM.md)。

## 安装

```sh
magpie plugin add opencode-agentrouter-auth1        # npm
magpie plugin add github:roiding/opencode-agentrouter-auth   # git
magpie plugin add /path/to/opencode-agentrouter-auth # 本地文件夹
magpie plugin login agentrouter
```

需要 Magpie 0.1.1813 及以上：账号密码与系统访问令牌登录依赖宿主的 `keyless` 支持，旧版会退回多余的 API key 提问。

本插件与社区 AgentRouter 插件使用相同的供应商 ID `agentrouter`。两者同时安装时，用 `magpie plugin use` 选择由哪个插件服务该供应商，不把两份认证实现串联。已有 API key、站点会话、用户 ID、显式端点及请求头会通过兼容层读取；不会删除账号、重置令牌或擅自改变旧的独立请求/站点地址。**旧账号即使保存了密码，也不会因此默认开启自动签到**；需要通过账号密码方式明确选择开启。其他供应商的配置不改。

## 登录方式

| 入口 | 需要提供什么 | 自动签到 | 余额 |
| --- | --- | --- | --- |
| 账号密码 | AgentRouter 站点用户名或邮箱、密码 | 可选，默认关闭（详见下方开启说明） | 有效站点会话允许时读取 |
| GitHub | 浏览器完成正常授权，再交接回调或本站会话 | 不自动执行每日 OAuth | 有效站点会话允许时读取 |
| LinuxDO | 浏览器完成正常授权，再交接本站会话 | 不自动执行每日 OAuth | 有效站点会话允许时读取 |
| 系统 Access Token | AgentRouter 系统令牌和用户 ID | 不允许 | 站点权限及防护允许时读取 |
| 模型 API key | 模型调用密钥 | 不允许 | 不查询账号余额 |

所有入口都提供端点选择和基础自定义头能力。账号名称从真实身份取得，显示别名通过添加后的 Magpie 原生“改名”设置；仅模型 API key 入口可选填写真实账号邮箱，因为模型 key 无法读取站点身份。账号级额外请求头、已有调用密钥 ID 放在可选高级设置中，不要求所有用户依次填密码、Cookie、访问令牌和各种备用凭据。

账号密码、OAuth 和系统令牌入口会读取账号已有的调用密钥：只有一个有效密钥时使用它；存在多个时要求明确选择数字 ID，不擅自选第一条。没有有效密钥会明确失败，要求用户在站点管理好密钥后再连接。不会调用重置系统访问令牌的 `/api/user/token`，也不会自动创建、旋转或删除调用密钥。

模型 API key 和系统 Access Token 是两类不同凭据，不能混用。API key 入口只提供模型发现和请求保护。

## GitHub / LinuxDO 回调与端点

每个账号选择 `agentrouter.org` 或 `ps.air-outer.com`。新账号的默认 API 与站点操作使用所选端点；OAuth 应用注册的回调仍是 `agentrouter.org`，之后的 AgentRouter 侧登录兑换可以在所选端点进行。

GitHub 默认沿用未消费授权码的交接方式：浏览器返回 `agentrouter.org/oauth/github/magpie` 后，将完整地址粘回 Magpie。该子路径可能显示未找到页面，这是为了不让站点普通回调页先兑换授权码。插件校验可信域名、路径和本次 state，再携带该流程自己的站点 Cookie 向所选端点兑换；授权码不能重放。

**LinuxDO 不假设可以沿用 GitHub 的回调子路径。** 默认走网站自己的完整登录流程，再由用户明确交接 AgentRouter 会话：

1. 在打开的站点登录页选择 LinuxDO，完成正常浏览器登录；必要时将返回地址中的 `agentrouter.org` 换成所选端点域名。
2. 登录后打开浏览器开发者工具的 Network，刷新账号页面，找到本站的 `GET /api/user/self`，选择 Copy as cURL（bash 格式）。
3. 将复制内容粘到 Magpie 的登录交接框。也可使用包含 `cookie` 和 `userId` 的 JSON 导出。

该内容是敏感凭据，只在本机 Magpie 中使用，不要粘贴到聊天、Issue 或日志。**插件只解析文本，不执行 cURL 或任何命令**，只接受已知 AgentRouter 域名的本站请求。随后只读校验用户 ID，再读取已有调用密钥。导入的浏览器客户端头仅用于本站接口，不覆盖模型请求的客户端标识。

GitHub 也可选择这种完整网页登录后的交接方式。LinuxDO 的未消费回调 URL 方式保留为高级选项，但不能拿已被站点网页兑换的授权码再试。

不保存 GitHub/LinuxDO 的网站登录 Cookie，不管理它们的多账号浏览器资料，不每天自动重新授权。OAuth 登录是否同时获得当日奖励，以站点实际响应为准，不能仅凭已有会话或余额刷新宣称签到成功。

## 签到、余额和多账号

> **【重点提示】开启每日自动签到步骤**
>
> 1. **添加账号时授权**：仅「账号密码」入口支持自动签到（GitHub、LinuxDO、系统访问令牌和模型 API key 均不自动执行签到）。在添加账密账号时，提示 `开启每日自动签到？` 请选择 `是 - 保存密码用于每日签到`。
> 2. **在 Magpie 设置中开启宿主权限**：完成账号添加后，**必须前往 Magpie 宿主设置开启调度开关**。路径为：打开 Magpie 的 **设置（Settings）› 额度（Allowances）**，在页面下方的每日签到列表中找到 **AgentRouter** 并将其滑块置为 **On**。
>    - Magpie 宿主默认对第三方插件不开启后台自动签到，必须在此处开启后，宿主后台例程才会将其纳入每日定时签到调度（通常在上午轮询执行）。
>    - 若配置了多个账密账号，在 AgentRouter 签到行下还可单独控制每个具体账号的签到开关。
>    - 打开开关后宿主会在下一个定时周期调度执行，非即时触发；也可在卡片上直接点击立即执行。

- 自动签到只由 Magpie 的 `auth.checkin` 调度。供应商启用签到后，插件仍要求该账号明确选择签到、并具备站点账密和用户 ID。
- 开启签到才把站点密码保存到 Magpie 本地认证存储；关闭时密码只用于当次登录。这里不是承诺使用系统钥匙串或加密存储，仍需保护本机认证文件。
- 签到是站点登录操作，响应 `checked_in: true` 才记为新领取；当日已处理则不再次登录。并发重复调用会合并。
- 返回的站点用户 ID 必须匹配目标账号；错误密码、验证码或账号变更不能覆盖另一个账号的会话，也不误判独立模型 key 失效。
- `auth.usage` 严格只读，不因查余额失败而登录签到。余额缺失或受 WAF 拦截时显示未知；累计消耗不是余额，未知不是零。
- 站点同时返回余额与累计消耗时，用两者生成可切换的“已用/剩余”金额窗口；只有余额时保留 Magpie 的钱包余额字段参加原生路由。百分比来自站点实际数据，不伪造重置窗口。签到奖励增加余额，不等于额度每天自动重置。

可重复添加多个账号。每个账号的端点、凭据、模型和签到状态独立，由 Magpie 决定账号选择、冷却、并发及故障切换；插件内部没有隐藏的账号池。按意图换模型也使用 Magpie 的原生路由组，过滤器自己不换模型。

### 真实账号名、显示别名与旧记录

真实账号名与显示别名是两回事。新登录的 `accountId` 优先采用站点真实邮箱，缺失时采用站点用户名，仍缺失才使用站点 UID。账密和 OAuth 的登录响应可能不含邮箱，因此完成登录时会额外读取并校验 `/api/user/self`；系统令牌和会话导入已读取该接口，不重复查询。身份不匹配或资料验证失败时不保存账号，也不凭备注猜测邮箱。

原实现把“账号备注”放在 `email` 提问中，再优先写入 `accountId`，导致 `maodou38` 这样的显示别名被当作原账号名。这是插件的字段混用问题，不应解释成正常的备注行为。现在不再将备注当作账号身份；旧流程中已填写的备注仅作为 `label` 保留，不参与账号名或 UID 的生成。

当前已验证的 Magpie 0.1.1976 插件 SDK 没有登录时写入原生显示别名的接口，因此撤掉误导性的“账号备注”输入，而不是返回一个宿主不识别的 `alias` 字段或直接改写宿主配置。添加完成后使用 Magpie 原生“改名”：例如账号名 `alice@example.test`，显示别名 `roiding`。部分界面仍会并列显示别名与真实账号名；两个不同邮箱使用相同显示别名，不会因此变成两个同名原账号。若真实账号名本身重复或身份未知，宿主仍可能显示槽位标记，不能删除 UID 来掩盖。

旧记录不会在加载、余额刷新或签到时静默改写 `accountId`：宿主别名和部分路由设置按原账号名关联，直接替换会丢失关联。旧记录缺少邮箱时也不能把备注当作邮箱。当前宿主对“相同 UID、不同账号名”的重新添加不保证去重，**不要把再次添加或删除旧账号当成无损迁移**；迁移必须同时保留存储槽位、别名及按名称关联的设置，需要宿主侧配合。这里修复新登录的命名来源，不宣称已自动迁移既有账号。

余额接口不返回 `usage.user`，不拿站点用户名覆盖宿主账号名；读取余额不修改名称、别名、UID 或凭据。

## 模型与请求头

**没有默认模型。** 模型目录按账号发现，公共元数据只补充已发现模型的协议、能力、推理档位和上限，不凭公共定价表或注册表扩大账号可用列表。用户显式声明的模型和 API 地址作为人工覆盖保留，最终权限仍由上游校验。发现失败时保留可信缓存/显式配置，不退回写死的模型名单。

模型元数据逐字段按以下优先级解析：用户覆盖、账号 `/models` 声明、本站 `/api/pricing`、对应服务商注册表、原厂精确型号、可信同族信息，最后才使用宿主已有字段。读取 `limit.context/input/output`、`reasoning_options`、推理/工具/输入输出模态等能力；将原厂声明的 effort 转成 `capabilities.reasoning` 和 `variants`，不统一塞入 `low/medium/high/xhigh`。用户可通过 `variants.<档位>.disabled` 隐藏档位；显式 `reasoning: false` 禁用推理档位。仅有 toggle 或 budget 控制时不编造 effort 档位。注册表只补充总上下文 `context` 和输出上限 `output`，不提供 `input`：Magpie 把插件模型的 `input` 直接当作告知 agent（并导出给 Codex）的窗口，继承厂商规格会把 1M 总窗口压成 922k 输入上限，模型选择器的 1M 徽标也会因此消失；`input` 只认用户覆盖、账号声明、本站 pricing 或宿主已有配置。

优先只读宿主的原始 `models.json` 缓存，避免宿主规范化时丢失 `reasoning_options`；缓存不可用时匿名读取 `https://models.dev/api.json`，不发送账号凭据。内存缓存每五分钟重新检查，可用插件选项 `modelsRegistryPath` 指定只读注册表路径。带日期的别名仅在完整基型号的多个已知版本一致时回退；其他同族回退必须有明确 family 声明，并且只补充原厂多个同族成员一致的字段。不同型号对 `none` 等档位存在分歧时不取并集。

`context` 是总上下文，`input` 是独立输入上限，`output` 是输出上限，不互相冒充，也不通过相加猜测总窗口。缺失值保持未知；低优先级的上限不能覆盖更高优先级声明，也不能留下明显矛盾的窗口。Magpie 可能为 Codex 选择输入上限，并在 compact 模式下另设工作窗口；Codex 的工作窗口不等同于模型总上下文。**不要手改会重新生成的 Codex 模型目录**，更新插件并正常刷新模型，由宿主重新导出。

模型 API 可以是 Responses、Chat Completions、Anthropic Messages 或 Gemini。用户显式 SDK/模型配置优先；不使用一个无条件的 loader `baseURL` 覆盖所有模型的独立地址。AgentRouter 元数据只写 `openai` 时无法区分 Chat 与 Responses，默认按该站点现有 Responses 接入，仍允许用户明确覆盖 SDK。

自定义头不是某种登录的附加特权。模型请求原样透传 Magpie 已合并的本次请求/当前模型头；账号自定义头可以覆盖它们，不混合其他模型的头。兼容客户端标识（默认开启，可关闭）只在 Responses 协议上把网关替换掉的客户端身份恢复为 codex 客户端标识，账号自定义头仍然优先。登录、签到和账户信息等站点请求统一使用 Chrome 浏览器请求头（含 `Origin`/`Referer`），账号自定义头和会话导入的浏览器头优先于默认值。认证头使用当前账号的模型密钥，并按出站协议选择 Bearer、`x-api-key` 或 `x-goog-api-key`。站点 Cookie、系统令牌及用户 ID 不发送到模型接口。

账号级自定义头不能直接覆盖认证、Cookie、Host、连接与长度等受管理字段；此类凭据应由对应登录方式维护。

## 多协议请求保护

保护四类对话 API 的流式与非流式请求：

1. 首次保留请求体原始字节；普通重试也保留，不预先删历史、不替换 `model`。这里指 `fetch` 收到的上游协议请求；Magpie 可能已转换客户端协议。
2. 仅 Responses 的明确资源不匹配、会话绑定失效（`session binding invalidated` / code 30013）或 `invalid_encrypted_content` 才执行已验证的历史清理。资源不匹配同时识别原始 `Azure OpenAI resource` 和 AgentRouter 脱敏后的 `*** OpenAI resource`，仍要求完整的两句资源错误说明；兼容上游增加的 `OpenAI Responses bad request:` 前缀。会话绑定失效兼容 HTTP 400/409、JSON/纯文本/SSE 错误体；两者也会识别 SDK 包装成 `stream disconnected before completion: ...` 的异常消息。会话绑定清理后同时轮换请求中的会话标识并只重试一次。非流式 HTTP 200 中明确的错误对象也在交付前检查。
3. 清理保留消息正文、图片、phase、工具参数/结果及 `call_id` 配对；需要无法恢复的服务端引用、压缩或 item reference 时明确失败，不静默丢上下文。
4. Chat、Anthropic、Gemini 不套用 Responses 字段删除。thinking、signature、thoughtSignature 不会因为泛化错误而被删掉；未经验证的签名修复不猜着做。
5. 限流、传输与已识别的可用性错误有限重试；502/504 等状态中的明确 `upstream_idle_timeout`、`stream_disconnected` 错误也进入传输重试，不再只识别 HTTP 200 内的同类错误。认证失败、余额不足和普通参数错误不触发清理。

单次选定供应商调用最多额外重试 20 次，资源/限流/传输/可用性分别最多 5/20/10/10 次；会话绑定失效单独最多恢复一次，不会在同一个失败绑定上循环。遵守服务端等待提示、总期限、空闲期限和客户端取消。Magpie 跨账号故障切换是独立外层，不应把这里的 20 次宣传为整条调用链的总数。

SSE 在确认有效终止前不交付内容或客户端工具调用。Responses 识别 completed/incomplete；Chat 检查 choices 和 DONE；Anthropic 检查 message_stop；Gemini 检查候选项结束或合法阻断，并等待正常流结束、保留用量尾帧。失败尝试整体丢弃，同一网络块中终止标记之后的多余内容不泄露。合法拒绝、长度终止不当成断流重放。

缓冲不再等于下游完全静默。流式请求等待超过默认 10 秒后，提前返回 SSE，并定期发送不含 response/item ID、正文或工具调用的非内容事件。Responses 使用 Codex 能解析但不当作输出的 `response.in_progress`；其他协议使用对应空进度帧。只发送 `: keepalive` 注释不足以重置 Codex 的 SSE **事件**空闲时钟。保活覆盖上游等待和重试退避，但不会重置独立的上游空闲计时或总期限；日志中的 `sse-keepalive-started` 表示已启用本次下游保活。

快速响应保留原 HTTP 状态和响应头。保活开始后 HTTP 头已提交，后续失败通过 SSE 错误事件交付，携带原始错误码、HTTP 状态及重试/认证提示，不拼接裸 JSON，也不伪造完成。成功 SSE 保留上游 ID 和事件字节；上游退回完整 JSON 时，只转换协议已终止的结果，不把处理中或失败状态伪造成完成。依赖完整原始 HTTP 响应头的调用方可设置 `keepaliveMs: 0` 关闭提前交付。Magpie 自身还可能暂存非内容事件；当前实测版本最多暂存约四分钟，因此网关版本、代理缓冲或更短的客户端超时仍需独立检查，不能承诺消除所有断流。

未知路径及上传、删除、批任务、站点管理等操作不盲目重放。压缩/二进制请求体暂按原格式透传，不冒充能够安全清理；正常 fetch 自动解压的上游 JSON/SSE 响应可以处理。插件不能扩展 Magpie 尚未提供的网关入口。

全量缓冲增加首字等待。默认单个请求/响应缓冲上限 64 MiB，并非整个宿主的内存上限；并发及拷贝会增加峰值。取消会中止读取和退避；超限明确失败，不改成先输出再重试。它不保证上游工具或推理只执行/计费一次。

## 开关与参数

供应商开关「安全重试加密历史错误」只控制请求保护，不影响认证及账号能力。默认开启。插件选项示例：

```json
{
  "quotaPerUnit": 500000,
  "filter": {
    "enabled": true,
    "deadlineMs": 1800000,
    "idleTimeoutMs": 120000,
    "keepaliveMs": 10000,
    "maxBufferBytes": 67108864,
    "maxRequestBytes": 67108864
  }
}
```

日志只记录结构化事件、类别、计数和耗时，不记录请求正文、密码、Cookie、令牌、授权码或 state。Magpie 当前宿主会丢弃日志的 `extra` 字段，因此这些安全诊断也写进 `message`，可以直接看到 `kind`、`errorCode`、清理计数和重试次数，而不只是事件名。

## 开发

```sh
npm test
bun test
```

普通测试只使用模拟数据和本地 HTTP 服务，不读取真实账号或调用收费模型。真实 Magpie 宿主/网关测试默认跳过，必须明确提供测试路径：

```sh
MAGPIE_TEST_HOST=/path/to/host.js MAGPIE_TEST_BUN=/path/to/bun npm run test:host
MAGPIE_TEST_BINARY=/path/to/magpie MAGPIE_TEST_BUN=/path/to/bun npm run test:gateway
MAGPIE_TEST_BINARY=/path/to/magpie MAGPIE_TEST_BUN=/path/to/bun MAGPIE_TEST_SSE_IDLE=1 npm run test:gateway
```

宿主脚本应来自隔离 HOME 中 Magpie 写出的缓存。这些测试创建临时配置、模拟账号和回环服务，并在结束后清理，不修改现有 Magpie 配置。

`MAGPIE_TEST_SSE_IDLE=1` 额外运行约四分钟的真实网关测试，模拟 Codex 的五分钟 SSE 事件空闲计时：注释不算活动，收到真实进度事件后才允许上游完成。这能发现只在过滤器单测中“保活成功”、经过网关却仍无事件的问题。

本包自包含，不捆绑上游源码。旧通用供应商入口 `generic.mjs` 继续保留，用于非 AgentRouter 场景，不会由默认入口自动注册。

## License

MIT
