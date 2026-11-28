# @magpie-community/opencode-mobook-auth

**Version: 0.9.0**

MoBook / 书灵墨宝 (`mobook.me`) **subscription** provider for Magpie and OpenCode: sign in with a phone
number and SMS code, with the whole site Cookie, or by importing the local desktop client's login state;
chat through the account's own API key; list the models with their ink-drop multipliers; claim the daily
check-in; drive the growth-plan task list; and use image generation, TTS and realtime ASR.

> Unofficial. Not affiliated with MoBook / 数传集团. It calls the same web APIs the site itself calls,
> so a change on their side can break it.

## Features

| Area | What it does |
|---|---|
| Sign-in | phone + SMS code (registered as a **client** via `deviceToken`, so a signed-in page or device is never signed out); paste the **whole Cookie** (`_tk=…; _uid=…`, a bare `_tk` is refused); import the local desktop client's login state |
| Chat | native OpenAI-compatible chat through the account's API key (`model-gateway`), with real streaming and token usage |
| Models | the 23 models the site sells, with real multipliers and measured context windows; an option also lists the gateway's 62 ids |
| Images | `mobook-image` (Doubao-Seedream-5.0-Pro) on `/v3/images/generations` |
| Speech | `mobook-tts` (Doubao Seed-Audio 1.0) on `/v1/audio/speech`; `/v1/audio/transcriptions` through Tencent realtime ASR |
| Usage card | ink-drop usage over non-expired batches with the nearest expiry, recharge/gift pools, recording minutes + points, activity-map streak + makeup cards |
| Check-in | daily check-in; the activity map is checked first, so the punch-in conversation only runs when today is not active yet (can be switched off) |
| Agent tools | `mobook_task_status` (read-only) and `mobook_tasks` (background runner, easiest-first, human-like waits, JSONL log) |

## Install

```
magpie plugin add github:dolacmeo/magpie-mobook
magpie plugin on mobook
```

Then sign in under Settings › Providers › 书灵墨宝 MoBook. The plugin fetches the account-level API key
itself, so the native gateway, images, TTS and ASR work without the desktop client.

## Sign-in

| Route | Signs out a signed-in page/device? | Adds a registered device? |
|---|---|---|
| Phone + SMS | no (`deviceToken` registers a client session) | reuses an existing client, registers one only when the list is empty |
| Whole Cookie (opens the sign-in page first) | no (pure reuse) | no |
| Imported local client state | no (reuses the client's bot token) | no |

The SMS code is requested in the **desktop app scope (appId 200)**, where MoBook's `/user/verifyConfig` reports `captchaEnable: false`; the web scope (40) is the one that turns the Aliyun slider on. If the server still asks for human verification, the plugin cannot show the slider — it then opens the sign-in page and asks for `_tk` / `_uid` instead (the Whole Cookie route; that route never needs a captcha).

All three routes return the same oauth-shaped credential (`access` = `_tk`, `refresh` = `''`, `expires`,
`accountId` = nickname, `uid`). The host keeps `accountId`/`uid` only for that shape, so two accounts stay
apart (`mobook` + `mobook#…`) and its background renewal works on every route. The agent is always the
default 「墨宝」 (13).

## Accounts, API key and device identity

- After sign-in the plugin reads `/organization/getApiKeyConfigDetail` and stores `apiKey` /
  `apiKeyBaseUrl` / `apiKeyDefaultModel` in the credential metadata. That is what turns the native
  gateway on (streaming + token usage) and unlocks images, TTS and ASR.
- The key is scoped by `_appId`: a fresh account has no key under the web client (40, `status -1`) but
  does have one under the desktop client (200 Windows / 210 macOS). The plugin asks in the web scope
  first and falls back to the desktop scope.
- A credential saved without a key is not a user problem: the plugin fetches the key on first use,
  caches it in memory for 10 minutes and retries that request. A failed attempt is not retried for 60 s.
  Only when the key still cannot be read does a request say so.
- Ordinary requests carry **no** `deviceId`; only the phone route sends one, to register itself.
- Device identity is local only:
  - **Phone**: a stable 43-character `deviceToken` derived from the phone number; the client name is
    `DESKTOP-` plus the first 7 hex digits of `MD5(uid)`; the client list is read first and an existing
    client is reused (a client is registered only when the list is empty).
  - **Cookie / imported client state**: reuse only — no `deviceId`, no bot creation, no change to the
    existing sign-in. Importing reuses the client's real `hardware.fingerprint` and hostname.
  - Hardware probing is cached per process and each command is capped at 6 s, so signing in does not
    stall on a slow machine.
- The bot lookup is cached in-process for 60 s, keyed by `(uid, appId, platform)`; registering a client
  clears it.
- `appId` is the product × client number every signed request carries: web `40`, Windows `200`, macOS
  `210` (standard edition `400`/`410`/`420`). The desktop client stores `110`, which `appIdForApi()`
  maps to `200`/`210`. Bots are scoped by it.
- Growth-plan state lives per account in the plugin's own directory
  (`<magpie config>/mobook-tasks/<uid>/`, or `~/.mobook-plugin/tasks/<uid>/` without magpie; a
  `~/.mobook-harness/mobook-tasks` left by older versions is copied over once): `run.lock` (exclusive
  create) keeps two runners apart, and `run.heartbeat` (every 15 s, stale after 90 s) decides whether one
  is still alive — not the PID, which the OS reuses.

## Models

- The catalog is the 23 models the site sells, each with its multiplier and a measured context window
  (1,048,576 for booksgpt / deepseek-v4-flash / deepseek-v4-pro; 983,616 for eco / ultra / qwen4-max /
  qwen3.8-* / qwen3.7-plus; 262,144 otherwise). The **output** limit is separate: 393,216 for booksgpt /
  deepseek-v4-flash / deepseek-v4-pro, 262,144 for doubao-seed-2-1-turbo, 131,072 for most, 65,536 for
  hy4 / hy4-flash.
- Option `show_all_models` lists all 62 gateway ids; historical aliases (`-l3`, `-unsafe`, old versions)
  fall back to 262,144 / 131,072 because they publish no multiplier or window.
- `mobook-image` is declared in `config.models` and `provider.models` with `modalities.output:["image"]`.
  A stock magpie build lists it in the chat list as well; filing it only under Settings › Models ›
  Images needs the host-side patch in `patches/draw_mobook.go`, which is not part of the installed
  binary. Generation works either way.
- `mobook-tts` stays a chat model because `/v1/audio/speech` routes by model.
- Both media models need the account API key; the plugin fetches it on first use.

## Usage card

- **墨滴用量** — `used = granted total of all non-expired batches − current balance`. The balance API
  returns exactly the sum of the remaining amounts of those batches, so the bar and the number always
  reconcile. `runsOutAt`/`runsOut` are the nearest upcoming expiry among batches that still have
  something left (every reward has its own 31-day validity, so this is not a calendar month). If the
  ledger exceeds the read cap (2400 rows per direction) the card says the numbers are approximate.
- **充值/礼包** — all pools merged into one row, with the earliest expiring batch as `runsOutAt`.
- **录音时长** — recording is free for 60 minutes per account, then 5 points per minute; the numbers
  come from the `录音时长消耗` rows in the ink-drop ledger.
- **活跃地图** — consecutive active days and makeup-card count; while growth-plan tasks are unfinished
  the row also carries `任务 x/y`.

## Check-in and the activity map

`auth.checkin` claims the daily check-in and **checks the activity map first**: when today is already
active the punch-in conversation is skipped (no ink drops spent). Otherwise it sends one short
conversation (`deepseek-v4-flash`, falling back to 快速/eco) with a 120 s timeout, deletes it and
confirms by polling `/activity/queryUserActiveList`. Option `skip_activity_chat` turns that conversation
off. When the background runner claimed the check-in first, the check-in thread re-reads the activity
and reports it as done.

Check-in starts **two independent threads**: the flow above and the growth-plan runner (background, it
never blocks the check-in). The runner reads the task list first: when everything is claimed it records
`done.json` for the account and exits, and later check-ins skip the task thread for the rest of the day.

## Growth-plan tasks (agent tools)

Magpie exposes the tools as an MCP server at `http://127.0.0.1:3425/mcp/magpie/tools`; the two names are
`mobook_task_status` and `mobook_tasks`.

- `mobook_task_status` — read-only list of tasks, statuses and rewards, plus the tail of the last log.
- `mobook_tasks {actions:false}` — join unjoined tasks and claim finished rewards.
- `mobook_tasks {actions:true}` — hand the whole run to `task-runner.mjs` in the background. Actions run
  one at a time, easiest first. Each one: read progress → run → verify (6 × 10 s, claiming each round;
  one immediate re-run if it did not verify) → claim the reward, then clean up what this run created.
  The wait before the next action is that action's human minimum plus a random 15–30 s (check-in 3 s,
  activity chat 15 s, desktop 10 s, scheduled task 40 s, knowledge base 30 s, image note 35 s, recording
  note 30 s, skill 25 s, 25 s per expert); the last action has no following wait.
- Some actions temporarily install products (skills and the XHS expert) and uninstall them at the end;
  the scheduled task the run creates is deleted after its claim. Only free products are ever installed.
- A title match only picks the *most fitting* action. After planning, the runner checks that every
  automatable task was claimed by some action and adds a fallback for the ones it missed (rule 12: one
  message to an installed expert; rule 23: an image note), logging `plan/uncovered`.
- A JSONL log lives at `<magpie config>/mobook-tasks/<uid>/latest.jsonl` (`previous.jsonl` keeps the run
  before). When every task is claimed the runner writes `done.json`, so check-in skips it for the day.
- Failures are not swallowed: when an action cannot send its message the error is thrown, and an expired
  sign-in aborts the whole run instead of replaying every action with a dead credential.
- The runner is started **outside the plugin host's process job** (a WMI-created hidden `wscript` →
  `.cmd` chain), so it keeps running when magpie recycles or closes the host; the credential travels in
  a per-run file that the runner deletes as soon as it has read it.

13 tasks across 9 rule types (12 / 13 / 14 / 15 / 17 / 18 / 19 / 22 / 23) can be automated. 小程序端墨宝对话
(16) needs WeChat and 审校批注送墨滴 (20) needs a human review pass; they are excluded from `任务 x/y`
and from `done.json`, so a day with only them left counts as done.

| # | Task | Rule | What the action does | Human min |
|---|---|---|---|---|
| 1 | 新建图片笔记体验AI总结 | 23 | uploads a 1px image and creates an IMAGE note (the server writes the summary) | 35 s |
| 2 | 新建录音笔记 | 23 | `recordNoteViaTranscript`: private OSS upload of an mp3 + a paragraph JSON, `durationMs` 330000 (5 min+), then one summary click; no streaming, no recording billing | 30 s |
| 3 | 试用个人知识库 | 22 | creates the personal knowledge base when the account has none (`createUpdateLibrary`, `bizType: KNOWLEDGE`), uploads a generated PDF and asks one `rag_chat` question tagged `knowledge_qa` | 30 s |
| 4 | 桌面端墨宝对话1次 | 15 | one desktop-scope conversation | 10 s |
| 5 | 设置定时任务 | 14 | `createCronTask` creates 「墨宝插件选题灵感日报」; the task is deleted after the claim | 40 s |
| 6 | 完成一次参考文献核查 | 13 | finds `reference-word-reviser`, installs it temporarily, sends one format check | 25 s |
| 7 | 完成一次体验文档对校技能 | 13 | `pdf-compare-unified`, sends two texts to compare | 25 s |
| 8 | 完成一次AI选题报告生成 | 13 | `book-proposal`, sends a topic request | 25 s |
| 9 | 使用3个技能 | 19 | fills up to three installed skills (installing free ones if needed) and runs each | 25 s each |
| 10 | 完成一次小红书图文笔记创作 | 12 | installs the dedicated 小红书图文笔记数字专家 (product 3366 → agent 22) and asks for an XHS note | 30 s |
| 11 | 使用3个专家 | 18 | sends to the tasks' `agentId`s, else to three installed experts | 75 s |
| 12 | 完成一次书稿审校 | 12 | shares the `reviser3` action: a manuscript PDF with typos, uploaded and sent to the review expert | 75 s |
| 13 | 使用审校专家3次 | 17 | the same review expert three times, each waiting for the answer to land | 75 s |

## Media

- **Images** — `POST /v3/images/generations` (no model field; returns `{model, data:[{url}]}`), mapped
  from the host's `/v1/images/generations`.
- **TTS** — `POST /v3/tts/create` with `seed-audio-1.0`; voices come from the API key's own
  `speaker_map` / `speaker_audio` / `mega_info`, so with none configured only the default voice works.
  The response MIME follows the requested format.
- **ASR** — `POST /media/startRealtimeTranscription` (provider tencent) returns a signed
  `wss://asr.cloud-rtc.com/…`; 1280-byte frames of 16 kHz/16-bit mono PCM, an end instruction, only
  final sentences kept. WAV is decoded in the plugin, anything else goes through the local `ffmpeg`
  (asynchronously, with a size cap and a 10-minute timeout). A timeout or early close is an explicit
  error, never a silent partial transcript; the server session is stopped on every exit path.

## Limits

- When the account has no API key the chat runs on MoBook agent sessions: no tool calls, no image
  input, no multimodal output. Images need the native gateway; the plugin fetches the key and retries,
  and only if no key can be obtained does it say so.
- One web session per account. The phone route registers a client (`deviceToken`) instead of replacing
  the web sign-in; Cookie and imported-client routes only reuse; desktop clients each hold their own bot
  token.
- Recording: 60 free minutes per account, then 5 points per minute, 3 hours per recording.
- The imported-client route keeps the desktop scope (`appId` 200), so its task list is the desktop
  catalog (12 automatable) while phone / Cookie accounts see the web one (15 tasks, 13 automatable).

## Tests

```
node --test index.test.mjs task-runner.test.mjs   # 119 tests (95 + 24 for the task runner)
```

## 中文

书灵墨宝（MoBook，`mobook.me`）的 Magpie / OpenCode **订阅**插件，面向出版编辑场景的 AI 平台。

### 功能总览

| 模块 | 能做什么 |
|---|---|
| 登录 | 手机号 + 短信验证码（**登记为一台客户端**，不顶网页端）、粘贴**整段 Cookie**（`_tk=…; _uid=…`，只给 `_tk` 会被拒绝）、导入本机客户端登录态 |
| 对话 | 走账号 API Key 的原生 OpenAI 兼容网关，真流式、带 token 用量 |
| 模型 | 网页在售 23 个，带真实倍率与实测上下文；选项可列出网关全部 62 个 id |
| 图片 | `mobook-image`（Doubao-Seedream-5.0-Pro），`/v3/images/generations` |
| 语音 | `mobook-tts`（Doubao Seed-Audio 1.0）走 `/v1/audio/speech`；转写走腾讯实时 ASR |
| 用量卡 | 未过期额度的墨滴用量 + 最近到期、充值/礼包合并行、录音时长与积分、活跃地图 |
| 签到 | 每日签到；先查活跃地图，今天还没活跃才发打卡对话（可关） |
| 智能体工具 | `mobook_task_status`（只读）、`mobook_tasks`（后台跑、从易到难、拟人等待、JSONL 日志） |

### 安装

```
magpie plugin add github:dolacmeo/magpie-mobook
magpie plugin on mobook
```

然后在 设置 › 供应商 › 书灵墨宝 MoBook 登录。插件自己取账号级 API Key，所以原生网关、图片、TTS、ASR
都不需要桌面客户端。

### 登录

| 方式 | 会顶掉已登录页面/设备 | 会新增登记设备 |
|---|---|---|
| 手机号（客户端登记） | 否 | 已有客户端就复用，没有才登记一台 |
| 粘贴 Cookie（会先打开登录页） | 否（纯复用） | 否 |
| 导入本机客户端登录态 | 否（复用客户端 botToken） | 否 |

发短信验证码走的是**桌面端作用域（appId 200）**：墨宝的 `/user/verifyConfig` 在这个作用域返回 `captchaEnable: false`，而网页作用域（40）才会打开阿里云滑块。如果服务端仍然要求人机验证：插件是纯 Node 环境弹不出滑块，会直接打开登录页，改问你要 `_tk` / `_uid`（即「粘贴 Cookie」方式）；Cookie 方式永远不需要验证码。

三种方式都返回 oauth 形状的凭据（`access` = `_tk`、`refresh` = `''`、`expires`、`accountId` = 昵称、
`uid`）：宿主只对这个形状保留账号身份，两个账号能分开（`mobook` + `mobook#…`），后台续期也生效。
对话智能体固定是默认的「墨宝」（13）。

### 账号、API Key 与设备身份

- 登录后读 `/organization/getApiKeyConfigDetail`，把 `apiKey` / `apiKeyBaseUrl` / `apiKeyDefaultModel`
  存进凭据 metadata —— 这才打开原生网关（真流式 + token 用量）并解锁图片、TTS、ASR。
- Key 按 `_appId` 分作用域：新账号在网页端（40）下没有（`status -1`），桌面端（200 Windows / 210 macOS）
  下有。插件先按网页作用域取，取不到再换桌面作用域。
- 凭据里没有 Key 不是用户的问题：插件在首次用到时自动补取，内存里缓存 10 分钟并重试这一次请求；
  补取失败后 60 秒内不再重试。真的取不到，请求才会说明原因。
- 普通请求**不带** `deviceId`；只有手机号登录会带，用来登记客户端。
- 设备身份只记在本地：
  - **手机号**：`deviceToken` 由手机号派生（43 字符、跨机器恒定）；客户端名是 `DESKTOP-` 加
    `MD5(uid)` 的前 7 位十六进制；登录后先读客户端列表，已有就复用（列表为空才登记一台）。
  - **粘贴 Cookie / 导入客户端**：只复用，不带 `deviceId`、不建 bot、不改动已有登录态；导入时沿用
    客户端真实的 `hardware.fingerprint` 与 hostname。
  - 硬件探测结果在进程内缓存，每条命令 6 秒超时，慢机器上登录不会卡住。
- bot 查询在进程内缓存 60 秒，键是 `(uid, appId, platform)`；登记客户端会清缓存。
- `appId` 是每个签名请求都带的“产品 × 接入端”编号：网页 `40`、Windows `200`、macOS `210`
  （标准版 `400`/`410`/`420`）；桌面客户端存的 `110` 由 `appIdForApi()` 映射。bot 也按它分作用域。
- 成长计划状态按账号放在插件自己的目录（`<magpie 配置>/mobook-tasks/<uid>/`，没有 magpie 时
  `~/.mobook-plugin/tasks/<uid>/`；老版本的 `~/.mobook-harness/mobook-tasks` 会一次性复制过来）：
  `run.lock` 独占创建当锁，`run.heartbeat`（15 秒一次、90 秒过期）判活——不看 PID，因为 PID 会被回收再分配。

### 模型

- 目录是网页在售的 23 个模型，各带墨滴倍率（`0.03` = 0.03×）和实测上下文：booksgpt /
  deepseek-v4-flash / deepseek-v4-pro 是 1,048,576；eco / ultra / qwen4-max / qwen3.8-* / qwen3.7-plus
  是 983,616；其余按 262,144 兜底。**最大输出**是另一个数：booksgpt / deepseek-v4-flash /
  deepseek-v4-pro 是 393,216，doubao-seed-2-1-turbo 是 262,144，多数 131,072，hy4 / hy4-flash 是 65,536。
- 选项 `show_all_models` 打开后列出网关全部 62 个 id；历史别名（`-l3`、`-unsafe`、旧版本号）没有公开倍率，
  上下文按 262,144 / 131,072 兜底。
- `mobook-image` 在 `config.models` 与 `provider.models` 里都声明，带 `modalities.output:["image"]`。
  原版 magpie 里它也会出现在对话模型列表；要让它只进「设置 › 模型 › 图像模型」，需要宿主侧补丁
  `patches/draw_mobook.go`，而当前安装的 `magpie.exe` 没有这个补丁。补没补都不影响画图。
- `mobook-tts` 仍是对话模型，因为 `/v1/audio/speech` 按模型路由。
- 两个媒体模型都需要账号 API Key；插件会在首次用到时自动补取。

### 用量卡

- **墨滴用量**：已用 = **未过期批次的发放总和 − 账户当前余额**。余额接口返回的正好是这些批次的剩余之和，
  所以进度条与卡片上的数字天然对账。`runsOutAt`/`runsOut` 取还有剩余的未过期批次里最近的一个到期时间
  （每笔奖励各自 31 天有效，所以不是自然月）。流水超出读取上限（每方向 2400 条）时卡片会注明数字为近似。
- **充值/礼包**：所有池子合并成一行，`runsOutAt` 用最早作废的那一笔。
- **录音时长**：账号累计免费 60 分钟，之后 5 积分/分钟；数字来自墨滴流水里的「录音时长消耗」。
- **活跃地图**：连续活跃天数与补登卡数量；成长计划没做完时这一行还会带 `任务 x/y`。

### 签到与活跃地图

`auth.checkin` 先签到，然后**先查活跃地图**：今天已经活跃就跳过打卡对话（不再花墨滴）；只有还没活跃时
才发一条短对话（`deepseek-v4-flash`，失败回退 **快速**/eco，超时 120 秒），对话随后删除，并轮询
`/activity/queryUserActiveList` 确认。选项 `skip_activity_chat` 可彻底关掉这条对话。后台 runner 先领掉
签到时，签到线程会复查并记成功。

签到现在会同时起**两个互不干扰的线程**：上面的签到流程，以及成长计划任务 runner（后台启动，不阻塞签到）。
runner 启动时先读任务清单：已经全部领取就写 `done.json` 并直接结束，当天后续签到看到缓存就不再起任务线程。

### 成长计划任务（智能体工具）

magpie 把插件工具挂到内置 MCP 服务器 `http://127.0.0.1:3425/mcp/magpie/tools`，工具名是 `mobook_task_status`
和 `mobook_tasks`。

- `mobook_task_status`：只读列出任务、状态、奖励，附带上次运行日志尾部。
- `mobook_tasks {actions:false}`：补领未领取任务、领取已完成奖励。
- `mobook_tasks {actions:true}`：交给 `task-runner.mjs` 后台跑，按**从易到难**逐条执行：
  **读进度 → 运行 → 核验（6 × 10 秒、每轮补领一次，没核验到就立刻补跑一次）→ 先领取奖励 → 再清理本次产物**，
  相邻动作等待 = 该类动作的真人最快时间 + 15–30 秒随机（签到 3s、活跃对话 15s、桌面端 10s、定时任务 40s、
  知识库 30s、图片笔记 35s、录音笔记 30s、技能 25s、每个专家 25s），最后一个动作不等。
- 部分动作会临时安装产品（技能、小红书专家），结束时卸载；本次新建的定时任务领取后删除。临时安装只挑免费产品；小红书专用专家按任务要求安装（它的商品目录接口 `productType=EXPERT` 不可用，不再做价格拦截）。
- 标题只用来挑「更合适的做法」：规划后 runner 会检查每条可自动化任务是否都有动作认领，漏掉的补一个兜底动作
  （规则 12 用已装专家发一条、规则 23 建图片笔记），并在日志里 `plan/uncovered` 点名。
- 日志在 `<magpie 配置>/mobook-tasks/<uid>/latest.jsonl`（上一次留 `previous.jsonl`）；全部领完后写 `done.json`，
  当天签到就不再起任务线程。
- 失败不吞：动作发消息失败会抛出来；登录态失效时整轮立即中止，不再拿过期凭据把每个动作都跑一遍。
- runner 在**插件宿主的进程 Job 之外**启动（WMI 创建隐藏的 `wscript` → `.cmd`），宿主被回收/重启时它继续跑；
  凭据走 per-run 文件，runner 读到就删。

可自动化的共 13 项任务、9 种规则类型（12 / 13 / 14 / 15 / 17 / 18 / 19 / 22 / 23）。小程序端对话（16）与
审校批注（20）是人工任务：不计入 `任务 x/y`、不写进 `done.json`，只剩它们时即视为今天完成。

| 顺序 | 任务 | 规则 | runner 动作做了什么 | 真人最快时间 |
| --- | --- | --- | --- | --- |
| 1 | 新建图片笔记体验AI总结 | 23 | 传一张 1px 图，`addNote` 建 IMAGE 笔记（服务端生成总结） | 35s |
| 2 | 新建录音笔记 | 23 | `recordNoteViaTranscript`：私有 OSS 上传 mp3 + 段落 JSON，`durationMs` 写 330000（满足 5 分钟以上），再点一次智能总结；不推流、不计费 | 30s |
| 3 | 试用个人知识库 | 22 | 账号没有个人知识库时先建一个（`createUpdateLibrary`，`bizType: KNOWLEDGE`），再传一份生成的 PDF，用 `rag_chat` + `knowledge_qa` 在库内提一次问 | 30s |
| 4 | 桌面端墨宝对话1次 | 15 | 用桌面作用域发一条对话 | 10s |
| 5 | 设置定时任务 | 14 | `createCronTask` 建一个名为「墨宝插件选题灵感日报」的定时任务；领取后删除 | 40s |
| 6 | 完成一次参考文献核查 | 13 | 找 `reference-word-reviser` → 临时安装 → 发一条格式核查 | 25s |
| 7 | 完成一次体验文档对校技能 | 13 | 找 `pdf-compare-unified` → 发两份文本对比 | 25s |
| 8 | 完成一次AI选题报告生成 | 13 | 找 `book-proposal` → 发选题请求 | 25s |
| 9 | 使用3个技能 | 19 | 用账号已装技能补足 3 个（不够就临时装免费技能），各跑一次 | 25s/个 |
| 10 | 完成一次小红书图文笔记创作 | 12 | 装专用的小红书图文笔记数字专家（产品 3366 → agent 22）并发一条小红书创作请求 | 30s |
| 11 | 使用3个专家 | 18 | 任务带 `agentId` 就按它发，否则用已装前 3 个专家各发一条并等回复 | 75s |
| 12 | 完成一次书稿审校 | 12 | 与第 13 条同一个 `reviser3` 动作：生成带错字的稿件 PDF → 上传 → 审校专家带附件发审校 | 75s |
| 13 | 使用审校专家3次 | 17 | 同一个审校专家带同一份稿件连发 3 次，每次等回答落地 | 75s |

### 媒体

- **图片**：`POST /v3/images/generations`（无 model 字段，回 `{model, data:[{url}]}`），由宿主的
  `/v1/images/generations` 映射过来。
- **TTS**：`POST /v3/tts/create`（`seed-audio-1.0`）；音色来自 API Key 自己的 `speaker_map` /
  `speaker_audio` / `mega_info`，没有配置时只有默认音色。返回的 MIME 按请求的 format 标。
- **ASR**：`POST /media/startRealtimeTranscription`（provider tencent）回带签名的 `wss://asr.cloud-rtc.com/…`；
  每帧 1280 字节、16 kHz/16 bit/单声道 PCM，发 end 指令结束，只收整句。WAV 插件自己解，其它格式走本机
  `ffmpeg`（异步、有大小上限与 10 分钟超时）。超时或提前关闭一律显式报错，不返回半截文本；任何退出路径都会
  在服务端 stop 会话。

### 已知限制

- 没有 API Key 时对话走墨宝智能体会话：没有工具调用、没有图片输入、没有多模态输出。带图片需要原生网关，
  插件会自动补取 Key 再重试，真的取不到才报错。
- 网页会话同一账号同时只有一个。手机号登录登记为客户端（`deviceToken`），不会替换网页端登录态；
  粘贴 Cookie 与导入本机客户端只复用；每台桌面客户端各自持有 botToken，可同时存在多个。
- 录音：账号累计免费 60 分钟，之后 5 积分/分钟，单条上限 3 小时。
- 「导入本机客户端登录态」保留桌面作用域（`appId` 200），任务清单是桌面那份（12 条可自动化）；
  手机号 / Cookie 走网页作用域 40（15 条，其中 13 条可自动化）。这是服务端按 `_appId` 分区。

### 测试

```
node --test index.test.mjs task-runner.test.mjs   # 119 个用例（95 + 24），约 2 秒
```
