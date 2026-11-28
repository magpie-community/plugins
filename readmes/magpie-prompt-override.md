# Magpie 网关提示词替换

把经过本网关的请求，发给上游模型的系统提示词，换成你自己的一套。
默认对每一个 Agent、每一个模型、每一个上游一律统一；填了「作用范围」之后，
就只对指定的那一个供应商与模型生效。

## 安装与首次使用

1. 安装本插件，打开插件页。
2. **选模式**。第一次建议用「追加」——它保留原提示词，只把你的接在后面。
   链路确认通了、也确认你的提示词真的进模型了，再切「整体替换」。
3. 选人格预设，或直接手写提示词。
4. 勾选「启用提示词处理」，点「保存设置」。

默认关闭。启用前必须填写提示词（「清空」模式除外）。

预设内容可在编辑框继续修改；切换预设不会自动保存，要自己点保存。

## 作用范围：单一供应商 + 单一模型

插件原本对网关里**每一个**请求一律替换。现在可以收窄到一组供应商与模型：

| 字段 | 空 | 有值 |
| --- | --- | --- |
| `target_provider` | 不限供应商 | 只对名字对得上的供应商生效 |
| `target_model` | 不限模型 | 只对模型名对得上的请求生效 |

两个条件是 AND：都填就都要对上，填一个就只管那一个。

- **不区分大小写**。
- `target_model` 结尾带 `*` 是**前缀匹配**：`kimi-k3*` 命中 `workbuddy/kimi-k3.1-pro`。
- **模型 id 是 `<provider>/<model>` 形式**，网关上就是长这样：

  ```
  codex/gpt-6.2-sol
  workbuddy/deepseek-v4.1-flash
  raccoon/sn-deepseek-v4-1-flash-1017
  ```

  填**短名**（`gpt-6.2-sol`）和填**全串**（`codex/gpt-6.2-sol`）都算命中。
- 模型名从请求体的 `model` 取；Gemini 把模型名放在 URL 上，body 里没有，这时退回 `ctx.model`。
- 供应商名**优先从 `ctx` 取**。`ctx` 上这个字段没有正式契约，中间件按候选表逐个试：
  `provider` / `provider_name` / `providerName` / `provider_id` / `upstream` /
  `upstream_name` / `upstreamName` / `upstream_id` / `channel` / `channel_name` /
  `channelName` / `route` / `route_name` / `vendor`，值可以是字符串或 `{name,id,slug}`
  对象；再不行就看 `ctx.request` 与 `ctx.meta` 里的同名字段。
- **`ctx` 取不到时，用模型 id 斜杠前那段作供应商**（`codex/gpt-6.2-sol` → `codex`）。
  这才是最可靠的信息源，不必依赖 `ctx` 有没有那个字段。
- 两个来源都拿不到才**不替换**（fail-closed）。拿不到供应商名还硬替换，等于把
  别的渠道的提示词一起换掉——那比「这次没生效」难查得多。

范围外的请求一个字节都不动，连协议都不识别。

## 模式

| 模式 | 选项值 | 效果 | 提示缓存 |
| --- | --- | --- | --- |
| 整体替换（默认） | `replace` | 原系统提示词整段丢掉，只留你的 | 失效 |
| 追加 | `append` | 保留原提示词，你的接在后面 | 仍有效 |
| 前置 | `prepend` | 你的放在原提示词前面 | 失效（上游每轮重读整段） |
| 清空 | `strip` | 把原提示词删掉，什么都不加 | 失效 |

页面上选模式即可。手改 `plugins.json` 时用上面「选项值」那一列的字符串。

## 清理客户端自带的人格规则

WorkBuddy 这类客户端不把身份与行为规则放在 `system` 字段，而是塞进第一条
user 消息里：一部分是 `<system-reminder>` 块，一部分是直接写在正文的
`<product_identity>` / `<tone_and_style>` 顶层标签。

只换 `system` 字段是不够的——那套旧规则照样进模型，两套规则并存，
看起来就像「提示词替换没生效」。

开启「清理客户端自带的人格规则」后，插件会移除这些**行为类**区块：

- `<product_identity>`（身份）
- `<tone_and_style>`（语气）

**保留不动**的：

- `<system-reminder data-role="user-context">` —— 用户资料、SOUL / IDENTITY / OS 信息
- `<system-reminder data-role="additional-data">` —— 文件引用、当前时间、附件
- `<system-reminder data-role="craft_mode">`
- `<project_context>` / `<connector-status>` —— 工作目录结构与连接器状态。
  这些是事实信息不是行为规则，删了模型会丢掉工作区和可用能力。

`user-context` 块内部如果混进了行为标签，标签照样会被清掉，块本身保留。

只有「整体替换」模式会动 user 消息；追加 / 前置 / 清空不动。

### 选项

插件的配置写在 magpie 的 `plugins.json` 里，全部字段如下：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | 布尔 | `false` | 总开关。关着时中间件完全不介入 |
| `target_provider` | 字符串 | `""` | 只对这个供应商生效。空 = 全部 |
| `target_model` | 字符串 | `""` | 只对这个模型生效。空 = 全部，结尾 `*` 当前缀匹配 |
| `system_prompt` | 字符串 | `""` | 你自己的系统提示词。除「清空」模式外必须非空 |
| `mode` | 字符串 | `"replace"` | 处理方式，见上面的模式表 |
| `replace_reminders` | 布尔 / 字符串 | `true` | 是否清理客户端自带的人格规则，见下 |
| `preset_id` | 字符串 | `""` | 当前选用的人格预设 id，页面用来回显选中项 |

`enabled` 写成 `"true"` / `1` / `"on"` 也能识别——手改配置时不必纠结引号。
`mode` 写了不认识的值按 `replace` 处理。

`replace_reminders` 控制清理的粒度：

| 值 | 效果 |
| --- | --- |
| `true`（默认） | 只清行为类区块，环境类保留 |
| `"all"` | 连环境类一起清 |
| `false` | 完全不动 user 消息，只换 `system` 字段 |

页面上有对应开关。手改 `plugins.json` 设的值，保存时会被保留，不会被冲掉。

### 清理的粒度

只删**行为区块本身**，不连提醒块里的其它内容一起删。
客户端经常把行为标签和真正的上下文放进同一个 `<system-reminder>` 里，
整块丢掉会连带丢掉用户资料、工作目录、附件引用——那比不清理更糟。

块里清干净之后如果什么都不剩，这个块才会被整个删掉。

## 协议支持

Anthropic `/v1/messages`（含 `?beta=true` 与 `/v1/messages/count_tokens`）、
OpenAI `/v1/chat/completions`、`/v1/responses`，以及 Gemini 的
`systemInstruction` / `system_instruction`。

- Anthropic：改 `system`
- Chat：改首条 `system` / `developer` 消息，其余同类消息删除
- Responses：改 `instructions`，并清掉 `input` 里的 `system` / `developer` 指令项
- Gemini：改 `systemInstruction`，原来用哪个字段名就继续用哪个

协议由请求体形状识别，不完全依赖 magpie 传的 `ctx.protocol`：
有顶层 `system` 字段是 Anthropic，有 `instructions` / `input` 是 Responses，
有 `systemInstruction` / `contents` 是 Gemini，消息里带 `system` / `developer`
角色是 Chat。形状定不下来时才退回 `ctx.protocol`（`claude` / `openai-chat` 等
别名都认），两者都定不下来就不改动——宁可不换，也不能把请求改坏。

不支持的模型接口、原生透传、WebSocket、压缩请求体、无法安全识别的请求结构
及超过 8 MiB 的请求体会被**严格入口代理**拒绝；Responses 服务端历史引用也会被拒绝。
后台页面、插件设置和模型列表仍可使用。

## 边界与限制

- 严格入口代理单独部署，**仅安装本插件不会启用代理的强制保护**。
- 该代理无法控制 Magpie 内部发起的辅助调用、服务端已保存的历史状态，
  或上游供应商追加的指令。不应声称最终所有上游指令都被替换。
- 原有系统提示词可能包含工具调用指令，替换后客户端行为可能改变。
  Claude Code、Codex 这类客户端尤其明显——先用「追加」确认链路再整体替换。
- 清理 user 消息时若某条消息被清空到没有内容，该消息会被移除；
  但如果整段对话清空后就没有任何用户消息了，会保留原文——
  上游会因为「没有用户消息」直接 400，那比留着一条提醒块更糟。
- **改不动就原样放行**：请求体被冻结（不可变结构）、字段类型异常、
  或出现没预料到的结构时，中间件不会抛异常把请求搞崩，
  而是这一次不替换。宁可让用户看到「提示词没生效」还能自查，
  也不能让整个请求失败。
- 客户端把标签写错了（没闭合、写成自闭合 `<tone_and_style/>`）也能降级处理。
  没闭合时只清到下一个空行——客户端的注入块之间用空行分隔，
  用户真正的正文在空行之后，不会被误删。

## 开发

```sh
npm test        # 跑全部测试
npm run build   # 改完 page/style.css 或 index.src.html 后重新生成 index.html
npm run check   # 构建 + 测试
```

`npm test` 覆盖中间件逻辑、页面交互、人格库数据、打包完整性、配置一致性与可访问性。
改了 `page/style.css` 或 `page/index.src.html` 之后一定要跑 `npm run build`——
测试会校验 `page/index.html` 与源文件**逐字一致**，
改了源文件忘了重新生成，页面跑的仍是旧版，用户看到的是「改了没反应」。

配套的严格入口代理使用 `go test ./...` 验证。

## 已知问题

插件页面的资源若偶发取不到，外链样式会让整页失去样式，因此样式已内嵌进
`page/index.html`。桥接脚本没加载时页面会明确提示刷新并停用按钮；脚本完全
没跑起来时，纯 CSS 会在 2.5 秒后显示提示。

Magpie 要求插件页在 10 秒内向窗口报到。`page/boot.js` 只要加载成功就立即
报到，并在 9 秒内每 400 毫秒重发一次，直到窗口回话（窗口对重复报到幂等）。

仍未覆盖的一种情况：整页文件都没取到时脚本根本不会执行，插件内无法自救，
只能点重试或重开页面——那是 Magpie 自身在安装瞬间的页面注册竞争。
