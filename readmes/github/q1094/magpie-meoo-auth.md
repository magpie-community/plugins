# magpie-meoo-auth

OpenCode & Magpie provider plugin for **Meoo 秒悟**（`meoo.com`）。本仓库是 [`Fish-under-sea/opencode-meoo-auth`](https://github.com/Fish-under-sea/opencode-meoo-auth)（npm `@fish-under-sea/opencode-meoo-auth`）的改进分支，包名 `magpie-meoo-auth`。

## 与上游的区别

上游能登录、能拉模型目录、能看积分余额；下面三件事是这一支加上去的：

| 改进 | 上游 | 这里 |
| --- | --- | --- |
| **多项目时手动选项目** | 账号下有多个项目就直接报错，回 Magpie 重登还是同一条错 | 授权回调页停下来，列出项目让你点一个（也可直接粘贴项目 id），选完在同一个回调里把 AK 取完；取不到 AK 会留在页面上说原因，换一个再试，不用重走授权 |
| **每日签到** | 没有 | 实现 magpie 的 `auth.checkin`：受控浏览器（持久 profile）headless 打开 meoo.com，在页面里打 `/api/mc/entitlement/init`，每天 2000 积分自动到账；设置里的签到按钮走同一个钩子 |
| **登录态有效期** | 没有 | 概览卡片多一行「登录态 · 还剩 29 天（2026-12-11 21:30:10 到期）」，供应商编辑页的面板列出 6 个鉴权 cookie 的逐行到期时间；只读 Chrome `Cookies` 库的 `expires_utc`，不解密 cookie 值 |

顺带改的：授权改为插件自己的受控浏览器窗口（一次登录同时拿到 OAuth 凭证和网页会话，签到才有 cookie 可用），签到结果按 magpie 的 outcome 枚举映射，缺 `playwright-core` 或有别的意外都会在卡片上说明原因而不是静默失败。积分卡、模型目录、思考强度这些上游原有的能力保持不变。

在 Magpie 的插件界面里，名字是两层：**外层短名 `Meoo`**（「已安装」那一行、插件卡片的标题、供应商卡片），**点进插件详情**看到的是 `npm · magpie-meoo-auth`（npm 发布者 + 完整包名）。这与官方插件（卡片上 `magpie 社区 · @magpie-community/…`）同一套呈现：短名由 `package.json` 的 `magpie.name` 给出（社区列表没收录时生效），详情里的包名由宿主读到的插件 spec 给出。

```json
"magpie": {
  "name": "Meoo",
  "summary": {
    "zh": "用自己的 Meoo 秒悟账号使用 Meoo 网关上的模型——浏览器 PKCE 授权、复用本机登录态或项目服务 AK，模型目录实时同步。",
    "en": "Meoo 秒悟 (meoo.com) in magpie: sign in with your own Meoo account and its gateway's models show up as one provider, with usage-billed tokens."
  }
}
```

`magpie.name` 最多 80 字节、必须单行、不能含控制或双向格式字符，否则整条忽略（回落成包名）；`summary` 按语言给一句，最多 300 字节。

作者：[@Fish-under-sea](https://github.com/Fish-under-sea)、[Chensy（elysia395）](https://github.com/elysia395)。本包由 [FISH-DOCK-Plugins PR #35](https://github.com/Fish-under-sea/FISH-DOCK-Plugins/pull/35) 的 Magpie 供应商插件落成独立 npm 包；代码源头是 [dsh-meoo-connect](https://github.com/2239058652/dsh-meoo-connect)（DeepSeek Harness 的 dsh 插件）：同一套 Meoo 官方「AI 服务」链路（OAuth 登录 → 项目服务 AK → OpenAI 兼容网关），换到 Magpie / OpenCode 的 provider 插件平面上。装好并登录后，Meoo 的模型会出现在 Magpie 的模型选择器里，也作为 OpenCode 的一个 provider。

## 模型与上下文

网关 `/models` 只回裸 id，不带上下文与输出上限，所以规格由包里那张表给出（数字取自各家官方文档，2026-11 核对）：

| 模型 | 传参值 | 上下文 | 最大输出 | 图片 |
| --- | --- | --- | --- | --- |
| Qwen3.8-Flash | `qwen3.8-flash` | 1M | 131072 | ✓ |
| Qwen3.8-Max | `qwen3.8-max` | 1M | 131072 | ✓ |
| Qwen3.7-Max | `qwen3.7-max` | 1M | 131072 | |
| Qwen3.7-Plus | `qwen3.7-plus` | 1M | 131072 | ✓ |
| DeepSeek V4.1 Flash | `deepseek-v4.1-flash-1017` | 1M | 384K | ✓ |
| DeepSeek V4 Pro | `deepseek-v4-pro-0813` | 1M | 384K | |
| DeepSeek V4 Flash | `deepseek-v4-flash-0731` | 1M | 384K | |
| GLM-5.2-Fast | `glm-5.2-fast-preview` | 1M | 128K | |
| GLM-5.2 | `glm-5.2` | 1M | 128K | |
| Qwen VL（视觉理解） | `qwen3-vl-plus` | 262144 | 32768 | ✓ |

两点和别家插件不一样，值得知道：

- **`qwen3-vl-plus` 不在网关 `/models` 里**，但 Meoo 文档给了、网关也接（实测可调）。插件拉目录时会用一次 1-token 的探针试它，接了就补进目录，否则不提——不写死一个调不通的模型。
- **目录里出现表外的新模型**按保守值给（200K 上下文 / 64K 输出、纯文本），不会把 1M 随手许出去；要正式支持就把它加进 `MODEL_SPECS`。

### 为什么 Kimi K3 / GLM-5.3 / MiniMax 没出现

Meoo 文档的「支持模型介绍」把 Kimi K3、Kimi K3.1 Pro、GLM-5.3、GLM-5.3-Flash、MiniMax M3.1 Flash、Qwen3.8-Max-0902 都算作平台模型，但**项目的 OpenAI 兼容网关只收这 9 个文本 id**（2026-11 实测，其余一律 400）：

```
当前仅支持配置模型: qwen3.8-flash、qwen3.8-max、qwen3.7-max、qwen3.7-plus、
deepseek-v4.1-flash-1017、deepseek-v4-pro-0813、deepseek-v4-flash-0731、
glm-5.2-fast-preview、glm-5.2
```

Kimi / GLM-5.3 / MiniMax 在 Meoo 的 **Agent 产品**里（`/open/v1/projects/<id>/agent/runs`，SSE 协议，不是 OpenAI 兼容），想用它们装 [`magpie-plugin-meoo-agent`](https://github.com/RexVane/magpie-plugin-meoo-agent)。两个插件可以并存：`meoo` 与 `meoo-agent` 是两个 provider id，不抢同名 key。

插件仍然会把上面这些候选逐个探一遍（并发 4 条、1 token、结果随目录缓存 10 分钟）：**Meoo 哪天在网关放开哪个，下次拉目录就自动出现**，不用等发版。

### 自己加模型

网关接了但目录没列、插件也不认识的 id，用环境变量塞进去（仍然要过那一探，不接的不进目录）：

```bash
MEOO_EXTRA_MODELS=my-model-a,my-model-b
```

未知 id 一律按 200K / 64K、纯文本处理；想给它正确的上下文，就往 `MODEL_SPECS` 里加一条。

## 余额

浏览器授权登录后，供应商卡片会带一张积分卡（控制面 `/open/v1/cli-compat/account/points`）：

```
你的账号 · 12,345 积分 · 2026-12-31 到期
已用 2,153 积分
```

按 magpie 的**预付费钱包**窗口给出：窗口只有 `balance` + `unit`、不写 `used`/`limit`，所以卡片显示数字而不是百分比条；`runsOutAt` 是最近一批还没用完的积分的到期日。手填项目服务 AK 的登录读不到积分账户，卡片会说明要用浏览器授权。

## 思考强度

模型默认带三档思考强度，对应会话 UI 里的 **快速 / 适中 / 极致**（`reasoning_effort: low / medium / high`）。网关实测该参数真实生效（low 档思考 tokens 约为 high 档的 60%~70%，`enable_thinking:false` 可完全关闭，但为避免不可控行为未暴露「关闭」档）。不选档位时走上游默认思考。

## 它是怎么做的

不自己做 LLM 适配器、不加会掉流式的中间代理——插件只准备「凭证 + 模型目录」，
真正的转发交给宿主的 `@ai-sdk/openai-compatible` SDK 直连 Meoo 网关：

```
magpie-meoo-auth
  ├─ 受控浏览器（持久 profile）        → 授权登录：OAuth 回调 + meoo.com 网页会话
  ├─ OAuth(PKCE) 登录 meoo            → access/refresh token 存宿主账号记录
  ├─ /open/v1/cli-compat/...          → 身份、项目列表、项目服务 AK（自动开通云服务）
  ├─ GET {gateway}/models             → 当前可用模型目录（10 分钟缓存）
  ├─ auth.checkin                     → 同一个 profile，headless 打 /api/mc/entitlement/init
  └─ loader                            → baseURL + apiKey(项目服务 AK) 交给宿主 SDK
                                          ↓
                       Magpie 的模型选择器 / OpenCode 的 provider 列表
```

## 登录方式（三选一）

| 方式 | 适合谁 | 要人工做什么 |
| --- | --- | --- |
| **受控浏览器授权**（PKCE，本机 loopback 自动收回调） | 大多数人 | 插件弹出自己的浏览器窗口，点一次「授权」；身份、项目、云服务 AK 全自动，meoo.com 的网页会话也留在那个 profile 里（每日签到要用，见下） |
| **复用本机登录态** | 已在用 dsh-meoo-connect 或 meoo-proxy 的人 | 无——只读 `$DSH_HOME/meoo/state.json` 或 `~/.meoo-proxy/config.json`，不会写这两个文件 |
| **手填项目服务 AK** | 不想走 OAuth / 账号下多项目想精确指定的人 | 在 meoo.com 打开项目 → 云服务，复制 `meoo_project_service_v1.` 开头的 AK 粘贴；保存前会用网关 `/models` 校验一次 |

自动链路的细节：

- access token 过期前 5 分钟自动单飞续期（并发共享一次刷新请求），续期结果写回宿主的账号记录。
- 项目没开通「云服务」时，授权登录会自动开通一次再取 AK；仍失败会提示在 meoo.com 项目的对话框里让 AI 开启（平台的设计是会话触发自动开通，没有手动按钮）。
- 账号下一个项目都没有时，授权登录会**自动创建一个项目**（默认名「AI 服务」，可在 meoo.com 改名），再继续取 AK。
- 账号下有多个项目且没设默认时，回调页会停下让你**选一个项目**（项目间计费归属不同，不替你做主）：页面上直接点列表，或在输入框里贴项目 id（`proj-a1b2c3d4` 这种 `url_id`），提交后当场把 AK 取完，登录完成。选中项目但取不到 AK（没开云服务、配额满）时同样留在那一页显示原因，换一个项目再点即可——不用回 Magpie 重新走一遍授权。
- 手填了 `meoo_ak_` 开头的用户 Key 会被明确拒绝——那是用户 Key，不是项目服务 AK。
- 授权在**插件自己的浏览器窗口**里完成（持久 profile `~/.meoo/web-profile`），不是你日常用的浏览器：一次登录同时拿到 OAuth 凭证和 meoo.com 网页会话，后者是每日签到的前提。装不上 `playwright-core` 或本机没有 Chrome/Edge 时会退回「宿主打开系统浏览器」，登录照常完成，但签到会不可用。

## 每日签到

Meoo 的每日 2000 积分**不是自动发的**：发放入口是网页端的 `GET /api/mc/entitlement/init`，只认 meoo.com 的网页会话 cookie（`oneday_sid` / `login_oneday_ticket` / `lang` 三对，前两对是 HttpOnly）。`cli.compat` 的 OAuth token 打进去是 `401 NEED_LOGIN`，`meoo` CLI 也没有签到子命令——平台就是靠「登录网页」这个动作促活，纯 token 的自动化拿不到。

插件因此实现 magpie 的 `auth.checkin` 钩子，靠受控浏览器的 profile 去签：

- **自动**：在 magpie 里为 Meoo 打开签到后，它每个北京日为每个已登录账号调用一次；
- **手动**：账号设置里的签到按钮，调的是同一个钩子。

实现方式：headless 打开同一个 profile → 访问首页 → 在页面上下文里 `fetch('/api/mc/entitlement/init', { credentials: 'include' })`。请求从页面里发出，TLS 指纹、`sec-fetch-*` 都是真的，不用手工导 cookie，也不会因为少带一个 cookie 被判成异常会话而注销。

结果怎么映射：

| 网页端返回 | `auth.checkin` 返回 |
| --- | --- |
| `dailyLoginGranted: true` + `dailyLoginGrantAmount` | `{ outcome: "claimed", credit: 2000 }` |
| `dailyLoginSkipReason: "ALREADY_GRANTED_TODAY"` | `{ outcome: "done" }` |
| `401`（profile 里没有登录态或已失效） | `{ outcome: "failed" }`，重新登录一次该账号即可 |
| 没装 `playwright-core` / 没有 Chrome、Edge | `{ outcome: "failed" }`，消息里说明原因 |

依赖 `playwright-core` 声明在 `optionalDependencies`：纯 JS、不下载浏览器（用系统已装的 Chrome 或 Edge），装不上不影响插件其他功能。profile 在 `~/.meoo/web-profile`（`MEOO_WEB_PROFILE` 覆盖），删掉等于退出登录；`MEOO_WEB_DAILY=0` 可整体关掉签到。

## 登录态还剩多久

两处都会显示：

- **概览卡片**（`auth.usage`）多一行 `登录态 · 还剩 29 天（2026-12-11 21:30:10 到期）`，`aside` 窗口，不参与路由和账号权重；
- **供应商编辑页**的面板卡片，列出 6 个 cookie 各自的到期时间。

供应商编辑页那张卡片上面一行是「还剩 29 天」，下面是参与鉴权的 6 个 cookie 各自的到期时间和剩余量。

```
29 天
到 2026-12-11 21:30:10 · 采集于 2026-11-11 21:32:47

cookie                     到期                    剩余
oneday_sid                 2026-12-11 21:30:10     29 天
oneday_sid.sig             2026-12-11 21:30:10     29 天
login_oneday_ticket        2026-12-12 02:30:10     30 天
...
```

数据来自受控浏览器 profile 里的 Chrome `Cookies` 库：只读 `expires_utc` 算到期时间，**不解密任何 cookie 值**，也不启动浏览器。宿主有 `bun:sqlite`（magpie 自己）或 `node:sqlite`（Node 22.5+）时是毫秒级；两者都没有才退回受控浏览器读一次，一小时最多一次。缺少某个 cookie 时卡片上会指出来（那就是登录态已经坏了）。

面板本身跑在沙盒里（`connect-src 'none'`，没有网络），所以数据是插件写成 `panel/state.js` 递进去的：宿主启动时写一次，之后每 30 分钟刷新，签到结束再刷一次。剩余不足 3 天时数字会变色。

## 安装

### Magpie

Magpie 的插件清单在数据目录的 `plugins.json`。这个包还没发布到 npm 时，用 git spec（跟着仓库的默认分支走）：

```json
{
  "plugins": [
    { "spec": "git+https://github.com/q1094/magpie-meoo-auth.git" }
  ]
}
```

发布到 npm 之后换成包名（`@latest` 跟着版本走）：

```json
{
  "plugins": [
    { "spec": "magpie-meoo-auth@latest" }
  ]
}
```

也可以把包解开后指向本地目录（开发用；本地目录在 magpie 里不显示版本，也不参与更新检查）：

```json
{
  "plugins": [
    { "spec": "C:\\<magpie 数据目录>\\plugins\\magpie-meoo-auth" }
  ]
}
```

改完重启 magpie：模型来源/插件列表里会出现 **Meoo**，点进去显示 `magpie-meoo-auth`，选一种方式登录即可。

### OpenCode

```bash
# 发布到 npm 后按包名加载：opencode.json 的 plugin 里写 "plugin": ["magpie-meoo-auth@latest"]
# 未发布时用本目录的绝对路径，或 "plugin": ["git+https://github.com/q1094/magpie-meoo-auth.git"]
opencode auth login   # 选 Meoo
```

也可以把本目录放进 `~/.config/opencode/plugin/`，或在 `opencode.json` 里写本目录的绝对路径。

## 配置（可选）

环境变量（Magpie 的插件进程只透传白名单变量，这两个主要用于 OpenCode/裸跑调试）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEOO_MAIN_SITE_URL` | `https://meoo.com` | OAuth/控制面站点（测试环境可换） |
| `MEOO_GATEWAY_BASE_URL` | `https://api.meoo.host/meoo-ai/compatible-mode/v1` | OpenAI 兼容网关 |
| `MEOO_PROXY_HOME` | `~/.meoo-proxy` | meoo-proxy 登录态目录（复用方式） |
| `MEOO_WEB_PROFILE` | `~/.meoo/web-profile` | 受控浏览器的 profile（授权与签到共用） |
| `MEOO_NO_BROWSER` | 未设 | `1` = 不启动受控浏览器，授权退回宿主打开系统浏览器（签到会不可用） |
| `MEOO_WEB_DAILY` | 未设 | `0` = 关掉签到钩子 |

## 排错

| 现象 | 处理 |
| --- | --- |
| 授权页 404 / unsupported_response_type | 用插件生成的授权链接，别手拼；redirect_uri 必须是本机 loopback |
| `账号下有多个项目…` | 出现在浏览器回调页时是正常的选项目步骤（点一个即可）；只在 Magpie 卡片上看到这条，说明是**运行期**取 AK（登录时已绑定项目、后来项目被删/换了）触发的，重新登录一次并在回调页选定即可 |
| `项目 xxx 还没开通 Meoo AI 服务` | 云服务/AK 没有手动按钮：在 meoo.com 打开该项目，**对话框里发「帮我开启云服务」**（或让 AI 加个带后端/AI 的功能），平台自动开通并签发 AK 后重试；若带 `QUOTA_EXCEEDED（实例数已达上限）`，先释放不用的全栈项目/实例（Free 可部署 1 个全栈项目），或升级套餐 |
| `AK 被网关拒绝 (401/403)` | 填的是用户 Key 或项目没开云服务；确认是 `meoo_project_service_v1.` 开头 |
| `401（登录态已失效）` | refresh token 失效，重新登录一次 |
| 签到 `failed`：受控浏览器里还没有 meoo.com 登录态 | 那次登录是回退成系统浏览器完成的（`~/.meoo/web-profile` 里没有 cookie），或 profile 被删了；重新登录一次该账号 |
| 签到 `failed`：缺少 playwright-core | 插件依赖没装全（`bun add` 失败、离线等）：装一次 `playwright-core` 再试 |
| 签到 `failed`：登录态失效 | profile 里的网页会话过期（约 29 天或被平台注销），重新登录一次 |
| 登录时没弹出受控浏览器 | 没装 `playwright-core`，或本机没有 Chrome/Edge；此时会退回系统浏览器，登录可用、签到不可用 |
| 模型列表是兜底清单 | 网关 `/models` 暂时拉不到（断网/AK 失效），恢复后会自动同步 |

## 状态与凭证

- 凭证（token、AK）只存在宿主的账号记录里：Magpie 的 `plugin-auth.json`、OpenCode 的 `auth.json`。插件自己不写配置文件。
- 受控浏览器的登录态落在 `~/.meoo/web-profile`（Chrome profile，`MEOO_WEB_PROFILE` 可改），那是浏览器自己的目录，只用于授权与签到。
- 「复用本机登录态」是严格只读的，不会写 dsh-meoo-connect / meoo-proxy 的文件，也不消耗它们的 refresh token 之外的东西（续期结果只写回 Magpie 自己的记录）。
- 调用消耗 Meoo 账号自身额度，插件不绕过任何计费；与 Meoo 官方无关联，是第三方集成。

## 开发

```bash
node --check index.mjs && node --check opencode.mjs && node --check web.mjs
node --test test/offline.test.mjs test/web.test.mjs   # 31 项：假 fetch + 假 client，含 PKCE loopback 全流程、多项目选择页、签到未登录分支、cookie 到期换算
```

测试会设 `MEOO_NO_BROWSER=1`，保证 `browserSignIn` 不会真去启动 Chrome。

Windows 沙箱里跑测试要关掉测试隔离（沙箱禁命名管道，`spawn EPERM`）：

```powershell
node --test --test-isolation=none test/offline.test.mjs test/web.test.mjs
```

## 作者与致谢

### 维护

- [q1094](https://github.com/q1094)：本分支（`magpie-meoo-auth`）的维护者——多项目手动选择、每日签到、登录态有效期面板。

### 上游

- [Fish-under-sea](https://github.com/Fish-under-sea)：上游 `opencode-meoo-auth`（npm `@fish-under-sea/opencode-meoo-auth`）的独立包化、仓库与发版，外层显示名（Meoo）与包名呈现，模型规格表与积分余额卡。

### 上游作者

- [Chensy（elysia395）](https://github.com/elysia395)：本插件的 Magpie 供应商插件形态与实现，见 [FISH-DOCK-Plugins PR #35](https://github.com/Fish-under-sea/FISH-DOCK-Plugins/pull/35)。这个 npm 包就是该 PR 里的插件本体，作者同为上游作者之一。
- [2239058652/dsh-meoo-connect](https://github.com/2239058652/dsh-meoo-connect)：Meoo OAuth(PKCE)、控制面（身份 / 项目 / 云服务 AK）、网关模型目录的原始实现。`index.mjs` 的登录与取 AK 链路由这里移植而来。
- [sangonomiya249/dsh-meoo](https://github.com/sangonomiya249/dsh-meoo)（基线 `cf77e92`）：dsh-meoo-connect 的上游，版权归其作者所有。
- [magpie-community/plugins](https://github.com/magpie-community/plugins)：`opencode2.mjs`（OpenCode 2.x 适配层）整份取自该仓库，按「每个包携带同一份字节」的约定未做修改。
- [yetone/magpie](https://github.com/yetone/magpie)：供应商插件契约（`config` / `provider.models` / `auth`）、`magpie.name` 与预付费钱包窗口的宿主实现；「外层短名 + 详情包名」的呈现由它决定。

### 资料出处

- Meoo 秒悟官方（[meoo.com](https://meoo.com) / [docs.meoo.com](https://docs.meoo.com)）：AI 服务协议、模型清单，以及本包规格表里的上下文与输出上限。本项目是第三方集成，与官方无隶属关系。

### 相关但不同的项目

- [RexVane/magpie-plugin-meoo-agent](https://github.com/RexVane/magpie-plugin-meoo-agent)：走 Meoo 的 Agent 接口（`/open/v1/projects/<id>/agent/runs`），覆盖 Kimi K3、GLM-5.3 等本插件网关调不到的模型。两者 provider id 不同（`meoo` 与 `meoo-agent`），可同时安装。

各上游的许可证与使用范围见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## License

MIT
