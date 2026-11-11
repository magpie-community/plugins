# magpie-websearch

<p align="center">
  <img src="assets/magpie-websearch-hero.png" alt="magpie-websearch — One plugin. Many sources." width="100%">
</p>

[中文说明](README.md) | [English](README.en.md)

为 [magpie](https://usemagpie.ai) 增加的第三方多源网页搜索 API 插件。安装后，这些 API 会出现在 **设置 › 模型 › 网页搜索** 中，由 Magpie 统一管理密钥、启用开关与请求顺序。

支持 **21 个搜索通道**：AnySearch、Bocha、Jina、Kagi、Keenable、Linkup、Metaso、Moonshot、Moonshot CN、Ollama、Parallel、Perplexity、Querit、SerpApi、Serper、StepFun、TinyFish，以及 Z.ai／Zhipu 各自独立的标准 REST 与 Coding Plan MCP。AnySearch、Keenable、Parallel 和 TinyFish 支持免 Key 匿名访问；其余十七个通道需要对应产品的 Key。

## 安装

```sh
magpie plugin add @guotree/magpie-websearch
# 或从 GitHub 安装
magpie plugin add github:guotree/magpie-websearch
```

## 快速上手

在 Magpie 的 **设置 › 模型 › 网页搜索** 中添加需要的 API，开启并调整顺序。支持匿名访问的 API 可以留空 Key；填写 Key 则使用自己的账户。

也可以通过命令行添加：

```sh
# 免 Key 匿名搜索
magpie search add magpie-websearch:anysearch

# 使用自己的 API Key
magpie search add magpie-websearch:linkup <key>

# 查看搜索 API
magpie search
```

默认注册全部 21 个 API，无需设置插件选项。Magpie 的网页搜索设置决定实际使用哪些 API。

Magpie v0.1.3062 起，Agent 可在调用 `web_search` 时指定 `count`（1–20，默认 6）；命令行示例：

```sh
magpie tool web_search "OpenAI API documentation" --count 20
```

插件未配置数量上限时跟随宿主 `count`，并遵守各供应商限制；所有供应商统一使用可选的 `resultLimit` 或 `*_RESULT_LIMIT` 环境变量设置用户上限。供应商可能返回更少结果，插件不追加请求补足条数。旧选项保留兼容，迁移与数量策略见[技术参考](docs/technical-reference.md#configuration)。

使用官方服务时，将 **Base URL** 留空；自定义地址应填写完整端点，插件不会追加路径。详见[自定义 Base URL](docs/technical-reference.md#custom-base-url)。

如需调整供应商参数，可在 **Plugins → Installed → Options** 配置，或运行：

```sh
magpie plugin options magpie-websearch '{"anysearch":{"format":"markdown"}}'
```

Options 编辑器会用包内的 AnySearch 示例预填；示例不会自动生效，点击 Save 后才会写入并重载。示例使用 AnySearch 的默认 `format`，保存后行为不变。

每次命令会替换已保存的完整选项对象，需包含希望保留的所有选项。保存后插件宿主会自动重载。完整参数和注册过滤见[技术参考](docs/technical-reference.md#configuration)。

## 支持的供应商

| 供应商 | Vendor ID | Key 需求 | 主要能力 |
|---|---|---|---|
| AnySearch | `magpie-websearch:anysearch` | 可选 | 意图路由、`cn`／`intl` 分区、Markdown／JSON 输出 |
| Bocha | `magpie-websearch:bocha` | 必填 | 博查中文搜索，默认普通摘要、可选生成摘要与时效筛选 |
| Jina | `magpie-websearch:jina` | 必填 | Jina Search 专用端点，默认摘要、可选全文正文截断与时效映射 |
| Kagi | `magpie-websearch:kagi` | 必填 | Kagi Search API 公开 Preview，支持 Lens、时间与地区过滤 |
| Keenable | `magpie-websearch:keenable` | 可选 | 匿名或带 Key 搜索，支持 `pro`／`realtime` 模式 |
| Linkup | `magpie-websearch:linkup` | 必填 | 查询相关摘录，支持四档检索深度 |
| Metaso | `magpie-websearch:metaso` | 必填 | 秘塔搜索，支持网页、论文等搜索范围 |
| Moonshot | `magpie-websearch:moonshot` | 必填 | 国际站 Basic 网页搜索，默认摘要、可选页面正文 |
| Moonshot CN | `magpie-websearch:moonshot-cn` | 必填 | 国内站 Basic 网页搜索，默认摘要、可选页面正文 |
| Ollama | `magpie-websearch:ollama` | 必填 | Ollama 官方云端网页搜索，需账户 API Key，支持本地正文截断 |
| Parallel | `magpie-websearch:parallel` | 可选 | 匿名 MCP（`fast`）或带 Key REST；最多 20 条 |
| Perplexity | `magpie-websearch:perplexity` | 必填 | 官方独立 Search API，支持 `web`／`fast` 模式、时效与国家／语言筛选 |
| Querit | `magpie-websearch:querit` | 必填 | 摘要或句子级匹配内容 |
| SerpApi | `magpie-websearch:serpapi` | 必填 | Google 自然搜索，支持地区、语言和安全搜索配置 |
| Serper | `magpie-websearch:serper` | 必填 | Google 自然搜索备用渠道，当前单页 10 条、支持地区语言与 tbs 筛选 |
| StepFun | `magpie-websearch:stepfun` | 必填 | 阶跃星辰国内站独立 REST 搜索，支持场景偏好、摘要／正文选择 |
| TinyFish | `magpie-websearch:tinyfish` | 可选 | 匿名 MCP 或带 Key REST；网页、新闻和论文搜索（论文需 Key） |
| Z.ai | `magpie-websearch:zai` | 必填 | 智谱国际站独立 REST 搜索，使用 `search-prime` |
| Z.ai Coding Plan | `magpie-websearch:zai-coding` | 必填 | 国际站 Coding Plan 的 Streamable HTTP MCP 搜索，消耗套餐共享 credits |
| Zhipu | `magpie-websearch:zhipu` | 必填 | 智谱国内站独立 REST 搜索，支持 `search_std`／`search_pro`、搜狗和夸克引擎 |
| Zhipu Coding Plan | `magpie-websearch:zhipu-coding` | 必填 | 国内 Coding Plan 的 Streamable HTTP MCP 搜索，消耗套餐共享积分 |

搜索项在 Magpie 中显示为 `<Provider> (magpie-websearch)`。Vendor ID 保持为 `magpie-websearch:<id>`；插件选项和注册过滤使用 `linkup` 等短 ID。完整支持状态与接入规划见 [PROVIDERS.md](PROVIDERS.md)。

## 隐私与安全

- **直连端点**：请求直接发往厂商官方 API，或用户显式配置的自定义端点。
- **搜索数据与协议元信息**：请求包含搜索参数，MCP 握手另含客户端名称、包版本及协议能力；不读取或转发对话记录、系统提示词、用户本地文件、工具输出或 Agent 上下文。
- **Magpie 管理凭证**：Key 按厂商协议传递。SerpApi 错误省略原始异常、响应体和请求 URL；其他厂商保留各自的诊断处理。插件不能控制厂商或代理的访问日志。
- **不静默降级**：带 Key 的请求失败时，不会降级为匿名访问。
- **通道严格隔离**：Coding Plan Key 与 Standard API Key 不通用；provider 内部不会将 MCP 失败改走按次计费 REST，或自动跨站重试。Magpie 可按用户显式配置的顺序尝试其他 provider，各自使用自己的 Key。

两个 Coding Plan provider 目前标记为实验性接入：官方页面说明 Remote MCP 可用于兼容客户端，但未明确把 Magpie 列为官方支持客户端。使用前请自行确认 Coding Plan 使用政策与账户条款；本项目不声称 Magpie 获得智谱或 Z.ai 官方支持。

已有 Key 的条目编辑时留空 Key，仍会保留原 Key。切回匿名访问的方法及限流处理见[匿名搜索与限流](docs/technical-reference.md#anonymous-search)。

## 详细文档

| 主题 | 内容 |
|---|---|
| [自定义 Base URL](docs/technical-reference.md#custom-base-url) | 精确端点规则、URL 校验、MCP／REST 切换 |
| [命令行管理](docs/technical-reference.md#cli) | 添加 API、多个 Key、排序、启停与移除 |
| [匿名搜索与限流](docs/technical-reference.md#anonymous-search) | 匿名端点、切换访问模式、429 冷却与回退 |
| [供应商协议](docs/technical-reference.md#parallel-search) | Parallel、[TinyFish](docs/technical-reference.md#tinyfish-search)、[SerpApi](docs/technical-reference.md#serpapi-search)、[Moonshot](docs/technical-reference.md#moonshot-search)、[Zhipu 与 Z.ai](docs/technical-reference.md#zhipu-search)、[StepFun](docs/technical-reference.md#stepfun-search)、[Perplexity](docs/technical-reference.md#perplexity-search)、[Bocha](docs/technical-reference.md#bocha-search)、[Ollama](docs/technical-reference.md#ollama-search)、[Jina](docs/technical-reference.md#jina-search)、[Kagi](docs/technical-reference.md#kagi-search)、[Serper](docs/technical-reference.md#serper-search) 的端点、能力限制与验证记录 |
| [结果处理](docs/technical-reference.md#result-processing) | 结果数、文本清理、日期与错误状态 |
| [完整配置参考](docs/technical-reference.md#configuration) | 参数表、环境变量、优先级、缓存与超时 |
| [注册过滤](docs/technical-reference.md#registration-filters) | `enable`／`disable` 的规则与示例 |
| [开发与本地测试](docs/technical-reference.md#development) | Node／Bun、Magpie 宿主测试、沙箱与验证环境 |

## 接入规划

第三批规划的独立网页搜索 API（Jina、Kagi、Serper）现已全部接入；接入规划见 [PROVIDERS.md](PROVIDERS.md#planned)。仅有同厂商的模型预设或模型内置搜索能力，不构成排除其独立搜索 API 的理由。新增接入前会重新核对 Magpie 官方的搜索支持情况。

Coding Plan 双站实现和本地模拟验证已完成；真实 Key 搜索、套餐积分／标准 REST 账单核对及 Magpie 客户端使用政策确认仍待完成。当前实验性状态不等于已完成真实账户验证。

## 鸣谢

适配器设计与响应测试用例最初基于 [guotree/opencode-search-plugin](https://github.com/guotree/opencode-search-plugin) v4.6.1。

## 开源协议

MIT

## 友情链接

- [LINUX DO](https://linux.do/) — the new ideal community
