# AnyRouter

面向 **magpie** 的 AnyRouter（`https://anyrouter.top`）供应商插件：六种登录入口、余额与北京时间今日消耗、由宿主调度的每日签到，以及 Claude / GPT / Gemini 模型分派。

**当前发布版本：0.2.4，通过独立 GitHub 仓库发布，不发布同名 npm 包。** 源码更新或 GitHub Release 不等于你的生产网关已升级。主要验证宿主为 Magpie 0.1.4795 + Bun 1.4.5；使用 OpenCode 风格的 hooks，但未独立验证原版 OpenCode 的加载器及专有扩展兼容性。

运行时依赖 `tough-cookie` 6；本项目的 [锁文件](<pnpm-lock.yaml>) 固定了实际依赖。插件不执行远端 JavaScript，不启动代理／保活服务，不建立自己的账号池，不创建或轮换站点 Key，也不在推理 fetch 内自动重试。

## 安装与首次检查

### 从 GitHub 安装（发布版）

按 [Magpie 官方发布说明](<https://usemagpie.ai/docs/zh/plugins#发布与上架>)，此仓库根目录提交可直接加载的入口，不依赖发布时才生成的 dist。可以固定 Release 对应标签：

```sh
magpie plugin add github:Guardinary/opencode-anyrouter-auth#v0.2.4
magpie plugin login anyrouter
magpie quota anyrouter --json
```

不写 `#v0.2.4` 时安装默认分支代码。仓库的 `magpie-plugin` topic 用于“非官方插件 · GitHub”发现，**不代表官方审核或推荐列表收录**。本仓库没有把同名上游 npm 包当作自己的发布物。

### 本地源码

本地文件夹插件原地加载，**magpie 不会替本地文件夹安装依赖**。在项目目录先明确安装锁定依赖，再交给宿主：

```sh
pnpm install --frozen-lockfile --ignore-scripts
magpie plugin add /absolute/path/to/opencode-anyrouter-auth
magpie plugin login anyrouter
magpie plugin list --json
magpie quota anyrouter --json
```

安装命令可能下载依赖；`--ignore-scripts` 禁用依赖生命周期脚本。不要在不信任的目录执行安装。此独立仓库只通过 GitHub 发布；没有发布同名上游 npm 包，发布任务也不替你改生产安装或账号配置。

供应商 ID 为 `anyrouter`。与其他 AnyRouter 插件共存时，需要在 magpie 中明确选择由哪个插件服务这个 ID。

**保存成功 ≠ 推理可用。** 控制台余额可读、账号已连接、签到成功都不能证明模型请求通过；需要你自行授权后的实际对话／模型测试。真实请求可能计费，不属于下面的离线验收。

## 六种登录入口

| 入口 | 宿主类型 | 站点凭据 | 余额／今日消耗 | 签到能力 |
| --- | --- | --- | --- | --- |
| AnyRouter 账号密码 | `oauth` | 本站用户名与密码，登录后取得 Session | 有 | 有效会话可签到；选择保存密码后可在会话被拒绝时重新登录 |
| GitHub 浏览器交接 | `oauth` | 浏览器登录 AnyRouter 后导入本站 Session | 有 | 有效会话可签到 |
| LinuxDO 浏览器交接 | `oauth` | 同上，不回放被页面消费的 OAuth code | 有 | 有效会话可签到 |
| 浏览器会话 | `oauth` | 本站 `/api/user/self` 的 cURL／JSON 导出 | 有 | 有效会话可签到 |
| 系统访问令牌 | `oauth` | 本站系统令牌与正整数用户 ID | 有 | 不支持，无 Session Cookie |
| 模型 API Key | `api` | 已有模型 Key | 仅累计消费接口可用时显示累计消耗 | 不支持 |

### 已有模型 Key 与 ID

前五个入口都提供可选的 **已有模型 API Key** 和 **已有 Key ID**：

- 直接填写完整 Key 时使用该 Key，不通过 ID 再查询或推断它的归属；保存不代表推理已验证。
- 留空 Key、填写正整数 ID：只读 `GET /api/token/{id}`，目标不存在、停用、过期、耗尽、掩码、身份不符时失败，不替换成其他 Key。
- 两者都留空：只读当前账号已有列表；仅有一条明确可用记录时选择它。多条、列表截断或没有可用 Key 时，可连接成 **余额／签到专用账号**，不会偷偷创建 Key。
- 裸 Key 的站点返回值会规范成 `sk-…`；含空白、掩码、控制字符或非 ASCII 的模型 Key 不被当作可用凭据。
- 余额专用账号的账号模型列表为空；推理本地返回 HTTP 400 `anyrouter_missing_api_key`，不发送占位符。

系统访问令牌不是模型 Key。插件不请求 `/api/user/token` 生成／重置系统令牌，也不创建、删除或轮换模型 Key。

### 账号密码

“是否保存本站密码用于会话失效后的签到登录？”只控制 **密码存储和后续续登**：

- **否**：保存会话，不保存密码；有效 Cookie 仍有签到能力，过期后需要重新连接。
- **是**：保存本站密码；只在签到预检明确拒绝会话时使用，网络／WAF／限流故障不会触发重新登录。

是否调度签到由 magpie 的额度／账号设置控制，不由这个密码选择代替。首次密码连接需要状态预检、一次认证 POST、profile 校验与可选 Key 读取；不会在登录 callback 中额外调用奖励接口。站点要求 Turnstile 时，在发送密码前提示改用浏览器交接。

### GitHub / LinuxDO / 浏览器会话

在 `https://anyrouter.top/login` 完成正常浏览器登录和人工验证。打开 DevTools → Network，找到本站 `GET /api/user/self`，复制 cURL（bash）并粘贴到 **本机 magpie 的交接框**。也接受：

```json
{"cookie":"session=VALUE_FROM_YOUR_BROWSER; acw_tc=VALUE_FROM_YOUR_BROWSER","userId":"123"}
```

这是格式示例，不是真实凭据。必须替换成你自己的本站 Cookie 和正整数 UID。插件只解析文本，不执行 cURL、shell 命令或远程脚本；不接受 GitHub／LinuxDO 本身的 Cookie。可导入的浏览器客户端头仅用于本站接口，不进入模型请求。

**导出等同于登录凭据，不要发到聊天、Issue、公开日志或仓库。**

## 签到为何与登录有关

AnyRouter 的已观察前端在取得本站登录态后调用 `POST /api/user/sign_in`，因此用户体感是“登录／刷新账号就签到了”。插件必须区分认证结果与奖励接口结果，不能把另一个魔改站点的登录奖励语义机械套过来。

浏览器页面可能自行完成这一步；插件的登录 callback 和余额查询不额外执行它。插件只在宿主调用 `auth.checkin` 时签到，不创建后台调度器。

```text
会话有效：GET /api/user/self → 一次 POST /api/user/sign_in

会话明确失效且已授权保存密码：
GET /api/user/self（被拒绝）→ GET /api/status → 一次 POST /api/user/login
→ GET /api/user/self → 一次 POST /api/user/sign_in
```

- 每次 POST 都不重放，包括密码认证 POST；返回挑战或故障也不重发同一个 POST。
- 只读 GET 遇到唯一、已知的 40-hex `arg1` 时做本地排列／XOR 计算，并最多重试一次。未知挑战和 CAPTCHA 交还浏览器，**从不执行 HTML 中的 JavaScript**。
- 预检轮换的 Cookie 用于后续请求；必须对签到的精确路径有效。UID 不匹配或登录已变化时，不提交或覆盖旧状态。
- 同 UID 的站点操作排队，执行时读取最新状态。后续同日签到读取已确认结果，不重复报告一次领取。
- 按北京时间的 **确认日** 保存 `claimed`／`done`。`captcha`、`inactive`、`ineligible`、`failed` 都不伪造当天完成标记。
- 成功 POST 后若本地保存失败，仍返回已确认结果并提示保存问题；不会因保存失败再次写入或重发 POST。
- `claimed` 是站点确认本次成功，`done` 是已完成／空成功消息；不凭登录或余额变化猜测固定每日奖励。

## 余额、累计消耗与今日消耗

站点账号默认只查询一次 `/api/user/self`：余额取 `quota`，累计消费取 `used_quota`。GUI 的 **查询站点今日消耗**（`site-today-spend`）默认关闭；开启后才额外查询北京时间今日 `type=2` 消费统计。

- 同凭据并发额度读取合并；取消一个调用者不影响其他调用者，全部取消才停止共享请求。签到不合并结果。
- 成功额度读取缓存 60 秒；缓存文本保留实际采样时间，不因刷新改写。新登录、Key／凭据更改、Cookie 到期和今日窗口跨北京时间午夜不会复用旧样本。
- 站点 HTTP429、`http_ratelimit` 和明确业务限流触发所有控制台账号／匿名价格共享的冷却：至少 60 秒，较长 `Retry-After` 优先，最多 24 小时。冷却不阻断模型推理，不触发密码续登。
- 冷却期间最多保留 5 分钟的旧样本；过期余额只作为标注采样时间的历史文本，不返回数值路由钱包，不把旧余额冒充新读取。缓存限于当前插件实例、最多 64 个凭据作用域；跨进程限流状态不共享。

- 默认 `quotaPerUnit=500000`，同一个选定换算率用于金额文本与数值钱包；不自动把 `/api/status` 的值改写成用户配置。
- 标准换算率保持单个 quota 的精度。非常规换算率最多展开 18 位小数后截断；不宣称所有分数都能用有限小数精确表示。合法安全整数换算率不会把单个非零 quota 显示成零。
- 明确的 `0` 才是零；缺失、错误类型、非安全整数、不可完整汇总都显示不可用。负值不被插件伪装为零；宿主自身可能另有数值窗口展示策略。
- `/api/log/self/stat` 被 WAF 拦截或无有效统计时，回退完整日志分页：100 条／页，最多 20 页。已知 WAF／404／405 统计路径在当前实例跳过 15 分钟，再到期尝试；不暂停余额／签到／日志路径，不把普通网络故障视为路径屏蔽。重复页／ID、总数变化、提前结束、越界时间、错误 UID、超过范围均不发布部分总数。
- 调用者取消或统计接口限流不触发继续分页或另一次统计回退。
- 今日失败只影响今日窗口；控制台会话过期不把独立模型 Key 标成失效，返回 `signIn: kept`。
- 业务接口只读，但收到的 Cookie 轮换可以经宿主保存；不能把“只读余额接口”误解为“绝不更新本地会话”。

### 站外用量同步（显式开启）

Magpie `auth.calls` 默认返回空列表，不发送请求。普通用户在 GUI 开启 **同步站外用量（自动排除当前 Key）**（`site-external-usage`）即可，无需填写外部 Key ID：

- 仅本站会话／系统令牌账号可读；先校验当前 UID，再只读识别当前 Key ID 并排除其日志。已保存的 ID 仍需核对实际 Key；没有 ID 时读取完整有界列表。无法唯一识别、身份不符或列表截断时明确失败，不猜测来源。
- 余额／签到专用账号没有当前模型 Key，读取全部完整日志；有模型 Key 的账号导入其他 Key 的日志，包括已有日志里的历史 Key ID。
- 本站没有可靠客户端来源字段。**其他 Key 也可能被另一 Magpie 账号、进程或设备使用，自动同步仍可能重复计账；当前 Key 的站外消费默认不导入。** 开启前 GUI 会提示该限制。
- 高级白名单继续兼容：`provider.anyrouter.externalUsageKeyIds`（最多十个唯一正整数）优先于 GUI 自动选择，且显式空数组关闭同步。指定 ID 必须只用于外部客户端，不用于任何 Magpie 账号；插件校验元数据并拒绝当前 ID／同一 Key／掩码。它是用途声明，不是站点来源证明。不创建或轮换 Key。
- 可选 **同 Key 站外同步（尽力匹配）**（`site-external-same-key`）默认关闭，必须同时启用自动站外同步；高级白名单不受它影响。仅同步本实例开始追踪后、最近一小时的同 Key 日志，不补更早历史。按模型、普通／缓存 token 和本地请求时间区间（容差 5 秒）作互相唯一匹配；匹配到的本地调用不重复导入。
- **这不是精确去重。** 相似请求可能误匹配而漏记，重启、新登录、未知用量、取消、超限或未读完响应可能缺少指纹而重复计账。歧义匹配不被冒充确定来源。追踪最多 64 个登录／Key 作用域、512 条指纹，纯内存、不落盘；观察不主动读取、不重试，原始响应字节保持不变。JSON／SSE 单帧缓冲最多 64 KiB、总观察最多 4 MiB，超限只停止观察。
- 固定游标时间窗口内完整读取 100 条／页、最多 20 页，按 `token_id` 筛选；重复 ID、总数变化、身份／时间不符、未知缓存用量、取消或 Cookie 保存失败都会使读取失败，不推进宿主游标、不返回部分消费。
- `rid` 为 UID 作用域的稳定站点日志 ID；秒级日志转为毫秒，不编造毫秒精度。缓存读／写与普通输入分开，消费 `cost` 使用既有 `quotaPerUnit` 换算；缺失费用不猜零。
- 不导出日志正文、用户名、Key、Cookie 或任意 `other` 字段。Cookie 轮换只按既有队列和凭据快照安全保存。同步调度与去重由 Magpie 控制，插件不新建后台定时器。

## 模型与协议

| 模型／形态 | 默认 SDK | 网关路径 |
| --- | --- | --- |
| `claude-*` 与 `*-cc-format` | `@ai-sdk/anthropic` | `/v1/messages`，兼容开关开启且请求可识别时加 `beta=true` |
| GPT / Codex | `@ai-sdk/openai` | `/v1/responses` |
| `gemini-*`（非 `*-cc-format`） | `@ai-sdk/google` | `/v1beta/models/{model}:generateContent` 或 `:streamGenerateContent?alt=sse` |

2026-11-26 实测 `gemini-4-neon` 经本插件原生 Google 路径返回 200 SSE 并以 `STOP` 结束。旧版本把 Gemini 误分派到 Responses，会出现图示 404；0.2.2 修正默认 SDK／路径，并保留显式用户 SDK 与端点声明。carbon 原生路径当时返回负载上限，2.5-pro 原生路径返回 404；协议正确不保证所有上游模型当前可用。模型列表发现仍走 `/v1/models`，不会改为 `/v1beta/models`。

更新后在模型页点击“重新获取模型”。如果你曾手动固定某个 Gemini 的 Responses API，请恢复默认，或将 SDK 设为 `@ai-sdk/google`、基础地址设为 `https://anyrouter.top/v1beta`；插件不会偷偷覆盖明确的用户配置。无需重新登录或轮换 Key。历史 Chat Completions 探测仍为 404，不通过自动改协议重发来掩盖错误。

[内置声明](<lib/declared-models.mjs>)提供 18 个登录前展示／临时兜底模型，不默认启用它们。**成功的账号 `/v1/models` 列表是权威，包括空列表**；公开定价、models.dev 和手工配置不向成功列表添加未发现的模型。临时发现失败使用插件自己的保守兜底并带 `fellBack`，不把宿主缓存模型无条件并入。

配置与运行时是不同形状。配置模型覆盖使用：

```json
{
  "provider": {
    "anyrouter": {
      "models": {
        "friendly": {
          "id": "gpt-6.1-sol",
          "provider": {"npm":"@ai-sdk/openai","api":"https://anyrouter.top/v1"},
          "reasoning": true,
          "attachment": true,
          "tool_call": true,
          "modalities": {"input":["text","image"],"output":["text"]}
        }
      }
    }
  }
}
```

运行时才转换为 `api.{id,npm,url}` 和 `capabilities`。用户的显式 `false`、SDK、别名和上限受到尊重；`context`／`input`／`output` 独立处理，不把模型厂商上限伪装成本站明确给出的 input 上限。

### 价格元数据

模型 `cost` 单位为 USD／百万 token，优先保留明确用户配置（包括零）：

```json
{"provider":{"anyrouter":{"models":{"gemini-4-neon":{"cost":{"input":2,"output":10}}}}}}
```

如已确认要使用某个站点分组的公开参考价，可在 `provider.anyrouter` 配置 `"pricingGroup":"default"`。仅在有效公开价格样本包含该分组倍率、模型允许该分组且为按 token 计费时，插件填充 `cost`；未选择分组时不假定账号属于 default。输入价为 `model_ratio * 2 * group_ratio`，输出再乘 `completion_ratio`。这是公开分组参考价，不是实际账单、充值汇率或“官方价格的几倍”。

匿名 `/api/pricing` 成功样本在当前插件实例缓存 15 分钟，并合并并发读取；取消一个目录读取不影响其他调用者。失败／无效响应暂停价格读取 60 秒，价格保持未知，不沿用到期旧报价。切换显式计价分组会用当前配置换算，但账号模型权限列表仍独立刷新。

未确认的价格／缓存价格保持缺失；按次计费不能转换成 token 单价。不从厂商 models.dev 价格或宿主占位零值补齐，不猜测 Magpie `rate`。显式用户 `cost` 对象优先，缺失字段不自动填站点价；宿主如何显示缺失价格由宿主决定。无需修改账号凭据。

## 开关、请求头和参数

| Provider 开关 | 默认 | 作用 |
| --- | --- | --- |
| `site-today-spend` | **关** | 额外查询北京时间今日消耗；限流即停止 |
| `site-external-usage` | **关** | 自动排除当前 Key 后同步其他 Key／余额专用账号日志；需确认来源与重复计账限制 |
| `site-external-same-key` | **关** | 需同时开启站外同步；同 Key 最近用量尽力匹配，需确认重复／漏记风险 |
| `send-codex-headers` | 开 | 仅 Responses 的 Codex 客户端头与兼容字段，不影响 Claude |
| `claude-code-compat` | 开 | 仅 Messages 的 Claude 头、system／metadata 与 beta 参数，不影响 Codex |
| `portable-responses` | 开 | 只内联完整已知历史；不拆散未知、签名、加密或仅资源引用的数据 |
| `text-filter` | 开 | 有本地词表时替换 Responses 可见文字，保护代码与工具数据 |
| `codex-session-repair` | **关** | 显式启用的有损发送副本清理；丢弃状态后必须验证工具调用／结果配对 |
| `request-diagnostics` | 开 | 仅对可证明尚无内容的明确错误生成诊断，不重试 |

关闭一个兼容开关不代表全部请求变换停止；完全停用正文变换还需关闭便携历史、词表替换和有损清理。认证与目的地址校验始终工作。

插件级 JSON 参数与 Provider 布尔开关不同：

```json
{"quotaPerUnit":500000,"retryAfterSeconds":10,"siteTimeoutMs":30000}
```

`quotaPerUnit` 是正安全整数；`siteTimeoutMs` 是 1–600000 毫秒的有效整数预算。诊断等待值优先级为账号 → 显式 Provider 配置 → 插件选项 → 默认 10 秒；上游已给出的等待头始终优先。

模型请求只使用模型 Key，站点 Cookie／系统令牌／密码／`New-Api-User` 不进入模型流量。最终目标固定官方 HTTPS origin 和已识别模型接口；外域、未知路径、URL 凭据、凭据重定向在发送前被拒绝。账号自定义模型头不能覆盖受管认证、Cookie、Host 或长度字段；浏览器交接头单独用于站点操作。

本地词表路径是 `lib/content-filter.local.json`，这是你自行创建的私有配置。格式见[示例](<content-filter.example.json>)；示例随包附带，但不会自动加载。词表仅支持有界字面量规则，不支持任意正则。缺失不替换，损坏时本地拒绝请求且不回显词表；修改后需重新加载插件。它不是通用数据防泄漏工具。

## 升级与安全边界

- 保留账号 schema 2，新会话使用 `sessionState: {version:1, origin, jar}` 与 `loginGeneration`。旧 raw Cookie 只读导入；正常、身份一致的操作才保存迁移。新状态损坏不得回退旧 Cookie。
- Cookie 域、路径、Secure、前缀、删除及固定过期时间由 `tough-cookie` 管理；不会因读取／重启延长 Max-Age，也不会复活已删除 Session。
- 保留最新宿主账号字段、UID、Key 和未知 refresh 字段。队列与完整凭据快照是 **尽力而为的竞争保护，不是跨进程原子 CAS**。
- 降级旧版本可能无法读取新 jar，需在旧版本重新导入本站会话；不要恢复旧 Cookie 来“修复”已经删除或失效的登录态。
- 凭据仍由宿主存储，不增加独立密钥文件。宿主存储权限／加密方式取决于宿主和操作系统，其他同权限插件也属于信任边界。
- JSON 诊断读取最多 64 KiB／2 秒克隆；SSE 前导最多 64 KiB／15 秒，出现内容或未知状态立即逐块交还。请求正文变换最多 4 MiB／2 秒克隆，不全量缓冲正常回答。
- **只有插件生成的诊断文本做已知凭据脱敏**。成功输出、部分输出、未知数据和关闭诊断时的原始上游响应不被偷偷清洗；分享宿主日志或原始响应仍需自行脱敏。

细节见[安全说明](<SECURITY.md>)与[实现契约](<DESIGN.md>)。

## 已验证与未验证

0.2.3 本地优化验收（2026-11-26）：Node 527 项中 524 通过、Bun 503 项中 500 通过，均零失败；各有三项普通运行下的宿主 opt-in 跳过，这三项在 Magpie 0.1.4795 的隔离宿主／CLI 中另跑全部通过、零跳过。包图、私有哨兵排除和实际归档离线导入通过。执行细节与未验证的线上条件见[优化验收记录](<docs/validation/optimization-plan.md#L63-L69>)。

2026-11-24 的本地验收：Node 26.5.0、Bun 1.4.5 的全套离线回归，以及 Magpie 0.1.4720 的真实宿主／CLI 隔离测试通过。它们使用合成凭据和本机模拟服务，不是对线上 Claude／Gemini 可用性、真实奖励金额或真实登录端到端的证明。

较早的真实探测观察到 GPT Responses 可完成；Claude 路径仍有 429／520 等上游问题，Chat Completions 为 404，`fcapp.run` 备用入口不可用。这些是历史样本，不是当前站点永久契约。本版不自动切换备用域名、不绕过人机验证，也不承诺修复上游 Claude 可用性。

Node 最低版本声明为 20.3.0；本机执行证据为 Node 26.5.0。CI 配置覆盖多个 Node／操作系统，不等于那些矩阵已在本机或远端实际通过。原版 OpenCode 的加载器及 Magpie 专有 usage／checkin／options／模型发现扩展未单独验收。

## 开发与离线验收

```sh
pnpm test
pnpm run check:package
pnpm run check:pack
pnpm pack --dry-run --json
```

普通测试不读取真实账号、不调用收费模型。三项显式 opt-in 的[宿主测试](<test/host.integration.test.mjs>)默认跳过；在提供已经安装的绝对路径后，使用自己的临时 HOME、配置／缓存／账号与 loopback 服务：

```sh
MAGPIE_TEST_HOST=/absolute/native/path/to/host.js \
MAGPIE_TEST_BINARY=/absolute/native/path/to/magpie \
MAGPIE_TEST_BUN=/absolute/native/path/to/bun \
node --test --test-concurrency=1 test/host.integration.test.mjs
```

Windows 环境变量使用 `C:/...` 等原生绝对路径，不使用 `/c/...` 传给 Node 子进程。只提供 HOST 或 BINARY 可以分别运行对应层；[沙箱脚本](<scripts/sandbox-check.sh>)委托同一套已验证测试，不再独立维护一个会把假 Key 发往线上站点的脚本。

CLI 测试会验证实际宿主的 preload 标记；缺失时在凭据步骤前失败，不把“设置了 HOME”当作网络隔离。它不依赖未知全局 Bun 配置，也不下载或安装 Magpie／Bun。

[CI](<.github/workflows/ci.yml>)先安装锁定依赖并禁用安装脚本，再执行测试和发布清单检查。[变更记录](<CHANGELOG.md>)区分当前未发布修复与历史版本；[来源说明](<UPSTREAM.md>)和[许可证](<LICENSE>)记录代码归属。
