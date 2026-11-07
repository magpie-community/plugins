# @magpie-community/opencode-autoclaw-auth

中文 | [English](README.en.md)

[OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider 插件：**AutoClaw（智谱澳龙 / OpenClaw 云端账号体系）**。直连上游云 API，一次登录同时拿到**模型调用**与**积分额度**，支持多账号、故障切换、token 自动轮换与每日签到。

## 这个插件管什么

一个包注册两个供应商，按账号所在地分开登录、分开记额度：

| 供应商 id | 登录方式 | 上游 host | 模型引用 |
|---|---|---|---|
| `autoclaw` | Google / z.ai 网页 OAuth | `autoglm-api.autoglm.ai` | `autoclaw/zai_auto` 等 |
| `autoclaw-cn` | 手机验证码（+86） | `autoglm-api.zhipuai.cn` | `autoclaw-cn/zai_auto` 等 |

两个供应商都支持 magpie 的多账号、故障切换、token 自动轮换与积分余额显示。实测可用的 4 个在线模型为带前缀的 routeModelId（`zai_` 智谱 / `zaicoding_` coding plan）：

- `zai_auto` / `zai_auto-fast`（自动路由，支持 reasoning variants：low / high / max）
- `zai_glm-5.3-flash`（极速推理，支持 reasoning variants）
- `zaicoding_glm-5.3`（GLM-5.3 编程专项，支持 reasoning variants）

> 注：旧版中的 `zai_glm-5-turbo` 以及豆包 DeepSeek 映射 `tdpsk_deepseek-v4-flash-202605`、`tdpsk_deepseek-v4-pro-202606` 已被上游下线（调用均返回 `400 非法模型`），本版本已从模型列表中移除。

## 怎么登录

```sh
magpie plugin add @magpie-community/opencode-autoclaw-auth
magpie plugin login autoclaw                   # Google / z.ai 网页登录
magpie plugin login autoclaw-cn                # 手机验证码
magpie provider test autoclaw zai_auto
magpie quota                                   # 积分余额
```

OpenCode 同样可加载（`opencode auth login`）。登录信息保存在 magpie 的 `plugin-auth.json`（600 权限）/ OpenCode 的 `auth.json`。

**对话端点**：`POST {host}/autoclaw-proxy/proxy/autoclaw/v1/chat/completions`，`X-Authorization: Bearer <access token>` 鉴权（与登录/积分接口各自的头分开）。token 过期前自动轮换——refresh token 一次一换，`auth.refresh` 钩子交给 magpie 串行化，同一令牌的刷新在途共享（60 秒内复用），**不会双花**；轮换结果记入内存兜底，写回失败也不丢。

**积分显示的口径**：纯积分制，无总量上限，细分钱包（赠送/会员等）以 `余额行（赠送积分 500 · 会员积分 734）` 的括号形式附在 balance 字符串里，不单独成窗口。「本轮消耗」窗口的百分比是**「自上次上涨以来花掉的比例」**（峰值 − 当前），不是池子剩余；开新一轮的条件是**余额出现任何上涨**（相对上次观察值，含从 0 回升——签到、礼包、兑换），**不等涨过旧峰值**（签到常在花费之后到）。每日签到恰好每天开一轮，所以「本轮」≈「自今天签到以来」。

**国际版登录是完整本地实现**：插件在 127.0.0.1 上取官方 TokenServer 端口池中的一个端口（18432/19654/19723/53699，OAuth client 回调白名单；被占自动顺延）起临时服务器，内嵌引导页完成阿里滑块验证（`AliyunCaptcha` SDK，`ali_captcha_verify_param` 回执）→ 获取授权页 → 自动跳转 Google/z.ai → 回调自动捕获 code，全程浏览器完成、无需粘贴；登录结束服务器即关（未完成时 10 分钟后自动关闭释放端口）。回调 code 必须匹配授权页下发的 `state`，其余一律拒收（防伪造回调劫持登录）；本地服务器的写接口仅接受 127.0.0.1/localhost 来源。

## 积分在卡片上怎么显示

`magpie quota` / GUI 刷新时，每张 AutoClaw 卡片显示：

- **积分余额**（预付钱包窗口 `{ name: "积分余额", balance, unit: "积分" }`，magpie ≥ v0.1.1790，#3950）：路由按真实余额认识和排位账号，不发明百分比，余额 0 算用完；更早的 magpie 不认识 `balance`，账号维持原状。
- **每日签到**状态行（今日已签 ✓ / 今日未签（+N））。
- **本轮消耗**（aside，只展示、不参与路由）：上游没有按模型的积分流水接口（wallets.v2 只有余额），所以由本地余额差值算——每次 `usage()` 记下本轮峰值，`峰值 − 当前 = 本轮已消耗`；**任何上涨**（相对上次余额，含从 0 回升——签到、礼包、兑换）都开新一轮。因为每天签到都会开新一轮，「本轮」≈「自今天签到以来」。
- **活动积分**（aside）：账号有活动流水时末尾多一行，见下文[「每日签到」](#每日签到)一节。
- `total_balance` 为 null/空串/非数时按未知处理（「积分响应异常」），不记账。

状态按账号（键复用 `signinAccountKey`，#254：uid，没 uid 按 refresh token 哈希）存 JSON，地址优先级：`AUTOCLAW_USAGE_STATE_FILE`（显式覆盖）→ `$XDG_CONFIG_HOME/magpie/` → `$HOME/.config/magpie/`（Windows 上 HOME 常未设，改用 `USERPROFILE`，再兜底 `os.homedir()`，绝不落在盘根 `C:\.config\magpie`）→ 文件名 `autoclaw-usage.json`。写入走临时文件 + rename，30 天没动的条目清走；插件更新不会丢。测试可用 `_internal.setUsageStatePath` 指到临时目录。

## 每日签到

两种方式，推荐用**原生签到**：

**① magpie 原生签到（magpie ≥ v0.1.1083，推荐）**：插件实现 `auth.checkin` 钩子，走 magpie 统一调度——Settings → Usage → Plugins 里每个供应商有 **Daily check-in** 开关（默认关），打开后每天每账号自动签一次（北京时间；启动 2 分钟后首查、每 30 分钟轮询，失败 30 分钟后重试），账户 Usage 卡片显示签到结果，也可 **Check in now** 手动签。

**② 旧链路自动补签（默认关）**：查额度（`magpie quota`、GUI 刷新）与 token 刷新时发现未签就补签（服务端幂等，本地按北京日去重；失败无节流——下次查额度或刷新时立即重试）。旧版 magpie / OpenCode 宿主或偏好该行为的用户开启 `signinOnUsage`。

> **「登录领积分」类活动奖励**：服务端只为带整套官方桌面端业务头（`X-Channel: AutoClaw20`、`X-Version: 2.2.0`、UA `AutoClaw/2.2.0 (win-x64)`、`X-Tm: win-x64`、`X-Product` 等；所有平台都按这套 Windows 指纹上报）的 `POST /userapi/v1/user-info` 记录 `autoclaw_user_active` 活跃事件——没有这次调用，这类活动就领不到（yetone/magpie#3681）。本次实测到账：国际「AutoClaw Weekly Perks」+4000、国内「AutoClaw 用户登录奖励」+5000。
>
> **只有 ① 原生签到链路会调用 `user-info`**：用当前 access token 直接请求，access token 被上游拒绝时才刷新重试；`user-info` 本身不完成每日签到，每日签到仍由 `task-complete` 完成，两者相互独立。② 旧链路补签与不执行 `checkin` 钩子的宿主（OpenCode 1.x/2.x）不会领取活动奖励。

### 活动积分行

账号有活动流水时（领过、花过或失效过活动积分），`usage()` 返回的窗口列表末尾多一行：

```text
剩 4,000（AutoClaw Weekly Perks） · 已领 14,000 · 过期 7,711（近期）
```

- **数据来源**：`GET /agent-assetmgr/api/v1/ledgers_std?biz_app_id=autoclaw&page_size=200&wallet_scope=campaign`。服务端给每个活动开独立的 `wallet` 实例（`wallet_id`），credit / debit / expire 三种流水都带 `wallet_scope=campaign`；服务端可能忽略过滤参数，客户端按 scope 再过滤一遍。
- **剩 的算法**：按实例 `credit − debit − expire`（截 0）。入账掉出窗口的旧实例按 0 计（其失效额仍计入「过期」）——**「剩」永远不会虚高**，但窗口外的旧入账不参与计算。
- **已领 / 过期**是窗口内（最近 ~151 条、约 18 天，翻页参数无效）的合计，标注（近期）。
- **缓存**：按账号键（`signinAccountKey`）10 分钟；`checkin` 的 user-info 到达服务端时立即失效（活动可能刚到账）；读取失败不缓存（下次 `usage()` 立即重试）；协议变更（entries 非数组）按未知处理、缓存 10 分钟不重试。任何读取失败只省略该行，绝不影响余额与签到行。
- **活动行不携带 `balance`**：窗口的 `balance` 会被 magpie（≥ v0.1.1790）当作预付路由池（#3950）重复计入路由。
- **数字三位分组**（`fmtPoints`，不依赖 locale）；余额行里的细分钱包数值暂不分组。

## 配置项

旧链路的开关有**两个通道**（插件 options 优先，配置文件兜底；原生签到开关只在 GUI 的 Settings 里）：

```sh
# 通道 1：插件 options（magpie CLI）
magpie plugin options @magpie-community/opencode-autoclaw-auth '{"signin": false}'        # 关闭自动补签总开关
magpie plugin options @magpie-community/opencode-autoclaw-auth '{"signinHour": 8}'        # 只在 8:00–8:59 补签
magpie plugin options @magpie-community/opencode-autoclaw-auth '{"signinOnUsage": true}'  # 开启查额度/刷新自动补签

# 通道 2：配置文件 ~/.config/magpie/autoclaw.json（保存即生效，热读取）
cat > ~/.config/magpie/autoclaw.json <<'EOF'
{ "signin": true, "signinHour": null, "signinOnUsage": true }
EOF
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `signin` | `true` | 旧链路自动补签总开关（不影响原生 checkin） |
| `signinOnUsage` | `false` | 查额度/刷新时自动补签（默认关，交给原生开关） |
| `signinHour` | `null` | 限定补签小时：`8` = 仅当本地时间处于 8:00–8:59 时补签；`null` 不限 |
| `dump406` | `false` | 406 诊断落盘总开关（布尔值，`"false"` 字符串不算开）。开启后写入 `~/.config/magpie/autoclaw-406/`；`AUTOCLAW_406_DUMP_DIR` 环境变量可改址、且设了即开启（优先于本选项） |

## 对话网关与请求整形

AutoClaw 对话网关对请求形状有硬性要求，缺任一条都回 `406 Not Acceptable` 且 body 为空：
- **官方 system 前缀**：必须以 `You are AutoClaw. Answer the user directly and concisely.` 开头（插件会自动合并进 caller 已有的 system 消息，无 system 时补一条最小 system）
- **删除 max_tokens**：网关拒收 `max_tokens` / `max_completion_tokens`，插件会在发送前自动剔除
- **不发送 X-Harness-Type**：上游收到 `X-Harness-Type` 即报 406，已删除该残留请求头
- **改写外部 Harness 身份声明**：上游拦截 system 中包含的外部 agent 身份句（如 `You are Codex`、`You are Claude Code` 等），插件的 `unflag` 会自动将其替换为兼容措辞，避免 406 拦截
- **官方客户端指纹（国际版对话）**：国际版对话请求带官方 AutoClaw 2.0.3 桌面端（`official` 渠道）的整套请求头，取自其 AppImage 的 `dist/main.cjs`：`X-Channel: official`、`X-Version: 2.0.3`、`X-Lang: en`、`X-Client-Type: pc`、`X-Product: autoclaw`、`x_trace_id: autoclaw-desktop`、`X-Auth-Appid/X-Auth-TimeStamp/X-Auth-Sign`（`md5("100003&<秒级时间戳>&<appKey>")`，与登录/积分接口同一签名）、`X-Request-Id` = `X-Trace-Id`（每次请求一个 UUID）、`X-Session-Id`（同一对话不变的 UUID，插件由对话首条消息导出）、OpenAI SDK 6.26.0 的 `User-Agent` 与 `X-Stainless-*`。`X-Tm` 与官方 `managedPlatform()` 一致：macOS `mac`、Windows `win`、Linux `linux`（x64/arm64 相同）。网关只在**非官方指纹**旁拒收 `X-Tm: linux`（403 `forbidden`，#367）；0.2.7–0.2.11 发的 `linux-x64` 只是绕过，不是官方值。

国内版 `autoclaw-cn` 走 AutoClaw 2.1.0 managed gateway（`autoglm-acceleration-api.zhipuai.cn`）；国际版 `autoclaw` 走海外直连网关（`autoglm-api.autoglm.ai`）。两者均已通过真实调用与推理验证。

### 406 诊断落盘（默认关）

406 的上游 body 是空的，magpie 只留 token 计数——排查"FLAGGED 没盖住的那句"需要被拒请求的原文。开启（`AUTOCLAW_406_DUMP_DIR` 环境变量，或插件选项 `"dump406": true`）后，每次 406 把**改写后实际发出的** system/developer 消息（含 `model` 字段，绝无 user/assistant/tool 内容）写成一份 JSON：文件 0600、目录 0700，只留最近 10 份（按写入时间轮转，只动 `autoclaw-406-*.json` 形状的文件，不动目录里其它任何文件）。

**注意隐私**：system prompt 并非不含个人信息——harness 会把工作目录、git 状态、项目指令文件、有时还有用户邮箱放进去。这是本地 0600、默认关闭的诊断文件，但开启前应当知情。`AUTOCLAW_406_DUMP_DIR` 可指向任意已有目录（轮转只删自己写的文件）；默认目录在 Windows 的 GUI 进程（常无 `HOME`）下依次回退 `HOME` → `USERPROFILE` → `os.homedir()`。

## 已知行为

- 手机号账号只认国内 host（走 managed gateway，401/403 标记登录失效）；z.ai/Google 账号只认国际 host（401/403 自动换侧重试，均拒绝时标记失效）。
- 额度用完不算登录失效：上游以 `403` + `{"code":810000,"message":"GLM-5.3 免费额度已用完,…"}` 回答时（或 403 正文说额度/余额已用完），插件转成 `429`，原样带上游文案，登录保留（`X-Magpie-Sign-In: kept`），国际版也不再换 host 重试（plugins#274）。
- 账号被封不算登录失效：上游以 `403` + `{"code":410004,"message":"The account has been banned"}` 回答时（或 code/message 字段说 banned / 封禁 / 账号异常 / 账号被冻结等），对话、刷新、积分与签到都原样带上游文案，对话转成 `403 permission_error`，登录保留（`X-Magpie-Sign-In: kept`），不再换 host 重试。其他 401/403 仍按登录失效处理。
- 上游模型白名单随版本变化，模型下线时上游返回 `400 非法模型`（原样透传错误消息）。
- refresh token 与 AutoClaw 桌面端**共用会互踢**（双方都轮换），插件账号请勿同时在桌面端登录。
- 上游偶发改协议时，`CLIENT_VERSION` / 端点路径可能需要随官方客户端更新。

## 本地登录页的所有权（Local sign-in page ownership）

插件先在回环端口上就绪，再返回引导页 URL。magpie/OpenCode 打开这个 URL；回调不会通过 shell 再拉起第二个浏览器。已取消或已过期的会话会释放端口——请重新发起登录，不要复用旧 URL。

引导页会区分「用户主动完成授权跳转」与「用户直接关闭页面」：授权跳转必须保持回环回调存活；在授权完成前关闭引导页同样视为取消。会话断开或过期时，引导页会明确提示。

## 免责声明

本包为**非官方**社区插件，与智谱 AI / OpenClaw / AutoClaw 无任何关联。实现基于对官方客户端行为的逆向分析与实测，仅供个人学习研究；使用产生的账号风险由使用者自行承担。上游协议变更可能导致插件随时失效。
