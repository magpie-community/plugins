# kimi-chat

`kimi.com` 网页版 Kimi Chat → OpenAI Chat Completions / Responses 的 **magpie 原生 provider 插件**。
用你自己 kimi.com 账号的会员额度对话：不用官方 API key，也不是 Kimi Code / Kimi API 的转发。

- 供应商 id：`kimi-chat`（客户端里写作 `kimi-chat/kimi-fast` 这样）
- 上游：`https://www.kimi.com/apiv2`（connect-rpc over protobuf，私协议，见 [PROTOCOL.md](PROTOCOL.md)）
- 能力：流式对话、思考档、联网搜索 + 引用、客户端工具调用（`tools`，工具手册压缩）、Kimi 网页端技能适配（如 `kimi-widget` 组件卡片，附 `html-card` 渲染事件）、生成式 UI 事件、月额度与费用估算、token 用量（估算，见下）
- 当前版本：**0.6.1**（变更见 [CHANGELOG.md](CHANGELOG.md)）；Node ≥ 20.3，无运行时依赖，纯 ESM

## 安装

```bash
# 方式一：直接从 GitHub 装当前代码（不用等 npm 发布）
magpie plugin add github:paceyw/kimi-chat

# 方式二：桌面端「插件 → 发现」里点安装
# 本仓库打了 magpie-plugin topic，会出现在「非官方插件 · GitHub」列表里

# 方式三：npm 发布之后
magpie plugin add kimi-chat
```

装好后供应商列表里出现 **Kimi Chat (Web)**（id `kimi-chat`），点「添加账号」就进入登录流程（见下一节）。

装完可以三条命令自检，都通过再往下走：

```bash
magpie plugin list                        # 应列出 kimi-chat，7 models
magpie provider test kimi-chat kimi-fast  # 应打印 ✓ chat <毫秒>
magpie quota                              # 应出现「月额度」窗口与剩余百分比
```

> 插件是纯 ESM，没有构建步骤；从 GitHub 装时用的是仓库当前代码，所以本机不需要 `npm install`。
>
> 注意 spec 要带来源前缀：`github:paceyw/kimi-chat`（或 GitHub 仓库链接）。若把 `plugins.json` 里的 spec 写成裸包名
> `kimi-chat` 而 npm 上还没有这个包，magpie 重启时会因解析不到而把这条 spec 丢掉，插件就从列表里消失了。
>
> 如果 magpie 提示 “Kimi Chat (Web) is signed in but not offered: You removed it from magpie”，那是上面这种情况留下的
> 「已移除」标记，跑一次 `magpie provider add kimi-chat` 就能恢复，**登录状态不会丢**。

## 它登录什么

登录的是**你在 kimi.com 的网页账号**（同一份会员/订阅额度，也就是网页里聊天消耗的那个月额度）。
插件不做账号池、不做多人共享、不代注册；一个 magpie 账号 = 一个 Kimi 账号。

## 怎么登录

### 方式 A：网页登录 + 短信验证码（推荐）

1. magpie → 供应商 `kimi-chat` → 添加账号，选 **“手机验证码登录（推荐）”**，填手机号（带国家码，例如 `86 13800138000`）。
2. magpie 会打开 <https://www.kimi.com/login>。如果 Kimi 允许插件直接发码，短信会立刻到你手机；如果它要求人机验证（常见），就在刚打开的页面里走一遍「登录 → 手机号 → 发送验证码」，把码发出来。
3. 回到 magpie，填你收到的 6 位验证码。

插件拿这 6 位码当场换取会话令牌（`access_token` + `refresh_token`），**不需要你复制任何 token**；账号归属（`accountId`）取自令牌，不用填 ID。magpie 弹窗里的说明与上面这几步一致，写成一个自然段、用 `① ② ③ ④` 编号（弹窗正文是普通段落，换行会被折叠，写不出一行一步）。

### 方式 B：粘贴 `refresh_token`（备用）

上面的验证码方式走不通时（换号、收不到短信、号码不在支持地区），可以选 **“高级：粘贴网页 refresh_token（备用）”**：

1. magpie 打开 <https://www.kimi.com/login>，在页面里正常登录。
2. DevTools（F12）→ **Application → Local Storage → `https://www.kimi.com`** → 复制 `refresh_token` 的值；
   或直接在 **Console** 里执行

   ```js
   copy(localStorage.getItem('refresh_token'))
   ```

3. 粘贴回 magpie。插件会立刻用它换新的 `access_token`：换成功才存，401（已登出/值不对）当场报错，不会留下几分钟后就失效的坏凭据。

弹窗里的说明同理是一个自然段（`①`–`④`）：复制的动作在 DevTools 里「右键 → Copy value」完成，**不需要从弹窗文字里选中任何东西来复制**。

只粘 `refresh_token` 一个值就够：`access_token` 由插件自己换，设备指纹（device/session id）由插件本地生成。

> 为什么没有「扫码」和「一键自动回传」：扫码方式的确认页是微信专用入口，桌面浏览器无法完成；而 kimi.com 的网页登录没有对第三方开放的回调通道，令牌只会落在浏览器本地存储里，插件读不到——Kimi Code 那套 OAuth 设备授权虽然能自动换 token，但签发的是 `scope=kimi-code` 的令牌，网页聊天接口不认（实测 401，见 `PROTOCOL.md` §6.3）。所以能在「不复制 token」前提下工作的最短路径就是上面的验证码方式。

## 登录信息存在哪里

全部只存在本机 magpie 的配置目录里，插件不上传、不写日志：

| 位置 | 内容 |
|---|---|
| `plugin-auth.json`（macOS 默认 `~/Library/Application Support/magpie/`，Linux `~/.config/magpie/`，Docker 部署是 `/config/magpie/`；设置了 `XDG_CONFIG_HOME` 时以它为准；权限 600） | `kimi-chat` 条目：`{type:"oauth", refresh:"<整份凭据 JSON>", access:"", expires:0, accountId:"<userId>"}` |
| 上面 `refresh` 字段里的 JSON | `accessToken`、`refreshToken`、`userId`、`webId`、`ssid`、`timezone` |
| 同目录的 `plugin-providers.json` | 只放供应商/模型/登录状态等元数据，**不含令牌** |

凭据是明文文件（与 magpie 其它插件一致），所以按普通密钥对待：别提交到仓库、别贴到公开 issue。
想换账号：再登录一次即可（`accountId` 相同会替换旧账号）；想彻底撤销：在 kimi.com 网页里登出，再删掉 `plugin-auth.json` 里的 `kimi-chat` 条目。

## 凭证生命周期

- `refresh_token` 是长期凭据，`access_token` 只有约 15 分钟寿命。
- 插件在每次请求前按需刷新（magpie `auth.refresh`），请求中途遇到 401 也会刷新一次并继续那一轮，所以正常使用不需要你重新登录。
- 只有上游明确拒绝（登出 / refresh_token 失效）才判定“需要重新登录”，网络抖动不会被当成分手。

## 请求走到哪里

- 对话：`POST https://www.kimi.com/apiv2/kimi.chatty.ChatService/Chat`（流式，connect 协议）
- 模型清单：`ConfigService/GetAvailableModels`；刷新令牌：`https://auth.kimi.com/.../AuthService/RefreshToken`
- 额度：`MembershipService/GetSubscription` + `GetSubscriptionStats` + `ListBalanceActions`
- 只对 `www.kimi.com` 与 `auth.kimi.com` 发请求；不跟重定向，不把令牌发到别的主机。

## 模型

模型清单**按上游实际返回动态生成**（`GetAvailableModels`，缓存 10 分钟），并始终保留三个稳定入口：

| 入口 | 上游 | 思考档 | 说明 |
|---|---|---|---|
| `kimi-fast` | Instant（`scenario=CHAT`） | 低 / 高 | 日常对话，最省额度 |
| `kimi-thinking` | Agent 模型 + `thinking=true` | 低 / 高 / 最高 | 思考输出 → `reasoning_content` |
| `kimi-agent` | Agent（`scenario=OK_COMPUTER`）+ 插件能力 | 低 / 高 / 最高 | 联网、工具、时间线 |
| `kimi-<slug>` | 上游返回的其它模型（如 K3.1 Pro / K2.8 Preview） | 低 / 高 / 最高 | 由 `display_name` 派生，不覆盖上面三档 |

思考档通过 `reasoning_effort` 传：`low`/`medium`/`high`/`xhigh`/`max`（=3/4/5/6/7）或直接给数字。插件按该模型真实支持的档位夹取：落在两档之间的（如 `medium`=4）取最近的一档，并列取高档；超过上界夹到上界；低于下界（`minimal` 及以下）视为“不要思考”，不发这个字段。Instant 只有低(3)/高(5)，其余模型三档齐全。
**给了档位就会把上游的思考打开**：Instant 的「思考」和服务端联网搜索是同一个开关——思考关着时，上游不会给这次请求挂 `web_search` 工具（即使请求里显式要求联网），模型也就只能回答“我没有实时数据”。所以想让快速档联网，就传一个思考档；不想思考就不要传。
注意：magpie 的「推理档（variants）」取自它自己的 models.dev 目录，插件能上报的只有 `reasoning` 布尔，所以 `kimi-chat/*` 在 `/v1/models` 里的 `supported_reasoning_levels` 是空数组——档位要由客户端在请求里显式传 `reasoning_effort`（`provider/model` 的写法照常用）。

一个已登录账号通常能看到 7 个入口（随上游返回变化，缓存 10 分钟）。「网页里叫」是 Chat 前端模型菜单里的名字：

| 入口 | 网页里叫 | 上游 id / 场景 | 思考档 | 估算单价 ¥/1M（入/出） |
|---|---|---|---|---|
| `kimi-fast` | 快速（Instant） | `k28-instant`，CHAT(1) | 低 / 高 | 2 / 8 |
| `kimi-k28-instant` | 快速（Instant 动态入口） | `k28-instant`，CHAT(1) | 低 / 高 | 2 / 8 |
| `kimi-thinking` | 思考（K3 + thinking） | `k3-agent`，OK_COMPUTER(6) | 低 / 高 / 最高（默认高） | 8 / 32 |
| `kimi-agent` | Agent | `k3-agent`，OK_COMPUTER(6) + 插件能力 | 低 / 高 / 最高 | 8 / 32 |
| `kimi-k3d1-agent` | K3.1 Pro | `k3d1-agent`，OK_COMPUTER(6) | 低 / 高 / 最高 | 8 / 32 |
| `kimi-k2d8-preview` | K2.8（Work 里叫 K2.8 Preview） | `k2d8-preview`，OK_COMPUTER(6) | 低 / 高 / 最高 | 4 / 16 |
| `kimi-k3` | K3 | `k3`，OK_COMPUTER(6) | 低 / 高 / 最高 | 8 / 32 |

其它固定事实（实测，见 PROTOCOL.md §12）：

- **对话长度**：**默认不支持选择**，固定用标准档（L）。超长上下文会让单次请求的消耗成倍上涨，而且几乎没有客户端能传这个额外参数；需要时可在服务端用 `KIMI_MAX_CONTEXT_LENGTH` 调高上限（取决于账号权限）。
- **速度**：**默认不支持选择**，固定用上游的 FAST 档（请求枚举 5）。更快的档位与更高消耗绑定、且只有部分模型提供，客户端也很少能传这个参数，所以不做开关。
- **客户端工具**：不是上游一等能力，但插件支持：把请求里的 `tools` 渲染成提示词里的工具手册，再把模型输出的 `<tool_call>` 还原成 OpenAI `tool_calls`（`finish_reason: "tool_calls"`），能力位因此报 `toolcall: true`。工具多的时候手册会自动压缩（见下节）。复杂工具流建议用 Agent 档。
- **联网搜索**：默认开启，搜索结果以 `search-results` UI 事件 + `annotations` 引用返回；`search_enabled: false` 可关。注意上面那条：快速档要先开思考，服务端才会真的挂 `web_search`。
- **标题类请求**：客户端发来「给会话起标题」的请求（system 里带 `Create a concise title…`）时，插件自动关掉思考与联网搜索——这类请求不需要工具，开着只是白花额度；同一个 magpie 会话的标题请求还会复用同一个上游 chat，不会在 Kimi 网页里变成一串多余的「会话」。
- **空回答补偿**：上游偶尔会在思考后直接停下（`finish=stop`、正文为空、没有工具调用）。插件会自动在同一会话里把「请直接给出最终答复」再说一遍、重问一次；第二次的思考不重复推给客户端。第二次仍为空才把空结果交回去。
  这类请求客户端自己也会重试（实测某客户端重发一次、prompt 多 8 个 token），插件先补一次等于替客户端省掉一轮完整费用。
- **生成式 UI**：搜索/引用/时间线/产物以 `agent-timeline`、`citation-list`、`preview-card` 等白名单组件的事件流输出（Agent UI Protocol v1），未适配的客户端只看到文本 + 工具调用。

### 工具手册压缩

真实编码客户端一次能声明 **300+ 个工具**。把这些工具的完整 JSON schema 塞进提示词是笔冤枉钱，也更容易让模型把不存在的工具名一起“脑补”出来（真机见过：模型坚持要先 `read` 一个根本没声明的 `SKILL.md`）。

默认渲染是「一行一个工具」：

```
- fs_read(path*:str, offset:int, limit:int): Read an existing file before overwriting it with write.
- web_search(queries*:arr): Search the web for up-to-date information.
```

`*` 标必填，`str/int/bool/arr/obj` 是 JSON 类型，`+N` 表示还有 N 个参数没列，`"a"|"b"` 是枚举；说明只保留**第一句**（去掉各家客户端 `Calling convention:` 之后的样板）。超出预算时按阶梯整体缩短说明（160 → 120 → 96 → 72 → 56 → 40 字），仍放不下才从最长的行开始退到“只有名字”。**工具名永远不会被丢掉**——预算只是软目标，名字消失等于工具不存在。

真机对照（DSH 声明 305 个工具）：

| 渲染方式 | 字符数 | 说明 |
|---|---|---|
| 完整 JSON schema | 330,230 | 约 8 万 token |
| 一行一工具（默认预算 48k） | 45,381 | 约 1.2 万 token，7 倍压缩，每个工具仍有 72 字说明 |
| 一行一工具（`KIMI_TOOLS_MAX_CHARS=0`） | 57,870 | 每个工具保留完整的第一句 |
| 完整 JSON schema（`KIMI_TOOLS_MODE=full`） | 330,230 | 旧行为，仅排查兼容问题时用 |

可调：`KIMI_TOOLS_MAX_CHARS=0` 关掉预算；`KIMI_TOOLS_MODE=full` 回到完整 schema（默认 `compact`）。

真机验证（网关 `127.0.0.1:3425`，`kimi-chat/kimi-fast` + `reasoning_effort=low`）：

- 305 个工具 + 一句「只回四个字」：`http 200`，带 `usage` 的 `prompt_tokens` 只有 **11,385**（整段提示词，旧渲染约 9 万）；模型照常回答。
- 两步工具循环：第 1 步模型发出 `get_weather({"city":"北京","unit":"c"})`（`finish_reason=tool_calls`），把结果按 `role:"tool"` 回填后第 2 步给出「北京今天当前气温为 **16℃**…」——紧凑手册没有破坏参数格式与多步收尾。

### 网页端技能适配（`kimi-widget` 之类）

Kimi 的网页/桌面容器里挂着 `/app/.agents/skills/<name>/SKILL.md`。模型在那边遇到「做个组件卡片」会先 `read` 一下 `kimi-widget` 的规范再动手；换到我们这个 OpenAI 兼容通道里，那个路径**不存在**（实测报 `FS_NOT_FOUND`），而失败之后模型经常顺着这条错思路继续想，最后只吐思考、不吐正文。

所以插件在两种情况下往提示词前面加一段校正（`src/skills.mjs`）：

- 提示词里出现 Kimi 容器路径（`/app/.agents/skills/` 或 `/app/skills/`）或 `kimi-widget`：明确告诉模型「这里不是 Kimi 容器，没有那个目录，别为了读规范去调工具」；调用方自己声明的工具（含它自己的技能工具）照常可用。触发条件只认这些真实路径——DSH 的真实请求里 `SKILL.md` 出现 0 次，只有模型自己脑补时才会出现，所以别家的「读 SKILL.md」约定不会被误伤；
- 最后一条用户消息像是要「卡片 / 组件 / 看板 / widget」，且客户端**没有**提供 `show_widget` / `render_widget` / `artifact` 这类工具：附上 `kimi-widget` 的等价做法——直接输出一段内联样式的自包含 HTML，先把数据查好再一次性出卡片，卡片外最多一句说明。

客户端自己就有 widget/artifact 渲染工具时只保留第一条，免得跟真正的渲染能力打架。`KIMI_WEB_SKILLS=0` 可关掉整段注入。

真机验证（就是会话 `session-72ea02fe…` 里那句导致空白回答的原话「你好，今天是几号，北京天气如何，请用一个组件卡片展示」）：0.4.3 会先 `read("/app/.agents/skills/kimi-widget/SKILL.md")` → `FS_NOT_FOUND` → 第二轮只吐思考、正文为空；0.5.0 同一个问句直接给出 **2,249 字符的内联样式 HTML 卡片**（含真实天气 16℃/1℃ 与 `[2][10]` 引用），全程没有出现任何 `/app` 路径或 `SKILL.md`。

### 卡片在客户端怎么渲染

模型产出的卡片是**正文里的自包含 HTML**（0.5.0 起）。对不做 HTML 渲染的客户端，那就只是一段源码；所以 0.6.1 额外下发一帧 Agent UI Protocol 事件，让宿主把它渲染成真正的卡片：

```json
{"v":1,"surfaceId":"card","itemId":"card","seq":2,"op":"create","component":"html-card",
 "props":{"html":"<section style=\"padding:20px\">…</section>","title":"北京天气","text":"北京今天晴。"}}
```

- 信封：`tool_calls[]` 里的 `kimi_ui__render`（`component` 为 `html-card`），正文**保持原样**继续流式输出；
- 时机：正文之后、`finish_reason` 之前；`finish_reason` 仍是 `stop`——卡片不是工具调用，宿主不该因此进入工具循环；
- `props`：`html`（必填，原样、未清洗）、`title`（从 `<h1~h3>`/`<title>` 抽的纯文本）、`text`（卡片外那句说明）、`height`（可选）；
- 工具轮（`finish_reason: "tool_calls"`）不产卡片帧。

宿主渲染要点（**安全**）：HTML 是模型输出，必须当不可信内容处理。仓库里有一份零依赖的宿主适配实现可以直接抄/直接用：[examples/html-card-renderer.js](examples/html-card-renderer.js)（`parseCardEnvelope` / `findCardEnvelopes` / `cardSrcDoc` / `renderHtmlCard`），下面是最小示意——

```js
// 最小参考实现：沙箱 iframe + srcdoc，脚本与网络一律不许出
const iframe = document.createElement("iframe")
iframe.setAttribute("sandbox", "allow-same-origin") // 不要加 allow-scripts / allow-top-navigation
iframe.setAttribute("referrerpolicy", "no-referrer")
iframe.style.cssText = "width:100%;border:0;border-radius:16px"
const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
iframe.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + csp + '"><body style="margin:0">' + props.html + "</body>"
document.body.append(iframe)
iframe.addEventListener("load", () => {              // 自适应高度
  iframe.style.height = iframe.contentDocument.documentElement.scrollHeight + "px"
})
```

接线只要三步：① 流里出现名为 `kimi_ui__render` / `kimi_ui__patch` 的 function call 时**不要执行**（它是信封，不是真工具）；② `findCardEnvelopes(calls)` 取出卡片事件；③ `renderHtmlCard(container, props)` 挂上去。也可以把它降级成纯文本（直接显示 `props.html`）或丢弃；未知组件按协议应当退回文本摘要，不要整条消息失败。

## 用量与费用

`auth.usage` 只返回**月额度**一项（不含 5 小时 / 每周滚动窗口，那两个是限流器内部计数，展示出来只会误导）：已用百分比、套餐名（从订阅接口取，如 `<plan name>`）、到期时间，以及本机的会话映射条数。
换算口径：月额度 100% = 你所用套餐的价格（环境变量 `KIMI_PLAN_CNY`，默认 199，不同套餐/地区请自行设置）→ 按 199 计 1% ≈ ¥1.99；每模型单价写在 `src/models.mjs` 的 `DEFAULT_PRICING`（¥ / 1M tokens，由额度百分比反推的估算价），作为 magpie 的 `cost` 回传。

### token 用量（估算）

上游的 Chat 流**不返回 token 计数**（`ChatResponse.usage` 只有一个联网搜索配额对象，不是 token），所以插件按文本估算：

- 流式请求带 `stream_options:{include_usage:true}` 时，在 `data: [DONE]` 之前多发一帧 `choices: []` + `usage`（OpenAI 的标准收尾帧，magpie 就是靠它记账）；
- 非流式响应直接带 `usage`；
- 口径：CJK 逐字约 1 token，其它字符约 4 字符 1 token；`completion_tokens_details.reasoning_tokens` 单独给出思考部分的估算；
- `prompt_tokens_details.cached_tokens` 恒为 `0` —— 上游没有缓存命中计数，不编造。

因此 magpie `quota` / 客户端里看到的 token 与价格是**量级正确的估算**，不是上游账单；真正的花费请以 magpie 的月额度百分比为准。

## 不包含

- 不是官方 Kimi API / Kimi Code：没有官方 API 的稳定性承诺，私协议变动会同步更新到 [PROTOCOL.md](PROTOCOL.md)。
- 不做图片/文件多模态上传（网页侧未验证），不做多人共享账号池，不做代理池。
- 不保证并发：网页账号的并发能力有限，`magpie.maxConcurrency` 保守设为 2。
- 不默认启用“超长上下文”与“更快的速度档”（消耗大、客户端支持少，见上面的固定事实）。

## 开发与验证

```bash
npm run check     # 16 个源文件语法检查
npm test          # 单元测试（16 个文件 / 143 条，全部离线：假 transport，不需要登录、不打真实网络）
```

测试覆盖：wire 级 protobuf 编解码、Chat 流解析、工具调用标记切分与手册压缩（含预算降级、300 工具语料）、网页端技能适配注入、登录输入解析（含中文提示文案）、模型目录映射、思考档夹取、token 估算、逐帧取证、空回答补偿重试、标题会话复用、用量换算、UI 事件信封、多轮会话映射。
CI 在 Node 20 / 22 / 24 上跑同一套（`.github/workflows/test.yml`）。本地不需要 `npm install`（零依赖），也不需要登录 Kimi。

### 抓一份逐帧日志（可选）

想在出问题时看到上游到底回了什么，可以打开取证开关（默认关闭，只写文件，不影响对话）：

```bash
KIMI_TRACE=1 magpie provider test kimi-chat kimi-fast        # → <tmpdir>/kimi-chat-traces/<时间戳>.jsonl
KIMI_TRACE=/tmp/kimi-trace.jsonl magpie provider test kimi-chat kimi-fast
```

文件里是 `request` 摘要（model / scenario / thinking / reasoningEffort / speed / prompt 长度）、
每一帧 `ChatResponse` 原文、末尾一条 `end`（状态、正文字数、思考字数、引用数）。
令牌、Cookie、Authorization 头从不写入。

两点提示：

- `provider test` 只等到第一个 token 就取消，所以它的日志通常没有 `end` 行；要完整日志就发一次真实对话（客户端里问一句即可）。
- magpie 在容器里时，环境变量会传给插件进程，把日志指到挂载目录再取出来就行：

  ```bash
  docker exec -e KIMI_TRACE=/config/magpie/kimi-trace.jsonl magpie /usr/local/bin/magpie provider test kimi-chat kimi-fast
  ```

协议事实表（端点 / proto / 认证头 / 参数刻度 / 错误码 / 待验证项）见 [PROTOCOL.md](PROTOCOL.md)。

## 许可

MIT（见 [LICENSE](LICENSE)）。`src/qrcode-generator.mjs` 是 Kazuhiko Arase 的 MIT 版二维码生成器，原样保留，
版权与许可声明见文件头与 [THIRD_PARTY.md](THIRD_PARTY.md)。

本项目与 Kimi / 月之暗面无关，也未获其背书；使用它意味着你用自己的账号、按自己的会员条款使用该服务。
