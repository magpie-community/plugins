# opencode-kiro-custom

**简体中文** · [English](README.en.md)

登录 [Kiro](https://kiro.dev) 订阅（Free、Pro、Pro+、Power），在 OpenCode 和 magpie 里代发请求。供应商 id：`kiro-custom`。

这是非官方插件。它跟 magpie 内置的 Kiro、社区插件 `@magpie-community/opencode-kiro-auth`（供应商 id `kiro`）并排：包不同，供应商不同，登录也分开。它不替换那两个。在 magpie 里它走非官方 GitHub 列表，仓库需要打上 `magpie-plugin`，并且是独立仓库，不能是 fork。

更新说明见 [CHANGELOG.md](CHANGELOG.md)。

## 登录

- **Kiro（Google、GitHub、AWS Builder ID、IAM Identity Center）**：走 Kiro IDE 自己的登录。
  - Kiro 的页面（`app.kiro.dev/signin`）把浏览器送回 IDE 监听的端口之一（3128、4649、6588、8008、9091、49153、50153–53153），地址是 `127.0.0.1`。IDE 正在登录时，这些端口可能被占用。
  - Google 和 GitHub 回来的是一个 code，由 Kiro 的认证服务换成 token。
  - Builder ID 和 Identity Center 回来的是 AWS 登录地址和区域。插件向 AWS 的 OIDC 服务注册客户端，把浏览器送到 AWS，再换成 code 对应的 token。
  - 账号名用 Kiro 记下的邮箱（`Get-Usage-Limits`），套餐也从同一次调用读取。
  - 公司自己的身份源（`external_idp`）这里不支持。先用 `kiro-cli login`，再用下一种方式。
- **使用 Kiro CLI 或 Kiro IDE 的登录**：用 kiro-cli 已经登录的账号，否则用 Kiro IDE 的。不复制，每次从它们存放的地方读：
  - kiro-cli：SQLite 数据库的 `auth_kv` 表。
    - macOS：`~/Library/Application Support/kiro-cli/data.sqlite3`
    - Linux：`~/.local/share/kiro-cli/data.sqlite3`
    - Windows：`%APPDATA%\kiro-cli\data.sqlite3`
  - IDE：`~/.aws/sso/cache/kiro-auth-token.json`。

  kiro-cli 会先刷新自己的 token（`kiro-cli debug refresh-auth-token`）。插件自己刷新得到的 token 会写回去，kiro-cli 和 IDE 接着用。
- **Kiro API Key（ksk_…）**：以 `tokentype: API_KEY` 发送。档案用 `GetProfile` 查找。
- **导入导出的账号（JSON）**：在 magpie 里下一步是两个按钮，「选择文件…」和「粘贴 JSON」。「选择文件…」在浏览器里打开导入页，文件在浏览器里读取，所以 magpie 窗口和网页都能用（见下文）。「粘贴 JSON」是文本框，也可以填 magpie 这台机器上的路径。已安装的 magpie 只会画按钮和文本框，插件写什么就显示什么，所以这些标签是中文。OpenCode 则询问 JSON 或文件路径。接受的导出：Kiro Account Manager、Cockpit、kiro.rs 的 `credentials.json`，以及 IDE 的 `kiro-auth-token.json`。细节见 [导入导出的账号](#导入导出的账号)。

浏览器登录保存在 OpenCode 存放登录的地方（`auth.json`；magpie 里是 `plugin-auth.json`），类型为 `oauth`。里面有 token、profile ARN、区域，AWS 登录还有注册的客户端。刷新：

- magpie 在过期前 10 分钟，经插件的 `auth.refresh` 续期，每个账号一次，并且在请求、模型列表和用量需要它之前。magpie 保存新 token。续期失败，哪怕是 Kiro 拒绝，也不把账号标成失效，下次再试。
- OpenCode 不调用这个钩子：那边在过期前 2 分钟、发请求之前刷新并保存。
- 两边都一样：Kiro 以 403 拒绝的 token 会先刷新，请求再试一次。
- 同一时间只有一次刷新，包括 magpie 的续期。已经刷新但还没保存的 token 会接着用，不会把旧的 refresh token 再花一次。
- kiro-cli 和 IDE 的登录不由 magpie 续期：它们在请求前按上面的方式刷新，并写回去。

刷新走：

- Google / GitHub：`prod.<region>.auth.desktop.kiro.dev/refreshToken`。
- Builder ID / Identity Center：AWS 的 `oidc.<region>.amazonaws.com/token`。

## 请求

Kiro 没有 OpenCode 能直接说的 API。模型按 Anthropic Messages（`@ai-sdk/anthropic`）声明，每次请求由插件的 `fetch` 处理：

- 发到 `runtime.<region>.kiro.dev/generateAssistantResponse`，也就是 kiro-cli 用的 API，请求头也按 kiro-cli。区域取 profile ARN 里的那个。
- 把请求转成 Kiro 的对话：
  - 系统提示放在第一条消息的开头。
  - 工具调用和结果成对：没有回应的调用补一条错误结果，超过 250,000 字符的结果会被截断。
  - Kiro 不接受的工具 id 会改写。工具名超过 64 字符（Claude Code 里的 MCP 插件）会缩短并带上哈希，调用结果仍用全名返回。
  - 工具里的图片（截图、Codex 的 view_image）跟在回应这次调用的消息上，因为 Kiro 的工具结果只有文本。
  - 只发送最新的图片。
  - 历史里用过、但这次请求没提供的工具，仍会声明。
- 把 Kiro 返回的 AWS 事件流转回 Messages 的事件（流式）或一条消息。回复含文本、思考、工具调用和用量。Kiro 只报告上下文有多满时，输入 token 按这个估算。
- 思考（Claude 模型和 Auto）按 kiro-cli 的方式在提示里请求，带预算：low 1 万、medium 2 万、high 3 万、xhigh 和 max 5 万（与 magpie 内置 Kiro 的 #120 一致）。回复里的 `<thinking>` 块作为思考返回。
- Kiro 的失败保持原意：
  - 输入过长 → 400
  - 没有容量 → 503
  - 用量到顶 → 429
  - 限流 → “rate limited”

magpie 在还有别的 Kiro 账号可以换时，会把 Claude 只有思考、还没有正文的流压住，外面只看到 `: keepalive`，直到正文出现。本插件在思考块已经打开、第一段思考写出之后，发一帧 `response.done`。magpie 把这帧当成正文，于是把思考放行。Anthropic 客户端不认识这个事件类型就跳过，所以它不会变成思考、正文或工具调用。new-api 把同一条流转成 OpenAI Chat 时丢掉它。一个字都没写出就被安全策略拒答时，按 `refusalReply` 回：

- 关（默认，new-api 用）：400 错误（`invalid_request_error`，`code: content_filter`）。magpie 认出这是拒答，先换别的账号再问，都拒了才把 400 和拒答说明交给客户端；new-api 不重试这个状态，记一条错误并退回预扣。
- 开（Claude Code 直连 magpie 用）：按 Anthropic 的样子回 200，不带正文，`stop_reason: "refusal"`，原因在 `stop_details`（例如 `{"type":"refusal","category":"bio",…}`），用量全为 0。magpie 同样先换别的账号，都拒了才原样交给 Claude Code，Claude Code 随即换它自己的备用模型。

两种接法用的是同一个插件、同一个开关，所以一个 magpie 只能选一种：给 new-api 当上游的 magpie 关着，自己的 Claude Code 直连的 magpie 打开。写出过内容之后才拒的，两种都一样：连接已是 200，以 `stop_reason: "refusal"` 结束，按 Kiro 数到的用量结算。

## 模型

`config` 钩子声明 `auto`（由 Kiro 选模型）。登录之后，`provider.models` 钩子用 `List-Available-Models` 换成这个账号自己的列表，默认模型排在第一。每个模型带上下文窗口、输出上限，以及是否接受图片。Claude 模型和 Auto 有思考档位。

## 导入导出的账号

登录方式「导入导出的账号（JSON）」接受 JSON，或装着它的文件路径。在 magpie 里，「选择文件…」打开导入页，「粘贴 JSON」接受文本或路径。OpenCode 询问这段文本或路径。

导入页（[`import.html`](import.html)，由 GitHub Pages 提供，地址是 `https://professor-chen.github.io/magpie-kiro-plugin/import.html`；`importPage` 或 `KIRO_IMPORT_PAGE` 可以指定另一份）在浏览器里读文件，一次可以多个，列出账号供勾选（处于启用的默认勾上），不带插件不保存的内容（导出里的密码和备注）。每个账号先刷新检查；第一个作为这次登录，其余各自成为独立账号（`kiro-custom#…`，按名字，再次导入会替换）。页面会说明哪些被跳过或失败，以及原因。

页面按第一个能用的办法把账号交回来，所以 magpie 窗口、网页、Docker 或服务器上的 magpie 都一样：

1. 浏览器和 magpie 在同一台机器时，走插件在 `127.0.0.1` 上的端口。
2. 中转，默认 [ntfy.sh](https://ntfy.sh)：页面用这次导入专用的密钥，以 AES-256-GCM 封上账号。密钥只放在链接的 `#fragment` 里，浏览器不会把它发出去。封好的文本发到一个随机主题。插件在等待导入时订阅这个主题，打开封包，并在同一主题以 `-r` 回复，页面据此说明结果。ntfy.sh 只看得到封好的文本，几小时内会丢掉。`importRelay`（`KIRO_IMPORT_RELAY`）可以换成别的 ntfy 服务器，比如自己的，或设成 `off`。
3. 两边都走不通时（magpie 或浏览器到不了中转），页面把一个地址复制到剪贴板：贴进 magpie 登录下方的地址框，magpie 在自己的机器上打开它，跟 Kiro 的浏览器登录一样。这样的地址大约只能装十几个账号（magpie 接受 16 KB）。

接受的导出：

- Kiro Account Manager：`{version, exportedAt, accounts: [{email, credentials: {…}, machineId, status}]}`
- Cockpit：`{version: "cockpit-kiro-import", accounts: [{email, auth: {…}, machineId, status}]}`
- kiro.rs 的 `credentials.json`：一个对象或数组，`expiresAt` 为 RFC3339
- Kiro IDE 的 `kiro-auth-token.json`（IdC 需要 `clientId` / `clientSecret`）

读到的字段：`accessToken`、`refreshToken`、`expiresAt`（毫秒、秒或日期）、`region`、`authMethod`（`social`，或 `idc`；`builder-id` 和 `iam` 也当作 `idc`）、`provider`、`clientId`、`clientSecret`、`profileArn`，以及账号的 `machineId`。`status` 不是启用的，或没有 refresh token 的，会跳过并说明原因。导出里的密码和备注一律不保存。导出里有多个账号时，下一个问题选择登录哪一个（1 是第一个）。保存前会先刷新 token，所以已经失效的导出会立刻失败，而不是等到第一次请求。

## 设置

写在 magpie 的 `plugins.json` 里该插件的 options（`{"spec": "…", "options": {"cacheRatio": 0.8}}`），或 OpenCode 的 `["…", {options}]`，否则用环境变量。`web`、`dropHidden` 和 `refusalReply` 另外是这个供应商设置里的开关（Kiro Web、去掉 Kiro 自带提示、拒答按 Claude 原样返回），下一个请求就生效：

| 选项 | 环境变量 | 默认 | |
| --- | --- | --- | --- |
| `cacheRatio` | `KIRO_CACHE_RATIO` | `0` | 0–1：Kiro 没有报告缓存时，提示里算作 `cache_read_input_tokens` 的比例，其余是 `input_tokens`。Kiro 自己给了缓存数字时，以它为准。 |
| `fingerprint` | `KIRO_FINGERPRINT` | `ide` | `ide`：Kiro IDE 的请求头（`aws-sdk-js/1.0.34 … KiroIDE-<version>-<machineId>`）；`cli`：kiro-cli 的，和以前一样。 |
| `fp` | `KIRO_FP` | `safe` | 指纹总开关。`off`：完全回到旧行为（整台机器共用一个 machineId、不补 `Accept-Language`/`x-amz-date`、`amz-sdk-request` 仍是 `max=1`、不用账号代理）；`safe`：每个账号各自的设备身份和出口（推荐）；`full`：同 `safe`，TLS 伪装（curl-impersonate）留了接口但还没接，见 `curlBin`。 |
| `fpDeviceId` | `KIRO_FP_DEVICE_ID` | 跟随 `fp` | 每个账号自己的 machineId（取账号自带的，否则按 refreshToken 派生）。关掉就回到"全机共用一个"，只有做对照测试时才关。 |
| `fpProfile` | `KIRO_FP_PROFILE` | 跟随 `fp` | 版本、OS 标识、`Accept-Language` 按账号自洽，并把旧的 `0.9.2` 换成 `1.1.70`（显式设了 `KIRO_VERSION` 则听你的）。 |
| `fpProxy` | `KIRO_FP_PROXY` | 跟随 `fp` | 账号自带 `proxyUrl` 就用它，`direct` 表示显式直连（绕过 magpie 的全局代理），没写则交给 magpie 选。 |
| `fpKiroVersion` / `fpNodeVersion` / `fpSystemVersion` / `fpLocale` | `KIRO_FP_VERSION` / `KIRO_FP_NODE_VERSION` / `KIRO_FP_SYSTEM_VERSION` / `KIRO_FP_LOCALE` | 账号自带，否则 `1.1.70` / `22.21.1` / 本机 / `zh-CN` | 显式指定这套身份，优先级高于默认、低于账号自带的值。 |
| `curlBin` | `KIRO_CURL_BIN` | 空 | `fp=full` 时打算用的 curl-impersonate 可执行文件（如 `curl_chrome116`）。现在填了也不生效，等 TLS 那层接上。 |

这三个开关在 magpie 的供应商编辑器里也能直接改（「Plugin options」下的三个开关），改完下一个请求就生效，不用重启，也不用编辑 `providers.json`：**每个账号自己的设备指纹**、**版本与操作系统自洽**、**账号自带代理优先**。`providers.json` 的 `options.fp` 仍然有效，开关是它的逐项覆盖。| `kiroVersion` | `KIRO_VERSION` | `0.9.2` | 指纹里的 Kiro IDE 版本。 |
| `nodeVersion` | `KIRO_NODE_VERSION` | `22.21.1` | |
| `systemVersion` | `KIRO_SYSTEM_VERSION` | 本机系统（`win32#10.0.22631`） | |
| `endpoint` | `KIRO_ENDPOINT` | `kiro` | `kiro`：`runtime.<region>.kiro.dev`；`q`：`q.<region>.amazonaws.com`。 |
| `retries` | `KIRO_RETRIES` | `2` | 0–5：网络错误、空回复、408、429 或 5xx 之后再试，带退避（遵守 Retry-After）。月度限额立刻换下一个账号。 |
| `thinkingMin` / `thinkingMax` | `KIRO_THINKING_MIN` / `_MAX` | `1024` / `64000` | 思考预算的上下限，调用方的 `budget_tokens` 也受这个限制。 |
| `budgets` | `KIRO_BUDGETS` | `low=10000,medium=20000,high=30000,xhigh=50000,max=64000` | 每个力度的预算。选项里是对象，环境变量里是 `k=v,…`。 |
| `adaptive` | `KIRO_ADAPTIVE` | `false` | `true` 时，调用方的 `thinking: {type: "adaptive"}` 按 kiro-cli 的自适应模式发送（`<thinking_effort>low/medium/high`）。默认关：实测 Kiro 对它的回答没有思考（claude-sonnet-4.5），所以自适应按该力度的预算发送。 |
| `effortField` | `KIRO_EFFORT_FIELD` | `auto` | `auto` 对在 Kiro 上原生思考的 Claude（Opus 和 Sonnet 4.7 及以后）用它们自己的字段请求：`additionalModelRequestFields: {thinking: {type: "adaptive"}, output_config: {effort}}`，因为提示里的标签对它们不起作用。`off` 则全部用提示。4.6、4.5、Haiku 和其他厂商的模型始终用提示思考；4.5 和 Haiku 会拒绝这个字段。 |
| `minInterval` | `KIRO_MIN_INTERVAL_MS` | `0` | 同一账号两次请求之间的最短间隔。 |
| `toolDescriptionLimit` | `KIRO_TOOL_DESCRIPTION_LIMIT` | `9216` | 工具描述截断到这个长度。 |
| `meter` | `KIRO_METER` | `on` | `on`：用量里的缓存 token，以及原生思考模型没有展示出来的推理，从 Kiro 的计量读取（见下）；`off`：用 `cacheRatio` 代替。 |
| `web` | `KIRO_WEB` | `false` | `true` 时每条消息声明来自 Kiro Web（`KIRO_WEB`），而不是 kiro-cli。Kiro 自己加在前面的提示更短（Sonnet 4.5：740 个 token，而不是 4052）。 |
| `refusalReply` | `KIRO_REFUSAL_REPLY` | `false` | 一个字都没写出就被拒答时怎么回，见下。`false`：400 报错，给 new-api 用；`true`：按 Anthropic 的样子回 200 和 `stop_reason: "refusal"`，给直连 magpie 的 Claude Code 用。 |
| `dropHidden` | `KIRO_DROP_HIDDEN` | `false` | `true` 时，报出的提示 token 去掉 Kiro 自己的那段（各模型实测长度见代码里的 `HIDDEN`），先扣缓存读到的部分，再扣全新输入。默认按 Kiro 数到的整段报。Kiro 没给上下文、只能估算调用方请求时不扣。 |
| `importPage` | `KIRO_IMPORT_PAGE` | GitHub Pages | 「选择文件…」打开的导入页：别处提供的 `import.html`（http 或 https）。 |
| `importRelay` | `KIRO_IMPORT_RELAY` | `https://ntfy.sh` | 浏览器和 magpie 不在同一台机器时，导入页把封好的账号交给的 ntfy 服务器；`off` 表示不用。 |

### 用量：从 Kiro 的计量读取

Kiro 不给 token 数：流里的 `metadataEvent` 定义了带 `cacheReadInputTokens` 的 `tokenUsage`，但从不发送；kiro-cli 自己的客户端也报 `usage: None`。它给两个准确数字：提示的大小（`contextUsagePercentage` × 模型窗口，用它自己的分词器）和这次请求花了多少（`meteringEvent`，单位是积分）。用每个模型的三个单价（`PRICES`：全新输入、缓存输入、输出，实测标定过），缓存可以算出来：

    credits = fresh × (prompt − cached) + cached_price × cached + output × reply

所以 `cache_read_input_tokens` 是 Kiro 的缓存实际读到的，`input_tokens` 是其余。超过一次冷提示加回复的积分，是原生思考模型的推理，只以摘要出现，按输出 token 计入，这样回复的计费和 Kiro 的计量一致。用同一套单价折回去，用量和 Kiro 的计量相符：五轮实测对话误差在 0.01% 以内（Sonnet 4.5 后续每轮提示有 41–47% 命中缓存；Opus 5.5 为 72–86%）。

这段提示里含有 Kiro 自己加的提示（`HIDDEN`：Sonnet 4.5 在 kiro-cli 下 4052 个 token，Kiro Web 下 740）。`dropHidden` 打开后，报出的用量先从缓存部分扣掉它，再从全新输入扣，调用方不再为这段付钱。缓存是按整段提示（含这段）从积分反推的，扣掉发生在反推之后。`web` 打开后请求走更短的那段。

回复的 token 是字符数除以该模型每个 token 的字符数（标定值，例如 Sonnet 4.5 为 4.59，Opus 5.5 较新的分词器为 3.34），再零成本修正：对话的下一轮带着这条回复，Kiro 给出的准确上下文按它的 token 数增长。

标定结果：Kiro 把 Claude 的缓存 token 按全新 token 的 0.526 计量（Opus 和 Sonnet 5.5 为 0.266），GPT-5.6、DeepSeek、MiniMax、GLM 则完全不缓存。缓存由 Kiro 自己决定：插件的缓存点、位置和对话 id 都改变不了。

拒答（Kiro 的安全过滤：`stopDetails.refusal`，例如 `BIO`）不当成空回复再试一次。一个字都没写出就被拒的，默认回 400：`{"type":"error","error":{"type":"invalid_request_error","code":"content_filter","message":"…（BIO）"}}`；`refusalReply` 打开时回 200、`stop_reason: "refusal"` 和 `stop_details`。Kiro 对它计量为 0（实测：同一段提示正常回答约 0.17 积分），所以两种都不计用量。已经写出内容后才拒的，以 `stop_reason: "refusal"` 结束。

思考：每个力度有自己的预算（`max` 高于 `xhigh`）。调用方没指定力度时用它的 `budget_tokens`。`thinking: {type: "disabled"}` 不请求思考。

Kiro 上各模型怎么思考，来自 Kiro Pro+ 账号的实测：

- Opus 和 Sonnet 4.7 及以后自己会思考，提示怎么写都一样，推理单独成流（`reasoningContentEvent`，是摘要）。`output_config.effort` 决定想多少：一道难题上，`low` 是 47 帧推理、0.23 积分，`max` 是 218 帧、0.77 积分。它们的 `thinking.type` 只接受 `"adaptive"`（`"enabled"` 是 400）。按这个方式请求（`effortField: auto`）。调用方不要思考时，不展示它们的推理；关掉思考时，按最低档（`low`）请求。
- Sonnet 和 Opus 的 4.6、4.5（以及 Auto）只在提示里的 `<thinking_mode>` 标签要求时才思考，思考写在回复的 `<thinking>` 标签之间，再被取出来。kiro-cli 的自适应标签（`<thinking_effort>`）实测没有产生思考（`adaptive: false`）。

用提示思考的模型，前面几轮想过的内容会以 `<thinking>…</thinking>` 放回历史，思考对话能接着自己的推理往下走。思考只在它自己的结束标签处结束：被引用的（`` `</thinking>` ``）不算，并且后面要是空行或回复结束。

另外：模型用文字说出的工具调用（`[Called Bash with args: {…}]`）会转成调用，前提是这次请求提供了这个工具。403 且说明账号被暂停（`TEMPORARILY_SUSPENDED`，服务条款）时，在 magpie 里把这次登录标成过期（`X-Magpie-Sign-In: expired`），下一个请求换账号，而不是刷新它。Google 或 GitHub 登录按请求所声称的 IDE 来刷新。

机器 id 用账号自己的（64 位十六进制，或一个 UUID 重复一遍），否则用账号名的哈希，刷新之后保持不变。

这个分支里还有：`message_start` 会报出提示的估算大小（以前要到结束才不是 0）；Kiro 什么都没说时，提示大小按请求估算；流沉默 15 秒（思考、一次很长的工具调用）时，用 `ping` 事件保持连接。

## 不包括

- 用量和配额的展示（积分、月度窗口）。
- 在插件内部切换多个账号。OpenCode 每个供应商只保留一个登录。
- 在浏览器里用公司自己的身份源登录（用 kiro-cli 的登录）。
- magpie 为 Kiro 准备的网页搜索替身。
