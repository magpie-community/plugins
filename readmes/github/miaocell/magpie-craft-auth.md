# magpie-craft-auth

<a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-%E7%A4%BE%E5%8C%BA-FFB003?style=flat-square" alt="LINUX DO 社区" /></a>

> 感谢所有人的反馈和建议，名单见 [CREDITS.md](CREDITS.md)。

**不必把网页一直开着。** 把腾讯游点灵（CraftBuddy，`craft.qq.com`）的积分接成 [magpie](https://usemagpie.ai) 网关上的一组模型：登录一次之后，Claude Code、Codex、OpenCode 或任何走 OpenAI 兼容接口的客户端都能直接调用，消耗的是这个游点灵账号的积分。

- **登录一次就够了。** 模型调用、积分查询全走 HTTP，不依赖浏览器进程。登录用粘贴 Cookie，或让插件开一个临时窗口扫码。
- **新人送 10,000 积分，每天再送 2,000。** 账号菜单里有什么模型就出什么，混元两档现在标「限时免费」。
- **多账号。** 每次登录一个独立账号，凭据各自加密，互不干扰。
- **不要中间层。** 不需要浏览器常驻，不需要抓页面。

> **适合拿来做游戏，不适合当通用模型用。** 游点灵的模型是给游戏创作调过的，上游每一轮都会带一段「你是专属游戏制作人」的系统提示词，能力也围着工程走——它真正强的地方是站点侧的那套东西：写工程文件、跑构建、打快照、可视化调参。插件只能拿到最表层的流式对话正文，那些都碰不到。所以：拿它写游戏相关的东西顺手，当日常编程助手的替代品会很别扭；做游戏请直接用官方 [Craft MCP](#做游戏用官方-craft-mcp)，不要用这个插件绕。

## 近期更新

> 完整记录见 [CHANGELOG.md](CHANGELOG.md)，最新的在最上面。

- **说清楚它适合干什么**（`0.1.4`）。补了一节「做游戏用官方 Craft MCP」：游点灵的模型是为游戏创作调过的，上游每轮都带「你是专属游戏制作人」的系统提示词，插件又只能拿到最表层的对话正文，站点侧写工程文件、跑构建、打快照那些产物一个都碰不到。认真做游戏请走官方 `@craft_eco/craft-mcp`，这个插件只适合把免费额度接进 magpie 顺手用。
- **修了一个会把账号用废的 bug**（`0.1.3`）。每轮对话都会在账号里留一个项目，插件之前不删，堆到站点上限（50 个）后所有新对话都回 `30006`，接着并发槽位也放不掉。现在每轮结束自动删掉会话，跑完项目数回到 0。老账号建议先跑 `node test/prune.mjs` 清理存量。
- **换成游点灵官网的图标**（`0.1.2`）。之前是手绘的抽象占位，跟站点品牌没关系；现在从官网 favicon 轮廓追踪还原成矢量，紫色圆角方块配白色四角星，插件列表里一眼能认出来。
- **站点下线 GLM-5.4，清单跟着变成 4 个**（`0.1.1`）。插件本来就每次从 `/api/chathost/model-options` 现拉，不用改代码——`KNOWN` 表里留着 GLM 条目，站点恢复时会直接显示正确名称。

## 拿到的模型

模型**不是写死的**，每次登录后从账号的模型菜单现取（`/api/chathost/model-options`）。账号菜单里有什么就有什么，站点上下线模型不用改插件。

| 模型 | 扣费 | 上下文 | 说明 |
| --- | --- | --- | --- |
| `lgb-auto` | 按实际后端 | 128K | Auto，服务端按负载挑，实测会选 DeepSeek V4.1 Flash |
| `deepseek-v4.1-flash` | 最低 | 128K | 快速档，日常首选 |
| `Hy4-preview` | 限时免费 | 128K | 混元预览 |
| `Hy4` | 限时免费 | 128K | 混元正式版 |

**`Hy4-preview` 和 `Hy4` 是两个独立模型**，不是同一个的两个名字。实测各发一次，上游 `model_queue` 事件分别回报 `Hy4-preview` 和 `Hy4`，路由到不同后端；菜单里也是两条。

站点不按 token 计费，是**按轮扣积分**（一轮 1~3 分）。所以 magpie 的 `cost` 字段一律填 0 不编造价格，只有限时免费的模型带 `rate: 0` 徽章。

## 装

```sh
magpie plugin add github:miaocell/magpie-craft-auth
magpie plugin login craft
magpie provider test craft
```

在 magpie 窗口里是「插件 → 添加插件」填仓库地址，然后在「游点灵」那一行点登录。改完代码在插件页关掉再打开即可生效（宿主常驻，只改文件不重载）。

### 平台支持

| 平台 | 状态 | 登录方式 |
| --- | --- | --- |
| Windows | 完整支持 | 粘贴 Cookie / 插件开临时窗口登录 |
| macOS | 完整支持 | 同上 |
| Linux | 支持，仅「粘贴 Cookie」 | 从浏览器开发者工具复制 Cookie |

Linux 上对话、流式回复、积分查询都能用——这些只依赖 `https://craft.qq.com`。「用浏览器登录」那条路要按 Chrome / Edge 的安装路径找可执行文件，那些路径只覆盖 Windows 和 macOS，硬做只能靠猜，所以 Linux 上直接不显示这项。

## 登录

两条路，都不需要常驻浏览器：

| 方式 | 说明 |
| --- | --- |
| 粘贴 Cookie | 从开发者工具复制，最省事，所有平台都能用 |
| 用浏览器登录 | 插件自动开一个带调试端口的临时窗口，你登录后自动抓取，然后关窗删临时目录 |

**粘贴 Cookie 时不能用 `document.cookie`。** 登录态在 `jwt_token` 这个 HttpOnly cookie 里，JS 读不到。正确取法：F12 → Network → 随便点一个 `/api/...` 请求 → 请求头 → `Cookie` 整段复制。

**导入后与浏览器解耦。** 登录那一刻就把 Cookie 存进插件自己的保管库（Windows 用 DPAPI），此后浏览器退出登录、切号、甚至卸载，已导入的账号照常工作。只有 Cookie 在服务端过期（通常几个月）才需要重新登录。

非 Windows 的保管库是明文落盘，靠目录权限保护。DPAPI 密文只有同一 Windows 用户能解，换机或换用户读不出来是预期行为；同一用户下运行的恶意程序它挡不住，别指望它更强。

**多账号。** 每次登录就是一个独立账号，凭据各自加密、互不干扰。

## 积分

新人一次性 **10,000 积分**，之后**每个自然日自动发 2,000**。

这笔赠送的机制值得说清楚：站点**没有领取按钮，也没有签到接口**。`login_grant_today` 只是 `/api/ms/points/balance` 返回的一个字段，服务端按 `point_day`（北京时间自然日）判断——只要当天认到这个账号有活跃就自动发。网页前端只是拿这个字段决定要不要弹一句「每日登录积分已到账」。

所以「每天登录就行」的真实含义是：**每天让服务端见到你一次**。用插件的话，每天跑一次对话、或者调一次 `magpie-craft_daily_grant` 就够了。同一天重复登录不会重复发。

```
可用积分                                   9,964
每日登录赠送（2026-11-25 已到账）   已发 2,000
即将过期（2026-12-23）                  5,964
```

**积分按批过期，不用就真的没了。** 额度面板里「即将过期」那栏列出每批的到期日和额度。

`magpie-craft_balance` 和 `magpie-craft_daily_grant` 两个工具都能报今天领没领到、下个自然日会发多少。

## 风控方面的处理

**同账号串行。** 游点灵一个账号同一时刻只能跑一个对话，撞上会回 `10010 并行聊天已达上限`。插件把并发限死 1。

**槽位残留自动清理。** 上一轮异常收尾（客户端提前断开、模型一直排队）后，服务端的会话槽位可能没回收，之后所有请求都会撞 10010。这种时候插件会对那个会话调一次 `POST /api/chathost/cancel` 把槽位放掉再重发——**只重试一次**，因为每轮都扣积分，cancel 之后还撞说明确实有别的对话在跑，重试只会白扣。

**排队如实上报。** 限时免费的模型高峰期会被挤满，实测见过 `ahead=32`。插件把排队状态报成 `model_queued`：前面还有几个请求，不会让你对着空白猜。

**不伪造参数。** 不做假设备指纹、不做假 referer、不刷邀请。

**不让 magpie 换账号重试。** 业务错误码都映射成明确的状态（10010 → 429、10104 → 401），不是可重试的失败。

## 一些实现细节

**接口不是 OpenAI 兼容。** 发消息是 `POST /api/chathost/send`，只入队；回复要另开 `GET /api/chathost/stream?conversation_id=&attempt=` 的 SSE 拉，两者靠 `conversation_id` 关联，`attempt` 用的是 send 返回的 `task_id`。流里 `event:message` 的 `answer` 是增量正文，`agent_event` 是它内部 Agent 的动作（读写工程文件、模型队列），混进回答会污染内容，全部丢弃。

**`X-Client-Version: 21` 和 `X-Client-Type: pc` 缺一不可。** 少了就回 `10001 请求参数错误`——这个坑很隐蔽，body 逐字对齐了还是失败，因为问题在头上。站点升级前端后如果开始报 10001，把版本号改成新的即可（从网页的请求头里看）。

**`conversation_id` 不能自己编。** 会话得先用 `POST /api/ms/conversations`（body 是 `{title, raw_description}`）建出来，服务端返回的 id 才能用在 send 里，否则回 `10006 会话不存在`。

**每个会话在账号里就是一个项目，站点对项目数有硬上限。** 实测 50 个，到顶后 `POST /api/ms/conversations` 回 `30006 已达到项目数量上限`，之后整个插件都用不了。所以插件每轮对话结束都会 `DELETE /api/ms/conversations/<id>` 把会话删掉——不发这个请求，跑几十轮就会把账号用废。

**删除比取消快，别反过来。** 收尾时先 `DELETE`，删不掉才 `POST /api/chathost/cancel` 补一刀。实测 DELETE 对「正在处理中」的会话也直接成功（几百毫秒），而 cancel 在同一个会话上会一直挂着等。

**登录态只在 HttpOnly cookie 里，但服务端直连不校验 TLS / HTTP2 指纹。** 这一点和豆包完全不同：带对 Cookie 加两个客户端头，Node 直接就能打上游，不需要浏览器，也不需要页内 fetch。

**历史消息折进 `query`。** 站点只接受一段 `query` 字符串，不收 `messages` 数组。插件把历史压成「以下是此前的对话记录…」前置进去，所以对话本身是连贯的，但站点侧每个请求都是新会话——它不会累积项目状态。

**`usage` 是估算的。** 上游不给 token 计数，插件按「中文 1 字 1 token、英文 3.5 字符 1 token」折算。真实扣费看积分，不看这个。

## 已知边界

**不支持图片和 function calling。** 上游这两样都不接受，能力声明里照实标了 `false`。图片会被降级成 `[图片已省略]` 占位文字，而不是静默丢掉。

**每轮按积分扣，不做自动重试。** 一个请求对应一次扣费，失败了宁可报错让你决定（唯一的例外是 10010 清槽位后重试一次，那次不产生新扣费）。

**模型清单由站点决定。** 站点下线了 `GLM-5.4`，插件里就跟着消失。这不是 bug。

## 做游戏用官方 Craft MCP

游点灵官方有 MCP：`@craft_eco/craft-mcp`，站点里点「Craft MCP」就能拿到装到 IDE 的提示词。它是给外部 Agent 用的，能力比这个插件厚一层——在你的工程里构建、实际运行、检查资源，然后把 `index.html` 为入口的成品上传到 Craft 私有草稿（一个项目 2,000 个文件、单文件 8 MiB、合计 64 MiB 上限）。上传只到私有草稿，要公开发布还得另外提审。

```sh
# Node.js 需要 22.12 或更新
npm view @craft_eco/craft-mcp dist-tags.stable --registry=https://registry.npmjs.org/
npx --yes --prefer-online @craft_eco/craft-mcp
```

装了之后在 IDE 里调一次 `craft_game_info` 确认连上 `https://craft.qq.com`。

**两条路的分工很清楚：** 想认真做游戏，走 MCP——它拿到的是工程目录、构建、预览、上传这一整条链。这个插件的价值只有一点：把账号里那点免费积分变成 magpie 网关上随便哪个客户端都能调的模型，顺手用。两者的额度是同一个账号的，不互通也不会互相抵消。

**别指望插件复刻 MCP 那套。** 那 51 秒的「工作中」背后是站点侧的 Agent 在写工程文件、跑快照，这些产物全在会话的资源库里，插件拿不到——上游 SSE 里虽然有 `agent_event`，但它只是动作摘要，不含产物。插件能做到的上限就是「一个带游戏味的对话模型」。

## 路径

| 文件 | 位置 |
| --- | --- |
| 账号保管库 | `%LOCALAPPDATA%\magpie-craft-auth\accounts.json`（Windows） |
| 登录用浏览器配置 | 临时目录 `craft-login-*`，登录完成即删 |

保管库在 Windows 上是 DPAPI 密文（`dpapi:AQAA...` 开头），其他平台是明文。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 插件入口：`config` / `auth` / `provider` / `tool` 四个钩子 |
| `lib/session.mjs` | 会话：请求封装、建会话、发消息、SSE 解析、取消 |
| `lib/chat.mjs` | OpenAI `chat/completions` ↔ 游点灵协议互转 |
| `lib/models.mjs` | 模型清单与补充信息（中文名、免费标记） |
| `lib/magpie-models.mjs` | 转成 magpie 的 `provider.models` 格式 |
| `lib/quota.mjs` | 积分余额换算成 magpie 的 usage 窗口 |
| `lib/daily.mjs` | 每日登录赠送的判断与文案 |
| `lib/cookie.mjs` | Cookie 解析与关键键校验 |
| `lib/vault.mjs` | 凭据保管库（DPAPI） |
| `lib/cdp.mjs` | 通过调试端口读浏览器 Cookie |
| `lib/const.mjs` | 常量与错误类型 |

## 开发

```sh
# 全部功能跑一遍（会真的消耗几点积分）
CRAFT_COOKIE='...' node test/e2e.mjs

# 只验证流式转发不丢字符
C='...' node test/stream-check.mjs

# 打印站点当前模型清单
C='...' node test/list-site-models.mjs

# 诊断某个模型为什么不出正文
C='...' M='Hy4' node test/diag-model.mjs

# 清理账号里堆积的项目（先演习，看清数量再加 --delete）
node test/prune.mjs
node test/prune.mjs --delete --keep 3
```

六个脚本跑一遍会真的消耗几点积分（每个脚本发一到两轮对话），别当无副作用的冒烟测试反复刷。

## 与游点灵的关系

非官方插件，与腾讯及游点灵开发方无关。上游是网页版的内部接口，站点改版可能失效。验证于 2026-11。

`craft.qq.com` 的积分是站点给账号的创作额度，不是付费订阅。用插件消耗它的方式，和你在网页上聊天没有区别，扣的还是那份额度。

## 许可

MIT。

版本号约定见 [VERSIONING.md](VERSIONING.md)，贡献者名单见 [CREDITS.md](CREDITS.md)。