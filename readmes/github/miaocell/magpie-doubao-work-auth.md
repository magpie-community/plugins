# magpie-doubao-work-auth

<a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-%E7%A4%BE%E5%8C%BA-FFB003?style=flat-square" alt="LINUX DO 社区" /></a>

> 感谢所有人的反馈和建议，名单见 [CREDITS.md](CREDITS.md)。

**无需登录豆包客户端，本机无需下载豆包工作。** 把豆包工作（Doubao Work）的订阅额度接成 [magpie](https://usemagpie.ai) 网关上的一组模型：登录一次之后，Claude Code、Codex、OpenCode 或任何走 OpenAI 兼容接口的客户端都能直接调用，消耗的是这个豆包工作账号的积分。

- **不用装客户端。** 模型调用、积分查询、签到状态全走 HTTP。登录用浏览器扫码或粘贴 Cookie 即可。
- **九个模型，带真实倍率。** 账号订阅里有什么就出什么，`DeepSeek V4.1 Flash` 和 `豆包 2.1 Lite` 只要 **0.01x**。
- **多账号。** 每次登录一个独立账号，凭据各自加密，互不干扰。
- **不要中间层。** 不需要 Agent2API，不需要浏览器常驻。

## 近期更新

> 完整记录见 [CHANGELOG.md](CHANGELOG.md)，最新的在最上面。

- **短回复也能流式了**（`0.4.7`）。0.4.6 判断输出形态要攒 200 字符，短回复永远攒不够，只能等整段生成完才吐字（6-12 秒）。现在只看首字符。同时修了 `/responses` 路径不解析工具调用的问题。感谢 [@WeeZHnMin](https://github.com/WeeZHnMin) 在 [#17](https://github.com/miaocell/magpie-doubao-work-auth/issues/17) 指出。
- **流式输出修好了**（`0.4.6`）。带工具的请求之前一律整段缓冲，纯文本回复也要等全部生成完才吐字（issue #9 的「首字 15-25 秒」、#14 的「看不到工作过程」）。顺带修了 `tool_calls` 组装后没发出去的 bug。
- **客户端断开时不再空跑**（`0.4.5`）。`/responses` 链路（Codex 走这条）之前没有取消处理，用户中断后上游还会把回复生成完，白花额度。

## 拿到的模型

模型**不是写死的**，每次登录后从账号的模型菜单现取：读 `action_bar` 里 office 模式的 `model_list`，界面会带上豆包自己的扣费倍率。账号订了什么就有什么，带 `need_upgrade` 的条目会列在清单里但不暴露给客户端，订阅生效后自动出现。

| 模型 | 倍率 | 上下文 | 前置条件 |
| --- | --- | --- | --- |
| 自动 | 小额免费 | 256K | 免费 |
| 豆包 2.1 Lite | 限时优惠 0.01x | 256K | 免费 |
| DeepSeek V4.1 Flash | 限时优惠 0.01x | 300K | 免费 |
| Kimi K3.1 Pro | 0.95x | 300K | 免费 |
| Kimi K3.1 Pro 高速 | 1.44x | 300K | 免费 |
| Kimi K3 | 1.48x | 300K | 免费 |
| GLM 5.3 | 0.80x | 300K | 免费 |
| GLM 5.3 Flash | 0.08x | 300K | 免费 |
| DeepSeek V4 Pro | 0.46x | 300K | 免费 |
| Qwen 3.8 Flash | 0.05x | 300K | 订阅 |
| Qwen 4 Max | 新上线 0.47x | 300K | 订阅 |
| Qwen 3.8 Max | 0.74x | 300K | 订阅 |
| 豆包 2.1 Pro | 0.65x | 256K | 订阅（`need_upgrade`，插件当前不暴露） |

前 9 个是内置基线，任何账号都能用。后面 4 个要靠服务端下发——菜单是按账号给的，订阅账号能拿到，免费和飞书账号拿不到，就退回基线那 9 个。

**飞书登录本身不影响能不能用**，影响的是服务端给不给那批 office 模型。飞书号原本是订阅、后来过期的，模型就掉回基线那 9 个。

**菜单会随账号变。** 以后订阅生效、到期，或者豆包上新模型、调倍率，都不用改插件：菜单每次登录后从上游现取，倍率从 `tag_list` 的文案里解析。

**倍率越低越省额度。** `DeepSeek V4.1 Flash` 和 `豆包 2.1 Lite` 是 0.01x，跑同样的量只扣百分之一的额度，日常优先用这两个；`Kimi K3` 是 1.48x，一倍半的价。

倍率来自豆包返回的 `tag_list`（`type:2` 是纯倍率，`type:6` 是「限时优惠 0.01x」这种带前缀的）。magpie 的 `cost` 字段语义是「每百万 token 的单价」，豆包给的是相对订阅的扣费系数，量纲不同，所以 `cost` 一律填 0 不编造价格，倍率放在 `rate` 字段里由界面渲染成徽章。

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

### 平台支持

| 平台 | 状态 | 登录方式 |
| --- | --- | --- |
| Windows | 完整支持 | 粘贴 Cookie / 浏览器登录 / 从本机浏览器读取 / 从客户端读取 |
| macOS | 完整支持 | 同上 |
| Linux | 支持，仅「粘贴 Cookie」 | 从浏览器开发者工具复制 Cookie |

Linux 上能用的是对话、流式回复、工具调用、额度、签到，和 Windows 没区别——这些只依赖 `https://www.doubao.com`，不需要本机装豆包客户端。

Linux 上**没有**的是「浏览器登录」和「从客户端读取」这两项：它们要按 Chrome / 豆包工作的安装路径去找数据，那些路径只覆盖 Windows 和 macOS，硬做只能靠猜，所以登录菜单里直接不显示，免得点进去才失败。

Linux 的安装步骤就是上面那几行，`magpie plugin add` 会自动识别 `os` 字段。保管库落在 `~/.config/magpie-doubao-work-auth/vault/`，每个账号一个 `.bin`（AES-256-GCM 密文），旁边一个 `vault.key`（权限 600）。想换位置可以设 `DOUBAO_WORK_VAULT` 或 `XDG_CONFIG_HOME`。

## 登录

四条路，都不强制装客户端：

| 方式 | 需要客户端 | 说明 |
| --- | --- | --- |
| 用浏览器登录豆包 | 不需要 | 插件自动开一个带调试端口的窗口，你登录后自动抓取 |
| 粘贴 Cookie | 不需要 | 从开发者工具复制，最省事 |
| 从本机浏览器读取 | 不需要 | 读 Chrome / Edge 里已登录的豆包 |
| 从客户端读 | 需要 | 装了豆包工作才有的选项，数据目录留空会自动查找 |

**Linux 上只有「粘贴 Cookie」**，浏览器登录和客户端读取不显示，原因见上面的[平台支持](#平台支持)。

**「从客户端读」留空就行。** 豆包工作不同版本装的目录名不一样（见过 `Doubao` 和 `DoubaoWork` 两种，也可能在 Roaming 下），插件会把这些常见位置挨个试一遍，不用自己翻路径。如果都找不到，报错里会列出试过哪些位置，并提示两个办法：先在客户端登录一次，或者去 `%LOCALAPPDATA%` 下面找名字带 Doubao、里面有 `User Data` 的文件夹，把完整路径填进去。

读不到还有一种常见原因：**客户端装了但没登录**。插件只读客户端本地的配置，客户端自己没登录过，里面就没有可读的会话。

**导入后与客户端解耦。** 登录那一刻就把 Cookie 存进插件自己的保管库（Windows 用 DPAPI，其他平台用本地 key + AES-256-GCM，磁盘上都不是明文）。此后客户端退出登录、切号、甚至卸载，已导入的账号照常工作。只有 Cookie 在服务端过期（通常几个月）才需要重新登录。

非 Windows 的 key 单独存在同一目录下的 `vault.key`（权限 600）。它能挡住同机其他用户和误拷贝，但挡不住同一用户下运行的恶意程序——Windows 的 DPAPI 也一样，别指望它更强。

**多账号。** 每次登录就是一个独立账号，凭据各自加密、互不干扰。magpie 里可以设故障切换或轮询，`magpie quota` 分别显示每个账号的积分。

## 积分与签到

订阅额度、活动赠送额度分别显示，用积分计数：

```
订阅额度                              0 / 500 积分
活动赠送额度                        5 / 1,500 积分  不足 1%
每日签到（今日未签 · 可领 200 额度）   需去豆包电脑版领
```

已签时变成 `每日签到（今日已签 · 连续 7 天）`。签到状态缓存 10 分钟，不会每次刷额度都去打上游。

### 签到只能在豆包电脑版完成，插件绝不代签

这条实测过，结论是硬的：**网页会话签不了，而且试图代签会有代价**。

**先说代价，这是最要紧的。**

试图代签失败不是「没签上」这么简单，它会**吃掉当天的额度**。实测过程：账号当天还没签到，插件发了一次 `POST /alice/ug/campaign/landing/checkin` 拿到 `710010702`；服务端状态看起来没变（`checked_in_today` 仍是 `false`、`task_status` 仍是 `1`），但之后去豆包客户端点签到，弹的是「当前暂不符合领取条件」，今天这一次已经作废了。

也就是说：**失败写入不可回滚、不可补救，用户只能等第二天。** 所以插件在任何情况下都不发这个请求，标成只读不是保守，是唯一正确的选择。看到这条说明的人也不要再「试着签一下看看」。

**为什么 Web 侧签不了**

网页里根本没有签到按钮。走一遍：账号菜单 →「免费用豆包工作」→ 弹出的窗口写着「每天签到领 200 额度，周一额度翻倍」，下面只有一个「立即下载电脑版」按钮。页面上挂不到任何签到请求，因为压根没得点。

直接调接口一律被拒：

```
POST /alice/ug/campaign/landing/checkin  {"scene":"pc_incentive_task_mvp_v3"}
→ 710010702
```

**插件做什么**

只读状态，在额度卡片上显示：今天签没签、连续几天、能领多少额度。没签时提示「需去豆包电脑版领」。要签到就去豆包电脑版点一下。

**两个容易搞混的点**

早前这里记过「试 `landing/checkin` 拿 `710010702`，是选错了接口」，这个说法不准确——`landing/checkin` 就是客户端用的接口，Web 侧按来源被拒才是原因；换 `item/reward/claim/` 同样拿不到，只回 `biz_error.code: 3`。

另外，账号显示「连续签到 4 天」不代表 Web 能签，那 4 天是在电脑版签的。签到任务有活动组（`campaign_group_code` 非空）只说明这个账号被投放了活动，不说明 Web 侧能领。

## 风控方面的处理

反代类工具最容易出问题的地方在这，所以设计上有几处刻意保守。

**只读优先，写请求克制。** 签到先读状态，已签就完全不发写请求；未签才提交一次，回查没确认就落保留记录、当天只查不重提。不做「失败重试」——那正是风控最敏感的模式。

**同账号串行。** 一个账号同一时刻只跑一个对话会话，靠队列串行化。锁只覆盖「建会话 + 拿到响应头」，读流时不占锁，避免长回复堵死队列。

**缓存压掉重复请求。** 模型菜单 60 秒、失败后 10 分钟不再重试；签到状态 10 分钟；账号信息 60 秒。

**即用即焚。** 每个请求一个临时会话，结束（成功/报错/取消都算）就删并核对结果。清理记录落盘，进程被杀后下次请求前补做。跑一天下来客户端侧边栏不会堆满对话。

**不伪造参数。** 不做假设备指纹、不做假 `biz_params`、不刷邀请、不批量注册。

**被拦后进冷却。** 一旦收到人工验证要求，5 分钟内不再打上游，直接本地返回提示。风控按账号和出口 IP 记，验证没过之前每多打一次都可能让解除时间推后——客户端自动重试时尤其明显。

**不让 magpie 换账号重试。** magpie 默认把 403 当作「换个账号可能就好」，会连着打好几次。插件在风控错误上带 `X-Magpie-Refused` 头，明确告诉它这是拒绝而不是可重试的失败，只失败一次。

**遇到风控怎么办。** 这是豆包侧按账号投的限制，插件绕不过去，正确做法是：打开 https://www.doubao.com/chat/ 手动发一句话，完成出现的验证；如果网页端也一直提示，说明限制还没解除，等一段时间再试。不建议换着法子重试或换 IP 硬闯，那只会让限制更久。

## 一些实现细节

**模型菜单没有前端接口。** 那份数据由网页 SSR 的 loader 在服务端取好内联进页面。前端调 `/alice/slot/action_bar_v3/brief_list` 只返回 `entry_list`（底部工具条：PPT 生成、录音这些 `coco_instruction`），`/alice/bot/action_bar_v3/brief_list` 直接 404。`get_item_conf`、`input/list`、`launch.model_list` 都试过，都不是模型菜单。

所以现在的做法是拿 `/chat` 页面的 HTML 解析 `modeSelectData`。**难点在于这份数据按账号类型给**：有订阅的账号菜单里有 Qwen 4 Max / Qwen 3.8 Max / Qwen 3.8 Flash，飞书账号只有自动和 2.1 Lite 两档（飞书没有 office 的 `model_list`）。直接用它替换会让飞书账号的模型从 9 个掉到 2 个，所以插件把它和内置基线取并集，只增不减——订阅账号出 12 个，飞书账号仍是 9 个。

**`aid` 必须是 497858。** 用错成 1044603 会让所有请求落到另一条产品线：拿不到工作版模型菜单，`launch` 里的 `ug_campaign_info.campaign_group_code` 也是空字符串。

**读浏览器 Cookie 为什么走调试端口。** 浏览器运行时用独占锁占住 Cookies 数据库，`copyFile`、流式读、`esentutl`、`robocopy /B` 全部 `EBUSY`，VSS 快照要管理员权限。调试端口可以直接问浏览器要 Cookie，不碰文件。两个坑：`Network.getCookies` 是页面级命令，连浏览器级 websocket 会报 `wasn't found`，得先挂到 page target；不传 `urls` 参数拿到的是默认上下文，必须显式传 `https://doubao.com/`。

**流式回复按补丁语义还原。** `STREAM_CHUNK` / `CHUNK_DELTA` / `STREAM_MSG_NOTIFY` 的 block 增量拼回去，`block_type=10040` 及其子块归到 `reasoning_content`。流提前结束或没有正文就报错，不把半截回答当成功。

## 已知边界

风控验证码（`710022004`）返回 403 但保留账号；登录失效（`710012001`）返回 401，magpie 会把账号标成需要重新登录。

Linux 支持是后加的，目前只在「粘贴 Cookie」这条路上验过，其余功能按不依赖平台的假设实现。

## 路径

| 文件 | 位置 |
| --- | --- |
| 账号保管库 | `%LOCALAPPDATA%\magpie-doubao-work-auth\vault\`（Windows）<br>`~/.config/magpie-doubao-work-auth/vault/`（macOS / Linux） |
| 登录用浏览器配置 | `%LOCALAPPDATA%\magpie-doubao-work-auth\browser-profile\` |
| 临时会话清理记录 | `%LOCALAPPDATA%\magpie-doubao-work-auth\conversations\` |

可用 `DOUBAO_WORK_VAULT` 覆盖保管库位置。每个账号一个 `.bin`，Windows 上是 DPAPI 密文，其他平台是 AES-256-GCM 密文（key 在 `vault.key`）。

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
| `lib/vault.mjs` | 账号保管库（DPAPI / AES-GCM） |
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
