# ChatSEU 网页版 (东南大学 chatseu.seu.edu.cn)

**这不是东南大学的模型 API**，而是学校部署的模型聊天网页 ChatSEU，按网页自己的方式调用。文本、工具调用、流式输出都有；图片和附件不支持——发图会被换成占位符（`[image omitted: only text reaches this model]`），不报错但图不会到模型，请让 agent 拒绝图片请求。非官方：站点可以随时改动或限制，被封号的风险由使用者自担。

在 [magpie](https://usemagpie.ai) 和 [OpenCode](https://opencode.ai) 里把 ChatSEU 变成一个供应商 `seu-chat`，所有接在 magpie 网关上的 agent（pi、Claude Code、Codex 等）都能用它。

## 它怎么工作

1. **登录**。「在单独的浏览器窗口登录东南大学统一认证」会打开一个 Chrome/Edge 窗口——插件专属的配置，不碰你平时的浏览器。你在里面用学工号过统一认证（密码、验证码都在那个窗口里输入，插件看不见），登录完成、跳回 ChatSEU 后窗口自动关闭，插件经本机 127.0.0.1 的 DevTools 接口读回 chatseu.seu.edu.cn 的 cookie 并关窗。

   「粘贴 Cookie」是备选：从任何已登录浏览器里复制整行 Cookie 也可以。需要本机装有 Chrome 或 Edge（可用 `SEU_CHAT_BROWSER` 指定路径；Safari 不行）。

2. **每个请求**把整段 OpenAI 请求（system、历史、工具）压成一条消息，`POST /api/chat/streamchat` 新开一个对话，读它 SSE 的回复，边读边翻成 OpenAI chat completion（SSE 或整段）。读完就把那条对话删掉，不在你的 ChatSEU 历史里留痕。

3. **工具调用**。客户端声明的工具以文本方式描述给模型；两个模型都会用 JSON 回出调用（GLM5.3-Flash 和 Qwen3.8-Flash-Next 实测 8/8 回出正确调用），插件解析回标准 `tool_calls`。工具在本地执行，学校那边看到的只是文本。

4. **保持登录**。ChatSEU 的会话按空闲超时作废（实测几小时不用就掉；cookie 本身有 24 小时）。所以登录时插件写一个 25 分钟后的到期时间，并提供 `auth.refresh`：magpie 的网关在它到期前自动用存的 cookie 碰一次 `userInfo`，到期时间再续 25 分钟。**只要 magpie 开着，登录就一直有效**；magpie 关久了再开会提示重新登录（点一下、在窗口里登录即可）。学校 CAS 的票据关窗即清，所以不能靠重开浏览器自动续。

## 模型

| id | 网页里的名字 | 网页型号 code |
| --- | --- | --- |
| `glm-5.3-flash` | GLM5.3-Flash | 4 |
| `qwen3.8-flash-next` | Qwen3.8-Flash-Next | 3 |

网页前端只露出这两个。模型表可以用 magpie 的插件选项覆盖或追加（`code` 是网页发给后端的数字型号）：

```sh
magpie plugin options magpie-seu-chat '{"models":[{"id":"glm-5.3-flash","name":"GLM5.3-Flash","code":4}]}'
```

## 限制

- 文本进、文本出：请求里的图片和文件不会发出。
- 每个账号同时一个请求（站点限额未知，保守起见）。
- 上下文上限（实测 2026-11-27，两个模型一致）：约 90 万字符 / 28 万 token。插件按 20 万 token 声明、85 万字符（站点实测约 90 万）硬上限；超过站点上限时它不报错而回空内容，插件把这改回 `413 prompt is too long`，让 agent 去压缩对话。
- usage 是估算的：中文按每字 1 token、其余按每 4 字符 1 token；站点不报真实 token 数。
- 思考内容（`<思考内容>` 段）作为 `reasoning_content` 给回；实测这两个模型多数回复没有思考段。

## 安装

```sh
magpie plugin add "本机文件夹路径"          # 本地目录
magpie plugin login seu-chat               # 选第一种方式，在弹出的窗口里登录
magpie provider test seu-chat              # 验证
```

环境变量：`SEU_CHAT_BROWSER`（浏览器路径）、`SEU_CHAT_PROFILE`（profile 存放目录）。

## 故障排查

- **报错含 `aTrust` / HTTP 307**：学校的零信任网关（aTrust）把请求拦下了，请求没到 ChatSEU。先打开 aTrust 客户端确认隧道已连接、应用已认证；如果用 Clash 之类的代理，给 `*.seu.edu.cn` 加一条 `DIRECT` 规则——走境外出口访问校内站点会被 gateway 直接 307。
- **报错 `seu_unreadable_call`**：模型把工具调用写成了插件读不出的形状（多半是被截断），插件放弃了这次回复让网关重试。连续出现请反馈复现对话。
- **报错 `seu_timeout` / `seu_stream_stalled`**：站点 30 秒没回响应头，或回复流 2 分钟没有新内容。重试几次；持续出现说明站点在维护或网络不通。
- **只有思考、没有正文**：这类回复会以 502 返回让 agent 重试，不会被当成一次完整回答（否则 Claude Code / Codex 会直接停下）。
- **agent 连着两次重试同一条失败命令**：发往模型的工具结果标题现在带状态（`[tool result of bash — exit code 9009]`、`— timed out after 120 seconds`、`— aborted`），模型应能一眼看出命令没跑成。`9009` 是 Windows 没装 Python、`python` 命中商店假 shim 的典型退出码——装 Python 或改用 `py`。

## 开发

`community/seu-chat/` 是由 `bun run sync` 从根目录生成的，不要手改；根目录是唯一的源。

## 已知风险与不做的事

- 协议是从 2026-11-27 的网页前端逆向的，站点改版就会失效。
- 站点条款禁止违规使用；请遵守学校的信息化规定，风险自担。
- 插件不读你日常浏览器的任何数据、不保存也不代填统一认证账号密码、不处理验证码、不碰站点的密钥审批接口。
- 如果学校的统一认证拒绝在开着调试端口的浏览器里登录（页面提示「浏览器不安全」之类），第一种登录方式会失败——改用「粘贴 Cookie」，并欢迎提 issue。

## 未做 / 以后可以做

- 多轮续聊（服务端保留上下文以省重发）——目前刻意无状态，见设计文档。
- 图片/附件上传（网页端支持 ≤10MB 附件，插件未接）。
- 提交到 magpie-community/plugins 后出现在发现页。
