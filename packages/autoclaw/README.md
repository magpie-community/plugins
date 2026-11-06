# @magpie-community/opencode-autoclaw-auth

[OpenCode](https://opencode.ai) / [magpie](https://usemagpie.ai) provider 插件：**AutoClaw（智谱澳龙 / OpenClaw 云端账号体系）**。

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

## 安装

```sh
magpie plugin add @magpie-community/opencode-autoclaw-auth
magpie plugin login autoclaw                   # Google / z.ai 网页登录
magpie plugin login autoclaw-cn                # 手机验证码
magpie provider test autoclaw zai_auto
magpie quota                                   # 积分余额
```

OpenCode 同样可加载（`opencode auth login`）。登录信息保存在 magpie 的 `plugin-auth.json`（600 权限）/ OpenCode 的 `auth.json`。

## 直连说明（不经本地网关）

插件**直连上游云 API**，登录/对话/刷新/积分全部自行完成：

- 对话走 `POST {host}/autoclaw-proxy/proxy/autoclaw/v1/chat/completions`（`X-Authorization` 鉴权）；
- token 过期前自动轮换（refresh token 一次一换，`auth.refresh` 钩子交给 magpie 串行化，不会双花）；
- 积分余额通过 `auth.usage` 的 `balance` 显示（纯积分制，无总量上限，细分钱包写在括号里），
  同时作为预付钱包窗口 `{ name: "积分余额", balance, unit: "积分" }` 上报（magpie ≥ v0.1.1790，
  #3950）：路由按真实余额认识和排位账号，不发明百分比，余额 0 算用完；更早的 magpie
  不认识 `balance`，账号维持原状。
  上游没有积分流水/用量接口（wallets.v2 只有余额），「本轮消耗」窗口**由本地余额差值算**：
  每次 `usage()` 记下本轮峰值，`峰值 − 当前 = 本轮已消耗`，**任何上涨**（相对上次
  观察到的余额，含从 0 回升——每日签到、礼包、兑换）都开新一轮，不等涨过旧峰值（签到常在花费
  之后到）。因为每天签到都会开新一轮，「本轮」≈「自今天签到以来」。这个窗口带
  `aside: true`，只展示、不参与路由：它的百分比是「自上次上涨以来花掉的比例」，不是池子剩余。
  `total_balance` 为 null/空串/非数时按未知处理（「积分响应异常」），不记账。
  状态按账号（键复用 `signinAccountKey`，#254：uid，没 uid 按 refresh token 哈希）存在
  `$XDG_CONFIG_HOME/magpie/autoclaw-usage.json`（或 `~/.config/magpie/`，`AUTOCLAW_USAGE_STATE_FILE`
  可改址），临时文件 + rename 写入，30 天没动的条目清走；插件更新不会丢。
  测试可用 `_internal.setUsageStatePath` 把状态文件指到临时目录。
- **国际版登录是完整本地实现**：插件在 127.0.0.1 上取官方 TokenServer 端口池中的一个端口
  （18432/19654/19723/53699，OAuth client 回调白名单；被占自动顺延）起临时服务器，内嵌引导页完成
  阿里滑块验证（`AliyunCaptcha` SDK，`ali_captcha_verify_param` 回执）→ 获取授权页 →
  自动跳转 Google/z.ai → 回调自动捕获 code，全程浏览器完成、无需粘贴；登录结束服务器即关
  （未完成时 10 分钟后自动关闭释放端口）。回调 code 必须匹配授权页下发的 `state`，其余一律拒收
  （防伪造回调劫持登录）；本地服务器的写接口仅接受 127.0.0.1/localhost 来源。

## 每日签到

两种方式，推荐用**原生签到**：

**① magpie 原生签到（magpie ≥ v0.1.1083，推荐）**：插件实现 `auth.checkin` 钩子，走 magpie 统一调度——Settings → Usage → Plugins 里每个供应商有 **Daily check-in** 开关（默认关），打开后每天每账号自动签一次（北京时间；启动 2 分钟后首查、每 30 分钟轮询，失败 30 分钟后重试），账户 Usage 卡片显示签到结果，也可 **Check in now** 手动签。

**② 旧链路自动补签（默认关）**：查额度（`magpie quota`、GUI 刷新）与 token 刷新时发现未签就补签（服务端幂等，本地按天去重、失败按小时重试）。旧版 magpie / OpenCode 宿主或偏好该行为的用户开启 `signinOnUsage`。

`magpie quota` 的额度窗口在查询成功时显示**每日签到**状态行（今日已签 ✓ / 今日未签 +N）。

> **「登录领积分」类活动奖励**：服务端只为带整套官方桌面端业务头（`X-Channel: AutoClaw20`、`X-Version: 2.2.0`、UA `AutoClaw/2.2.0 (win-x64)`、`X-Tm: win-x64`、`X-Product` 等；所有平台都按这套 Windows 指纹上报）的 `POST /userapi/v1/user-info` 记录 `autoclaw_user_active` 活跃事件——没有这次调用，这类活动就领不到（yetone/magpie#3681）。本次实测到账：国际「AutoClaw Weekly Perks」+4000、国内「AutoClaw 用户登录奖励」+5000。
>
> **只有 ① 原生签到链路会调用 `user-info`**：用当前 access token 直接请求，access token 被上游拒绝时才刷新重试；`user-info` 本身不完成每日签到，每日签到仍由 `task-complete` 完成，两者相互独立。② 旧链路补签与不执行 `checkin` 钩子的宿主（OpenCode 1.x/2.x）不会领取活动奖励。

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

## 对话网关与请求整形

AutoClaw 对话网关对请求形状有硬性要求，缺任一条都回 `406 Not Acceptable` 且 body 为空：
- **官方 system 前缀**：必须以 `You are AutoClaw. Answer the user directly and concisely.` 开头（插件会自动合并进 caller 已有的 system 消息，无 system 时补一条最小 system）
- **删除 max_tokens**：网关拒收 `max_tokens` / `max_completion_tokens`，插件会在发送前自动剔除
- **不发送 X-Harness-Type**：上游收到 `X-Harness-Type` 即报 406，已删除该残留请求头
- **改写外部 Harness 身份声明**：上游拦截 system 中包含的外部 agent 身份句（如 `You are Codex`、`You are Claude Code` 等），插件的 `unflag` 会自动将其替换为兼容措辞，避免 406 拦截

- **官方客户端指纹（国际版对话）**：国际版对话请求带官方 AutoClaw 2.0.3 桌面端（`official` 渠道）的整套请求头，取自其 AppImage 的 `dist/main.cjs`：`X-Channel: official`、`X-Version: 2.0.3`、`X-Lang: en`、`X-Client-Type: pc`、`X-Product: autoclaw`、`x_trace_id: autoclaw-desktop`、`X-Auth-Appid/X-Auth-TimeStamp/X-Auth-Sign`（`md5("100003&<秒级时间戳>&<appKey>")`，与登录/积分接口同一签名）、`X-Request-Id` = `X-Trace-Id`（每次请求一个 UUID）、`X-Session-Id`（同一对话不变的 UUID，插件由对话首条消息导出）、OpenAI SDK 6.26.0 的 `User-Agent` 与 `X-Stainless-*`。`X-Tm` 与官方 `managedPlatform()` 一致：macOS `mac`、Windows `win`、Linux `linux`（x64/arm64 相同）。网关只在**非官方指纹**旁拒收 `X-Tm: linux`（403 `forbidden`，#367）；0.2.7–0.2.11 发的 `linux-x64` 只是绕过，不是官方值。

国内版 `autoclaw-cn` 走 AutoClaw 2.1.0 managed gateway（`autoglm-acceleration-api.zhipuai.cn`）；国际版 `autoclaw` 走海外直连网关（`autoglm-api.autoglm.ai`）。两者均已通过真实调用与推理验证。

## 已知行为

- 手机号账号只认国内 host（走 managed gateway，401/403 标记登录失效）；z.ai/Google 账号只认国际 host（401/403 自动换侧重试，均拒绝时标记失效）。
- 额度用完不算登录失效：上游以 `403` + `{"code":810000,"message":"GLM-5.3 免费额度已用完,…"}` 回答时（或 403 正文说额度/余额已用完），插件转成 `429`，原样带上游文案，登录保留（`X-Magpie-Sign-In: kept`），国际版也不再换 host 重试（plugins#274）。
- 账号被封不算登录失效：上游以 `403` + `{"code":410004,"message":"The account has been banned"}` 回答时（或 code/message 字段说 banned / 封禁 / 账号异常 / 账号被冻结等），对话、刷新、积分与签到都原样带上游文案，对话转成 `403 permission_error`，登录保留（`X-Magpie-Sign-In: kept`），不再换 host 重试。其他 401/403 仍按登录失效处理。
- 上游模型白名单随版本变化，模型下线时上游返回 `400 非法模型`（原样透传错误消息）。
- refresh token 与 AutoClaw 桌面端**共用会互踢**（双方都轮换），插件账号请勿同时在桌面端登录。
- 上游偶发改协议时，`CLIENT_VERSION` / 端点路径可能需要随官方客户端更新。

## 免责声明

本包为**非官方**社区插件，与智谱 AI / OpenClaw / AutoClaw 无任何关联。实现基于对官方客户端行为的逆向分析与实测，仅供个人学习研究；使用产生的账号风险由使用者自行承担。上游协议变更可能导致插件随时失效。

### Local sign-in page ownership

The plugin waits for the loopback listener before returning its guide URL. Magpie/OpenCode opens that URL; the callback does not launch a second browser through a shell. Cancelled or expired sessions release their port; begin a new sign-in rather than reusing the old URL.

The guide distinguishes an intentional authorization redirect from the user closing the page. The redirect must keep the loopback callback alive; closing a guide before authorization still cancels it. The guide reports a disconnected or expired session explicitly.
