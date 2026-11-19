# opencode-agentrouter-shim

AgentRouter 的 magpie / OpenCode 供应商插件。把
[`agentrouter-responses-shim`](https://www.npmjs.com/package/agentrouter-responses-shim) 2.1.0
的**请求改写**搬进插件宿主：清理 Responses 历史里的 reasoning item、按需把内联 Base64 图片转成 WebP。
不再需要本地端口、子进程或 Node 22 客户端。

## 它做什么

magpie 收下 agent 的请求，转成该供应商使用的 API 格式，再交给插件的 `loader.fetch`。本插件在
`fetch` 里改写**发出去的 Responses 请求体**，然后原样转发：

1. `POST /responses`、`/responses/input_tokens`、`/responses/compact` 的 `input` 数组里，
   整条删除 `type="reasoning"` item（含密文与资源绑定的 id）；
2. 对可内联重放的 message / function_call / function_call_output / custom_tool_call(_output)
   删除顶层 `id`，保留 `call_id` 配对、用户内容、工具参数与结果、`store` / `include` /
   `prompt_cache_*` / 工具列表顺序；
3. （可选）把 `input_image.image_url` 里的 PNG / JPEG / 静态 GIF 转成 WebP，仅在更小时替换，
   保留尺寸、alpha、`detail` 与 EXIF/ICC；已有 WebP 不二次有损编码。

响应与 SSE 逐字节透传，插件不碰回复。改写逻辑与上游 `src/sanitize.mjs`、`src/images.mjs` 一致
（MIT，见 `LICENSE`）。

## 装

```powershell
# 从 npm（已发布 0.1.0）
magpie plugin add opencode-agentrouter-shim

# 或直接从 GitHub 装（仓库同时带 magpie-plugin 标签）
magpie plugin add xiaoqi0102/opencode-agentrouter-shim

# 就地加载本地目录（本仓库克隆下来即可，不安装任何东西）
magpie plugin add D:\Apps\magpie\plugin-agentrouter-shim
cd D:\Apps\magpie\plugin-agentrouter-shim; bun install   # 装 sharp；用 magpie 自带的 bun 即可
magpie plugin login agentrouter      # 粘贴 AgentRouter API key
magpie provider test agentrouter     # 真发一次很小的请求
```

`magpie plugin` 会列出：

```
D:\Apps\magpie\plugin-agentrouter-shim  on
  agentrouter-plugin (AgentRouter, 5 models)  not signed in · magpie plugin login agentrouter
```

两点和直觉不同，都是 magpie 的规则：

* **供应商 id 会变成 `agentrouter-plugin`。** magpie 自带一个叫 `agentrouter` 的供应商，id 撞了就会加
  `-plugin` 后缀（文档 FAQ「为什么我的供应商叫 …-plugin？」）。登录仍按 `auth.provider`，即
  `magpie plugin login agentrouter`。
* **模型数是 magpie 自己补的。** 本插件的 `config` 只写 `models` 里手写的条目；没登录时
  magpie 用自己 models 目录里的 AgentRouter 条目显示若干模型，登录后按账号走
  `GET https://agentrouter.org/v1/models`。

OpenCode 也能用同一份包（magpie 自己的钩子会被 OpenCode 忽略）。

## 只过滤，不登录（推荐给已经配好 AgentRouter 的人）

magpie 里已经有 `agentrouter` 供应商、账号和 key 时，不需要插件再登一次，也不需要第二张供应商卡片：

```powershell
magpie plugin add D:\Apps\magpie\plugin-agentrouter-shim
cmd /c 'magpie.exe plugin options plugin-agentrouter-shim "{\"declareProvider\":false}"'
magpie plugin list
```

```
D:\Apps\magpie\plugin-agentrouter-shim  on
  async gateway hook  onRequest
```

就这一行——没有 `agentrouter-plugin` 卡片，`magpie plugin login` 也不用跑。你的 `agentrouter` 供应商、
两个 key、"OpenAI Responses" 协议都照原样工作，插件只做两件事：

* `onRequest` 收到 agent 发来的请求体（Codex 这类 Responses 客户端才有 `input` 数组），
  整条删 `type="reasoning"` item、删可重放的顶层 `id`、内联图片转 WebP，然后把改过的请求交回 magpie；
* 没有 `input` 数组的协议（Anthropic Messages、chat completions 等）一律 `skipped` 原样放过。

钩子的三条边界（magpie 的规则，不是插件的选择）：

1. 它在 **Bun 宿主**里跑，每个 Agent 请求一次，位于网关中间件之前，**对所有供应商生效**；
2. **默认 1 秒预算**（`gatewayTimeoutMs` 可设 100–30000，整链 2–10 秒）。超时这次请求就按原样发，
   不会失败——所以大图压缩第一次可能来不及生效，把 `gatewayTimeoutMs` 调大或 `imageMode: "off"`；
3. 钩子**不能拒绝请求**，`strict` 在这种模式下退化为"记一次 `invalid` 后原样放过"。

调用次数、耗时和最近结果在应用里那一行的插件选项（设置 → 插件）里看。

### 关于 `magpie plugin use`（实测无效）

`magpie plugin use plugin-agentrouter-shim agentrouter` 会写 `plugins.json` 的 `prefer`，列表上也显示
`serves agentrouter`，但它**不会**把你已有供应商的请求改道到插件的 `loader.fetch`：我把插件的
`serverUrl` 临时指向一个不存在的域名再 `magpie provider test agentrouter`，请求照样直连
agentrouter.org。所以要过滤已有供应商，用上面的钩子模式，别指望 `use`。

## 发布到 magpie 市场

现状（2026-11-19）：

* **npm**：`opencode-agentrouter-shim@0.1.0` 已发布，shasum `66d11a92e882c82130b460bc54eddce9c17578df`。
  账号是**安全密钥式 2FA**（npm 已不支持新增 TOTP），所以发布要带 `--auth-type=web` 走浏览器验证，没有 6 位码可填。
* **GitHub**：[xiaoqi0102/opencode-agentrouter-shim](https://github.com/xiaoqi0102/opencode-agentrouter-shim) 已公开，
  带 `magpie-plugin` 标签，`magpie plugin add xiaoqi0102/opencode-agentrouter-shim` 可直接装。

三条路，可同时走：

1. **npm**：`npm publish` 后，`插件 → 发现` 的搜索按包名、简介或发布者就能找到，卡片显示 npm 发布者、不带社区标记。
   必要项已就位：`keywords: ["opencode","opencode-plugin","agentrouter","magpie",…]`、`main`/`exports`、
   `magpie.{name,icon,summary,hooks,options}`、MIT + 上游版权声明。`npm pack --dry-run` 出 8 个文件、约 17 kB
   （`test/` 不进包）。
2. **GitHub topic `magpie-plugin`**：仓库根放 `package.json`，加载的文件必须提交进仓库（本包没有构建产物，
   `index.mjs`/`hooks.mjs`/`src/` 就是源码，符合"按仓库当前代码安装"）。若同时发布到 npm 且 `repository`
   指向该仓库，则从 npm 装。
3. **社区仓库 PR**：`magpie-community/plugins` 的 `registry.json` 加一项
   `{"package","name","icon","providers","summary"}`；中间件/路由类写 `"kind": "middleware"`（不写 `providers`）。
   若直接放进 `packages/<name>`，包名按类型取 `@magpie-community/opencode-<name>-auth`（供应商）或
   `@magpie-community/middleware-<name>`（中间件）。

发布前还差两件事（都不是代码问题）：

* **npm 登录**：`npm whoami` 在本机是 `ENEEDAUTH`，`npm publish` 前要 `npm login`。
* **归类确认**：本包同时是供应商插件和网关钩子。文档只给了 `kind: middleware/tools/page/agent`，没写
  `*.hooks.js` 单独归到哪一组——提 PR 时选 `middleware` 或问一句 Discord 即可。供应商卡片那半靠
  `declareProvider`，默认 `true`，市场用户装上就能登录使用；你这种"已有供应商"的场景设 `false`。

发布时的两条行为约定（已实现，写在这里供审阅者看）：

* 钩子默认只作用于 `agentrouter`（`hookProviders`），不会去动用户其他供应商的 Responses 流量；
* `sharp` 是 `optionalDependencies`：装不上只降级为"跳过图片压缩"，不阻塞加载；钩子在 1 秒预算内跑完，
  超时就原样放过。

## 选项

在「插件 → 已安装 → 选项」里编辑 JSON，或（插件名是本目录名 `plugin-agentrouter-shim`）：

```powershell
# PowerShell 会把 JSON 里的双引号吃掉，交给 cmd 执行即可
cmd /c 'magpie.exe plugin options plugin-agentrouter-shim "{\"imageMode\":\"off\",\"logStats\":true}"'
magpie plugin options plugin-agentrouter-shim          # 读回
magpie plugin options plugin-agentrouter-shim off      # 恢复包里的默认值
```

`package.json` 的 `magpie.options` 只是"建议值"：没设置时显示在选项框里，但插件运行时用的是
`normalizeOptions` 里的 `DEFAULTS`。

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `serverUrl` | `https://agentrouter.org/v1` | 上游基地址；`auth.metadata.serverUrl` 可按账号覆盖 |
| `apiStyle` | `responses` | `responses` 用 `@ai-sdk/openai`（`POST /responses`，清理生效）；`chat` 用 chat completions（清理自动变成空操作） |
| `models` | 空 | `{"<model id>": {"name"?, "limit"?, "capabilities"?}}`，或 `["id", ...]`；同名条目优先于 `/models` 发现结果 |
| `modelAllow` / `modelDeny` | 空 | 对发现到的 id 做子串或 `/正则/` 过滤 |
| `modelApi` | 空 | `{"gpt-4o":"chat","/^o1/":"chat"}`：单个模型改走 chat completions |
| `discoverModels` | `true` | 关掉后只用 `models` 里的列表 |
| `declareProvider` | `true` | 设 `false` 进入"只过滤"模式：不声明供应商、不留卡片，由 `hooks.mjs` 干活 |
| `hookProviders` | `["agentrouter"]` | 钩子只对这些供应商生效（按模型 id 的 `供应商/` 前缀判断，`agentrouter-plugin` 也匹配）；`[]` 表示所有供应商 |
| `imageMode` | `lossy` | `off` / `lossless` / `lossy` |
| `imageQuality` | `90` | 1..100，仅 `lossy` |
| `imageCacheBytes` | `67108864` | 图片 LRU 预算，`0` 关闭，上限 512 MiB（也可写 `imageCacheMiB`） |
| `strict` | `false` | `true` 时对 `previous_response_id` / `conversation` / 加密 compaction / item_reference 直接回 400，而不是原样透传 |
| `logStats` | `false` | 把每次改写的计数写进 magpie 日志（只记数字，不记内容） |

非法取值会退回默认值并在日志里写一条 `warn`，不会让插件加载失败。

## 和原包的分工

| 原 shim | 这里 |
| --- | --- |
| 监听 `127.0.0.1:18080`、反向代理、`/healthz` | 不需要，magpie 自己就是网关 |
| gzip/deflate/br/zstd 请求解压、`--max-body`、`--timeout` | 不需要，`init.body` 是明文 JSON |
| Upgrade 请求回 426 | 不需要，magpie 只走 HTTP/SSE |
| 不重试、不跟重定向 | magpie 自带跨账号 / 跨模型故障切换 |
| `--mode passthrough` 手动作对照 | 换成 `magpie provider test` + 直接把 `imageMode` 设成 `off` |
| `--log-usage` 记 token | 交给 magpie 自己的用量与配额视图 |
| 本地端口 Key 透传 / 校验 | 换成 `auth.methods: [{type:"api"}]` + `loader`，key 存在 `plugin-auth.json` |

## 已知限制

* **第一次用插件要等 magpie 的内置 Bun 就绪。** 宿主没跑起来时 `magpie plugin` 会提示
  `Bun runtime not ready: downloading Bun`；本机这次是下载卡住，改用 `MAGPIE_BUN=<本机 bun.exe>`
  指向已有的 Bun 1.4.4 才把宿主拉起来。正常网络下等它下完即可。
* **sharp 可能装不上。** magpie 安装依赖时**不跑 install 脚本**。sharp 0.33 起靠
  `optionalDependencies` 预编译包（`@img/sharp-win32-x64` 等），多数平台能成；失败时插件**照常工作**，
  只是跳过图片压缩并记一条 `warn`（`skipped_no_encoder`）。不想冒险就 `imageMode: "off"`。
  此时它仍然是纯 JS、零依赖。
* **只清理 Responses 请求。** `apiStyle: "chat"` 或 chat completions 路径下没有 `input` 数组可清，
  插件原样转发（这也是上游 shim 的行为边界）。
* **reasoning item 是否真的出现在插件拿到的 body 里，取决于 magpie 的协议转换。** agent 与供应商都走
  Responses 时通常原样带过去；被 magpie 改写过的历史可能已经是清理过的形态，此时清理动作是空操作。
* **改图会让 prompt cache 失效。** 首次从 PNG 切到 WebP，或改 `imageQuality`，历史图片的字节变了，
  上游缓存命中率会掉；上游 shim 也有同样的提示。
* **不做用量 / 签到。** AgentRouter 的额度接口没有公开文档，这里不乱猜。

## 验证过的点

* `node --test`：11/11 通过（清理、strict 400、fetch 改写、路径白名单、图片、模型发现、选项兜底、`modelApi`）。
* **Bun 1.4.4 实跑**：插件模块加载正常；`sharp@0.35.5` 在该运行时下可用，240×240 PNG 的
  data URL 经插件压成 WebP，2318 → 595 字节；`/responses` 请求体被清理并去掉 `content-length`，
  无需清理的请求体逐字节原样转发。
* **magpie 0.1.4341 宿主实装**：`magpie plugin add` 成功，宿主加载插件并注册出
  `agentrouter-plugin (AgentRouter, 5 models)`，`magpie plugin options … '{…}'` 的设置 / 读回 / `off`
  恢复都正常；`declareProvider: false` 后同一入口只剩 `async gateway hook  onRequest`，不再有供应商卡片。

没有验证到的：真实 AgentRouter API key 下的端到端回话（手上没有 key）。这一步需要
`magpie plugin login agentrouter` + `magpie provider test agentrouter`。

## 测试

```powershell
cd D:\Apps\magpie\plugin-agentrouter-shim
node --test        # 11 个用例
```

## 许可

MIT。`src/sanitize.mjs` 与 `src/images.mjs` 来自 `agentrouter-responses-shim` 2.1.0
（Copyright (c) 2026 stevenarai），保留原许可声明。
