# opencode-catpaw-tools-auth

妙手（CatPaw，美团）的 magpie / OpenCode provider 插件。**支持工具调用**，所以能作为编程 Agent 的后端。

与社区插件 `@magpie-community/opencode-catpaw-auth` 的区别：那个用**提示词协议**假装工具调用——把工具定义塞进系统指令，要求模型在正文里回 `{"tool_calls":[…]}` 再解析出来。模型一走神就断，拿不到真正的 `finish_reason: tool_calls`，也拿不到流式增量。这个插件走妙手自己的 **Agent 协议**（`toolConfigs` → `tool_use` 帧 → `tool_result`），工具调用是协议层原生的：服务端决定调哪个工具，客户端执行，结果回传。

图标用的是妙手官方的标记，两个位置各管一处：`auth.icon` 落在 provider 行上，magpie 会把它缓存到 `~/.config/magpie/icons/`；`package.json` 里 `"magpie": { "icon": … }` 管 Discover 卡片，缺了会画成一个拼图块。两处是同一张图的同一串 base64，`index.test.mjs` 有一条断言盯着它们不许走散。要换图，改这两处——magpie 认 `https://` URL 或 `data:` URI，上限 1 MB。

图不是直接把原图塞进去的，做了一步处理：**把四个角裁圆**。magpie 里的插件图标都是圆角方块（它缓存里那几百个图标的圆角半径都在宽度的 19%–22% 之间），一张方方正正的图放进去会在圆角图标中间戳出一块直角砖头。所以这张图按宽度的 22% 做了圆角遮罩、缩到 256×256、编成带 alpha 的 WebP：

```
原图  https://s3plus.meituan.net/mcopilot-pub/nocode_image/default/CatPaw%20IDE_插件用户群头像-2o575boimy0e2qt8bg07nf02ad5q71.jpg
      480×480 JPEG · 18946 字节 · sha256 10bd758cd113e3b2b14c3d9b4f709a14db06369380e6db737ec913e66c59558b
图标  256×256 WebP(alpha) · 9300 字节 · 圆角半径 22%
```

内联而不是直接写那个 URL，是为了让图标不依赖 CDN：仓库自带一份，离线也能画出来，URL 以后失效也不影响已装好的插件。用 WebP 而不是 PNG 是因为同一张图 PNG 要 54 KB、WebP 只要 9 KB，而它要在 `index.mjs` 和 `package.json` 里各存一份。

## 安装

这个包没有发到 npm，装的就是这个仓库本身：

```bash
magpie plugin add github:gu-gavin/magpie-catpaw-tools
magpie plugin login catpaw-tools     # 选 1，用本机妙手客户端的登录态
magpie provider test catpaw-tools
```

也可以在 Plugins → Discover → **Unofficial, on GitHub** 里直接点装（仓库打了 `magpie-plugin` 标签，magpie 最多每十分钟刷新一次列表）。

装好之后模型是 `catpaw-tools/<model>`，可以直接给任何 Agent 用：

```bash
magpie claude catpaw-tools/longcat-2.5
```

## 登录方式

| 方式 | 说明 |
|---|---|
| 妙手桌面端登录态（推荐） | 实时读本机的 `auth.json`，每次请求前校验 mtime。在妙手里重新登录后无需重启 magpie |
| 网页登录 | 走妙手官方授权页，插件用 poll-token 通道取回登录态，不需要桌面端 |
| 手动粘贴 token | 粘贴 `auth.json` 里的 `auth.accessToken`，或把同一个值放进环境变量 `CATPAW_TOKEN`（优先级最高） |

桌面端登录态在哪个文件，按妙手自己的规则算出来——它是 VS Code 系的应用（产品配置里 `applicationName: catpaw-moon`、`dataFolderName: .meituan-catpaw`），所以数据目录跟着那一族走，而不是放在安装目录里：

| 系统 | 路径 |
|---|---|
| macOS / Linux | `~/.meituan-catpaw/auth.json` |
| Windows | `%APPDATA%\.meituan-catpaw\auth.json` |

程序装了在别处也不用改代码，四个环境变量任一都能指过去（前两个是本插件的，后两个是为了兼容另一个 catpaw 插件已经写下的配置）：

```bash
CATPAW_AUTH_PATH=/abs/path/auth.json     # 直接给文件
CATPAW_DATA_DIR=/abs/path/data           # 给目录，取里面的 auth.json
MEITUAN_AUTH_PATH=…  MEITUAN_DATA_DIR=…  # 同上，兼容名
CATPAW_TOKEN=<accessToken>               # 干脆不要文件，直接给 token（优先级最高）
```

`CATPAW_TOKEN` 的用处：桌面端没登录、但手上有个 accessToken 时不用伪造 `auth.json`。注意它会**盖过**其它所有登录方式，设了就一直用这个值，直到 token 过期。

**没有续期接口。** token 失效会返回 401；用桌面端登录态的话，在妙手里重新登录即可自动恢复。

## 模型

**模型列表是问接口要的，不是写死的。** `provider.models` 每次登录后按账号调一次 `POST /api/agent/maas/model-types`，把妙手此刻提供的模型交给 magpie，所以妙手加新模型不用等插件发版：

```bash
magpie provider models catpaw-tools
# ✓ 12 models from catpaw-tools … fetched just now
```

结果缓存 5 分钟。接口挂了、超时或登录态过期时，magpie 保留上一次的列表（插件返回 `provider.models` 原样，不抛错）；表里那些 id 还会被折叠进 live 列表，所以列表永远不为空。

下面这张表是打底用的：它给出接口不给的 `context`/`output`/`reasoning`，也是 `provider.models` 取不到时的兜底。倍率和免费标记以接口为准。

| id | 模型 | modelType | 官方倍率 | 上下文 |
|---|---|---|---|---|
| `longcat-2.5` | LongCat-2.5 | 107 | 限时免费 | 1M |
| `longcat-2.0` | LongCat-2.0 | 77 | 免费 | 1M |
| `glm-5.3` | GLM-5.3 | 89 | 0.59 | 1M |
| `glm-5.3-flash` | GLM-5.3-Flash | 91 | 0.06 | 1M |
| `glm-5.3-flashx` | GLM-5.3-FlashX | 98 | 0.16 | 1M |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | 97 | 0.06 | 1M |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 64 | 0.48 | 1M |
| `minimax-m3.1-flash` | MiniMax-M3.1-Flash | 10002518 | 0.05 | 1M |
| `minimax-m3` | MiniMax-M3 | 70 | 0.22 | 1M |
| `kimi-k3.1-pro` | Kimi-K3.1-Pro | 10002533 | 0.61 | 1M |
| `kimi-k3` | Kimi-K3 | 83 | 0.94 | 1M |
| `auto` | 妙手自动选择 | 0 | — | 1M |

`modelType` 和倍率来自 `POST /api/agent/maas/model-types`（body `{tenant:"CatDesk", scene:"CATX_APP", env:"EXTERNAL"}`，2026-11-05 实取，2026-11-25 复核），并逐个跑通对话验证过，不是猜的。**妙手会重新编号**：LongCat-2.5 从 `10002544` 改成了 `107`（旧号仍可用）。所以插件优先用接口给的值，表里的只是接口取不到时的兜底。上下文长度取自 models.dev 上同一模型家族的公开规格——妙手自己没发布 per-model 窗口，所以这些是模型本身的能力，不是编造的数字。接口里出现、表里没有的新模型会照原样上架（用接口给的 modelType），只是拿不到这几项规格，先按老模型的形状走。`supportImage` 决定 `configModel` 是否声明 `image` 输入。

## 限流

妙手对建会话有频率限制，撞上会返回 429。正确的反应是**停下来**——原地重试只会把窗口续期，越重试等得越久。

插件的行为：撞到 429 就开一个冷却窗口（默认 45 秒），窗口内的请求本地直接回 `HTTP 429` + `Retry-After`，不再往上打。流式的响应头已经发出去了，改不了状态码，所以在 SSE 里给一条错误帧。`CATPAW_RATE_LIMIT_MS` 可以改这个时长。

**实测边界**：本插件用的 `/api/agent/conversation/round`（Agent 接口）在 7.5 秒内连开 15 个新会话，15/15 全是 200，**没有触发限流**（2026-11-05）。45 秒这个数借自另一个 catpaw 插件在 `/api/chat/create`（网页接口）上的实测（约 41 秒），不是这条通路上量出来的。

那为什么还要留这段：`round` 的返回值原来是**被丢掉的**。万一它真回 429，插件会当成成功继续去拉流，最后给客户端一段**空回答**——比直接报错难查得多。现在这条路会明确告诉你「等 N 秒」。

## 额度

`magpie quota` 显示可用积分。接口是 `GET https://catx.nocode.cn/api/gateway/credit/balance`，鉴权头是 `X-Auth-Token`。

> ⚠️ 这个接口和对话网关**用的不是同一个鉴权头**。对话用 `Cookie: X-Passport-Token`，余额用 `X-Auth-Token`。把 cookie 发到余额接口会稳定 401（body `code 4010`），而 magpie 会把 usage 的 401 当成"登录失效"，账号会被错误标记为已退出。插件已经处理了这个差异。

## 错误码

所有失败都经同一个映射（`stepError`）出口，无论它发生在 `round`、`turn` 还是流式帧里：

| 上游情况 | 插件返回 |
|---|---|
| 妙手说余额不足（不一定是 402，通常只是一句带 markdown 链接的普通错误文本） | `402` + `insufficient_quota`，`error.code = "insufficient_credits"`，并给 `help_url` 和 `upstream_message` |
| 登录态失效（401，或本地没有 `auth.json`） | `401` + `authentication_error` + 响应头 `X-Magpie-Sign-In: expired`，让宿主停止重试并提示重新登录 |
| 429 | `429` + `rate_limit_error` + `Retry-After`（见上一节） |
| 其余 | 上游的 4xx 原样透出，5xx 与网络错误归为 `502` + `api_error` |

首轮的 `round` 会用自己的信封报登录失效（`{"code":401,"msg":"passport auth failed: 请重新登录"}`）。这一条单独识别，不然会被折成 502 让宿主一直重试。

额度门有时不以错误帧出现，而是**以 assistant 正文下发**（帧里不带 `model` 字段，真模型的帧一定带）。插件按"帧无 model + 文本命中余额关键词"识别它，转成 402 而不是把它当成正常回答。

流式时响应头已经发出去了，改不了状态码，所以同样的错误会以 SSE 帧内的 `error`（带 `type`/`code`）给出。

## 工具调用

这是本插件的主要目的。实测流程：

```
1. 客户端上传 toolConfigs（Agent 的工具定义）
2. 服务端返回 tool_use 帧，指名要调哪个工具、参数是什么
3. 客户端在本地执行，回传 tool_result
4. 服务端把结果喂回模型，模型据此继续
```

### 关键细节：`enable` 字段

`toolConfigs` 的每一项必须带 `enable: true`，否则服务端**静默忽略整条定义**，模型会回答"我没有这个工具"。这是最容易踩的坑——现有那个插件就是因为缺这个字段，才得出了"协议不支持工具"的错误结论。

还要带 `fromClient: true`，告诉服务端这个工具由客户端执行。

### 关键细节：服务端自带工具是关不掉的

妙手服务端有自己的工具集（`read_file`、`bash`、`web_search`、`Agent` 等 29 个），跑在美团自己的沙箱里。即使你一个工具都不传，服务端也会自己调 `read_file`/`list_dir`——而 magpie 收到一个自己不会执行的工具调用就是死路。

插件会把知道的服务端工具名以 `enable: false` 一起发过去，但**实测这并不能真的禁用它们**（2026-11-05 对照实验：把 `read_file` 写成 `enable: false` 并要求用它，模型照调不误）。所以这是尽力而为，不是保证。

实际泄漏率很低：用 6 个拟真客户端工具跑 6 个 prompt，6 次都调了客户端工具、0 次泄漏。泄漏基本只在 prompt **显式点名**服务端工具名时发生（比如"用 read_file 读…"）。给 Agent 的工具起名避开上面那 29 个名字，就不会撞上。

### 关键细节：SSE 是累积式的

每一帧带的是"到目前为止的完整文本"，不是增量。`toolParams` 也一样，分片到达：

```
'{"text": ' → '{"text": "hel' → '{"text": "hello"}'
```

插件按 `toolCallId` 聚合并做差分，转成 OpenAI 的 delta。

### 关键细节：一轮可以有多个工具调用

同一轮里模型会一次要调好几个工具（"读 a.txt 和 b.txt" → 2 个 `tool_use`，各自的 `toolCallId`）。流式输出给每个 `toolCallId` 分配递增的 `index`，非流式则把 `tool_calls` 全部返回——只留最后一个会让 Agent 丢掉一半的活。

### 关键细节：多轮会话

同一个对话复用 `conversationId`，服务端会保留历史，所以每轮只发新消息（不是整个 message 列表，否则会重复）。

调用顺序也有讲究：

- **首轮**：`round` → `event` → `turn`
- **后续轮**：直接 `turn`（既不 `round` 也不 `event`）

`round` 只在会话的**第一轮**成功。之后服务端一直认为这个会话"正在执行中"，任何后续 `round` 都回 `unifyCode: 1004010010 / "会话正在执行中，无法创建新轮次"`——等 90 秒、发 `turn-end`、换 `messageId` 都不解开。但**单独的 `turn` 照样能跑，消息也照样入库**（实测历史里每条都在）。所以插件只在 `fresh` 时发 `round`，之后直接拉流；`round` 的返回值也不再被忽略（真回 429/402 会如实报错）。

## 图片

请求里带图片（`image_url`，`data:` URI 或 http(s) 链接）时，插件先把图片上传到妙手的 S3，再把链接作为 `image_url` part 挂到**这一轮的 `turn` 消息**上。不需要妙手桌面端，也不需要本地服务。

实测形状（2026-11-25，LongCat-2.5）：

```jsonc
{ "type": "user", "messageId": "<新 id>", "finished": true,
  "content": [
    { "type": "text", "text": "这张图里有什么？" },
    { "type": "image_url", "imageUrl": { "url": "https://s3plus.meituan.net/..." } }
  ] }
```

几个必须踩对的点，错一个模型就说"没有看到图片"：

- **part 类型是 `image_url`，`imageUrl` 是对象 `{url}`**。写成 `{type:"image", imageUrl:{url}}`、`imageUrl` 传字符串、或者把 url 放进 `image.source`，JSON 都能过，但模型收不到图。
- **URL 必须是 http(s)**。`data:` URI 放在 `imageUrl.url` 里同样会被丢掉，所以先上传（`POST {PASSPORT_BASE}/api/gateway/v1/s3/upload-image`，头 `X-Auth-Token`、`content-type: text/plain`，body 是纯 base64）。
- **图片挂在 `turn` 上，`round` 只发文本**。图片 part 放进 `round` 会被存进历史，但服务端拼 prompt 时只带文本。
- **`turn` 的 `messageId` 必须是新的**。沿用 `round` 那个 id 时，服务端按已存的 round 重建消息，图片被抹掉。

多轮追问不用重发图片：服务端历史里已经有了，直接问"中间那条是什么颜色"能答对。图片也可以出现在第 2 轮以后（首轮纯文本、次轮才发图），一条消息里放多张图也没问题。

## 限制

- **无 token 用量统计**。妙手协议的 SSE 帧不返回 token 数，所以 `usage` 字段填 0。要计量请用 `magpie quota` 看积分。
- 依赖妙手桌面端登录态，属于私有协议；客户端升级可能失效。
- 只服务 `/chat/completions`。其他入口由 magpie 自己转换（实测 `/v1/messages` 也能正常工作）。
- 模型要支持图片（`configModel` 的 `modalities.input` 会据此声明）。LongCat-2.5、LongCat-2.0、GLM-5.3-Flash/FlashX、DeepSeek-V4.1-Flash、MiniMax-M3、Kimi-K3/K3.1-Pro 实测支持；GLM-5.3、DeepSeek-V4-Pro、MiniMax-M3.1-Flash、Auto 不支持。
- **后续轮的 `round` 一律失败**（见上文「多轮会话」）。插件已经绕开，但它意味着历史里不会有 round 记录，只有消息本身；依赖 `roundInfoList` 的功能（妙手客户端的轮次视图）看不到这些轮。

## 测试

```bash
bun test        # 45 个单元测试，不触网
```

端到端验证过（真实账号，LongCat-2.5）：纯对话、工具调用、工具结果回传、流式 tool_calls 聚合、多轮记忆、未知模型、不同模型、Anthropic 协议入口；图片（云端 turn 通道，流式与非流式、多轮追问、后续轮才发图、一条消息两张图、图片与工具调用同轮）用绿/黄/黑三色竖条图与左红右蓝图验证模型确实读到了图。

## 许可与免责

MIT。

这个插件通过模拟妙手桌面客户端的私有协议工作，不是官方 API。**使用可能违反妙手的服务条款**，尤其是把账号额度分享给其他人时。自行判断风险。协议细节来自对本机客户端抓包和逆向，随客户端升级可能失效。

`m-appkey`、`x-agent-version`、`permissionMode: unsafeBypassPermissions` 这些值都是从官方客户端抓来的，不是我发明的——但也不代表美团认可这种用法。
