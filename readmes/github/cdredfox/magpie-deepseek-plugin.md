# magpie-deepseek-web

把 **DeepSeek 网页版**（chat.deepseek.com）代理成 magpie 的一个供应商：在 magpie 里登录一次，所有智能体就能像调用普通 API 一样用网页版的模型，多账号、故障切换、用量显示都由 magpie 接管。

## 安装

```shell
magpie plugin add /path/to/magpie-deepseek-web
magpie plugin login deepseek-web
```

应用里：插件 → 添加插件 → 填入本文件夹路径 → 在 DeepSeek 网页版那一行点登录。

## 登录（获取 userToken）

插件用的是网页版自己的会话 token，不是官方 API key：

1. 浏览器打开 [chat.deepseek.com](https://chat.deepseek.com) 并登录；
2. 按 F12 打开开发者工具，进「控制台」，执行：

   ```js
   JSON.parse(localStorage.getItem("userToken")).value
   ```

3. 复制输出的那串 token（64 位），粘贴进 magpie 的登录框。插件会当场校验（读取账号信息），通过后以邮箱/手机号命名账号。

粘贴容错：带 `Bearer ` 前缀、带引号、或直接粘贴整段 `{"value":"…","__version":"0"}` JSON 都能识别。

token 等同于你的账号登录凭据，只保存在本机 magpie 的 `plugin-auth.json`（权限 600）里；只发往 `chat.deepseek.com`。可以登录多个账号做故障切换。网页版 token 没有公开的有效期，失效时账号会被标记（请求返回 401 + 登录引导），重新粘贴一次即可。

## 模型

| 模型 | 说明 |
| --- | --- |
| `deepseek-web/deepseek-chat` | 网页版快速模式（思考关闭） |
| `deepseek-web/deepseek-reasoner` | 深度思考（输出 `reasoning_content`） |
| `deepseek-web/deepseek-search` | 联网搜索（搜索引用混进正文） |
| `deepseek-web/deepseek-reasoner-search` | 深度思考 + 联网搜索 |

全部按免费（`free: true`）声明，不占套餐额度统计。上下文按网页版实测上限声明（约 1M token / 262 万字符）。

## 图片与附件

请求里带图片内容（OpenAI 的 `image_url` part）时，插件会把图片上传到 DeepSeek 网页版（走它自己的 PoW 鉴权与文件解析流程），再把文件 ID 填进 `chat/completion` 的 `ref_file_ids`，并切到 `model_type: "vision"` 的视觉后端——模型真正"看图"，不是靠占位文本。

- 图片来源支持 `data:` URL（base64 直传）与 `http(s)` URL（服务器侧代为下载）；**按内容哈希去重**：同账号下相同图片不重复上传（上游实测 file-ID 可跨会话引用），缓存上限 64 个。
- 限制：单次最多 8 张、单文件 10MiB、总 32MiB；解析轮询到 `SUCCESS` 才提交对话，`audit_result` 审核拒绝单独报错。
- 非图片附件没有标准格式，插件支持扩展 part `{ type: "file", filename, file_data: "data:…;base64,…" }`，上传后同样通过 `ref_file_ids` 引用（不带图时保持 `default` 后端）。
- 上传失败会显式报 502（模型看不见图就会胡编，不静默降级）；图片错误不会把账号标记为失效。
- 上传的文件会留在 DeepSeek 账号的文件列表里：接口层没有找到删除端点，插件不清理；解析通常 2-3 秒完成。

## 工作原理

网页版没有公开 API，插件直接走它的网页协议（2026-10 实测）：

1. `POST /api/v0/chat_session/create` 建会话（开启会话复用时按对话缓存，见下）；
2. `POST /api/v0/chat/create_pow_challenge` 拿 PoW 挑战，用 DeepSeek 官方网页自带的 `sha3_wasm_bg.wasm`（已随插件打包）在本地解出 nonce，组装 `x-ds-pow-response` 头（求解前有 0-300ms 随机抖动，打破匀速自动化节奏）；
3. `POST /api/v0/chat/completion`（SSE）发出 prompt，把网页版的分片事件流（THINK/RESPONSE fragment 补丁）转成 OpenAI chat completions 的流式增量；`event: ready` 帧里的 `response_message_id` 被记录下来作为下一轮的 `parent_message_id`；
4. 回答结束后删除临时会话（开启会话复用时保留至 TTL）。

鉴权只需要 `Authorization: Bearer <userToken>`；PoW 是唯一的服务端强制校验。所有请求都带完整浏览器头（UA/Origin/Referer/Sec-Ch-Ua/X-Client-* 等）。

### 超长历史：自动转存附件

单条 prompt 太长会触发上游限流甚至失败。网页版自己的做法是"超长粘贴转附件"，插件同样如此：当拍平后的历史超过 token 预算且需要新建会话时，最老的轮次被打包成 `对话历史存档.md` 上传（`ref_file_ids` 引用，按内容哈希去重），prompt 只保留近期对话并注明"历史见附件"——**记忆不丢、prompt 变小**。复用中的会话不重复上传（前缀已在服务端会话里）。

### 多轮对话与会话复用

网页版接口只接受一条 `prompt`。插件把 OpenAI 的 `messages` 拍平成"记录前缀 + 回复规则"两段，并按账号缓存最近 4 个对话的会话：

- 新请求的记录是缓存的**延伸**（agent 类客户端每轮重发全历史）→ 只发**新增尾部 + 回复规则**，用 `parent_message_id` 串接上游会话。agent 循环的输入吞吐从"每轮全量几万 token"降为"每轮几百 token"，这是避免触发上游限流的关键（全量重发同一会话在上游眼里是二次增长式刷屏）；
- 完全相同（客户端重试）→ 原样重发；
- 发散（编辑历史/新对话）→ 新建会话，绝不从消息内容推断身份；
- 会话 TTL 30 分钟，超龄/被挤出/发散失败时自动删除（`keepSessions: true` 则全部保留）。

`sessionReuse: false` 可回到"每轮新建、用完即删"的模式。

### 工具调用（DSML 文本协议桥接）

网页版模型没有原生的工具调用能力，插件用 DSML 格式桥接（与 DeepSeek 原生特殊 token 同风格，参考 ds2api/freeapi/web2api 项目）：

- 请求里带 `tools` 时，插件把工具清单写进 prompt，并教模型输出：

  ```
  <|DSML|tool_calls>
    <|DSML|invoke name="bash">
      <|DSML|parameter name="command"><![CDATA[ls -la]]></|DSML|parameter>
    </|DSML|invoke>
  </|DSML|tool_calls>
  ```

  字符串值一律用 CDATA 包裹——命令、代码、嵌套 JSON 零转义，这是比 JSON 块可靠的核心。`tool_choice` 的 `required`/命名函数会追加强制指令。
- 流式筛分器（StreamSieve）实时把回答里的调用块剥成 OpenAI `tool_calls`（`finish_reason: "tool_calls"`）：容忍任意分包（含逐字符）、剥离围栏、CDATA 当原子处理、未闭合自动修复、loose JSON 修复、同名参数合并、CamelCase 工具名归一化、1MiB 缓冲硬顶；解析失败降级为正文，永不静默丢内容。
- 历史 tool_calls 以同样的 DSML 格式回写 prompt，模型始终见到自洽的格式。
- prompt 里同时明确铁律：**严禁编造工具的返回结果**——模型曾照着对话记录的格式自己"表演"整个工具循环（连命令输出都是编的），这个坑已经堵上。

### 错误分级与自动重试

上游的几类失败都会伪装成"成功但空"，插件逐一识别并分级处置：

| 信号 | 识别 | 处置 |
| --- | --- | --- |
| 限流 | SSE `event: hint`，`finish_reason=rate_limit_reached`（"消息发送过于频繁"） | 退避 5s→15s 换新会话重试，耗尽后报错 |
| 账号禁言 | JSON 200，`biz_code 5`/"user is muted" | 立即 429，不重试（magpie 可故障切换） |
| toast/hint 其他错误 | `event: toast` / hint type=error | 显式报错，不重试 |
| 真空流 | 200 + 零事件 | 换新会话重试（默认 3 次），耗尽后 502/error 事件 |

另外：上游连接在提前结束时会**读干净再归还**，避免污染 keep-alive 连接产生后续空响应；限流/空回答不会污染账号状态。

## 限制

- **工具调用是桥接的，不是原生的**：模型偶尔会输出不合协议的调用块（该次调用降级为正文），复杂智能体任务的成功率低于原生工具调用模型，跑偏时重试通常即可。
- **图片走视觉后端**：带图请求的 `model_type` 固定为 `vision`，与网页版"图片消息"行为一致；单次最多 8 张。
- **突发限流仍有窗口**：上游按账号做突发限流，爆发窗可持续 1-2 分钟。插件的分级重试能扛住短冷却，长爆发窗仍会显式报错——根治办法是给供应商多登录一个 DeepSeek 账号（magpie 在账号间分摊），或调低智能体的循环频率。
- **会话复用的隐私权衡**：开启（默认）后上游会话保留 30 分钟且不在网页版历史里删除，同账号下两个"开头完全相同的对话"理论上可能串上下文（插件只按前缀延伸判定，风险极窄）；介意就 `sessionReuse: false`。
- **用量是近似值**：网页版只提供会话累计 token（`accumulated_token_usage`），拆不出输入/输出，插件只填 `usage.total_tokens`。
- **速率**：每个账号并发默认 2（并发过高会触发禁言）；被限流时 magpie 会按厂商回答做故障切换。
- **协议风险**：非官方接口，DeepSeek 改版（尤其是 PoW 算法或 wasm 文件名）后需要更新插件。

## 选项

在 `magpie plugin options magpie-deepseek-web '<json>'`（或应用里插件那一行的选项按钮）设置：

```json
{
  "keepSessions": false,
  "search": false,
  "sessionReuse": true,
  "maxContextTokens": 900000,
  "toolResultLimit": 0,
  "retryAttempts": 3,
  "retryBackoffMs": 1500,
  "rateLimitRetryDelays": [5000, 15000],
  "jitterMs": 300
}
```

- `keepSessions`：`true` 时保留所有会话（能在网页版历史里看到），默认用完即删（复用模式下按 TTL）。
- `search`：`true` 时允许网页版联网搜索；也可直接选 `deepseek-search` 模型。
- `sessionReuse`：会话复用 + 增量提示，默认开。关闭则每轮新建会话、全量重发、用完即删。
- `maxContextTokens`：拍平记录的 token 预算，默认 900000（1M 留余量）。超预算时**最老轮次打包成文本附件**（`对话历史存档.md`，走 `ref_file_ids` 引用——对应网页版"超长粘贴自动转附件"的官方行为），prompt 只保留近期对话，历史不丢失。
- `toolResultLimit`：工具结果截断长度（字符），0 = 不截断（默认）。长工具输出撑爆上下文时可设置。
- `retryAttempts`：空回答重试次数（每次换新会话），默认 3；1 = 关闭。
- `retryBackoffMs`：空回答退避基数（毫秒），线性放大，默认 1500。
- `rateLimitRetryDelays`：限流重试的退避序列（毫秒），默认 `[5000, 15000]`，空数组关闭。
- `jitterMs`：每次 PoW 前的随机抖动上限（毫秒），默认 300，0 关闭。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 插件入口：供应商声明、登录、请求流程、会话复用、错误分级重试 |
| `lib.mjs` | 纯函数：messages 拍平（DSML 工具协议、上下文裁剪）、图片/附件提取、SSE 转写（hint/ready 事件）、流式筛分器（StreamSieve）、泄漏清理 |
| `pow.mjs` | PoW 求解器（加载并调用官方 wasm） |
| `sha3_wasm_bg.wasm` | DeepSeek 网页版自带的 sha3 wasm（`fe-static.deepseek.com` 原样拷贝） |
| `test.mjs` | 单元测试（bun test.mjs）：拍平/裁剪、DSML 解析与筛分、SSE 转写、会话复用、错误分级与鉴权映射 |

测试过的环境：magpie 0.1.2283（插件宿主 Bun 1.4.4）、44 项单元测试（桩 fetch 全链路），真模型端到端：DSML 工具调用往返、会话复用增量（同会话 + parent 链 + 第二轮只发增量）、图片识图。
