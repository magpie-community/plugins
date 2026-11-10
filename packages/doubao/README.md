# Doubao (豆包) — chat, the campaign balance, and the check-in state

Uses a signed-in `doubao.com` web account for three things:

- **chat** through the page's own endpoint (`/samantha/chat/completion`), so an
  agent can ask `doubao/…` like any other provider;
- the campaign panel's **balance**, today's **check-in state**, and what is still
  on the table, on magpie's 用量 board;
- the credits that are **already earned are claimed for you, automatically** —
  the daily sign-in *and* every reached milestone tier — see 签到与奖励 below.

## Sign in

The check-in campaign is **hard-locked to the Doubao desktop client's own
webview** — the web page renders only "该活动仅支持在豆包电脑版参与 / 去下载", and
the raw claim POST answers `710010702` to every non-client caller. So the plugin
reads the session cookie **straight from the local client** (over CDP) and never
round-trips a web login to mint a token. Three ways to add the account:

1. **From the local Doubao desktop client (recommended, primary).** Pick
   *“从本机豆包客户端获取凭证（推荐）”*. The plugin attaches to the client over
   CDP and reads the signed-in session cookie directly — **no manual paste, no
   browser round-trip**. If the client is not installed yet, the plugin opens
   the official download page (`doubao.com/download/desktop`), and once you click
   download it **auto-installs the .dmg from ~/Downloads** and relaunches the
   client with the debug port — fully hands-off after that one click. It
   diagnoses the client first and tells you the stage (not installed / not
   running / running without the debug port / ready); a client that is installed
   but closed is started with port **9333** for you. CDP's `Network.getCookies`
   sees the full jar including the HttpOnly session cookies that the page's own
   `document.cookie` is forbidden from reading.

2. **Open a browser and log in — automatic (fallback).** Pick
   *“自动打开浏览器登录（免粘贴）”* when adding the account. The plugin launches a
   real browser (Chrome or Edge) with remote debugging, opens `doubao.com`, and
   you sign in through Doubao's own login UI. The plugin then harvests the
   session cookie over CDP — **you never copy a string**. Useful only for
   reading the balance / check-in state on a machine where the client cannot be
   installed; it cannot claim the campaign (that needs the client).

3. **Manual cookie paste (fallback).** Pick *“手动粘贴网页 Cookie”* and paste the
   whole `doubao.com` cookie directly:

   ```
   sessionid=…; sessionid_ss=…; sid_tt=…; passport_csrf_token=…
   ```

   Get it from the browser: F12 → Network → any `doubao.com` request → the
   `Cookie` request header, the entire line.

A bare JWT is **not** enough. Doubao's web session lives in a set of cookies;
one alone is answered `710012000 Invalid User ID`, so the plugin sends a bare
value as `sessionid=` and nothing more. `passport_csrf_token` is read out of
the same string and sent as `x-tt-passport-csrf-token`, which is the header the
page itself sends beside it.

> **Why no “Doubao redirects back with a token” OAuth button?** Doubao exposes
> no developer OAuth / device-code endpoint, and magpie's `callback()` only
> receives a redirect URL's query (code/state), not arbitrary page cookies. So
> we can't capture a session the autoclaw/opendesign way. Instead we **launch a
> browser ourselves** (method 1) and read the session it produces via CDP — the
> equivalent “open a page, sign in, done” flow with no Doubao cooperation and no
> manual paste.

## 签到与奖励 (claim everything that is already earned)

The `pc/agent-explore` page pays out in three ways, and the plugin collects
**all of them that are ready**, on one pass, every day:

| 奖励 | 金额 | 条件 | 插件 |
|---|---|---|---|
| 每日签到 | +200（周一翻倍） | 每天一次 | ✅ 自动领取 |
| 累计额度里程碑 | +200 / +500 / +1300 | 累计 500 / 2000 / 5000 点 | ✅ 达档即自动领取 |
| 任务奖励 | 每项 +100 | 需真实使用对应功能 | ✅ 走活动页提示词自动完成并领取（定时任务会跑但不保证计分） |
| 团队版试用 / 邀请好友 | 专属额度 | 企业认证 / 真实好友 | ⬜ 不代做 |

`任务与奖励` also shows up on the board: `累计 900 点 · 待领 200 点 ·
4 个任务可做（各 +100） · 再积累 1100 点解锁 +500`.

Why the desktop client and not a request or a web page: the claim endpoint
(`POST /alice/ug/campaign/landing/checkin`) still exists and is still called by
the page's own bundle, but it answers `710010702 系统错误` to every external
caller (verified 2026-11-01 against a live account: every body / `biz_params` /
`AgwCommonParam` / UA / `Origin` / `Referer` / `s_v_web_id` / `x-requested-with`
combination, all identical). The web page itself only renders
"该活动仅支持在豆包电脑版参与 / 去下载" — a bare chromium with the real cookie
still only sees the placeholder (verified 2026-11-02). So the claim has to be
made inside the real client, exactly as a person would: open
`https://www.doubao.com/pc/agent-explore` and click the button.

### 首次安装：一次完整扫描 (what happens on install)

The first time this account is checked, `checkin()` does not just sign in — it
runs **one sweep** (`lib/sweep.mjs`), because "install it and it handles the
rewards" is the whole point:

1. **Get the client attachable.** Already fine → nothing. Closed → launched.
   Running without the debug port (the normal case after double-clicking the
   app) → restarted *once* with the port. Without this step auto check-in
   silently does nothing on most machines.
2. **Claim everything already earned** — the daily sign-in plus every milestone
   tier at 已完成待领取 — then re-read the campaign server-side to prove what
   actually landed.
3. **Look at what is left and drive the tasks** (see `--tasks` below) — one
   short turn each, stopped as soon as the campaign says 可领取, then claimed and
   the conversation ended.

The sweep is recorded in the ledger (`firstRunAt`), so steps 1–2 happen daily but
step 3 happens **once per account** — re-running the +100 tasks every day would
be a slow quota leak. The account panel gets a 首装扫描 row showing the date,
the credit collected, and how many tasks were found.

### How the built-in claim engine works

`lib/rewards.mjs` attaches over CDP (Chrome DevTools Protocol — the same
approach the proven `doubao_checkin.py` uses) and works from the page's own
**task cards**, not from page-wide text. Every card carries
`data-reward-code`, and that string is byte-identical to the campaign detail
API's `campaign_code` (verified live 2026-11-02):

```
[data-reward-code="daily_signin"]         ←→ tasks[].campaign_code  daily_signin
[data-reward-code="points_milestone_500"] ←→ milestones[].campaign_code  same
[data-reward-code="pc_task_use_skill_v2"] ←→ tasks[].campaign_code  same
```

So `checkin()` first reads the server state, then hands the engine the exact
codes that are ready (`daily_signin` when unsigned, plus every milestone at
`task_status: 2`). The engine opens **that card's own button** and dispatches a
**trusted** mouse click at its centre (not a JS `.click()`, which the page
ignores). Before clicking it also verifies with `document.elementFromPoint`
that the topmost element at those coordinates really lives inside the target
card — a toast or overlay would otherwise make the click land on something
else. After the clicks it re-reads the campaign **server-side** with your real
auth cookie (the embedded webview's JS cannot see its own HttpOnly session
cookies, so an in-page fetch always reads as anonymous) and reports exactly
what flipped.

What counts as "reward-ready" is a strict, anchored label set, checked on top
of the code match:

```
立即签到 | 签到 | 领取奖励 | 领取 N 额度 | 额外领 N 点额度
```

**It never clicks `去完成` / `立即参与` / `立即领`（团队版）/ `用豆包试试看`** as part
of a *claim* — those start a real generation or an unrelated flow. The +100 tasks
that sit at `task_status: 1` are handled by the separate first-install sweep
(「做任务 领额度」below), where each one is one short turn that stops as soon as
the task flips to 可领取 — never an open-ended generation bill.

`task_status` as observed on a live account (2026-11-02): `0` 未开放（需企业认证）,
`1` 未完成（去完成）, `2` 已完成待领取, `3` 已领取. Only `2` is money on the table.

### The 14 cards, and what the plugin does with each

A full live cut (2026-11-02, account at 900 点):

| `campaign_code` | 页面文案 | 状态 | 插件动作 |
|---|---|---|---|
| `daily_signin` | 每日签到 +200 | 1 / 3 | ✅ 点「立即签到」 |
| `points_milestone_500` | 累计 500 点 | 2 / 3 | ✅ 点「额外领 200 点额度」 |
| `points_milestone_2000` | 累计 2000 点 | 1 | 达档后自动领 |
| `points_milestone_5000` | 累计 5000 点 | 1 | 达档后自动领 |
| `pc_task_complete_computer_task_v2` | 豆包帮你整理电脑资料 | 3 | ✅ 首装驱动 → 计分 → 领取（+100） |
| `pc_task_complete_work_task_v2` | 豆包可以帮你完成复杂任务 | 3 | ✅ 首装驱动 → 计分 → 领取（+100） |
| `pc_task_use_skill_v2` | 调用技能完成一项办公任务 | 3 | ✅ 首装驱动 → 计分 → 领取（+100） |
| `pc_task_create_schedule_v2` | 重要事项设置成为定时提醒 | 1 | ⚠️ 首装会创建一次性任务并触发，但未计分 |
| `select_work_fields` | 选择工作领域 | 3 | 已领 |
| `pc_task_generate_document_v2` | 零散资料整理成一份文档 | 3 | 已领 |
| `browser_tool` | 豆包帮你完成一次网页任务 | 3 | 已领 |
| `pc_task_generate_excel_v2` | 按需求快速生成实用表格 | 3 | 已领 |
| `pc_task_generate_ppt_v2` | 给出主题即可生成 PPT | 3 | 已领 |
| `c2b_guide` | 团队版 7 天试用 | 0 | ⬜ 需企业认证，永不点「立即领」 |

`node packages/doubao/tasks.mjs` prints this list straight from the API, with
Doubao's own recommended prompt for each of the four open tasks; `--run <code>`
opens the right surface and prefills that prompt **without sending anything**.


### Evidence (live account, 2026-11-02)

```
BEFORE: checkedIn=false, total=500, milestone 500:status 2
ENGINE: clicked ["额外领 200 点额度", "立即签到"]
        requests ["/alice/ug/campaign/landing/checkin"]
AFTER : checkedIn=true,  total=900, milestone 500:status 3
```

+200 签到 + 200 里程碑 = **+400**, both confirmed by the server, not by the page.

The +100 tasks, same day, through the activity-page route:

```
去完成 → chip「制作可交互的量化分析仪表盘」→ composer 自动出现完整提示词
发送   → pc_task_complete_work_task_v2  1 → 2
领奖励（刷新后）                        → 900  → 1000, status 3   +100

去完成 → chip「专业润色学术论文」→ composer 自动出现完整提示词
发送   → pc_task_use_skill_v2           1 → 2
自动领取                                → 1000 → 1100, status 3   +100
```

Two tasks, **+200**, each one confirmed by the campaign API (`task_status` 3)
and by `progress.total_amount`, not by the page's toast.

### Prerequisite: the client must exist and be debuggable

`lib/client-status.mjs` diagnoses four stages, and every message the plugin
shows names the one you are in — "installed but closed", "running without the
debug port" and "not installed" each need a different action:

| stage | 含义 | 插件行为 |
|---|---|---|
| `not-installed` | 没有 `/Applications/Doubao.app` | **自动打开官方下载页**，你点下载后插件自动安装并读取凭证 |
| `not-running` | 装了但没运行 | **自动以调试端口启动**，然后签到 |
| `running-no-debug` | 在运行，但没开调试端口 9333 | **自动重启一次**（优雅退出 → 强杀兜底 → 带端口重启），然后签到 |
| `ready` | 端口可达 | 直接驱动卡片领取 |

The client is launched with `--remote-debugging-port=9333` and the same
`--user-data-dir` it normally uses, so the session you are already signed into
is the one that gets used.

`running-no-debug` is the common case — double-clicking the app starts it
without the flag — so the sweep quits it politely (`osascript quit`), waits for
the profile lock to be released, and relaunches with the port. Two safeguards
keep that from being rude: it happens **at most once per 10 minutes**, and
`DOUBAO_CLIENT_AUTOLAUNCH=0` turns both the launch and the restart off entirely.

```sh
node packages/doubao/ensure-doubao.mjs            # no-op if already debuggable
node packages/doubao/ensure-doubao.mjs --force    # quit + relaunch with the port
node packages/doubao/ensure-doubao.mjs --install  # open the official page, then
                                                  # auto-install the .dmg from ~/
                                                  # Downloads and relaunch with 9333
```

Unit tests point `DOUBAO_CDP_PORT` at a dead port and set
`DOUBAO_CLIENT_AUTOLAUNCH=0`, so the suite is window-free even on a machine that
happens to run Doubao.

### About the "Doubao Browser" in your Applications

Doubao's desktop client ships a full Chromium browser as a **nested helper
app** — you did not install it separately:

```
/Applications/Doubao.app/Contents/Helpers/Doubao Browser.app   1.2 GB
  bundle id  com.bot.pc.doubao.browser     version  2.34.6  (same as the client)
  URL schemes: http, https, file, doubaobrowser
```

It is the surface the client opens web pages in (its config namespace is
`com.doubaobrowser.macosx`, and its profile lives in
`~/Library/Application Support/Doubao/Default`). The plugin does **not** drive
it: the reward cards live in the main app's webview
(`[webview] …?enter_method=fixed_entry`), which is the target the CDP session
attaches to. If you set it as your default browser, that was the client asking,
not this plugin.

### Toggle

Auto claim is **on by default**. Turn it off with the environment variable
(it is read by `checkin()`, not a UI field — magpie's plugin contract has no
per-plugin boolean toggle):

```sh
DOUBAO_AUTO_CHECKIN=0        # disable the built-in claim engine; checkin() then
                             # just reports ineligible and points you to the client
DOUBAO_CLIENT_AUTOLAUNCH=0   # attach only: never launch or restart the client
DOUBAO_CDP_PORT=9334         # if 9333 is taken by something else
DOUBAO_FIRST_RUN_TASKS=off   # install sweep: off | probe | full (default)
```

`DOUBAO_FIRST_RUN_TASKS` only shapes the **first** sweep:
`off` claims and lists, `probe` tries one task to learn whether the path credits
at all, `full` drives every drivable task (capped by `DOUBAO_MAX_TASK_TURNS`,
default 99) and each turn is cut the moment its task flips to 可领取. Later
sweeps use the `autoTasksDaily` setting, which defaults to `full` — the sweep
only ever drives tasks still at status 1, so a drained campaign costs nothing.

### Outcomes

| outcome | meaning |
|---|---|
| `claimed` | the plugin drove the client and the server confirmed the credit; `credit` is the sum, `message` lists each item |
| `done` | nothing left to claim today (signed + no pending milestone), or the first sweep finished; settles the Beijing day |
| `ineligible` | the claim could not run after the daily retry cap (4); the message names the stage and `client.fix` carries a copy-pasteable command |
| `failed` | the client was not reachable yet, or a click was not confirmed — retried in 30 minutes |

A `failed` answer carries **no** `until` on purpose: that is what makes the host
come back. Only after four failed tries does the day settle, so a machine whose
client stays closed does not burn 48 attempts.

### 做任务 领额度 (the four +100 tasks)

The page also lists tasks worth **+100 each**. Each is judged server-side by a
`campaign_type` — whether the matching feature was really used — not by text
matching and not by "a message was sent":

| task | campaign_type | what actually credits it | plugin |
|---|---|---|---|
| 豆包可以帮你完成复杂任务 | `WorkTaskMode` | a real artifact from the 新工作任务 flow | ✅ 已验证 +100 |
| 调用技能完成一项办公任务 | `SkillUsed` | a concrete skill invoked (`doubao-academic-polish`, …) | ✅ 已验证 +100 |
| 豆包帮你整理电脑资料 | `PCUsed` | 本地电脑 actually touched the machine | ✅ 已验证 +100 |
| 重要事项设置成为定时提醒 | `ScheduleSkill` | the job actually fired once | ⚠️ 会创建并触发，但本账号未计分 |

GenWord / GenExcel / GenPPT / `skill_use` work the same way, and on this account
all four already sit at **3 (已领取)** — proof that "just have the conversation"
does pay, as long as the turn really produces the artifact.

The 定时任务 row is the honest exception: driving it with a one-shot job
(「2 分钟后执行一次」) does create the job and it *does* fire 2 minutes later —
verified 2026-11-02, the 定时任务 panel showed 「本次请求是由「提醒补周报」定时任务
到时触发的」 — yet `task_status` stayed at 1 and no +100 landed. So the plug-in
still runs it (one cheap turn, no lasting hourly job), but it does not promise
that credit.

#### The route that works

Do what a person does on the activity page. It is three clicks, and the app does
the routing for you:

1. click the card's **去完成** → the popover 「试试这些灵感，快速上手」 opens;
2. pick one of its prompt chips (e.g. 生成完整的旅游攻略 PDF);
3. Doubao itself opens the right surface **with the full prompt already in the
   composer**; press send.

`openViaActivity()` automates exactly that: `data-reward-code` picks the card,
the chip title picks the prompt, and the composer is verified to hold text
before anything is sent. Typing the prompt by hand into a sidebar-selected
surface — the old approach — is what produced five zero-credit attempts: the
text landed, but the app never entered the flow the campaign measures.

After sending, `sendTask()` watches the campaign and **stops the turn the moment
`task_status` flips to 2** — the answer does not have to finish, the credit is
already banked. It also answers Doubao's clarifying question: the work-task flow
opens with 「正在询问用户」 and numbered choices instead of the composer, and
leaving that unanswered is how a task could sit at 未完成 forever while the
caller timed out and called it a miss.

Two of the four tasks touch the machine, so they are **pinned to the plugin's
own minimal prompt** instead of Doubao's recommendation (which is 「把桌面文件按
类别整理」 / 「每小时提醒我」):

| task | pinned prompt | why |
|---|---|---|
| 本地电脑 | 在桌面新建 `doubao-task-check.txt`，只写一行，不读改其他文件 | 最小副作用，可按键删掉 |
| 定时任务 | 2 分钟后执行**一次**，不重复、不按小时循环 | 不留持续烧额度的作业 |

The chip still routes them to the right surface; the text is then replaced, and
`prepareTask()` **refuses to send** if the replacement does not take. Both use
the same work conversation, so a sweep never leaves a half-finished job behind.

Verified live on 2026-11-02:

```
去完成 → chip「制作可交互的量化分析仪表盘」→ 自动填入完整提示词
发送   → task_status 1 → 2                              (+100 计分)
领奖励 → 「奖励领取失败，请稍后重试」                     ← 页面状态陈旧，未发出任何请求
刷新活动页 → 领奖励 → 领取成功                            → 900 → 1000 点, status 3
```

Note the last two lines: the page keeps a client-side snapshot of the campaign,
and a claim clicked against a stale snapshot fails **without issuing any
request**. The claim engine therefore reloads the activity page before clicking
(`refresh`, on by default). Miss that, and a finished task looks permanently
unclaimable.

```sh
node packages/doubao/tasks.mjs --sweep                 # install pass: claim, then drive every task
node packages/doubao/tasks.mjs --sweep --tasks off     # claim only, spend nothing
node packages/doubao/tasks.mjs --sweep --tasks probe   # one task, stop if it earns nothing
```

One task by hand — the prefill is free, nothing is sent:

```sh
node packages/doubao/tasks.mjs --run pc_task_complete_work_task_v2
node packages/doubao/tasks.mjs --run pc_task_complete_work_task_v2 --send
```

#### 一个必须知道的坑：Bun fetch 与 CDP 的 404

The DevTools HTTP endpoint answers **404 to any request that arrives on a reused
keep-alive connection** — first `GET /json` is 200, every later one is 404 with a
`null` body (verified 2026-11-02 with Bun). That single quirk makes a perfectly
healthy client look "not reachable" / "no debuggable page target", and it is why
`isCdpUp()` / `listTargets()` / `findChatTarget()` all send
`Connection: close`. If a future change starts reporting an intermittent
`cdp-not-reachable`, check that header first.

## Models

| id | what it is |
|---|---|
| `doubao-auto` | 自动 — the client's own model picker on its default entry (`model_item_key` `"9"`) |
| `doubao-2.1-lite` | 豆包 2.1 Lite (`model_item_key` `"seed-lite-7b"`) |
| `doubao-2.1-pro` | 豆包 2.1 Pro — shown as 升级 on a 体验套餐 account: upgrade-gated, so it stays on the account default until a paid plan is active |
| `doubao-2.1-pro-deep` | 豆包 2.1 Pro + 推理强度, i.e. the 深度思考 toggle as a separate model rather than a separate endpoint |

The ids and `model_item_key` values are reverse-engineered from the desktop
client's own control-plane traffic (`mode_switch/report` and
`thinkmode_memory_report`) — `bot_id` is constant (`7338286299411103781`) across
every consumer model and does **not** pick one. Honest limitation: the web
`/samantha/chat/completion` endpoint ignores per-message model selection (a
bogus key still returns 200 on the constant `bot_id`), so the model in practice
is the account / conversation default. `reasoning` is real — it drives
`completion_option.use_deep_think` — so a `-deep` model genuinely thinks harder
while the base model name may not change the server-side model.

All four are listed with their context and output limits, so an agent plans against
them instead of guessing. There is no endpoint to ask for the list; the account
has one model and one toggle, so a "dynamic" list here would only ever be this
table with extra ways to fail.

## What a request goes through

The agents speak Anthropic's Messages shape; this endpoint takes one turn of
text. So `lib/chat.mjs` folds the history into that turn — system prompt, then
each turn labelled, and the last user message echoed — and turns Doubao's SSE
back into Anthropic's events. Two consequences worth knowing:

- **Tool calls are not native.** A tool result reaches the model as text
  (`[tool result …]`), and a call it makes comes back as text. Agents that lean
  on structured tool use get text, not blocks.
- **Thinking is not sent as a thinking block.** An Anthropic thinking block
  needs a signature this protocol cannot give, and a made-up one is rejected
  outright. A `-deep` model's reasoning is delivered as ordinary text.

## Rate limits and bans

The endpoint is the page's, so the account is judged by the page's rules.

- `maxConcurrency: 1` is declared, so magpie queues each agent's requests
  instead of the vendor seeing several sessions at once.
- A `429` becomes a local cooldown that outlives the process; while it holds,
  the plugin sends nothing at all.
- A dead session (`401`/`403`, `710012001`, a captcha or a login wall) is
  remembered for the rest of the Beijing day, so a stale cookie costs one
  request, not ~48.

## Risks

The web protocol is undocumented and can change without notice. Using a web
account from a client that is not Doubao's own may not match its terms, and an
account can be restricted for it. Use an account you can afford to lose. If you
need Doubao models with a contract behind them, **Volcengine Ark**
(`api.volcengine.com`) is the supported route.

## Tests

```sh
HOME=$(mktemp -d) bun test      # 134 tests, no network: a local server plays Doubao
bun ../../scripts/check.mjs doubao
```

The sweep's tests inject the client, the claim engine and the task runner, so
they never launch a GUI and never spend quota; `checkin.test.mjs` additionally
pins `DOUBAO_CDP_PORT` to a dead port and sets `DOUBAO_CLIENT_AUTOLAUNCH=0`.
