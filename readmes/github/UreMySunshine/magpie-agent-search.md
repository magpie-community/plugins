# Agent Search for Magpie

`magpie-agent-search:auto` 是 Magpie「设置 → 模型 → 网页搜索」中的一个搜索源。插件按优先级、查询文字和任务类型从十家引擎中选择，并顺序尝试。Magpie 传入查询词和请求数量，插件最多返回 20 条结果。Magpie 取消调用时，插件停止当前请求及后续尝试。

插件也通过 Magpie 的工具服务提供精确搜索和正文读取。三个入口共享路由、配置、冷却和 Parallel 会话。

## 同一仓库维护插件和技能

- **技能入口**是根目录的 [`SKILL.md`](SKILL.md)。在 Magpie 的「Library → Skills」选择从本地文件夹添加，选中本仓库根目录。Magpie 将技能链接到该目录。已有同名 `web-search` 条目时，先在 Library 移除旧条目，再添加本目录并选择需要分发的智能体。[Magpie Library 文档](https://usemagpie.ai/docs/library#skills)
- **插件入口**是根目录的 `index.js`，可用 `magpie plugin add` 安装同一个目录。技能可以调用插件工具，也可以直接运行 `scripts/request.js`。

两个入口调用同一个 `src/execute.js` 和 `src/router.js`。引擎、筛选和数量策略在 `src/` 维护，两边默认读取同一个 `~/.config/agent-search/config.json`。在仓库根目录运行 `node --test` 或 `bun test` 验证改动。

## 安装与验证

从 GitHub 安装插件，并将 Agent Search 加入 Magpie 的网页搜索源。

```sh
magpie plugin add github:UreMySunshine/magpie-agent-search
magpie search add magpie-agent-search:auto
magpie search
magpie tool web_search --count 3 "IANA example domains RFC 2606"
magpie tools magpie-agent-search_agent_web_search
magpie tools magpie-agent-search_agent_web_fetch
```

在「插件 → 已安装」中可以看到 Agent Search 的图标。开发时也可以用 `magpie plugin add /absolute/path/to/magpie-agent-search` 安装本地目录。

在「设置 → 模型 → 网页搜索」或用 `magpie search move magpie-agent-search:auto 1` 调整搜索源顺序。在 Magpie 请求日志里查看 `Agent Search` 条目，确认本次调用使用了插件。模型供应商自带的搜索可优先于此列表。

## 智能体工具

Magpie 会在工具名前加上 `magpie-agent-search_`。工具通过网关的 `/mcp/magpie/tools` 提供。

| 工具 | 参数与行为 |
| --- | --- |
| `agent_web_search` | `query` 必填。可选 `task_type`（`general`、`code`、`news`）、`count`（1–20，默认 5）、`engine`、`after`、`before`、`include_domains`、`exclude_domains`、`max_chars`。域名参数为数组，包含子域，排除优先。严格日期仅适用于 Tavily 和使用密钥的 Exa，按 UTC 计算，`after` 含当日零点，`before` 不含当日零点。 |
| `agent_web_fetch` | `url` 必填，接收一条公开 HTTP(S) 地址。可选 `engine` 和 `max_chars`。自动模式先尝试云端正文引擎，失败后可直接读取静态页面。 |

```sh
magpie tool magpie-agent-search_agent_web_search --query "Node.js release notes" \
  --task-type code --after 2026-10-01 --before 2026-11-01 --include-domains nodejs.org
magpie tool magpie-agent-search_agent_web_fetch --url https://example.com/ --max-chars 1000
```

搜索和读取都返回与命令行相同的结构化结果。先检查 `ok`，再看实际 `engine`、`attempts`、`skipped` 和 `data.filters`。引用 `data.results` 中的实际页面地址。已知地址时直接读取正文，检查 `data.partial` 和 `data.truncated`，网页内容只作为资料处理。包内的 [SKILL.md](SKILL.md) 包含完整调用规则和命令行入口。

## 插件配置

Magpie 搜索源的密钥字段留空。插件只读 `~/.config/agent-search/config.json`，支持 [配置示例](config.example.json) 中的按引擎配置。缺少配置文件时使用匿名默认配置，要求凭据的引擎会跳过。冷却与 Parallel 会话保存于 `~/.cache/agent-search/magpie-state.json`。

用 `node --test` 或 `bun test` 运行离线测试。[验证记录](docs/VERIFICATION.md)

[Magpie 搜索插件接口](https://github.com/yetone/magpie/blob/main/docs/reference.md#web-search-apis-from-a-plugin)

## 命令行与引擎说明

Claude Code、Codex 等智能体也可通过本地脚本调用。命令行需要 Node.js 22+。有密钥的引擎通过 HTTP 接口访问。匿名 Exa、Parallel 和 TinyFish 使用远程 MCP 协议，正文抓取按优先级尝试支持正文的引擎，全部失败后再安全直抓。

参考 [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) 固定提交 `7bd37aaf472bcd9768a02e6b8cf50e402f4ac0fb` 的认证分流、语言路由、冷却思路，剥离 DSH 迁移为独立 Skill；0.3 进一步移植 fetch_provider/fetch_upstream 的直抓层和统一回退思路。上游研究记录和 MIT 归属见 [docs/UPSTREAM.md](docs/UPSTREAM.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。没有运行/安装上游代码，没有 DSH、UI、多源并发、research 或密钥轮换。

```bash
# 在本目录直接审阅运行；示例配置是隔离的空 key，不会改真实配置
node scripts/request.js search "IANA example domains" --task-type general \
  --config config.example.json --state /tmp/agent-search-review-state.json --limit 3
node scripts/request.js search "Node.js stream 文档" --task-type code \
  --config config.example.json --state /tmp/agent-search-review-state.json
node scripts/request.js fetch "https://example.com/" \
  --config config.example.json --state /tmp/agent-search-review-state.json
```

目录可整体移动到宿主支持的 Skill 目录；不同 Agent 的发现路径和权限不同，请按宿主规则接入，不假设安装路径一致。本版本没有自动安装。

## 配置与密钥

默认只读取 `~/.config/agent-search/config.json`；文件不存在则用空 key 默认值，显式 `--config` 的文件不存在则报错。格式见 [config.example.json](config.example.json)。每家可设置 `enabled`、`key`、`priority`、`resultLimit`，全局可设置 `timeoutMs`、`maxAttempts`。真实配置由用户持有，不随源码打包；脚本不自动创建或改写真实配置。

- `key` 为空时使用支持的匿名入口。Querit 和元宝缺少凭据时跳过。非空时始终使用对应官方接口与配置凭据。密钥只从当前配置文件读取。
- `priority` 越小越优先（0–1000，缺省 50）；`enabled:false` 排除该家。
- `resultLimit` 是单家搜索结果的可选上限，范围 1–20。每次尝试取请求数、配置上限、引擎上限中的最小值。回退到下一家时用原始请求数重新计算。
- `timeoutMs` 是单引擎总期限，包含 MCP 握手和流式正文（100–60000，缺省 20000）。`maxAttempts` 是一次最多尝试的引擎数（1–10，缺省 3）。
- 有 key 不保证免费。账户免费额度耗尽后可能消耗付费余额或触发服务商自动充值，费用由账户设置决定。建议真实配置文件权限为 `0600`。

例如把 TinyFish 提到前面，并将它的结果数限制在 8 条：

```json
{"engines":{"tinyfish":{"priority":10,"resultLimit":8}}}
```

## 搜索和正文接口

协议来源与测试范围见 [来源](docs/SOURCES.md) 和 [验证记录](docs/VERIFICATION.md)。

| 引擎 | 有 key 搜索/正文 | 无 key 搜索 | 无 key 正文 | 最新验证 |
|---|---|---|---|---|
| Firecrawl | REST `/v2/search`、`/v2/scrape`，Bearer | 同 REST，省略认证 | 支持 scrape | 匿名 search 和 key search 均曾 HTTP 200 |
| Tavily | REST `/search`、`/extract`，Bearer | REST，`X-Tavily-Access-Mode:keyless` | 同头 extract | 匿名 search 和 key search 均曾 HTTP 200 |
| Keenable | REST `/v1/search`、GET `/v1/fetch`，X-API-Key | `/v1/search/public`，固定应用标识头 | `/v1/fetch/public`，live=true | 匿名 search 和 key search 均曾 HTTP 200 |
| Exa | REST `/search`、`/contents`，x-api-key | `mcp.exa.ai/mcp`，web_search_exa | 同 MCP，web_fetch_exa(urls,maxCharacters) | 匿名 search 成功；fetch HTTP 200，首轮解析已用同次响应离线修复 |
| Parallel | REST `/v1/search`、`/v1/extract`，x-api-key | 当前官方 `mcp.parallel.ai/mcp`，web_search | 同 MCP，web_fetch(urls,full_content=true) | 匿名 search/fetch 均成功；key search 曾 HTTP 402，未改匿名重试 |
| You | REST POST `ydc-index.io/v1/search`、`/v1/contents`，X-API-Key | GET `api.you.com/v1/agents/search`，query/count | 官方免费档无 contents；明确使用 direct-http 直抓兜底 | 直抓兜底 HTTP 200；匿名搜索此前超时；不冒充 You 正文服务成功 |
| AnySearch | REST `/v1/search`、`/v1/extract`，可选 Bearer | 相同 REST，无认证头 | 原生 extract（严格单 url） | 匿名 search 一次 HTTP 200、code=0、解析 1 条；extract 仅 mock 验证 |
| 元宝 yuanbao | 仅搜索：完整 SecretId/SecretKey 走 TC3 `wsa.tencentcloudapi.com/`；两字段空时兼容服务 Bearer `/SearchPro` | 不提供；无凭据 requires_key，半对凭据 incomplete_credentials | 不支持 fetch；正文沿统一抓取链 | TC3 后续单次实测 HTTP 200，解析 10 条；此前 Bearer 曾授权拒绝 |
| TinyFish | 搜索 GET `api.search.tinyfish.ai`，`X-API-Key` | `agent.tinyfish.ai/mcp` 的 `search` 工具 | — | 匿名在隔离 Magpie 中联网验证；带密钥接口仅用模拟响应验证 |
| Querit | 搜索 POST `/v1/search`，Bearer | — | — | 模拟响应验证；无凭据时返回 `REQUIRES_KEY` 或跳过 |

You 匿名 REST 来自固定上游提交，当前官方文档主要描述免费 MCP profile；没有因此增加另一套自动匿名协议回退，需后续独立验证。Parallel 使用官方推荐的新 MCP 地址，区别于上游仍使用的 `search.parallel.ai/mcp`。这是远端 HTTP 协议调用，不需要用户安装/配置 MCP。

`--limit` 为 1–20，默认 5。AnySearch 每次最多 10 条。TinyFish 与匿名 Parallel 按引擎返回的一页结果在本地截断。其他支持结果数参数的引擎接收计算后的数量。返回不足时不额外请求补齐。正文一次读取一个地址，`--max-chars` 可限制长度。

日期与站点筛选见文末。元宝将 `news` 映射到 `Industry=news`。`Cnt` 按提供方允许的 10 或 20 向上取整，再按计算后的数量截断。Firecrawl 的 `code` 使用 `developer` 分类、`news` 使用新闻来源；Tavily 使用 `topic=news`，You 读取新闻分区，TinyFish 使用 `domain_type=news`。TinyFish 和 Querit 接入搜索，域名限制在本地过滤。

## 可解释路由

当前 Agent 判断并传 `--task-type general|code|news`（缺省 general），脚本不调用额外模型。查询包含汉字、平假名、片假名或韩文则标记 `cjk`，其他标记 `non-cjk`，仅是文字脚本启发式，不是完整语种识别。

先排除禁用、能力不符、凭据缺失或处于冷却的引擎，再按配置 `priority` 升序。同优先级按下表排序。显式 `--engine` 只尝试指定引擎；无密钥的 You 正文请求会走直抓，结果中记录 `requestedEngine=you` 与 `engine=direct-http`。

| 类型 | non-cjk 偏好次序 | cjk 偏好次序 |
|---|---|---|
| general | Tavily → Firecrawl → Parallel → Keenable → You → Exa | Keenable → Tavily → Firecrawl → You → Exa → Parallel |
| code | Exa → Firecrawl → Parallel → Tavily → Keenable → You | Exa → Firecrawl → Keenable → Tavily → Parallel → You |
| news | Tavily → You → Firecrawl → Parallel → Keenable → Exa | Tavily → You → Keenable → Firecrawl → Parallel → Exa |
| fetch | 云端层按 priority 与上表次序 → 直抓（全部失败后） | 同左 |

fetch 的云端层按 priority 升序，同级用上表顺序，最多尝试 maxAttempts 家；全部失败后才进入直抓层，直抓不占用 maxAttempts。同次链中不再尝试 You 的匿名直抓别名，避免重复直抓。所有引擎禁用时也不会额外直抓。显式引擎只调用该引擎，不进入直抓回退。

原有六家范围内没有上游中文默认池中的 Bing/Baidu/Aliyun/AnySearch，因此不照搬其中文排名。这里的中文池是可调整的启发规则，不声称某家中文质量最好。配置 priority 可覆盖该顺序。

同优先级的搜索回退顺序在上表之后接 AnySearch → TinyFish → Querit → 元宝。默认最多尝试 3 家。希望优先使用 TinyFish 或 Querit 时可单独调低其 `priority`。

JSON 中 `routing` 披露 queryLanguage、taskType、显式/自动选择方式，以及每个候选的 priority、preferenceRank 和实际协议档位（key-rest / anonymous-rest / anonymous-mcp-http）；`skipped` 解释未调用原因，`attempts` 给出每次结果与实际档位。路由说明不输出原查询或密钥。

失败最多顺序尝试 maxAttempts 家，首个成功即停，不融合、不并发；空搜索算成功。401/403、402、429、超时等可以继续下一家，但同一家不重试、不轮换 key、不变换身份。429/503 的 Retry-After 秒数/日期完整保存；无 Retry-After 的 429 默认 60 秒；鉴权/额度错误 5 分钟，网络/超时 30 秒。不会用匿名路径绕开同一家账号额度错误。

## 会话、缓存和 MCP

冷却默认写在 `~/.cache/agent-search/state.json`，可用 `--state` 改路径；只保存引擎/认证方式与凭据指纹/冷却时间及服务端返回的 Parallel session_id，不保存 key、查询、正文。按当前 tools/list 合同，Parallel 首次不生成 session_id，后续只复用服务端响应中的 session_id，不为限流生成新身份；MCP 传输握手返回的 Mcp-Session-Id 仅用于该次连接。AnySearch key 鉴权失败也只按既定规则回退别家，不照搬上游忽略无效 key 后改匿名的逻辑。AnySearch 402 原始响应可能包含服务端生成的凭据，错误处理不输出/保存正文、不采用生成凭据、不自动注册或重试；只保留安全类别、HTTP 状态及经 UUID 校验的 request_id。

损坏/不可读状态按空处理；写失败在 warnings 告知。该缓存不用于多进程分布式限流，重叠写仍是最后写入者生效。

内部 MCP 客户端处理 initialize/initialized/tools-call、协议版本协商、JSON/SSE、多行 data、通知/ping、响应 ID 与 tool error，读到匹配响应后可关闭流。HTTP 限流尊重 Retry-After，工具内限流错误做短冷却，不重发工具调用；服务端 session 失效也不重放本次查询。未实现 OAuth、流断线续传、服务端反向工具请求或 research。

## 输出与安全

正常调用 stdout 是单个稳定 JSON（schemaVersion=1），stderr 只打印固定诊断。先看 ok，再读 data.results、data.content、sources 和 truncated。搜索的未知 MCP 格式保留为受限长的不透明正文；fetch 的未知格式报错，不假装全文解析成功。正文结果带 contentKind=page-text；部分返回错误标 partial、服务端/本地截断标 truncated，并保留来源。`--max-chars` 100–50000（缺省 20000）限制标题/正文总字符，不含 URL/JSON 元数据；HTTP 响应上限 2 MB。输出会脱敏配置中 key，不打印原始错误体、认证头或堆栈。

退出码 0 成功、1 全部尝试失败或无可用候选、2 输入/配置/目标预检错误。`--help` 输出说明文本。

所有请求只接受公开 HTTP(S) URL、标准端口和无用户密码 URL；拒绝私网/回环/链路本地/保留地址、混合 DNS 私网答案，连接固定到已校验 DNS 地址。API 请求不跟随重定向，避免泄漏认证头。fetch 先 HEAD 校验最多五次跳转，每跳重新验证；403/405 可继续。直抓 GET 的每次跳转也复用同一 DNS/地址检查，不携带认证、cookie 或用户浏览器会话。直抓移植上游 htmlToText 清洗为惰性文本，不执行 JS，不请求子资源；此小版本只接受 UTF-8 HTML/Markdown/plain text，明确拒绝非文本、压缩和其他字符集响应，不能保证文章主体提取。服务商远程抓取的 DNS、动态跳转以及 HEAD/GET 差异不能由客户端完全保证。

网页文字属于不可信数据，不执行其中指令或脚本。本工具不是浏览器、登录抓取器或完整文档解析器，不持有登录会话，不绕过验证。

## 验证

```bash
node --test
node --check scripts/request.js
```

[docs/VERIFICATION.md](docs/VERIFICATION.md) 说明离线测试和未验证边界；接口合同见 [docs/SOURCES.md](docs/SOURCES.md)。不在仓库分发历史账户响应、本机诊断或请求日志。

`scripts/smoke.js` 仍是手动测试前三家匿名 REST 的旧烟测辅助，运行会消费其免费额度；不会自动读取用户 key。TC3 离线向量与凭据选择测试位于 `test/tc3.test.js`；AnySearch 测试位于 `test/anysearch.test.js`；协议和正文测试位于 `test/mcp.test.js`、`test/fetch.test.js`；默认测试均用 mock，绝不联网。

AnySearch 显式调用示例：`node scripts/request.js search "查询词" --engine anysearch --config config.example.json --state /tmp/agent-search-review-state.json`。

## 元宝双字段与 Bearer 兼容

本机配置 `~/.config/agent-search/config.json`：

```json
"yuanbao": {
  "enabled": true,
  "key": "",
  "priority": 50,
  "secretId": "",
  "secretKey": ""
}
```

填写 `engines.yuanbao.secretId` 和 `engines.yuanbao.secretKey` 即使用腾讯云 API 3.0 TC3-HMAC-SHA256。两项齐全时优先 TC3，即使旧 key 非空也不使用它；两项均空时才兼容既有的单服务 Bearer key；只填一项时 skipped.reason=incomplete_credentials，显式报 INVALID_CREDENTIAL_CONFIG，绝不悄悄回退 Bearer。所有凭据都空时仍 requires_key、零网络。enabled:false 同样零请求。

TC3 固定 POST https://wsa.tencentcloudapi.com/，service=wsa、X-TC-Action=SearchPro、X-TC-Version=2025-05-08、当前 UTC 秒级时间戳，无 Region。Node 内置 crypto 进行 SHA256/HMAC，不装 SDK。SecretKey 只在本地派生签名，不作为明文发送；SecretId 与最终签名出现在官方 Authorization 格式中，不打印或保存。签名与发送使用同一份 UTF-8 序列化正文，避免二次 JSON 格式变化。机器时间与标准时间偏差超过五分钟可能签名失败。

旧 Bearer 通道仍固定 POST https://api.wsa.cloud.tencent.com/SearchPro，仅携带服务 API KEY 和 JSON Content-Type，不混用 TC3 headers。两种方式失败都不自动切换另一种；不创建凭据、不充值或改账户。本版只实现长期 SecretId/SecretKey，不接受 STS 临时 Token；临时凭据不能在缺 Token 时假装等同长期凭据。

元宝仍只提供摘要搜索。Response.Error 即使 HTTP 200 也分类处理，不输出 Message 或原始响应。Cnt 和 news Industry 映射不变。状态指纹为 yuanbao:tc3:<哈希> 或 yuanbao:bearer:<哈希>，TC3 两字段任一变化或认证方式切换都使用独立冷却；不保存明文 ID/SecretKey/Bearer，也不因改变未使用的旧 Bearer 值而重置 TC3 冷却。



## web-search 0.7：日期与域名筛选

对外 Skill 名称为 `web-search`；统一凭据配置仍为 `~/.config/agent-search/config.json`。Node 22+，无需全局 CLI。旧 anysearch_cli.js、--max_results、map/crawl 和旧 dotenv 配置不兼容；现用 scripts/request.js 的 search/fetch。

```bash
node "<skill_dir>/scripts/request.js" search "release notes" --after 2026-10-01 --before 2026-11-01 --include-domains nodejs.org,github.com --exclude-domains gist.github.com --limit 3
```

日期仅接受有效 YYYY-MM-DD；以 UTC 计算，after 包含零点，before 排除零点，可单独提供一端。过滤参数只用于 search。未知、无效日期不通过严格筛选；Tavily 日期可能是最近更新而非最初发表。时间范围不会改写为查询提示，不支持的档位在请求前跳过，显式选择返回 UNSUPPORTED_DATE_FILTER。

| 档位 | 日期映射 | 域名映射 |
| --- | --- | --- |
| Exa 有 key REST | startPublishedDate / endPublishedDate，结果再严格校验 | includeDomains / excludeDomains + 本地边界校验 |
| Tavily 有/无 key REST | start_date / end_date，filter_by_published_date=true、include_published_date=true，再本地校验 | include_domains（restrict）/ exclude_domains + 本地校验 |
| Exa 无 key MCP、Parallel 两档、Firecrawl、Keenable、You、AnySearch、元宝 | 本版未接严格日期，跳过，不代表提供方完全没有时间功能 | 仅已召回结果本地过滤，不向接口虚构参数 |

域名最多20个，纯主机名，可用国际域名；不接受 URL、IP、端口、路径、通配符、账号或私网名称。example.com 包含自身和子域，不匹配 example.com.evil.org；排除优先。仅过滤已有召回结果，不补充请求，可能少于 limit 或为空；空结果成功即停。原始未知 MCP 文本不会绕过筛选从 data.content 返回。data.filters 报告 dateMode/domainMode/removed，保留结果 publishedDate。

当前固定排序未更改；日期要求仅减少候选。fetch 不接受这些筛选参数，直接抓取仍有静态页面和主内容质量边界。

接口核对（2026-10-29）：[Exa Search](https://exa.ai/docs/reference/search)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)。本版仅离线 mock 验证，无真实凭据计费请求。
