# magpie-mimo2api

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![author](https://img.shields.io/badge/author-Sliverkiss-8A2BE2)](https://github.com/Sliverkiss)
[![magpie](https://img.shields.io/badge/magpie-插件-00ADD8)](https://usemagpie.ai)

[magpie](https://usemagpie.ai) / OpenCode 供应商插件：把小米 MiMo Studio（aistudio.xiaomimimo.com）的网页账号变成一个 OpenAI 兼容的供应商，所有 agent 可用。改写自 [Sliverkiss/0xCost](https://github.com/Sliverkiss/0xCost/tree/mimo2api)（mimo2api 分支）的 Go 网关，按 magpie 插件协议重新实现。

## 功能

- **对话**：OpenAI Chat Completions（流式 / 非流式），多轮对话经 `previousDialogueId` 链接到同一个上游会话回放；系统提示词拼进首条 query
- **深度思考**：reasoning 以 `reasoning_content`（流式为 `delta.reasoning_content`）返回，react 通道原生字段 + v2 通道 `spark` 标记拆分均支持
- **图片理解**：`image_url`（http(s) / data URL）→ 上传 `resource/genUploadInfo` → `resource/parse` → `multiMedias` 附带发送
- **联网检索引用**：上游 `web_search` 事件转成 `citations` 扩展块（流式在 stop 前单独一个 chunk，非流式在响应体顶层）
- **联网搜索 API**：向 magpie 的搜索 API 列表（Tavily / Brave 那一列）贡献一个「MiMo Studio 联网搜索」条目，免 key、绑定本插件的已登录账号（见下）
- **模型目录**：以账号自己的 `bot/config` 为唯一事实来源（`provider.models` 钩子按账号列出；`redirectTo` 的被替代 id 不展示）
- **多账号**：magpie 原生多账号；会话过期自动续期（passToken → serviceLogin → STS 链），passToken 失效（70016）回退密码重登
- **用量**：会话健康 + 模型数展示在账号卡片（`auth.usage`）；上游 `usage` 事件有则透传，缺失时按 ~4 字符/token 自算补齐（额度展示用途，非计费数据）
- **账号导入**：支持从 mimo2api 部署的 Upstash/Redis 账号库直接导入（`mimo2api:accounts:*` 键格式）

## 登录方式

唯一方式：**手机号 + 密码**。完整 passport 链（serviceLoginAuth2 → STS）；若上游触发新设备风控（短信/邮箱验证码），会自动进入验证码两段式——验证码发出后按提示输入收到的码即可继续完成登录（10 分钟内有效，填错会显示上游原话原因，可重试）。

登录实现遵循 magpie 宿主的实际契约（对其二进制内嵌插件宿主反编译确认）：`authorize()` 的返回值一律被宿主存入会话并随后自行调用 `callback()`，因此 authorize 永不返回终态对象——成功包成 `{ callback }` 由宿主调用，失败直接 `throw`（宿主展示原话），风控两段式走 `{ instructions, method: "code", callback(code) }`。续期时的密码重登会回放已保存的设备指纹（deviceId 等），降低再次触发风控的概率。

登录信息由 magpie 保存在 `plugin-auth.json`（权限 600）；插件自身不落盘任何凭据。账号里会保留 phone/password（`metadata`）与设备指纹（`device`），供会话过期时透明重登。

## 使用

```bash
magpie plugin add ./mimo2api        # 文件夹就地加载
magpie plugin login mimo            # 输入手机号+密码；风控时按提示输入验证码
magpie provider test mimo           # 试一发
magpie quota                        # 会话状态
```

agent 侧以 `mimo/mimo-v2.6-flash`、`mimo/mimo-v2.6-pro` 等引用模型；`auto` 与 `-studio` 后缀自动归一。

## 联网搜索 API

插件的 `search` 钩子向 magpie 的搜索 API 列表贡献一条 **MiMo Studio 联网搜索**（Settings → 搜索 里选）。它和对话共用同一批账号：

- **免 key**：条目写的是 `auth: "mimo"`，magpie 自己挑一个开着的账号、到期先续期，再通过 `ctx.getAuth()` 交给插件——所以搜完不会去动其他账号，也不会跟 chat 抢续期（同一个账号共用一份内存态、同一个单飞 promise）
- **每次搜索 = 一次对话轮次 + 一份上下文**：Studio 网页侧没有独立的搜索接口，搜索就是一次 `webSearchStatus: "auto"` 的对话，结果取上游沿途发出的 `web_search` 事件（模型正在看的那些页面），回答正文丢弃。**这就是代价，别当免费**
- **`auto` 由上游决定搜不搜**：模型觉得不用查就径直回答，此时返回空列表——不是错误
- **每次搜索一个新会话**：不带 `conversationId`、不带 `previousDialogueId`，上一次搜的内容不会漏进下一次
- **去重**：同一 URL 只出一页（首个标题为准）；`count` 默认 6、上限 20（跟 magpie 文档的「1 to 20, 6 by default」对齐）
- **只给 title + url**：上游的 snippet 在这里填进了 `text`，但 magpie 的 `plugin.SearchPage` 只有 `title` / `url` / `page_age` 三个字段，没有 `text`——摘要在插件边界上被静默丢弃。消费者（模型的引用块）拿到的只有标题和链接，别指望有摘要
- **失败不吞**：账号被上游拒（401）时抛出的错误带 `status: 401`，magpie 据此让**该账号在搜索上**休息（不影响它的模型）；繁忙（`503`）、内容过滤、上游 5xx 原话上抛

## 请求识别说明

- 插件**不开任何端口**：对外服务是 magpie 网关自身的职责（`/v1/chat/completions`、`/v1/models`），插件只被 magpie 调用。loader（npm `@ai-sdk/openai-compatible`）收到的唯一流量是 magpie 转发来的 Chat Completions POST（字符串 body），fetch 直接翻成上游对话
- 这是 **web 反代**：上游对话就是网页会话本身，**上下文约 50k**（模型卡标注的百万上下文对网页链路无效），多轮经 `previousDialogueId` 在同一会话内回放
- **不支持工具调用**：`tool_call: false`；带 `tools` 的请求上游会按普通对话回答
- **参数对齐**：`temperature` / `top_p` 透传上游；`reasoning_effort` 映射为思考开关（`none`/`off` 关思考，其余档位开思考——上游只有布尔强度）；`max_tokens`/`stop`/`presence_penalty`/`frequency_penalty`/`seed`/`logit_bias` 上游无对应字段，静默忽略
- 模型条目上标了 `searches: true`（「这条模型自己会联网」）：magpie 把搜索请求直接交给它，而不是先自己搜一遍再喂过来。**别删这个字段**——不写不报错，只是搜索能力静默消失
- 模型列表由 `provider.models` 钩子（按账号目录）供出，网关的 `/v1/models` 由 magpie 汇总应答——插件不做 HTTP 层的 `/models`
- 上游只有两个存活通道：非 ultraspeed 模型走 `POST /open-apis/react/chat`（v3），`*ultraspeed*` 模型走 `POST /fastchat/open-apis/bot/chat`；每个 POST 带 `?xiaomichatbot_ph=`… 查询参数 + Cookie
- 上游 429/5xx 原样透传给 magpie 网关做故障切换；401 映射为登录过期标记（`signIn: "expired"`）

## 测试

```bash
bun test        # 89 个单元测试：SSE 解析、think 拆分、turn 规划、登录/OTP/续期链（mock passport）、网关转换、搜索钩子（citations→pages、count 裁剪、会话过期错误形态）、插件级登录契约
```

另有针对真实上游的端到端验证脚本（validate / catalog / chat / 多轮记忆 / 图片理解 / 续期后可用性）在开发期人工执行通过。

## 许可

MIT。仅供学习研究；请遵守小米 MiMo Studio 的服务条款。
