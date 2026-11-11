# magpie-agentrouter-plus

给 Magpie 接入 AgentRouter 的独立维护插件，源码版本 **0.2.0**。在上游基础上补齐纯文本 assistant 历史回放，并提供国内／国际模型 API 开关；保留原有登录、模型列表、余额、签到、请求头和有界错误诊断能力。

- 本仓库：[ForsakenDelusion/magpie-agentrouter-plus](<https://github.com/ForsakenDelusion/magpie-agentrouter-plus>)，**目前为私有仓库**，访问与克隆需要授权。
- 上游：[ZhaoJun233/agentrouter-magpie-plugin](<https://github.com/ZhaoJun233/agentrouter-magpie-plugin>)；基线及署名见 [UPSTREAM.md](<UPSTREAM.md>)。
- **尚未发布 npm 包。** 下文仅提供本地目录／tarball 安装，不要把源码版本号当成 npm 发布或宿主已升级的证明。

## 0.2.0 改了什么

1. `use-domestic-api` 默认开启：国内 `https://ps.air-outer.com/v1`；关闭后为国际 `https://agentrouter.org/v1`。下一次模型请求读取新选择，已开始的请求保持原端点。
2. 对已证明只有普通文本的 assistant 历史，将 `output_text`／`input_text` 数组按原顺序**精确拼接为 `content: string`**，保留 `role` 和 `phase`；使用明确的 `EasyInputMessage` 输入形式，不留下缺少原生必需 `id`／`status` 的半截输出消息。
3. 保留真实注释、非空／未知概率数据、拒绝、混合媒体、未知字段、不透明 reasoning、工具关联与仅引用历史。不新增失败重试，不删历史来换取表面成功。

这不是 WAF 绕过，也不会增加额度或解密其他资源的历史。所谓“免费”取决于服务商对账号发放的额度及规则，不代表无限请求、永久免费或所有模型／两端始终可用。

## 安装与替换旧插件

插件源码使用 Node.js 20 或更新版本；Magpie 自身的运行时要求以宿主版本为准，并须支持本地目录／tarball 插件安装。以下命令在 **Magpie 实际运行的环境** 执行；容器部署需先把完整目录或安装包放进容器可读路径。

**先备份，再替换。** 本项目包名改为 `magpie-agentrouter-plus`，但 provider ID 仍是 `agentrouter`。旧插件与本插件不能同时加载，否则会重复注册同一 provider。先用 `magpie plugin list --json` 核对当前来源，并确认你的宿主版本如何停用／替换单个插件及保留认证、选项。**不能假设卸载旧包一定保留账号登录。** 不要盲目执行全局更新或重复添加；本地目录与 tarball 二选一。

### 本地目录

有仓库访问权限且已配置 GitHub SSH 的用户：

```bash
git clone git@github.com:ForsakenDelusion/magpie-agentrouter-plus.git
cd magpie-agentrouter-plus
# 确认旧插件已按宿主支持的方式停用／替换，再执行
magpie plugin add "$PWD"
magpie plugin list --json
```

已注册这个本地目录的用户，更新后按宿主支持的方式重新加载；不要再注册一份 tarball。核对提交、包版本和宿主实际加载来源，不能只看本地文件已更新。

### tarball

从受信任的本地源码打包，或使用维护者交付并核对过的同版本安装包。在仓库根目录：

```bash
mkdir -p artifacts
npm pack --pack-destination artifacts
# 确认旧插件已按宿主支持的方式停用／替换，再执行
magpie plugin add artifacts/magpie-agentrouter-plus-0.2.0.tgz
magpie plugin list --json
```

不要只复制入口模块，运行时相邻模块也必须齐全。升级／回退步骤见 [OPTIMIZATION.md](<docs/OPTIMIZATION.md#升级与回退>)；没有授权时不能通过私有 GitHub 地址下载源码。

## 登录与模型

新账号运行：

```bash
magpie plugin login agentrouter
```

- **API Key（推荐）**：在宿主原生输入框填写模型 API Key。保存不代表联网验证成功；系统访问令牌和 GitHub Cookie 都不能代替它。
- **GitHub（需系统访问令牌）**：先输入 AgentRouter 个人设置中的系统访问令牌，再由用户打开授权链接、完成浏览器授权并回填含 `code`／`state` 的完整回调 URL。只接受唯一可用的已有模型 key；没有唯一候选或列表不完整时，改用 API Key 手动指定。不自动创建、轮换 key，也不是全自动 OAuth。
- 升级不自动重写已有 key、站点或其他配置。新登录账号的**账户站点仍默认 `org`**；这与模型 API 默认走国内端不是同一设置。

provider ID 和声明的模型保持不变：

- `agentrouter/gpt-5.6-sol`
- `agentrouter/gpt-6-astra`
- `agentrouter/gpt-6.1-sol`

登录后的模型列表读取所选模型 API；读取失败时保留插件的声明列表。显示在面板中不证明该模型有可用渠道，宿主目录缓存也可能贡献条目。

```bash
magpie provider models agentrouter
# 可选的真实推理测试：可能消耗免费额度或产生费用，确认后再运行
magpie provider test agentrouter
# 可选的账号数据查询：成功不等于模型可用或签到到账
magpie quota agentrouter
```

客户端应连接 **Magpie 自己的** OpenAI 兼容入口，使用 Magpie Caller Key，而不是直接填写这里的服务商地址或模型 key。插件声明 Responses 协议；其他客户端协议的翻译由宿主负责。

## 国内／国际 API 选择

在 Magpie 的 AgentRouter provider 选项中设置：

| 选项 | 值 | 模型 API 基址 |
| --- | --- | --- |
| `use-domestic-api` | 开启／`true`（默认） | `https://ps.air-outer.com/v1`（国内 CN） |
| `use-domestic-api` | 关闭／`false` | `https://agentrouter.org/v1`（国际 INTL） |

显示名称为“国内 API（开启：ps.air-outer.com；关闭：国际 agentrouter.org）”。每次模型 fetch 在异步正文处理前固定端点；即使 loader／模型实例已缓存，下一次 fetch 也会读取新开关。进行中的请求不改道，不因切换自动重试；模型列表在下一次实际读取时使用新选择，面板缓存不保证立即刷新。旧宿主未提供该选项读取接口时使用默认国内端，能否在界面切换需核对宿主版本。

### 旧自定义地址优先：要使用开关，须主动清除覆盖值

已配置的高级字段按以下顺序解析：

```text
有效 account.endpoint
> 有效 provider.endpoint
> 有效 account.apiBase
> 有效 provider.apiBase
> use-domestic-api
```

账号字段支持宿主提供的平铺字段或 `metadata`。`endpoint` 是站点根地址／前缀，会补一次 `/v1`；已有 `/v1` 不重复追加。`apiBase` 是完整 API 前缀，按配置使用，不再补版本。

**旧配置不会被静默清空。** 若开关看起来没生效，先检查账号与 provider 两层的 `endpoint`／`apiBase`；备份后只清除你决定不再使用的覆盖字段，不要删除 key、`site`、Cookie 或其他配置。保留覆盖地址就是继续使用它，与开关值无关。

无 URL scheme 的旧误填值会被忽略；显式的非法／不安全 URL 则拒绝，不悄悄改投另一端。地址不得包含用户名、密码、查询参数、片段、空白或反斜杠，不要把密钥放进 URL。模型请求只接受当前／初始配置基址及已知两端前缀下的地址；未知来源不会获得模型凭据。高级自定义地址是信任配置，配置前应确认所有权和用途。具体安全边界见 [OPTIMIZATION.md](<docs/OPTIMIZATION.md#端点与凭据边界>)。

模型列表请求始终移除 `Cookie`、`Cookie2`、`Proxy-Authorization`、`New-Api-User`，保留适用的公开请求头与模型 key；这不改变账户余额／签到请求。Request 若需要改道、仍继承原正文且有效 `keepalive:true`，会本地拒绝而不联网；不会为构造请求无界读正文或静默清除标志。其他支持情况和处理方式见下方排障及设计说明。

### 账户站点独立

`site`（`org`／`air`）及已有 `siteURL` 控制账户网页、OAuth、余额与签到。切换模型 API **不改变账户站点，不迁移账号，不启用签到**；累计消耗查询的既有 fallback 也不跟随这个开关。余额读取、模型调用和签到发放须分别确认，旧余额缓存不等于实时读数。

## 历史兼容与其他选项

| 选项 | 默认 | 范围 |
| --- | --- | --- |
| `portable-responses` | 开 | 仅对完整、形状已知的 Responses 历史做无损内联；含仅引用历史时不做 ID 改写 |
| `text-filter` | 开 | 只按用户配置的本地字面量词表替换获准正文；没有词表时不改文字 |
| `send-codex-headers` | 开 | 保留上游插件的默认客户端标识；自定义头仍可覆盖，不保证通过 WAF |

纯文本 assistant 回放只接受已知文本字段及缺省／空 `annotations`、`logprobs`。精确拼接不插入空格或换行，移除输出消息的 `type`／`id`／`status`，保留文本、角色与 `phase`。真实注释、概率数据、`refusal`、媒体或未知字段不降级为字符串；工具 `call_id`、参数与结果保持关联。带 `previous_response_id`、`conversation`、`item_reference` 或原生 `{ "id": "…" }` 引用的请求不会执行历史内联。无内容的引用无法凭升级恢复，仍需原资源或客户端提供完整历史。

两个正文开关相互独立：关闭内联仍可过滤可见正文；全部关闭也不等于关闭认证处理或响应诊断。请求读取上限 4 MiB／2 秒，JSON 响应诊断 64 KiB／2 秒，SSE 前导诊断 64 KiB／15 秒；不确定或超出范围时保留原文，不把预算当作总请求超时。详见 [OPTIMIZATION.md](<docs/OPTIMIZATION.md>)。

私有词表使用插件安装目录中的 `content-filter.local.json`，格式参考 [示例](<content-filter.example.json>)；修改后重新加载插件。它不是通用脱敏系统，不会自动学习拒绝词或探测服务商。自定义头只放必要的非敏感客户端标识，不粘贴整份抓包、Cookie 或 Authorization。

## 验证范围与排障

本项目的离线回归覆盖实际 `auth.loader.fetch` 路径：旧安装包 0.1.6 与上游基线不能满足新的纯文本 assistant 输入契约，本项目补齐该契约，并测试信息保留与端点切换。当前接入／传输验证仅为 Node.js 离线回归与 smoke，不代表浏览器 Fetch 或正在运行的 Magpie 已完成验收。**本 fork 尚未运行需消耗额度的真实推理测试，也没有延迟／吞吐基准结果。** 离线通过不等于两端服务恢复、账号有额度、WAF 放行或旧会话可跨资源恢复。

| 现象 | 先检查 |
| --- | --- |
| 切换开关后仍走旧端点 | 账号／provider 的显式 `endpoint`／`apiBase`，以及是否真有下一次 fetch／模型列表读取 |
| 本地 `agentrouter_missing_api_key` | 是否保存了真正的模型 key，而非管理令牌或占位值 |
| 本地 `agentrouter_invalid_endpoint`／`agentrouter_untrusted_request_url` | 高级 URL 是否安全，请求是否属于受信任 API 前缀；不要用随机 URL 探测凭据转发 |
| 本地 `agentrouter_unsupported_request_transport` | 需改道的 Request 同时继承正文与有效 `keepalive:true`；主动提供字符串 `init.body` 或原生支持的传输配置，不静默改标志。同 URL、无正文、显式／准备后字符串正文及有效 `keepalive:false` 不受此限制 |
| assistant 内容类型 400 或跨资源历史错误 | 宿主实际加载包、正文开关、消息是否含引用／不透明内容；不要删除这些内容重试 |
| 401、WAF、限流、无可用渠道 | 核对脱敏错误码与请求标识，遵循上游等待提示；切换端点不保证解决 |
| 余额有值但模型失败／签到未到账 | 三项证据独立；检查余额时间与签到明确结果，不把缓存当实时成功 |

源码开发验证无需真实账号：

```bash
npm test
npm run test:policy
npm run test:headers
npm pack --dry-run
```

## 文档与许可

[更新日志](<CHANGELOG.md>) · [上游来源](<UPSTREAM.md>) · [设计与升级／回退](<docs/OPTIMIZATION.md>) · [贡献指南](<CONTRIBUTING.md>) · [安全政策](<SECURITY.md>) · [独立本地签到工具](<LOCAL-CHECKIN.md>)

原始上游说明保存在 [UPSTREAM-README.md](<docs/UPSTREAM-README.md>)，仅作基线历史记录；其中旧包名、安装步骤、服务实验和性能描述不是本 fork 的当前承诺。

使用 [MIT 许可](<LICENSE>)；保留 `Copyright (c) 2026 ZhaoJun233`，本项目改动署名 `ForsakenDelusion`。私有仓库不改变 MIT 许可，但不代表无需 GitHub 访问授权。
