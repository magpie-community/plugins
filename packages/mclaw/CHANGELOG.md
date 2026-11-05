# Changelog

## 0.4.3 — 2026-11-05

- 用量窗口名去掉权益编号后缀：`MClaw tokens（RHR135）` → `MClaw tokens`（编号仍用于内部识别权益项）。

## 0.4.2 — 2026-11-05

- **用量窗口补全周期字段**：`resetsAt` 改为宿主标准的 ISO 字符串，并带上 `startsAt` + `span`（锚点 11 日 15:20:47 回退一个日历月的周期起点与秒数）。实测当前 magpie（0.1.2906）的插件桥会把这两个量剥掉（startsAt 留给自家网关窗口），额度卡片的「按此速度，预计…」推算由宿主自身的历史采样（≥3 个读数且跨度 ≥1 小时）得出——账号刚添加时没有推算行是正常现象，挂几个小时读数够了就会出。
- 明细 endTime 已是上轮周期（过期）时不再采用，退回锚点推算，避免「重置于」显示过去的时间。

## 0.4.1 — 2026-11-05

- **修复浏览器登录在宿主里必然失败的问题**：宿主（magpie/OpenCode）的 oauth 契约要求 `authorize()` 立即返回 `{ url, opened, instructions, method, callback }`、由宿主随后调 `callback()` 等登录完成；原实现把弹 Chrome + 等登录 + 收割全部阻塞在 `authorize()` 里并直接返回凭证，宿主拿不到 callback 直接报 "sign-in gave nothing to finish it with"。现在 Chrome 照样由 authorize 弹出，收割/验票/自动取 key 挪进 `callback()`（OpenCode 1.x、2.x、magpie 三宿主实测走通）。
- **登录方式收敛为纯浏览器登录**：移除「手动粘贴（API Key + 抓包凭证）」登录方式与只为它服务的昵称接口调用；已有手动粘贴的老账号登录态不受影响（loader 兼容保留）。

## 0.4.0 — 2026-11-05

- **浏览器登录（一次登录，凭证全自动）**：新增 oauth 型登录方式——插件弹专属 profile 的 Chrome（CDP 管道驱动 `--remote-debugging-pipe`，无端口、不碰系统浏览器），在窗口里完成移动云短信登录后，插件自动收割 `authorization` Cookie（= `pc:` 票，30 天期）。
- **`/api/llm/apikey/get` v1 集成（key+倍率一步拿）**：Basic 票（`mobile:`/`pc:` 均可，实测）POST `{"channelId":"102001"}` 一次返回真正的 llm chat key + 9 模型倍率表。浏览器登录零手动粘贴；手动粘贴方式下倍率也改走此接口（config/get 降为兜底——它只认 App 渠道票）。
- **自动续期**：oauth 账号到期前 3 天（refreshLead）宿主调 refresh 钩子，插件 headless 复开 profile，网页应用自己刷新会话后重新收割票（票变了顺手刷新 metadata.apiKey）。
- llm key 自动获取失败时可手动填（浏览器登录方式里的可选项）；chat 仍只认 na- key（pc 票不能直连 chat，网页聊天走另一套中继协议不可复用）。
- 新文件 browser.mjs（CDP 客户端，移植自 gcp-ai 的管道客户端，MIT）；profile 默认 `~/.config/magpie/mclaw-browser-profile`，`MCLAW_CHROME_PATH` / `MCLAW_BROWSER_PROFILE` 可覆盖。

## 0.3.0 — 2026-11-04

- openclawId 完全自动发现（agent/list 免 userId，agentType=mclaw 的 agentId），仓库与代码不再含实例 ID。
- 修复模型倍率（rate）在 magpie 里显示为 0 的问题：宿主传给 provider.models 钩子的 provider 是归一化对象（自定义字段被剥、config 模型的 rate 也不带），插件改为只用闭包值并保证钩子成功返回。
- 模型目录改为 agent/list（账号实际可用，新增 huoshan_deepseek_v4_1_flash）× config/get（倍率）合并。
## 0.2.0 — 2026-11-04

- 凭证生命周期管理：用量里显示 App Basic 凭证到期日（「凭证至 M/D」）；vip Cookie 失效时自动尝试 SSO 换票链（Basic → querySpecTokenV2 → ssoLogin，10 分钟冷却），换不到则「重置于」按月周期（每月 11 日 15:20:47）推算并标注。
- 登录时自动校验 App 凭证并设置账号显示名（掩码手机号，走 metadata.email）。

## 0.1.2 — 2026-11-04

- 供应商图标换成 yun.139.com 站点 LOGO（移动云蓝色「云」标）。

## 0.1.1 — 2026-11-04

- api 登录方法增加 authorize：校验凭证 + 自动取名。
- 用量窗口支持 resetsAt（「重置于」，来自明细 endTime）。

## 0.1.0 — 2026-11-04

- 首个版本：MClaw（ai.yun.139.com）接入 magpie/OpenCode。OpenAI 兼容 chat（/api/llm/102001）、模型目录（/api/openclaw/config/get，含 9 模型与积分倍率）、aitokens 用量（RHR135 池）、可选 vip Cookie 逐条消耗明细。
