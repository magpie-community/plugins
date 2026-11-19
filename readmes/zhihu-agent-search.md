# zhihu-agent-search · 知乎搜索 magpie 插件

把[知乎数据开放平台](https://developer.zhihu.com/docs)的**搜索相关接口**包装成 magpie 插件。
装上之后，所有接入 magpie 的智能体（Claude Code、Codex、Cursor 等）都会多出 6 个 `zhihu_*` 工具，
magpie 自带的「联网搜索」也可以选择用知乎站内搜索。

## 工具一览

| 工具 | 对应知乎接口 | 用途 |
| --- | --- | --- |
| `zhihu_search` | `GET /api/v1/content/zhihu_search` | 知乎站内搜索，可按赞同/评论/时间排序和筛选 |
| `zhihu_global_search` | `GET /api/v1/content/global_search` | 全网搜索，支持 `host=="…"` 等高级过滤 |
| `zhihu_hot_list` | `GET /api/v1/content/hot_list` | 知乎热榜 |
| `zhihu_question_answers` | `GET /api/v1/content/question_answers` | 某个问题下的回答列表，支持分页 |
| `zhihu_question_recommendations` | `GET /api/v1/user/question_recommendations` | 问题推荐（按账号画像或关键词） |
| `zhihu_quota` | `GET /api/v1/quota` | 查询各接口剩余额度（不消耗额度） |

工具名由 magpie 统一加前缀（如 `zhihu_search`、`zhihu_global_search`）。

正文默认**最多保留 500 字符**（超出部分以 `…` 结尾），避免一次搜索把上万字符塞进上下文；
需要全文时传 `maxTextLength: 0`。单条结果最多带 2 条评论摘要。

### `zhihu_search` 参数

| 参数 | 说明 |
| --- | --- |
| `query` | 必填，搜索关键词 |
| `count` | 返回条数，1–10，默认 10 |
| `sortField` | 排序字段：`CommentCount` / `VoteUpCount` / `EditTime` / `CreateTime` |
| `sortOrder` | `desc`（默认）/ `asc` / `none` |
| `min` / `max` | 排序字段的取值范围，可只填一边；时间字段用 Unix 秒 |
| `since` / `until` | 时间区间，`2026-01-01` 或 ISO 时间；需配合 `EditTime` / `CreateTime`，不能和 `min` / `max` 同用 |
| `maxTextLength` | 每条正文最多保留的字符数，0 表示不截断 |

插件会把这些参数拼成知乎要求的 `SortBy` 语法，例如
`VoteUpCount:desc:(10,100)`、`CreateTime:none:(1760000000,)`。
按时间筛选更推荐写 `sortField=CreateTime, since=2026-01-01`，插件会转成 Unix 秒（不带时区按 UTC 解析）。

`hasMore` 为 `true` 时表示还有更多结果，但**知乎搜索接口不支持翻页**：请缩小关键词、减少 `count`，
或改用 `zhihu_global_search`（同样不支持翻页）。

### 返回结构

知乎的 `Data` 会被整理成 camelCase，并做几项清理：去掉 `<em>` 等高亮/HTML 标签、
解码 HTML 实体、去掉链接里的 `utm_*` 跟踪参数、正文按 `maxTextLength` 截断（按码点，不会切坏 emoji）。

```json
{
  "hasMore": false,
  "searchHashId": "…",
  "items": [
    {
      "title": "如何学习 Go 语言",
      "contentType": "answer",
      "contentId": "123",
      "url": "https://www.zhihu.com/question/1/answer/123",
      "contentText": "先说结论：Go 语言适合……",
      "commentCount": 7,
      "voteUpCount": 42,
      "author": { "name": "张三", "avatar": "…", "badge": "优秀回答者" },
      "editTime": "2026-01-01T00:00:00.000Z",
      "createTime": "2025-12-31T00:00:00.000Z",
      "commentInfo": ["很有帮助"]
    }
  ]
}
```

## 安装与登录

```bash
# 从 npm 安装（推荐）
magpie plugin add zhihu-agent-search

# 或从 GitHub 安装
magpie plugin add https://github.com/ilioner/magpie-zhihu-search.git

# 本地开发时直接装目录
magpie plugin add ./zhihu-agent-search

# 保存 Access Secret（在 https://developer.zhihu.com/profile 生成）
magpie plugin login zhihu

# 确认已注册
magpie plugin list
```

`magpie plugin list` 应该显示：

```
zhihu-agent-search  on
  tools  zhihu_global_search, zhihu_hot_list, zhihu_question_answers, zhihu_question_recommendations, zhihu_quota, zhihu_search
  zhihu (知乎, 0 models)  signed in
```

### Access Secret 的三种来源（优先级从高到低）

1. 插件选项 `accessSecret`（`~/.config/magpie/plugins.json` 里该条目的 `options`）
2. 环境变量 `ZHIHU_ACCESS_SECRET`
3. `magpie plugin login zhihu` 写入的 `plugin-auth.json`

值开头带 `Bearer ` 也没关系，插件会自动去掉。

### 插件选项

写在 `~/.config/magpie/plugins.json` 里 `zhihu-agent-search` 条目的 `options`，或改选项后
`magpie plugin options zhihu-agent-search '{…}'`（会自动重载）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `accessSecret` | — | 直接写 Access Secret，优先级最高 |
| `baseUrl` | `https://developer.zhihu.com` | 只允许 https；回环地址可用 http |
| `maxTextLength` | `500` | 正文默认截断长度，0 表示不截断（单次调用可用同名参数覆盖） |
| `cache` | `true` | 设为 `false` 关闭结果缓存 |
| `cacheTTL` | 见下 | 统一覆盖所有接口的缓存毫秒数，0 表示不缓存 |
| `debug` | `false` | 把请求耗时/错误写进 magpie 日志（等同 `ZHIHU_DEBUG=1`） |

## 缓存与重试

知乎的额度按接口计算，重复调用很浪费，所以插件内置了一层很小的缓存：

| 接口 | 缓存时长 |
| --- | --- |
| `zhihu_search`（含 magpie 联网搜索） | 120 秒 |
| `question_answers` | 120 秒 |
| `hot_list` / `question_recommendations` / `quota` | 60 秒 |
| `global_search` | 不缓存（`realtime` 库要保证新鲜） |

- 缓存键 = `sha256(Access Secret)` 前 16 位 + 路径 + 参数，**不保存明文密钥**，多账号之间不会串数据。
- 并发发起的相同请求会合并成一次上游调用。
- 只缓存成功结果；缓存上限 200 条，LRU 淘汰。

失败时只对“再试一次有意义”的错误重试一次（间隔约 300ms，尊重 `Retry-After`，最长 3 秒）：
网络错误、HTTP 5xx/429、`30003`（风控）、`50002`（检索失败）、`90001`（内部错误）。
`30001` / `30002`（额度类）和 `20001`（鉴权）**不会重试**，避免白烧额度；超时也不重试，
因为一次超时已经吃掉大半的 55 秒预算。

## 在 magpie 里启用知乎联网搜索

设置 › 模型 › 联网搜索，选择「知乎」即可。它调用的是同一个 `zhihu_search` 接口，
返回 magpie 需要的 `{ title, url, text, age }`。

## 实现要点

- **必须检查 `Code`，不能只看 HTTP 状态。** 知乎鉴权失败时返回的是 HTTP 200 +
  `{"Code":20001,"Message":"Authorization failed"}`，所以插件在解析响应后强制校验 `Code === 0`；
  `20001` 抛 `AuthenticationError`，其余非 0 抛带中文说明的 `APIError`。
- **`X-Request-Timestamp`** 每次请求实时生成（Unix 秒），知乎要求与服务器时间相差不超过 10 分钟。
- **错误信息不回显密钥**，只包含错误码、中文原因和服务端 `Message`。
- **参数在本地再校验一次**：magpie 会把工具参数原样转发给插件，所以插件自己检查必填项、
  未知参数、数值范围和 URL 格式，避免把明显错误的请求发给知乎、浪费额度。
- **请求超时 25 秒**，同时尊重 magpie 传入的 `AbortSignal`；重试也监听同一个信号，中止后立刻停止。
- **重试有边界**：只重试网络错误、5xx/429 和 `30003` / `50002` / `90001`，额度与鉴权错误直接失败。
- **结果缓存**：见上文「缓存与重试」，热榜类接口重复调用不会反复消耗额度。
- **自定义 `baseUrl`** 只允许 https；只有回环地址（`127.0.0.1` / `localhost` / `[::1]`）
  允许 http，方便测试。

## 额度说明

知乎开放平台按接口分别限量。同一个 Access Secret 下实测的每日额度（不同账号/实名状态可能不同，以控制台和 `zhihu_quota` 为准）：

| 接口 | 额度 |
| --- | --- |
| `zhihu_search` | 每日 5000 次 |
| `global_search` | 每日 5000 次 |
| `hot_list` | 每日 100 次 |
| `question_discovery`（回答列表 / 问题推荐共用） | 每日 100 次（未实名认证 10 次） |
| `quota` | 不消耗额度 |

先用 `zhihu_quota` 看一眼剩余量，再决定要不要批量搜。

## 发布与收录

1. **GitHub 非官方列表**：给仓库加上 `magpie-plugin` 标签（GitHub 仓库页 → About → Topics），
   magpie 约 10 分钟内就会把它显示在「插件 → 发现 → 非官方插件 · GitHub」，
   按 Star 排序并标注未经审核。仓库根目录必须有 `package.json`，插件加载的文件必须提交进仓库。
2. **官方社区列表**：发布到 npm 后，往
   [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `registry.json`
   提 PR 加一条记录，magpie 每隔几小时拉取一次。
3. **自建列表**：`MAGPIE_PLUGIN_MARKET=<url>` 可以让 magpie 改用另一份列表，方便本地验证条目。

## 开发

```bash
node --test test/*.test.mjs
```

测试用本地 HTTP 服务模拟知乎接口，不需要真实密钥。

目录结构：

```
zhihu-agent-search/
├── index.mjs            # 插件入口（只导出插件函数和 _internal）
├── src/
│   ├── config.mjs       # 常量、超时/重试/缓存默认值、baseUrl 校验
│   ├── credentials.mjs  # Access Secret 的读取与优先级
│   ├── request.mjs      # 请求、Code 校验、重试、错误类型
│   ├── cache.mjs        # 有界 TTL 缓存 + 并发请求合并
│   ├── normalize.mjs    # 知乎返回结构 → camelCase，清理标签/实体/截断
│   ├── tools.mjs        # 6 个工具的定义、参数校验、SortBy 拼接
│   └── websearch.mjs    # magpie 联网搜索适配
└── test/
    ├── plugin.test.mjs   # 插件契约、各接口参数与返回结构
    └── optimize.test.mjs # 截断、清理、缓存、重试、since/until、日志
```

> 注意：magpie 会把入口文件导出的**每个函数**都当成插件调用，所以测试用的辅助函数
> 一律放在 `export const _internal = { … }` 对象里，不要单独 `export function`。

## 调试

### 1. 直接调用工具（最快的一步）

```bash
magpie tools                      # 所有插件工具和参数
magpie tools zhihu_search         # 单个工具的完整说明
magpie tool zhihu_search --count 3 --sortField VoteUpCount "如何学习 Go 语言"
magpie tool zhihu_quota --json    # 原样输出，不美化
```

这条路径和智能体真实的 MCP 调用完全一样，能一次验证：插件加载、参数校验、鉴权、
请求、`Code` 检查、结果整理。参数写错会在调用前就被拒绝，不消耗知乎额度。

### 2. 看日志

```bash
magpie log --path     # ~/Library/Logs/magpie/app.log（App 打开过后才有）
magpie log -n 100     # 最近 100 行
magpie log -f         # 跟随输出
```

插件里的 `console.log` / `console.error` / `process.stdout` 都会被转到 stderr，
在日志里以 `plugin: …` 开头；用 `client.app.log(...)` 则写成
`plugin [level]: [service] message`。请求失败的原因、加载错误都在这里。

想看到每次请求的耗时、重试和错误码，设 `ZHIHU_DEBUG=1`（或插件选项 `debug: true`），
插件会以 `zhihu-agent-search` 服务名写日志；只记录路径、耗时和错误码，**不记录密钥和搜索词**。

### 3. 确认加载状态

```bash
magpie plugin list           # 加载失败会在那一行写明原因
magpie plugin list --json    # 含每个工具的描述和 JSON Schema
```

### 4. 改完代码要手动重载

只改源码**不会**自动生效——重载由「开关插件」或「改插件选项」触发：

```bash
magpie plugin off zhihu-agent-search && magpie plugin on zhihu-agent-search
magpie plugin options zhihu-agent-search '{"accessSecret":"…"}'   # 也会触发重载
```

### 5. 设置 → 插件

每个插件那一行会显示工具的调用次数、平均耗时、失败次数和最近一次结果；
中间件类插件还会显示每个钩子的统计和最近一次错误。

### 6. 沙箱里跑，不碰自己的配置

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache \
          MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./zhihu-agent-search
m plugin list
```

### 7. 本地单测

```bash
node --test test/*.test.mjs
```

工具最多运行 55 秒，超时后 magpie 会触发 `ctx.abort`；长请求要自己监听
`ctx.abort`（本插件已把它和 25 秒请求超时合并）。

## 参考

- magpie 插件开发：<https://usemagpie.ai/docs/zh/plugins>
- 知乎开放平台文档：<https://developer.zhihu.com/docs>
- Access Secret 管理：<https://developer.zhihu.com/profile>