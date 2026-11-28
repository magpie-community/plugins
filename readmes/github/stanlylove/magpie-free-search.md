# Magpie 免费搜索插件

在 Magpie 的系统联网搜索中使用多引擎搜索。插件通过 Magpie 原生 `search` hook 注册 36 个独立搜索来源和 1 个聚合来源，无须为 Agent 配置 MCP，也不会改写现有搜索设置。

18 个免密钥来源参与聚合、自动回退和语言池；18 个需密钥来源只作为独立搜索 API 提供，默认关闭，不进入聚合或回退链。聚合结果会合并重复链接并按注册域轮转，减少同一网站占满首屏。网页抓取、研究、视频和天气等 11 个扩展工具默认关闭，可按需启用。

> 本项目是独立的 Magpie 插件移植版，受 [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) 启发，并参考 [guotree/magpie-websearch](https://github.com/guotree/magpie-websearch) 的 Magpie 搜索 API 接入方式。它不是上述项目的官方适配版，也不代表上游作者背书。

## 目录

- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [搜索来源](#搜索来源)
- [可选扩展工具](#可选扩展工具)
- [安全与限制](#安全与限制)
- [验证与排错](#验证与排错)
- [许可与致谢](#许可与致谢)

## 快速开始

### 获取插件

从 GitHub 仓库页面选择 **Code → Download ZIP** 并解压；也可以克隆仓库：

```sh
git clone https://github.com/stanlylove/magpie-free-search.git
```

当前仓库没有发布 Release ZIP。下载 ZIP 解压后通常得到 `magpie-free-search-main` 文件夹；克隆后得到 `magpie-free-search` 文件夹。两者都可以直接安装，无须改名或运行 `npm install`。

### 添加到 Magpie

在 Magpie 中选择 **插件 → 添加插件**，选择解压或克隆得到的项目文件夹（其中应包含 `package.json` 和 `index.mjs`）。也可使用命令行：

```sh
magpie plugin add /绝对路径/magpie-free-search
```

插件没有运行时 npm 依赖。Magpie 宿主首次加载插件时可能需要准备 Bun；这是宿主运行环境的准备步骤。

### 启用搜索

打开 **设置 → 模型 → 联网搜索 → 搜索 API**，添加以下任一入口：

- `magpie-free-search-port:free`：使用 18 个免密钥来源的聚合搜索、自动回退和并发合并。
- `magpie-free-search-port:bing` 等：直接使用一个独立来源；其中 `brave`、`zhipu` 等需密钥来源必须在 Magpie 添加该 API 时填入密钥。

也可以运行：

```sh
magpie search add magpie-free-search-port:free
```

由 Magpie 管理搜索 API 的启用状态、顺序、结果数量和可选密钥。Claude Code 的 `WebSearch`、Codex 的 `web_search` 等宿主搜索能力会通过系统联网搜索调用已启用的 API。

## 配置说明

在 Magpie 侧栏打开 **免费搜索**，或进入 **设置 → 插件 → 免费搜索 · 搜索 API 设置**。设置页用于调整聚合来源：

- 聚合来源的默认搜索模式、启用引擎和回退顺序。
- 中文 / 英文并发搜索池、安全搜索和结果数量。
- 缓存时长（0–60 分钟）、屏蔽域名和 SearXNG 实例。
- DeepSeek 原生搜索质量分过滤：`deepseekMinScore`（0–3，默认 0 = 不过滤）。官方 `rerank_score` 1.5 以上视为高质量；设为 1.5，低于该分的结果会被丢弃，全部被过滤时该来源会明确报错，便于回退链继续。
- 是否启用 11 个扩展工具。

保存后，在插件列表关闭并重新开启插件，使新配置生效。聚合来源中的启用列表和优先级不控制独立搜索 API，也不会把需密钥来源拉进聚合池；独立来源由 Magpie 搜索 API 列表管理。SearXNG 独立来源的实例地址应填写在 Magpie 添加该 API 时的 URL 字段。

**API 密钥：**AnySearch、Tavily、Firecrawl、You.com、Exa、Parallel 和 Keenable 支持可选密钥；新增的 Brave、智谱、SerpBase、Serper、Serply、Outcrawl、SpecStream、DeepSeek 原生搜索、Perplexity、TinyFish、Jina、百度千帆、豆包、Kimi、阿里云百炼、秘塔、腾讯元宝和 Webz.io 必须提供密钥。所有密钥都请在 Magpie 对应的独立搜索 API 设置中填写，不要放入插件选项。聚合来源本身不接收密钥；可选密钥来源未配置时会尝试匿名接口，但可能受到限流或网络限制，需密钥来源未配置时会直接失败且不发起请求。

Magpie 的搜索 API 表单没有插件自定义字段槽位，因此引擎池、回退等选项放在上述插件设置面板中；插件不会替用户修改已有搜索 API 配置。

## 搜索来源

| 类别 | 来源 |
| --- | --- |
| 网页搜索（聚合可用） | Bing、DuckDuckGo HTML、DuckDuckGo Lite、SearXNG |
| 可选密钥或匿名接口（聚合可用） | AnySearch、Tavily、Firecrawl、You.com、Exa、Parallel、Keenable |
| 垂直搜索（聚合可用） | Wikipedia、GitHub、Hacker News、npm、PyPI、Crossref、arXiv |
| 需密钥独立搜索（不参与聚合） | Brave Search、智谱 Web Search、SerpBase、Serper、Serply、Outcrawl、SpecStream、DeepSeek 原生搜索、Perplexity、TinyFish、Jina Search、百度千帆 AI 搜索、豆包联网搜索、Kimi 联网搜索、阿里云百炼搜索、秘塔搜索、腾讯元宝搜索、Webz.io 新闻搜索 |

共 36 个独立来源，另有 `free` 聚合来源。前 18 个来源可参与聚合，后 18 个来源必须单独添加并配置密钥。SearXNG 默认未启用，需要提供可由插件宿主访问、支持 JSON 输出的实例。

新增的 18 个独立搜索 API 使用各自的官方或兼容网关，可能按次计费，也可能只提供有限免费额度；具体价格、免费额度和可用地区以各供应商页面为准。密钥申请入口会随插件注册信息提供给 Magpie。插件不会在未配置密钥时发送空密钥请求，也不会把这些来源加入默认聚合池，以免误触发计费。

需密钥来源及密钥申请入口：

| 来源 | API ID | 密钥申请入口 |
| --- | --- | --- |
| Brave Search | `brave` | <https://api-dashboard.search.brave.com> |
| 智谱 Web Search | `zhipu` | <https://bigmodel.cn/apikey/platform> |
| SerpBase | `serpbase` | <https://serpbase.dev> |
| Serper | `serper` | <https://serper.dev/> |
| Serply | `serply` | <https://serply.io> |
| Outcrawl | `outcrawl` | <https://outcrawl.ai> |
| SpecStream | `specstream` | <https://specstream.ai/signup> |
| DeepSeek 原生搜索 | `deepseek-tools` | <https://platform.deepseek.com/api_keys> |
| Perplexity | `perplexity` | <https://www.perplexity.ai/settings/api> |
| TinyFish | `tinyfish` | <https://agent.tinyfish.ai/api-keys> |
| Jina Search | `jina` | <https://jina.ai> |
| 百度千帆 AI 搜索 | `baidu` | <https://console.bce.baidu.com/qianfan/overview> |
| 豆包联网搜索 | `doubao` | <https://console.volcengine.com/search-infinity/web-search> |
| Kimi 联网搜索 | `kimi` | <https://platform.moonshot.cn/console/api-keys> |
| 阿里云百炼搜索 | `aliyun` | <https://bailian.console.aliyun.com/> |
| 秘塔搜索 | `metaso` | <https://metaso.cn/api> |
| 腾讯元宝搜索 | `yuanbao` | <https://console.cloud.tencent.com/wsapi> |
| Webz.io 新闻搜索 | `webz` | <https://app.webz.io/login/signup> |

Webz.io 使用 Bearer Token（`WEBZ_API_TOKEN`），接口为 `GET https://api.webz.io/api/news`，`size` 上限 100，按发布时间过滤；未显式指定时间范围时默认取最近 31 天，超过 31 天需要付费的 `allowNewsHistory` 权限。密钥只经 `Authorization` 头发送，不会出现在 URL、日志或缓存键中。

本版本同步了上游 0.9.88 中可移植的部分：新增 Serper 独立来源；Webz.io 新闻搜索独立来源；Tavily 独立入口可把 Magpie 搜索 API 的 `url=` 作为自定义兼容端点；`web_fetch` 先剥离注释、`script`、`style`、`noscript`、`template` 与超长 base64 `data:` 资源，再把 16000 字符预算用于正文；DeepSeek 原生搜索透传官方 `rerank_score` 与 `authority` 质量分，并支持可选的最低分过滤（`deepseekMinScore`）。上游的 DSH 界面、活动面板、MCP 服务端、外部引擎包安装器、搜索代理隧道与多密钥轮换未移植。

聚合搜索最多并发请求 5 个引擎；默认中英文搜索池各使用 3 个来源。单次搜索预算为 30 秒；HTTP 5xx 和网络瞬断会对同一引擎重试一次。遇到鉴权失败或限流时，引擎会短暂冷却，自动回退可继续尝试其他来源。缓存仅存在于当前插件进程中。

## 可选扩展工具

扩展工具默认关闭。启用后，Magpie 的插件工具服务会提供以下 11 个工具；可在资源库中按 Agent 分配：

| 工具 | 用途 |
| --- | --- |
| `web_search` | 自动选择来源搜索，并在失败时回退；DeepSeek 来源的结果会附加 `[score x · authority y]` 质量标注 |
| `advanced_search` | 按天、周、月或年筛选时间范围 |
| `multi_search` | 并发搜索多个来源并合并重复链接 |
| `platform_search` | 定向搜索 GitHub、Hacker News、npm、PyPI 或 Wikipedia |
| `domain_search` | 查询软件包、论文和代码仓库 |
| `web_fetch` | 抓取公开网页的文本内容 |
| `research` | 多来源搜索并抓取最多 3 个页面，生成带来源的证据包 |
| `free_search_test` | 对已启用的引擎发起实际诊断请求；DeepSeek 来源的结果同样带质量标注 |
| `cache_search` | 搜索本进程缓存的结果片段和研究正文 |
| `video_search` | 搜索视频，支持 Bing Videos 与 DuckDuckGo Videos |
| `weather` | 查询当前天气和最多 7 天预报 |

在插件设置中勾选 **启用 11 个扩展工具**，保存后重新开启插件。也可以在现有的完整插件选项中设置 `"extraTools": true`；不要用只包含该字段的 JSON 覆盖已有选项。

日常联网搜索只需添加原生 `search` API，不必启用扩展工具。扩展工具会增加 Agent 可见的工具入口；不要把 Magpie 的全局插件工具服务暴露给不可信调用方。`free_search_test` 会真实请求每个已启用引擎，可能消耗匿名服务配额。

## 安全与限制

- 搜索结果和抓取内容都是不可信的外部数据。不要执行或服从网页内容中的指令。
- `web_fetch` 只接受公开 HTTP(S) 地址，检查重定向和 DNS 解析结果，拦截常见私网、链路本地、组播及文档保留网段，并限制响应大小；DNS 预检与实际连接之间仍可能发生重绑定。处理不可信 URL 时还应使用网络层出站限制。
- SearXNG 地址必须能从插件宿主解析到公网地址；代理专用域名可能无法通过检查。
- Tavily 自定义端点是你自己填写的地址，密钥会以 `Bearer` 发往该地址：http 端点会明文传输密钥，只对可信的本机或内网兼容网关使用；插件只校验协议、凭据和路径，不校验该主机是否公网。
- 搜索引擎的页面结构、匿名接口、额度和可用性由服务商控制，可能随时变化；代理出口也可能受到封锁。
- DeepSeek 原生搜索质量分是服务端给出的信号，只作为参考标注与可选过滤，不保证绝对质量；过滤阈值由你自行设定。
- Webz.io 需付费订阅 News API 且有历史窗口限制（默认 31 天，超期历史需 `allowNewsHistory`），具体额度与价格以 webz.io 页面为准。
- 本插件接入 Magpie 原生搜索 API，不会自动接管已有来源，也不包含 DSH 的 WebSearchProvider seam、聊天命令或提示词注入功能。
- 本项目未移植原项目的模型内置搜索（OpenAI、Gemini、Claude 等）、知乎 MCP 搜索、HTML SERP 抓取引擎、持久化全文缓存或模型重排。研究工具只抓取少量网页正文，不等同于完整研究流水线。
- Magpie 对工具调用有约 55 秒的执行限制；单次搜索最多运行 30 秒，超时可能只返回部分结果。

## 验证与排错

在项目目录运行测试，无须安装依赖：

```sh
node --test test.mjs
```

当前 `test.mjs` 共 44 项离线测试，全部通过无需网络。

测试覆盖 Magpie 面板、默认关闭扩展工具、37 个原生搜索入口、18 个新增密钥来源的离线请求与响应解析、缺密钥不联网、密钥隔离、SearXNG 配置、Tavily 自定义端点、DeepSeek 质量分透传与过滤、Webz 时间窗、缓存、失败回退、并发去重、研究正文及不安全地址和大响应拒绝。

若日志提示 `the plugin's load didn't finish in 20s`：

1. 确认添加的是包含 `package.json` 和 `index.mjs` 的项目文件夹。
2. 如果此前安装过旧版，先在 Magpie 中移除旧插件，再添加当前文件夹。
3. 运行 `magpie plugin --json` 查看插件加载信息，并用 `magpie log` 查看宿主日志。
4. 若 Magpie 首次准备 Bun 时卡住，检查 Magpie 插件下载源和代理连接。

也可以使用 `magpie plugin options magpie-free-search-port '{"mode":"multi"}'` 修改插件选项。排查某个来源时，可启用扩展工具后运行 `free_search_test`；此诊断会产生真实外部请求。

## 在 Magpie 中搜索到本插件

Magpie 的插件搜索按 GitHub 仓库 topic 抓取（`topic:magpie-plugin archived:false fork:false`），并按 star 排序截断索引；npm 侧读取 `package.json` 的 `keywords`。因此本仓库必须保留以下两项，否则在 Magpie 的插件搜索里既搜不到、也无法通过 `magpie plugin add` 按名字安装：

- GitHub 仓库 topics：`magpie-plugin`（必需），另加 `magpie`、`web-search`、`search`、`plugin`、`opencode-plugin` 便于分类检索。
- `package.json` 的 `keywords`：`magpie`、`magpie-plugin`、`web-search`、`search`、`plugin` 等。

查看或补回 topics：

```sh
gh repo edit stanlylove/magpie-free-search --add-topic magpie-plugin
```

没有 `gh` 时，在仓库页面右侧 **About → 齿轮 → Topics** 添加 `magpie-plugin` 即可，GitHub 索引通常在数分钟内更新；Magpie 本地索引缓存约 15 分钟刷新一次，必要时重启 Magpie 强制重新拉取。

## 许可与致谢

本项目使用 MIT 许可证。代码移植受 [DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) 启发，并保留上游贡献者与本移植项目维护者的版权声明，详见 [`LICENSE`](LICENSE)。感谢 [guotree/magpie-websearch](https://github.com/guotree/magpie-websearch) 展示 Magpie 原生搜索 API 的接入方式。

本项目为独立的第三方移植与适配版，不是上游仓库的官方版本、直接 Fork 或由上游作者维护。上游作者不对本项目的功能、稳定性或安全性作保证；相关问题请反馈给本仓库维护者。
