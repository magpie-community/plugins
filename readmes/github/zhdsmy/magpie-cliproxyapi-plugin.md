# magpie-cliproxyapi-plugin

[English](README.en.md)

CLIProxyAPI（CPA）的 Magpie provider 插件。**本插件主要聚焦 Claude via CLIProxyAPI**：Claude 推理走 CPA 的 Anthropic 兼容接口，识别出的 Codex 模型走原生 Responses；填写管理 key 后，还可读取 Claude 凭据的五小时与周限已用百分比、**重置卡**（Claude 设置 > 用量里的免费重置）和模型思考等级。无需额外 shim；OAuth 登录、Token 刷新和上游凭据选择均由 CPA 负责。

CPA 提供的其他供应商模型仍会被发现和转发。Codex 额度来自社区贡献；Codex 协议、思考等级、重置卡与按模型路由只在隔离宿主和 mock CPA 中验证；其他非 Claude 能力未验证。需要其他供应商的支持，欢迎贡献或 fork，见[定位、贡献与 Fork](#定位贡献与-fork)。

已验证 Magpie 0.1.2790 / 0.1.2826 与 CPA 8.0.51 的 Claude 链路。重置卡展示目前仅经 mock 测试。

插件内置 [router-for-me](https://github.com/router-for-me) 组织头像作为统一图标，缩放为 128×128 并嵌入元数据，显示时无需额外网络请求。

## 安装与登录

需有可用的 CPA 后端、业务 API key，以及支持 provider 插件的 Magpie。Magpie 会准备 Bun 运行时；插件本身没有外部运行时依赖。

```sh
magpie plugin add https://github.com/zhdsmy/magpie-cliproxyapi-plugin
magpie plugin login cpa
```

仅通过 GitHub 分发，不发布 npm 包。开发时可用 `magpie plugin add /absolute/path/to/magpie-cliproxyapi-plugin` 安装本地目录。

Magpie 服务运行中执行登录后，请运行 `magpie plugin on <安装时使用的包名或路径>`（本地开发示例为 `magpie plugin on /absolute/path/to/magpie-cliproxyapi-plugin`），或重启 Magpie 服务，使新账号生效。

登录时填写：

| 字段 | 含义 |
| --- | --- |
| CPA Base URL | 必填，例如 `https://cpa.example.invalid`。允许尾部 `/v1`，会自动去掉；不允许 URL 用户信息、query 或 fragment。 |
| Business API key | 必填，密码输入；CPA 业务 key，用于模型发现与推理。插件去掉首尾空白后返回给 Magpie。 |
| Management key | 可选，密码输入；用于额度及 Claude / Codex 思考等级。不填仍可推理，但不查询管理接口，也不显示思考等级。 |
| Management URL | 可选，**完整管理入口**，例如 `http://127.0.0.1:8317/v8/management`；默认 `<CPA Base URL>/v8/management`。 |
| CPA credential | 可选，按 CPA 凭据的 `name` 或 `auth_index` 精确选择。 |
| Model quota routing | 默认关闭。仅在确认 CPA 没有配置文件 API key、openai-compatibility 或插件提供同名模型时开启。 |

业务 key 由插件的登录字段收集。新版 Magpie（已核对 v0.1.4139）不再单独询问 key；旧版（已核对 v0.1.2738、v0.1.3431）可能会再问一次，以插件收集的业务 key 为准。

业务 key 与管理 key 分开使用，同存于 Magpie 的 `plugin-auth.json`，由宿主以 0600 权限保存。插件不读取 CPA 的 OAuth 文件。

插件返回的 metadata 不含业务 key。旧版宿主会把登录回答额外复制到同一文件的 `metadata.businessKey`；新版宿主不复制 password 回答。

模型名称为 `cpa/<CPA 模型 ID>`，例如 `cpa/claude-sonnet-4-6`。发给 CPA 的模型 ID 保持原样。插件通过 CPA 的 Anthropic 兼容接口转发 Messages、SSE、工具往返和 count_tokens。发现并行读取 OpenAI 格式列表的真实 ID 和 Anthropic 格式列表的名称，不随凭据组合切换策略。名称列表遇到非 401/403 错误时，使用 ID 作为名称；OpenAI 列表失败仍整体失败，任一列表 401/403 都标记登录过期。仅排除 `claude-fable-5-dd-` 开头的 cloaking 编码 ID；实际暴露范围由 Magpie 的模型选择与白名单控制。OpenAI 格式列表中 `owned_by === "openai"` 且 ID 不以 `claude-` 开头的模型使用 CPA `/v1/responses`，Bearer 为业务 key；CPA 会强制 `store:false`，Magpie 每次发送完整对话。其余模型保持默认 Anthropic 协议。边界：多个 provider 注册同一 ID 时，CPA 的 `owned_by` 来自最后一次注册，因此不能据此识别该 ID 的全部后端；由用户确认池配置。

已有名为 `cpa` 的自定义 provider 时，Magpie 会把插件的**生效 ID** 改为 `cpa-plugin`，模型变为 `cpa-plugin/<ID>`。用 `magpie providers`、`magpie models` 或网关模型目录确认；`magpie plugin --json` 仍可能只显示插件自报的 `cpa`。

## 管理访问与额度

管理 key 拥有 **CPA 完整管理权限，绝非只读额度 key**。插件只将其作为 Bearer 发送到指定管理入口，拒绝跳转；不会将其发往业务端点或直接发往 Anthropic / ChatGPT。仅使用你信任的管理入口和传输链路。

CPA 只把其看到的 `127.0.0.1` / `::1` 视为本机。通常需要 Magpie 与 CPA 处于同一网络命名空间并使用回环地址；否则需由你开启 CPA `allow-remote`；建议配合来源防火墙、隧道或私网限制访问。同机不同 Docker 容器、私网或 Tailscale 地址通常仍算远程。插件不修改这些设置，**不建议公开管理接口到公网**。

额度按所选上游**凭据账号**计算，不是按模型计算，也不代表整个 CPA 凭据池。适配器按管理接口返回的凭据 `provider` 分派；目前支持 `claude` 和 `codex`。Claude 保持 `5 hours` / `7 days`；Codex 按窗口时长命名，例如 `5 hours` / `7 days` / `30 days`。窗口输出已用百分比、跨度和重置时间，不显示金额或邮箱。管理接口还提供 Claude / Codex 频道的模型思考等级；插件把有等级定义的模型标为 reasoning 并显示等级。等级请求路径为 `GET <管理基址>/routing/model-definitions/claude` 和 `GET <管理基址>/routing/model-definitions/codex`。如果管理接口前有反向代理白名单，必须放行这两个路径，否则不会显示等级。管理接口不可达、返回错误或没有管理 key 时，模型仍正常发现但不带等级。发现模型本身不代表支持其额度或思考等级。

下表为按模型路由开关关闭时的默认规则。

| 凭据选择 | 行为 |
| --- | --- |
| 未指定，没有启用且受支持的凭据 | 显示“暂不支持额度”或没有启用凭据的错误，不输出窗口。 |
| 未指定，唯一启用且受支持的凭据 | 自动选择；总共只有一个启用凭据时参与额度路由，否则仅展示。 |
| 未指定，多个启用且受支持的凭据 | 展示全部受支持凭据的窗口，全部为 `aside`；纯 Claude、纯 Codex、混合池规则相同。 |
| 指定并唯一匹配受支持凭据 | 查询该账号；多个启用凭据时带标签，全部为 `aside`，**只展示、不参与路由**。 |
| 指定凭据的 provider 尚无适配器 | 只报“该供应商暂不支持额度”，不调用上游额度接口，不改查 Claude。 |
| 选择不存在、已禁用或不唯一 | 显示错误，不回退到其他凭据。 |

启用凭据总数包括尚不支持额度的供应商。多凭据时，即使只有一个可查询，也不能保证 CPA 的业务请求使用它，因此仍只展示其窗口。

### 按模型参与路由（默认关闭）

登录时将 `Model quota routing` 显式选为 Enabled，插件才保存 `metadata.modelRouting: "enabled"`。只有在 CPA 没有配置文件 API key、openai-compatibility 或插件提供同名模型时才开启：这些来源不出现在 `/credentials`，插件不能证明它们不存在。

开启且没有显式选择凭据时，插件读取每个启用、受支持凭据的 `GET <管理基址>/credentials/models?name=<name 或 ID>`。列表与 `/credentials` 共用 15 秒缓存，复用每管理 scope 最多 2 个并发。某 ID 只属于一个凭据时，该凭据的窗口带 `models: [独占 ID]` 且不设 `aside`；用尽只影响这些模型的额度路由判断，不停止整个 CPA 账号；宿主只有一个可用候选时仍可能尝试请求，窗口不是请求硬限制。共享模型、没有独占 ID 的凭据或失败行仍为 `aside`。任一清单失败，或池内有不支持的凭据时，全部回退为 `aside`。管理 401/403 仍整体熔断。唯一启用凭据及显式选择的规则保持不变。

风险：CPA 的模型注册可在两次刷新之间变化，清单不是原子快照；错误开启会把单凭据额度误用于路由。保持默认关闭即可使用原有展示规则。反向代理另须放行上述只读路径；无需放行任何含密钥或写类接口。

多凭据窗口名为 `<窗口名> (<Claude|Codex> <标签>)`，按 provider、标签排序。标签优先使用 `label`；为空、含 `@` 或控制字符时，使用不透明 `auth_index` 的前 8 位。不使用 `name`，因为它常含邮箱。显式选择也使用同一标签规则。

同一管理入口与 key 的凭据读取并发最多 2，共用一次调用的 15 秒预算。单个凭据失败时显示带标签的纯文本 `aside` 行，其他凭据继续展示；全部失败才整体报错。管理 401/403 始终整体停止；已发出的并行请求可以完成，不启动排队请求。同时读取多个凭据时不显示或合并重置卡；只读取一个凭据时（含池内显式选择），照常返回 `resets` 和 `plan`，与 `aside` 无关。

可用 `magpie quota --json` 查看读数。宿主报告 JSON 不输出 `aside` 字段，这不表示多凭据窗口参与路由。

### Codex 额度

主动请求为 `GET https://chatgpt.com/backend-api/wham/usage`，经 CPA 管理 `api-call` 发送，凭据仍用 `$TOKEN$` 占位。若 `/credentials` 返回 `id_token.chatgpt_account_id`，请求带上 `Chatgpt-Account-Id`；缺失时省略，不猜工作区。

只解析 `rate_limit.primary_window` / `secondary_window`，异常窗口跳过，无有效窗口时报错。只读取一个凭据时将白名单内的套餐类型放入 usage 的 `plan` 字段，不拼进窗口名。主动读取优先用 `reset_at`；缺失时按读取时刻加 `reset_after_seconds` 计算；两者都没有时保留窗口，省略 `resetsAt`。若 CPA 返回不超过 5 分钟、完整且未过期的 `x-codex-*` 主次窗口信号，直接展示，不主动请求 usage；只有重置卡清单过期时补读清单。被动信号的相对重置时间以 CPA 的观察时间为起点。主动和被动路径均只经隔离测试。

重置卡优先使用 usage 的 `rate_limit_reset_credits`；缺失时经 `api-call` 发送 `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`。只展示 `resets`，不调用 `consume`，不消耗卡。清单按凭据缓存 30 分钟；清单失败（含 400/403/404）只隐藏卡，窗口照常显示，30 分钟内不重试。被动窗口新鲜时只补读过期清单。带 `Chatgpt-Account-Id` 的条件与 usage 相同；详情请求另带管理中心的 Accept、OpenAI-Beta、Originator 头。计数与明细一致时才输出逐卡到期时间。多凭据同时展示时不输出卡。

不读取 `additional_rate_limits`、余额 credits 或订阅到期时间。未验证真实 CPA / ChatGPT。

### Claude 重置卡

额度请求为 `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1`，经 CPA 管理 `api-call` 发送。同一个响应同时带有窗口和 `cedar_ember` 重置卡清单，不增加请求次数。结果按 Magpie 原生的 `resets` 字段返回，账号卡片直接显示“↺ N 次重置”，悬停可看到最早到期时间和每张卡的到期时间，无需额外配置。

- 插件**只读**：不调用 `POST /api/organizations/{org}/reset_rate_limits` 或 `/api/oauth/profile`，也不调用 CPA 的冷却重置接口，不会消耗重置卡。Magpie 只为内置 Codex 账号提供“使用重置”按钮，插件账号的重置卡仅展示；需要使用时，请在 CPA 管理面板的 Claude 额度卡片上操作。
- 张数为各 grant 的 `resets_left` 之和，跳过已到期的 grant；`type` 为 `session` / `weekly` 时分别标为五小时 / 周重置。不可用（`eligible: false`、暂停、需先触顶）的 grant 仍计入持有数，是否能用以 CPA 管理面板为准。
- 与 CPA 管理面板一致，任一 grant 格式异常就整块不显示，避免把不完整清单当作完整数量；窗口不受影响。卡片 ID 和标签不会返回给宿主。
- 上游对带查询的请求返回 400/403 时，改用不带查询的请求重读一次，只显示窗口。该凭据此后 24 小时直接发不带查询的请求，不再每次多发一次。其他状态不重试。
- 资格由 Anthropic 服务端决定，可能与请求 UA（固定 `claude-cli/2.1.280`）有关；Anthropic 调整后可能需要更新插件。

### 减少对 Anthropic 的请求

Anthropic 对 `oauth/usage` 限流很严。插件按以下方式减少请求：

- **按上游凭据缓存与合并。** 读数按 CPA 凭据（`auth_index`）缓存 300 秒。留空、填名称、填 `auth_index` 而选中同一凭据的多个 Magpie 账号，共用一份读数、同一个进行中的请求和同一个退避。同一 CPA 下同时刷新的账号在 15 秒内共用一次 `/credentials` 列表。
- **优先用 CPA 已有的数据。** CPA 把每次真实推理响应的 `anthropic-ratelimit-unified-*` 头记在该凭据的 `quota.signals` 中，插件本来就读取的 `/credentials` 会返回它。若记录不超过 5 分钟，且 `5h` 和 `7d` 的用量与重置时间齐全、未过期，插件直接用它显示窗口，不请求 Anthropic。此时重置卡清单每 30 分钟才重读一次，期间已到期的卡在显示时剔除；在 CPA 管理面板使用重置卡后，张数最多滞后 30 分钟。CPA 版本不返回该字段，或凭据近期没有推理时，按原方式读取。此路径按 CPA 源码实现，目前只经过 mock 测试。
- **遵守上游限流。** 内层 429 带 `Retry-After` 时按其等待；连续失败的退避从 300 秒起翻倍，最长 1 小时。退避期间不请求 Anthropic；有近期 CPA 记录时仍用它显示窗口。

## 鉴权失败与恢复

CPA 对同一来源 IP 的管理鉴权失败累计 5 次会封禁 30 分钟，包括回环地址。插件遇到管理端 401/403 后（包括模型发现时读取思考等级），会停止对该管理入口和 key 的自动请求；改凭据选择不会解除停试。业务推理和业务账号状态不因额度错误而失效。

先修正管理 key 和远程访问设置，再恢复查询：更换管理 key 或管理入口并重新登录，或在配置修好后重启运行插件的 Magpie 宿主进程。**仅修复 CPA 侧设置，然后以相同 key/入口重新登录，不会清除原进程的停试状态。** 停试状态仅在当前插件进程内维护；新 CLI 进程或重启可能重新尝试，因此不要用错误 key 反复启动查询。

管理端临时错误退避 300 秒，上游错误的退避见上文；成功读数缓存 300 秒，并发调用合并为一次读取。插件最多沿用 900 秒内的旧读数，缺失或错误额度不会填成 0%。整次管理读取最多 15 秒。

## 宿主行为与限制

- 插件不增加推理重试。Magpie 宿主会对普通 429 重试同一 CPA 账号，隔离实测约 **8 次、37 秒**，实际策略随宿主版本和响应而变。
- Magpie 0.1.2738 发往 CPA 的业务 UA 为 `magpie/0.1.2738`。此插件被宿主视为账号，正式命令 `magpie provider set cpa user-agent=agent` 会被拒绝，GUI 也不提供该选项；本版本没有已验证的客户端 UA 透传方式。CPA 会将其视为非 Claude Code 客户端，可能按凭据的 cloak 配置改写请求。如需透传行为，应按 CPA 文档显式配置该凭据的 cloak 模式并验证；插件不自动调整，也不伪造 Claude CLI UA。
- 管理 api-call 内的 Claude OAuth usage 请求使用固定 UA `claude-cli/2.1.280 (external, cli)` 及 beta 头；Anthropic 调整要求时可能需要更新插件。
- Magpie 额度卡片有约一分钟缓存；即时重复读取可能不调用插件，GUI 卡片的刷新按钮可强制重新读取。
- Magpie 会把良好额度落盘，在某些临时错误时继续回显并标记 `asOf`，重启后也可能保留。**插件的 900 秒上限不约束宿主这层旧值保留**，请留意读数时间。
- 额度适配器支持 Claude 和 Codex；不输出 Opus/Sonnet 等模型专属窗口，也不把单凭据额度当作整个池的额度。
- 非 Claude 模型的工具、思考、prompt 缓存和计数等能力取决于 CPA 转换与实际后端，需自行验证；模型发现成功不等于这些能力已验收。
- 不提供 OAuth 登录、Token 刷新、模型改写或自定义故障切换。count_tokens 的同模型故障切换与恢复仍取决于宿主，尚未验收。

- Magpie 0.1.2790 的插件账号实测不会在额度报告中产生 `last` / `lastServedAt`；外部工具不应依赖这些字段判断当前账号。

## 修改配置与卸载

重新运行 `magpie plugin login cpa` 修改地址或 key。宿主按 `cpa@host:port` 标签识别账号：同一 host:port 只保留一个，即使 URL 路径不同；重新登录会替换原记录。

以下命令已对照 Magpie 0.1.2738 的 CLI：

```sh
magpie plugin logout cpa       # 删除插件登录信息
magpie plugin                 # 查看安装项，确认名称
magpie plugin rm '<installed-plugin-name>'
```

卸载前同步调整使用 `cpa/` 或 `cpa-plugin/` 的客户端、模型组等配置。注销和移除插件不等于撤销 CPA 端的 key。

## 定位、贡献与 Fork

维护者主要使用和验证 Claude via CLIProxyAPI。Codex 额度为社区贡献，Codex 扩展仅经隔离宿主与 mock CPA 验证；其他供应商功能仍依赖社区贡献。欢迎提交 issue 和 PR，也欢迎在 MIT 许可下 fork，按自己的需要发展。

PR 请遵守以下约定：

- 不引入运行时依赖。管理 key 只发往管理入口；不向宿主返回邮箱或 ChatGPT account id；展示标签按上文规则处理。
- 不增加重试、登录或 OAuth 刷新。缺失或无效的读数报错，不填成 0。
- 新行为用虚构 key 和响应的 mock 测试覆盖（`npm test`），并说明哪些内容经过真实 CPA 验证。

为其他供应商新增额度适配器：

1. 在 `index.mjs` 的 `usageAdapters` 新增一项，键与 CPA `/credentials` 返回的 `files[].provider` 完全一致。
2. 实现 `read(apiCall, credential, { now, memo })`。`memo` 是按凭据保留的对象，可记住上游的长期状态。每次 `apiCall({ method, url, header })` 经 CPA 管理 api-call 发送一个内层请求；上游凭据用 `$TOKEN$` 占位，由 CPA 替换。公共流程添加 `auth_index`，内层状态非 200 时抛错。
3. 按 Magpie usage 格式返回 `{ windows, resets?, plan? }`，例如 `{ name: "5 hours", used: 25, span: 18000, resetsAt: "2026-11-04T00:00:00.000Z" }`；`used` 是已用百分比，`span` 单位为秒。没有有效读数时抛错。可选实现 `passive(credential, now)`：从 CPA 已返回的凭据数据得出 `{ windows, observedAt }`，不发上游请求；无可靠数据时返回 `undefined`；不需要重置卡清单的适配器可返回 `inventory: false`，让完整被动信号跳过主动读取。
4. 管理鉴权、15 秒预算、响应大小限制、封禁停试、按凭据共享的缓存、单飞、退避和多凭据 `aside` 标签由公共流程自动处理。

注意：未指定凭据时会读取全部启用且受支持的凭据。新增适配器会增加混合池展示的窗口。按模型路由关闭时，只有唯一启用凭据的窗口参与路由；开启后的规则见上文。

## 开发与致谢

```sh
npm test
```

测试使用虚构 key 和本机 mock，不需要真实账号。官方宿主联调另有隔离证据，不能代替真实 CPA 验收。

参考了 MIT 项目 [sub2api-magpie-plugin](https://github.com/FischelChern/sub2api-magpie-plugin) 的 Magpie 接入方式；本项目运行时代码独立实现，未复制其代码段。MIT 许可证见 [LICENSE](LICENSE)。
