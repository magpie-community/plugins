# magpie-doubao-work-auth

<a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-%E7%A4%BE%E5%8C%BA-FFB003?style=flat-square" alt="LINUX DO 社区" /></a>

把**豆包工作（Doubao Work）的订阅额度**接成 [magpie](https://usemagpie.ai) 网关上的一组模型：登录一次之后，Claude Code、Codex、OpenCode 或任何走 OpenAI 兼容接口的客户端都能直接调用，消耗的是这个豆包工作账号的积分。

不需要安装豆包工作客户端（只有「领取积分」这一步必须用它，见下文），不需要 Agent2API 之类的中间层，不需要浏览器常驻。

## 它做不到什么

这一节写在前面，因为反代类工具最容易被误解。

**不能替你签到、不能替你领积分。** 领取接口的字段名已经摸对（`campaign_item_code`），但回执固定是「领取结果确认中」，任务状态不变——还卡在一个前置校验上，详见「积分与签到」。插件会提交一次并回查，没确认就落记录、当天只查不重提。

**没有任务系统。** 账号下有 11 个任务（使用技能、生成文档、生成 PPT 等），插件能读到它们的状态，但同样不能替领，原因同上。

**没有邀请裂变。** `launch` 里的 `fission_campaign_code` 目前是空字符串。刷邀请需要批量注册、伪造设备指纹、批量绑定，这类做法会真的把账号搞死——不是技术做不到，是不做。

**不支持图片输入。** 豆包的上传入口 `/alice/resource/prepare_upload` 需要前端生成的 `a_bogus` 签名，纯 HTTP 侧造不出来。对照实测：额度、活动、模型这些接口不带签名都是 200，只有上传接口返回 404；补齐 `web_id` / `ttwid` 也没用。需要识图请用别的供应商。图片不会被静默丢弃——会返回明确的错误说明。

**不支持采样参数。** `temperature`、`top_p`、`frequency_penalty`、`seed`、`stop`、`logit_bias`、`logprobs` 豆包桌面接口没有对应字段，会被静默忽略。这不是漏做：豆包这套接口本身没有采样控制，模型行为由账号侧的配置决定。

**工具调用是模拟的。** 豆包桌面接口没有原生 tools，插件把工具定义编进提示词、要求模型按约定格式输出 JSON、回来解析成标准 `tool_calls`。能跑通，但不如原生 function calling 稳，复杂工具链建议先小规模验证。

**不保证上游稳定。** 这是客户端内部协议，豆包升级客户端可能改字段。解析器对格式变化会报明确错误码（`invalid_models` / `invalid_stream`），不会静默返回错误内容，但需要跟着改。

## 拿到的模型

模型**不是写死的**，每次登录后从账号的模型菜单现取：读 `action_bar` 里 office 模式的 `model_list`，跳过 `need_upgrade` 的条目。账号订了什么就有什么，名字后面直接带豆包的扣费倍率：

| 模型 | 倍率 | 上下文 |
| --- | --- | --- |
| 自动 | 小额免费 | 256K |
| 豆包 2.1 Lite | 限时优惠 0.01x | 256K |
| DeepSeek V4.1 Flash | 限时优惠 0.01x | 300K |
| Kimi K3.1 Pro | 0.95x | 300K |
| Kimi K3.1 Pro 高速 | 1.44x | 300K |
| Kimi K3 | 1.48x | 300K |
| GLM 5.3 | 0.80x | 300K |
| GLM 5.3 Flash | 0.08x | 300K |
| DeepSeek V4 Pro | 0.46x | 300K |

`豆包 2.1 Pro` 是 0.65x，但需要订阅，免费体验账号看不到（`need_upgrade=true`），订阅后自动出现。

**倍率越低越省额度。** `DeepSeek V4.1 Flash` 和 `豆包 2.1 Lite` 是 0.01x，跑同样的量只扣百分之一的额度，日常优先用这两个；`Kimi K3` 是 1.48x，一倍半的价。

倍率来自豆包返回的 `tag_list`（`type:2` 是纯倍率，`type:6` 是「限时优惠 0.01x」这种带前缀的）。magpie 的 `cost` 字段语义是「每百万 token 的单价」，豆包给的是相对订阅的扣费系数，量纲不同，所以 `cost` 一律填 0 不编造价格，倍率放在模型名里。

每个模型带各自的推理档位（豆包系三档、第三方五档），上下文取菜单里的真实值。豆包上新模型不用改插件。

## 装

```sh
git clone https://github.com/miaocell/magpie-doubao-work-auth.git
magpie plugin add ./magpie-doubao-work-auth
magpie plugin login doubao
magpie provider test doubao
magpie quota
```

在 magpie 窗口里是「插件 → 添加插件」填目录，然后在「豆包工作」那一行点登录。改完代码在插件页关掉再打开即可生效（宿主常驻，只改文件不重载）。

## 登录

四条路，都不强制装客户端：

| 方式 | 需要客户端 | 说明 |
| --- | --- | --- |
| 用浏览器登录豆包 | 不需要 | 插件自动开一个带调试端口的窗口，你登录后自动抓取 |
| 粘贴 Cookie | 不需要 | 从开发者工具复制，最省事 |
| 从本机浏览器读取 | 不需要 | 读 Chrome / Edge 里已登录的豆包 |
| 从客户端读 | 需要 | 装了豆包工作才有的选项 |

**导入后与客户端解耦。** 登录那一刻就把 Cookie 存进插件自己的保管库（Windows 用 DPAPI 加密，磁盘上不是明文）。此后客户端退出登录、切号、甚至卸载，已导入的账号照常工作。只有 Cookie 在服务端过期（通常几个月）才需要重新登录。

**多账号。** 每次登录就是一个独立账号，凭据各自加密、互不干扰。magpie 里可以设故障切换或轮询，`magpie quota` 分别显示每个账号的积分。

## 积分与签到

订阅额度、活动赠送额度分别显示，用积分计数：

```
订阅额度                              0 / 500 积分
活动赠送额度                        5 / 1,500 积分  不足 1%
每日签到（今日未签 · 可领 200 额度）   需在豆包电脑版领取
```

已签时变成 `每日签到（今日已签 · 连续 7 天）`。签到状态缓存 10 分钟，不会每次刷额度都去打上游。

### 签到领取：接口找对了，但还卡在一个前置校验

领取走 `POST /alice/ug/campaign/item/reward/claim/`，请求体：

```json
{ "task_id": "", "campaign_group_code": "pc_incentive_task_mvp_v3", "campaign_item_code": "daily_signin" }
```

字段名必须是 `campaign_item_code`——写成 `campaign_code` 会得到 `710010202 common invalid param`。之前一直试 `landing/checkin` 拿 `710010702`，是选错了接口。

**但回执是「确认中」：**

```json
{"data": {"biz_error": {"code": 3, "message": "领取结果确认中，请稍后重试"}, "task_status": 0}, "code": 0}
```

连续提交三次都是这个，任务状态始终 `checked_in_today: false`。不是异步延迟，而是某个前置条件没满足。已知 `daily_signin` 这条任务里没有 `task_id` 字段，猜测与它或活动侧的某个上报事件有关，尚未验证。

**当前行为：** 提交一次、回查确认；没确认就落保留记录，当天只查不重提。不会为了打通它在账号上反复试领取接口——那正是风控最敏感的模式。

## 风控方面的处理

反代类工具最容易出问题的地方在这，所以设计上有几处刻意保守。

**只读优先，写请求克制。** 签到先读状态，已签就完全不发写请求；未签才提交一次，回查没确认就落保留记录、当天只查不重提。不做「失败重试」——那正是风控最敏感的模式。

**同账号串行。** 一个账号同一时刻只跑一个对话会话，靠队列串行化。锁只覆盖「建会话 + 拿到响应头」，读流时不占锁，避免长回复堵死队列。

**缓存压掉重复请求。** 模型菜单 60 秒、失败后 10 分钟不再重试；签到状态 10 分钟；账号信息 60 秒。

**即用即焚。** 每个请求一个临时会话，结束（成功/报错/取消都算）就删并核对结果。清理记录落盘，进程被杀后下次请求前补做。跑一天下来客户端侧边栏不会堆满对话。

**不伪造参数。** 不做假设备指纹、不做假 `biz_params`、不刷邀请、不批量注册。

## 一些实现细节

**模型菜单没有前端接口。** 那份数据由网页 SSR 的 loader 在服务端取好内联进页面。前端调 `/alice/slot/action_bar_v3/brief_list` 只返回 `entry_list`（底部工具条：PPT 生成、录音这些 `coco_instruction`），`/alice/bot/action_bar_v3/brief_list` 直接 404。所以插件内置一份实测基线，登录后仍会尝试在线刷新，刷不到就用基线。

**`aid` 必须是 497858。** 用错成 1044603 会让所有请求落到另一条产品线：拿不到工作版模型菜单，`launch` 里的 `ug_campaign_info.campaign_group_code` 也是空字符串。

**读浏览器 Cookie 为什么走调试端口。** 浏览器运行时用独占锁占住 Cookies 数据库，`copyFile`、流式读、`esentutl`、`robocopy /B` 全部 `EBUSY`，VSS 快照要管理员权限。调试端口可以直接问浏览器要 Cookie，不碰文件。两个坑：`Network.getCookies` 是页面级命令，连浏览器级 websocket 会报 `wasn't found`，得先挂到 page target；不传 `urls` 参数拿到的是默认上下文，必须显式传 `https://doubao.com/`。

**流式回复按补丁语义还原。** `STREAM_CHUNK` / `CHUNK_DELTA` / `STREAM_MSG_NOTIFY` 的 block 增量拼回去，`block_type=10040` 及其子块归到 `reasoning_content`。流提前结束或没有正文就报错，不把半截回答当成功。

## 已知边界

风控验证码（`710022004`）返回 403 但保留账号；登录失效（`710012001`）返回 401，magpie 会把账号标成需要重新登录。

## 路径

| 文件 | 位置 |
| --- | --- |
| 账号保管库 | `%LOCALAPPDATA%\magpie-doubao-work-auth\vault\`（Windows）<br>`~/.config/magpie-doubao-work-auth/vault/`（macOS / Linux） |
| 登录用浏览器配置 | `%LOCALAPPDATA%\magpie-doubao-work-auth\browser-profile\` |
| 临时会话清理记录 | `%LOCALAPPDATA%\magpie-doubao-work-auth\conversations\` |

可用 `DOUBAO_WORK_VAULT` 覆盖保管库位置。每个账号一个 `.bin`，内容经 DPAPI 加密。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 插件入口：`config` / `auth` / `provider` 三个钩子 |
| `lib/models.mjs` | 模型菜单解析、倍率提取、基线兜底 |
| `lib/session.mjs` | 会话：桌面参数、Cookie jar、串行队列、模型缓存 |
| `lib/protocol.mjs` | 请求组装（历史+工具编进提示词）、回复解析 |
| `lib/stream.mjs` | 豆包事件流翻译成 OpenAI 增量 |
| `lib/chat.mjs` | chat completions 端点，含 SSE 输出 |
| `lib/lease.mjs` | 临时会话的建立与清理 |
| `lib/quota.mjs` | 额度换算、签到状态做成额度窗口 |
| `lib/checkin.mjs` | 签到状态读取（只读） |
| `lib/desktop.mjs` | 读客户端 Chromium 配置、DPAPI 解 Cookie |
| `lib/cookie-import.mjs` | Cookie 解析、浏览器库扫描 |
| `lib/cdp.mjs` | 调试端口读 Cookie、启动登录窗口 |
| `lib/sqlite.mjs` | 自写的 SQLite 页面读取器 |
| `lib/vault.mjs` | 账号保管库（DPAPI 加密） |
| `lib/errors.mjs` | 错误码映射 |

## 测试

```sh
node --test "test/*.test.mjs"
```

79 个测试，覆盖模型解析、倍率、流翻译、协议组装、额度换算、多账号隔离、Cookie 解析、串行化与签到只读保证。不需要构建，不装依赖——只用 Node/Bun 内置模块，包括自写的 SQLite 页面读取器（插件安装时不跑构建脚本，原生模块装不上）。

## 与豆包的关系

非官方插件，与豆包开发方无关。上游是客户端内部协议，随客户端版本变化可能失效。验证于 2026-11。

## 许可

MIT。
