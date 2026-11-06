# Changelog

## 0.5.2 — 2026-11-05

- **magpie 式取消立即收尾**：magpie 在 authorize 之后**立刻**调 `callback(undefined, { signal })`，用户取消/登录超时时 abort signal——之前 callback 不读 signal、`clearTimeout` 又把 5 分钟兜底定时器拆了，Chrome 会一直开满 10 分钟 deadline（甚至给已被宿主放弃的登录继续取 key）。现在 `authorize` 和 `callback` 都接 signal：`signal.aborted` 先查、`addEventListener('abort', …, { once: true })` 后挂，abort 一到立即收尾。
- **启动期 abort 不再丢失**：`startBrowserHarvest` 的 abort 原来要等 `openMclawBrowser` resolve 后才生效，Chrome 还在启动时取消会被吞掉、窗口照样弹出。现在先记标记，开出来若已取消立即关闭。
- **失败/取消/超时的登录不再留孤儿 profile**：`signin-*` 目录在失败路径（含 abort、超时、浏览器被关）里删除——成功时目录归账号所有（`metadata.profile`），绝不删。已知限制：**重新登录同一账号会生成新目录，旧目录会留在** `mclaw-browser-profiles/` 下（内含不再被引用的历史登录态，可手动删）。
- 测试 28 → 30：magpie 式取消（callback 立即被调 + abort → aborted/closed/released）、authorize 时 signal 已 aborted。

## 0.5.1 — 2026-11-05

- **恢复 SSO 换票链（修正 toSourceId 为 001005）**：0.5.0 按 review 删链的前提错了——200050409「统一通信证临时票据验证失败」是渠道号用错（001003/001221），App vip 会员中心 H5 的 app.js 实配 **001005**；全链路 Node fetch 实测通：出票 → ssoLogin `resultCode 0` → Set-Cookie 下发 6 个 `mc_*`（`.139.com` 域，24h；mc_at/mc_pat httpOnly）→ 明细接口正常，pc:/mobile: 票均可。
- **vip Cookie 从此全自动**：未配置或失效时自动换票补会话，「重置于」（权威 endTime）与最近逐条明细免配置；手动粘的 Cookie 仍优先，失效后自动换新。触发收敛回应 review 顾虑：成功后进程内缓存复用（约 24h 一次），失败 30 分钟冷却，不再是「每次用量轮询都发一次票」。
- **修一个 Bun 运行时的真 bug**：Bun 的 `getSetCookie()` 会把多条 Set-Cookie 折叠成一条（逗号连接），`Expires` 日期里的逗号会把天真的切分打碎——只拿到第一个 cookie。现在按「逗号后紧跟 `名字=`」的边界展开，日期逗号保持原样；magpie 的插件正是跑在 Bun 上，这一修在真实环境同样必要。
- **登录零输入**：删掉登录时「llm API key」「vip Cookie」两个可选项——key 自动取、vip 会话自动换，登录全程只有「在弹出的 Chrome 里登录」一个动作（网页支持验证码、密码、扫码等多种方式，文案不再写死短信）。key 自动获取失败（网络抖动，罕见）时登录失败提示重试。0.5.0 前老账号手动粘过的 `metadata.vipCookie` 仍优先、失效自动换新。
- 测试：fake 上游补 `querySpecTokenV2` / `ssoLogin`（6 个 Set-Cookie 含 httpOnly）；新增自动换票、失败冷却、配置优先、零输入登录四个用例（28 个测试）。

## 0.5.0 — 2026-11-05

多账号与取消安全（market PR #746 review）：

- **每个账号一个专属 browser profile**：登录不再用共享目录——每次登录开一个全新 profile（绝不带旧票），目录存进账号 `metadata.profile`；续期只开该账号自己的 profile，并校验收割到的票属于本账号（票里的手机号对不上就按 `signIn: 'expired'` 报错，绝不让 B 账号的票和 key 存进 A 名下）。0.5.0 前的老账号续期退回老共享目录，成功后把目录钉进 metadata。`MCLAW_BROWSER_PROFILE` 语义变为 profiles 根目录。
- **取消的登录会收尾**：宿主没调 callback（用户取消/面板关闭）时，authorize 里的定时器（默认 5 分钟）到点关浏览器、放 profile 锁——之前锁被宿主 pid 占着，后续登录/续期全要等 LOCK_TIMEOUT。
- **「重置于」只认账号自己的权威 endTime**：删掉「每月 11 日 15:20:47」的硬编码锚点（那是观察到的某账号合同周期，别家账号各不相同）；没有权威 endTime（未配 vip Cookie）就不显示重置时间，也不造 startsAt/span。
- **删除 SSO 换票链**（querySpecTokenV2 → ssoLogin）：上游拒远程出的票（200050409），链路本来就不可用，不该每次用量轮询都把 Basic 票发出去。
- **补测试**（bun test，无网络、无真实 Chrome）：`nonet.mjs` 全局 fetch 只放行本地；`fake.mjs` 本地 fake 两大上游；`fake-browser.mjs` 可控的浏览器替身。覆盖 normalizeChatResponse（200 裸 JSON 错误 → 401/502、SSE 透传首字节重放、空响应）、usage（池数学、无 RHR135、票过期、明细失败不连坐）、accountModels（agent/list × apikey/get 合并）、authorize/callback/refresh（成功存 profile、错误账号拒写、取消收尾）。

其他修复：

- `normalizeChatResponse` 的 JSON 分支不再有 1MB 截断（大回复不再误报 502）。
- usage 里明细查询失败不再让整张卡片报错（池窗口照常）。
- vip Cookie 输入框改为密码型；去掉恒为 false 的 `free` 字段；`--crash-dumps-dir` 用 `os.tmpdir()`（Windows 上没有 `/tmp`）。
- 包 README 安装改为市场方式（`magpie plugin add @magpie-community/opencode-mclaw-auth`）。

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
