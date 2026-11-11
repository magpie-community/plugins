# 一人公司社区 FiimeOPC · magpie 供应商插件

把 **FiimeOPC（opc.fiime.cn）** 的账号接进 magpie：粘一次浏览器 Cookie，
卡片上就有 **Token 余额**、**每日用量 / 每日上限**、**今日任务进度**，
同时插件会用这条 Cookie 自动建一把 API Key —— 站点自己的 **17 个聊天模型**（DeepSeek V4、GLM 5.2、Kimi K3 等）
当场能在 agent 里跑。每日签到（寄语墙 +1000 万 Token）也在插件里，一条命令领完。

```
额度      Token 钱包（用一点少一点，不会每日重置）+ 每日消耗上限 1 亿（北京时间 0 点重置）
模型      17 个聊天模型（站点 /v1/models 实测 22 条，其中 5 条是图像/视频生成）
登录方式  3 种（隔离浏览器窗口（自动带邀请码）/ 读取默认浏览器凭证 / 粘贴 API Key）
跑模型要  一把 API Key（`opc_sk_…`）——「粘贴 Cookie」那条路插件会自己换一把
签到      寄语墙任务：每天 1 条 ≥20 字寄语，+1000 万 Token（累计上限 30 次）
邀请码    自己的码和邀请统计也上卡片（`GET /api/invite`）：已邀人数 / 付费转化 / Token 奖励
```

> ⚠ **这个站点的两个面是两套鉴权，缺一条就有一半功能是空的。**
> 模型面 `/api/model-service/v1/*` 只认 `Authorization: Bearer opc_sk_…`；
> 网页 cookie 打过去回 `{"error":{"type":"invalid_api_key"}}`。
> 网页面 `/api/model-service`、`/api/auth/me`、签到只认 Cookie；API Key 打过去是 401。
> 所以插件的推荐用法是**粘 Cookie**：额度、模型通道、签到一次齐。

---

## 三种登录方式

| 方式 | 适合谁 | 会发生什么 |
|---|---|---|
| **浏览器登录（隔离窗口）** | 任何人（推荐） | 开一个一次性 profile 的 Chromium 窗口，打开**带邀请码的注册页**（注册页上有「已有账号？去登录」）；登录完插件从 CDP 收下 Cookie |
| **读取默认浏览器凭证** | 已经在自己浏览器里登录过 opc | 直接读默认浏览器 Cookies 的副本（只读、不开窗）；新版 Chrome / Edge 用 app-bound 加密时外部解不开，会明确提示改用隔离窗口 |
| **粘贴 API Key** | 只想跑模型 | 只够模型通道；额度 / 签到仍然要网页登录 |

「粘贴浏览器 Cookie」那条路已经删掉了 —— 它要求用户开 F12，而「读取默认浏览器凭证」能覆盖同样的场景。

## 一次到位，或者两步走

**最省事的那条：登录时选「浏览器登录（隔离窗口）」。**
插件会开一个**一次性 profile** 的 Chromium 窗口 —— 没有扩展、没有书签、没有你其他网站的登录态，
也不读写你日常浏览器的任何数据。你在窗口里正常登录 opc.fiime.cn，**别关窗口**，
插件从 CDP 读走 `ANASID` + `opc_sid`，然后关窗、把临时目录整个删掉。全程不用碰 F12。

拿到 Cookie 之后，三条路（隔离窗口 / 粘贴 Cookie）做的是同一件事：

1. 用 Cookie 读额度（总余额 / 任务进度；用尽时提示恢复时间）
2. 用 Cookie 在站点上创建一把 API Key（`POST /api/model-service/keys`）并落盘到 `~/.cache/magpie/`
3. 把这条 key 交给模型通道

**不想开浏览器、也不想登**：登录时选「粘贴 API Key」，从
<https://opc.fiime.cn/zh-cn/model-service> 的「创建 API Key」拿一把 `opc_sk_…` 粘进去。
额度卡片会明确说「这条凭据只有 API Key，查不了额度」，不会假装 0。

**已经有 Cookie 文本**（比如从别的机器带过来的）：选「粘贴浏览器 Cookie」，
格式 `ANASID=…; opc_sid=…`（带不带 `ANACCOUNT` 都行 —— 实测只凭前两个就能打通额度与账号接口）。

## 登录之后会自动做什么

「浏览器登录」成功的那一刻，插件在后台做两件事（不阻塞登录结果）：

1. **建/复用一把 API Key** —— 模型通道立刻就绪（`POST /api/model-service/keys`，secret 落盘到 `~/.cache/magpie/`）。
2. **跑今天的每日任务** —— 但**只在状态允许时才动手**：

| 站点状态（`benefits.tasks[]`） | 插件动作 | 花不花 Token |
|---|---|---|
| `claimed: true` | 跳过 | 0 |
| `completed: true` 且 `claimable: true` | **只领取**，不重发内容 | 0 |
| `completed: true` 但不可领 | 跳过（内容在审核/未结算） | 0 |
| `limitReached` / `quotaAvailable: false` / `enabled: false` | 跳过 | 0 |
| 一条都没做过 | 才发布：寄语 + 帖子 + 项目 | 0（用内置文案，不调模型） |
| —— | **领到奖励后立刻删掉模板内容**（帖子 / 项目 / 需求） | 0 |
| `requirement_publish` 且实名未通过 | 跳过（连请求都不发） | 0 |

**模板内容不留在站上。** 帖子、项目、需求发布后，插件会先领奖励、再 `DELETE` 掉
（顺序写死在 `src/tasks.mjs` 里并有测试锁住 —— 先删会让任务变回「未完成」，就领不到了）。
寄语例外：它是签到本身，删掉会让当日进度回退。想保留就设 `"keepPublished": true`。

内置文案池按日期轮换（10 条寄语 / 5 条帖子 / 2 个项目模板），项目封面是随包发布的 3.6 KB PNG。
**默认不调模型** —— 用模型写内容换一份固定奖励不划算；想开就在选项里设 `"useModel": true`。

真机验证（2026-11-03，当天 3 条任务已领）：跑一轮的输出是
`已领 3，跳过 1`，`reward: 0`，没有任何一次发布请求。

## 功能

- **Token 余额上卡片**：钱包型窗口显示 `wallet.balance`（实测 2000 万起）。
  余额不会每日重置 —— 重置的只有「今天还能花多少」。
- **卡片只报总余额**：一格「Token 余额」，数字就是 `wallet.balance`（账号里还剩多少 Token）。
  **不写每日上限** —— `usage.dailyLimit`（实测 1 亿/天）是站点内置的「今天最多能花多少」，
  几乎永远用不完，写上去只会让进度条永远满格。只有**真的用尽**当日额度时，才多一行
  「已用尽 · N 小时后恢复」，其余时候连「上限」两个字都不出现。
- **今日任务进度**：4 个每日任务（寄语墙 / 搭子广场发帖 / 资源中心项目 / 需求中心）
  领了几个、还剩哪些，一行文字写在卡片上。
- **自己的邀请码上卡片**：一格「邀请码」显示 `GET /api/invite` 读到的码，
  有邀请记录时后面跟着「已邀 N 人 · 付费 N · 奖励 N Token」；
  查不到就整格不出现（不影响别的行）。分享用的注册链接是 `/register?invite=<code>`。
- **17 个聊天模型，能力照模型自己的声明**：`image` / `toolcall` 来自站点 `/v1/models` 的
  `modalities` 与 `capabilities`，不是猜的；`deepseek-v4-pro` 这类能收图的不会被标成纯文本，
  `glm-5-2` 这类纯文本的也不会被误标成能收图。
- **每日任务执行器**：4 条任务（寄语墙 / 发帖 / 项目 / 需求）按状态位逐个判断，
  已领的跳过、已完成可领的只领、没做过的才发布；需求任务实名没通过时直接跳过。
- **上下文窗口不猜**：站点不返回上下文长度，插件只在宿主缓存里查得到时才写，
  查不到就省略（猜大了 agent 会以为放得下，猜小了浪费容量）。
- **三态降级**：`/v1/models` 整个失败 → 退回静态表；单条模型缺字段 → 不列；
  登录失效 → `signIn: "expired"`，让 magpie 提示重新登录。

## 模型

站点 `/api/model-service/v1/models` 实测（2026-11-04）返回 21 条：16 条 `type: "text"`
（插件列这些），5 条图像 / 视频生成模型（`opc-image-*`、`opc-video-*`、`sensenova-u1-fast`，插件不列进 chat）。

> ⚠ `deepseek-v4-1-flash-1017` 已被站点**从目录里下线**（2026-11-04 实测：目录里 21 条没有它，
> 请求它回 `404` + 站点 SPA 的 HTML 落地页）。插件已把它从静态表删掉；如果你之前在 magpie 里
> 选过它，到供应商编辑器里换成下面任意一个仍在线的模型即可。

| 模型 | 能收图 | 工具 | 站点倍率 |
|---|---|---|---|
| `deepseek-v4-pro` | ✓ | ✓ | 5x |
| `deepseek-v4-flash` | ✓ | ✓ | 3x |
| `deepseek-v4-flash-0731` | ✓ | ✓ | 2x |
| `kimi-k3` | ✓ | ✓ | 5x |
| `mixmodel` | ✓ | ✓ | 10x |
| `sensenova-6-8-flash-lite` | ✓ | ✓ | 5x |
| `glm-5-2` / `glm-5-2-l` | ✗ | ✓ | 2x |
| `qwen3-8-27b` | ✗ | ✓ | 2x |
| `dots-3-note-preview` | ✗ | ✓ | 3x |
| `north-mini-code` | ✗ | ✓ | 1x |
| `laguna-xs-2-1` | ✗ | ✓ | 1x |
| `nemotron-3-ultra-550b-a55b` | ✗ | ✓ | — |
| `space-bunny-alpha` | ✗ | ✓ | — |
| `opc-txt-v1` / `opc-txt-v2` | ✗ | ✓ | 2x |

「倍率」是站点自己的 `rateMultiplier`：同一个问题用 `mixmodel` 消耗的 Token 是 `north-mini-code` 的 10 倍。
插件不据此改任何计费字段（`cost` 一律写 0），只把它写进模型的 `rate` 供参考。

## 签到

站点把「签到」做成了一个每日任务：**寄语墙发送寄语**（`message_wall`）。

- 要求：一条 20–160 字的寄语，审核通过后发布
- 奖励：`+10,000,000` Token（固定值）
- 频率：每天 1 次，北京时间 0 点重置
- 上限：累计 **30 次**（`maxClaims: 30`）—— 是总量，不是每日
- 实测：发布后 `completed` 与 `claimable` 立即为真，可以马上领；
  同一天第二次 `POST /benefits/claim` 返回 `409 already_claimed`

另外三个任务（发帖 / 项目 / 需求）同样每天各一次，插件只在卡片上显示进度，
不替你发帖 —— 那些是公开内容，交给用户自己决定。`requirement_publish` 还需要实名认证，
没通过时站点会直接回 `{"error":"请先完成实名认证"}`。

## 邀请

站点的邀请机制是**注册时**带码：`https://opc.fiime.cn/register?invite=<code>`，
注册完成后你会挂到邀请人名下。**老账号在登录 URL 上带码没有任何效果**（实测），
事后也补不了 —— 所以「用谁的码」必须在打开注册页之前就定下来。

「用谁的码」由一个**开关**决定，不是登录页上填：

> 供应商编辑器 →「插件选项」 → **邀请码挂到首选账号**

| 开关 | 模式 | 用谁的码 |
|---|---|---|
| **关**（默认） | 自动 | 跟随**上一个注册成功的新号**；一个都没有时用内置默认码（作者的码） |
| **开** | 首选 | magpie 账号页「**首选**」那个账号自己的邀请码；它还没记下码时回落自动 |

- 开关是 magpie 自己的 `auth.options`（与 workbuddy 的「Free models only」同一套机制），
  拨一下**立刻生效、不重启 host**。
- 点「邀请码注册（隔离窗口）」时，窗口上方会写明**这次挂在谁名下** ——
  和实际用的码同源，不会出现「文案说 A、实际用 B」。
- 想指定任意码：改插件选项 `inviteCode`（plugins.json 里的 JSON 配置）或内置的 `DEFAULT_INVITE`。
  magpie 的插件选项值**只存布尔**（`settings.PluginOptions` 是 `map[string]map[string]bool`），
  做不了「填一个码」的控件 —— 这也是 0.1.3 把登录页那个文本框拆掉的原因。
- 卡片上的「邀请码」一格是**你自己账号**的码（`GET /api/invite`，带已邀人数 / 付费转化 / Token 奖励）；
  它和上面「用谁的码」是两件事，别混。

自动模式为什么是「上一个注册成功的新号」而不是「上一个登录的号」：
重登一个旧号、或者签到轮到一个旧号，都会让下一次注册挂回旧号名下 —— 那个号可能早就不该再接人了。
所以**只有注册成功那一刻**才更新这个落点（`opc-invite-registered.json`）。

升级说明（0.1.2 → 0.1.3）：登录页里那个邀请码文本框没了。之前手填过的码还留在
`~/.cache/magpie/opc-invite.json`，作为自动模式的兜底继续生效（没有注册记录时才用它）。

## 安装

在 magpie 里：**插件 → 添加插件 → 填仓库地址**。

```bash
magpie plugin add github:MYCF711/magpie-opc-auth
magpie plugin login opc      # 选「浏览器登录（隔离窗口）」，在弹出来的窗口里登录一次
                             # 新用户也可以选「邀请码注册（隔离窗口）→ 自动登录」
magpie quota opc             # 看 Token 总余额
magpie models                # 确认 opc/* 模型出现在列表里

# 签到在应用的供应商页 —— 点这张卡上的「签到」；
# 想让它每天自动签到，打开对应设置项（magpie 的每日签到开关）。
```

装完在应用的 **供应商** 页能看到 `一人公司社区 FiimeOPC` 这一行。

### 选项（可选，全部有默认值）

```json
{
  "cookie": "",                    // 不通过登录界面时，直接把 Cookie 写在这里
  "apiKey": "",                    // 直接用一把已有的 API Key
  "autoKey": true,                 // Cookie 登录时自动创建/复用 API Key
  "keyName": "magpie-opc-auth",    // 自动创建的 key 的名字
  "checkinTask": "message_wall",   // 签到用哪个任务
  "checkinText": "",               // 签到文案；留空用内置池按日期轮换
  "inviteCode": ""                 // 覆盖内置的默认邀请码；留空 = 用插件内置的那个
}
```

多数人不需要填任何一项。

## 常见问题

**1. 为什么模型能聊，额度条却是空的？**
你粘的是 API Key。额度接口只认浏览器 Cookie，再走一次「浏览器登录（隔离窗口）」就好；
两条凭据可以同时挂在同一个供应商下，卡片会优先显示能查额度的那条。

**2. 为什么额度正常，模型列表却报「登录已失效」？**
反过来了：你只有 Cookie，而插件创建 API Key 失败（比如站点改了这个接口，或者达到 5 把上限）。
到 <https://opc.fiime.cn/zh-cn/model-service> 的「创建 API Key」手动建一把，再粘进来。

**3. Cookie 多久过期？**
站点给的 `opc_sid` 有效期 7 天、`ANASID` 是会话级；服务端**不滑动续期**（响应里没有 `Set-Cookie`）。
过期后卡片会写「登录已失效（Cookie 过期）」，重新复制一次即可。

**4. 签到说「今天已领取」？**
站点 0 点按北京时间重置。`done` = 今天已经领过，明天再来。

**5. 签到时说「审核未通过」？**
站点对寄语有一条自动审核（返回 `analysis.status` 与 `reason`）。插件不重试被拒的内容 ——
换一条文案再来，或者在选项里写死 `checkinText`。

**6. 为什么卡片上有个「今日任务」却没有进度条？**
那是纯文字窗口：任务进度没有「上限」可算占比。它不参与智能路由（`textOnly: true`），
路由只看 Token 余额窗口。

**7. 这些模型倍率会不会影响卡片上的余额？**
不会。余额是站点自己扣的，插件只读。倍率只影响同一句话在不同模型上扣多少。

**8. 邀请码填在哪？我在登录页 URL 上加 `?invite=` 怎么没用？**
邀请码只在**注册**时生效（`/register?invite=<code>`），老账号带码没有任何效果，事后也补不了。
用登录方式里的「邀请码注册（隔离窗口）→ 自动登录」，或者自己打开注册页带码注册。
想看**自己**的邀请码就在卡片上找「邀请码」那一格（需要 Cookie 凭据）。

## 参考源

| 来源 | 用了什么 |
|---|---|
| FiimeOPC 站点前端（`/assets/ModelService-*.js`、`MessageWall-*.js`、`index-*.js` 的 `secInvite*` 文案） | 接口路径、请求体字段、claim 的 `{task}` 形状、寄语 `check` → `publish` 两段流程、注册页的 `inviteCode` 字段 |
| 真实账号实测（2026-11-03） | `wallet` / `usage` / `benefits` 字段、模型 22 条与能力、`opc_sk_` 前缀、cookie 7 天、签到 30 次上限、409 已领取、`/api/invite` 的 `code` / `url` / `invitedCount` / `paidCount` / `tokenReward*` |
| [`MYCF711/magpie-plugin-scaffold`](https://github.com/MYCF711/magpie-plugin-scaffold) | 仓库结构、九钩子装配、`src/quota.mjs` / `usage-cache.mjs` / `model-context.mjs`、检查与打分脚本 |

实现细节、协议取证与「为什么这么写」在 [docs/internals.md](./docs/internals.md)。

## 许可

MIT。见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
本项目与 FiimeOPC 官方无关，是社区插件。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)
