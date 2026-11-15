# opencode-xiaoyiwork-auth

在 **magpie**（以及 OpenCode）里使用你**自己的**小艺Work（华为小艺 Celia）账号的模型：
DeepSeek-V4、DeepSeek-V4.1、GLM-5.3、GLM-5.3-Flash、Kimi K3.1 Pro、MiniMax M3.1、openPangu-2.1、Auto-Model。

- 两种登录方式：**免输入读取本机小艺Work 登录态**，或**浏览器华为账号登录**（不需要装 App）
- 凭据 7 天自动续期（网关代刷 + 重新签票），不需要小艺Work 常驻
- 同一账号只允许一个，两种方式混用也不会重复添加
- 支持流式、工具调用（function calling）、思维链（`reasoning_content`）、用量/额度展示

```
$ magpie plugin add opencode-xiaoyiwork-auth
$ magpie plugin login xiaoyiwork
$ magpie provider test xiaoyiwork
  ✓ chat       450 ms · LLM_DeepSeekV4_Think
$ magpie quota
  xiaoyiwork · 小艺体验版 · AI 点 200 · 首月权益包 剩余 1000（12-16 到期）
```

之后任何 agent 都能用 `xiaoyiwork/LLM_DeepSeekV4_Think` 这样的模型 id。

---

## 安装

magpie 应用里：**插件 → 添加插件**，填 `opencode-xiaoyiwork-auth`（npm）或本地文件夹路径。

终端：

```bash
magpie plugin add opencode-xiaoyiwork-auth
magpie plugin login xiaoyiwork      # 选 1 或 2
magpie provider test xiaoyiwork
```

OpenCode 也能直接用（它只认 `config` / `auth` / `provider` / `chat.headers`，本插件用到的都是这些）：

```jsonc
// opencode.jsonc
{ "plugin": ["opencode-xiaoyiwork-auth"] }
```

---

## 登录

### 方式 1：浏览器华为账号登录

不需要安装小艺Work。走标准 OAuth PKCE：

```
PKCE(S256) → 浏览器授权 → 本地回调 127.0.0.1:17355/auth/callback
           → /oauth2/v3/token 换 accessToken + refreshToken
           → business-credential/create 签 7 天凭据
```

⚠️ 登录要占用 **17355** 端口接回调，所以登录时**小艺Work 必须完全退出**（它会抢这个端口）。插件在开浏览器前会先探测端口，占用了会直接告诉你。

### 方式 2：读取本机小艺Work 登录态（Windows，免输入）

零输入：读注册表 `HKCU\Software\ClawDesktop\keychain` 里小艺Work 存的凭据，
用 `DPAPI` 解出 Chromium `os_crypt` 主密钥、再 `AES-256-GCM` 解开密文，拿到
`businessCredential` + `refreshToken` + `uid`，顺带算出 `deviceId`。

前提：这台机器上小艺Work 登录过一次。

> magpie 的 `api` 方式一定会先要一个 key 输入框。**随便填或直接回车**都行，插件会用自己读到的值；如果你把一整串凭据粘进去，它就改用你粘的那串（高级用法）。

### 同一账号只能有一个

两种方式拿到的 `businessCredential` 每次都不一样，magpie 只对 oauth 账号按 uid 覆盖，
所以插件自己把关：登录时直接读 magpie 的 `plugin-auth.json`，看这个 `uid` 是否已占了槽位
（`xiaoyiwork` 或 `xiaoyiwork#xxxxxx`）。

```
magpie: the sign-in failed: 账号 70086000334832078 已经添加过了，同一个账号只允许一个。
要换登录方式（比如从"读取本机登录态"换成"浏览器登录"），先在 magpie 的插件页把旧账号删掉再回来添加；
若确实需要并存，给插件开 allowDuplicate 选项。
```

删掉旧账号后判断自动失效，不会留下永久黑名单。真要并存：

```bash
magpie plugin options opencode-xiaoyiwork-auth '{"allowDuplicate": true}'
```

---

## 模型

上游真实目录按账号拉取（`provider.models` 钩子），下面是不返回时的兜底：

| 模型 id | 显示名 | 倍率 | 图片输入 | 说明 |
|---|---|---|---|---|
| `LLM_DeepSeekV4_Think` | DeepSeek-V4-Flash | 1x | ❌ | 默认，带思维链 |
| `DeepSeek_V4.1_Flash_VE` | DeepSeek-V4.1-Flash | 1x | ✅ | 复杂任务 |
| `LLM_GLM5.3` | GLM-5.3 | 8x | ❌ | 编程旗舰，**很贵** |
| `GLM_5.3_FLASH_VE` | GLM-5.3-Flash | 0.8x | ✅ | 便宜 + 能读图，性价比最高 |
| `MiniMax_M3.1_Flash` | MiniMax M3.1 Flash | 1x | ✅ | 速度/成本均衡 |
| `Kimi_K3.1_Pro_VE` | Kimi K3.1 Pro | 13x | ✅ | **灰度，默认隐藏**（见下） |
| `OpenPanguV2-Pro` | openPangu-2.1-Pro | 1x | ❌ | 鸿蒙任务增强 |
| `Auto-Model` | Auto-Model | — | ❌ | 由服务端按任务选 |

### 倍率（AI 点消耗）

`rate` 直接来自上游模型目录的 `aiPointConsumptionRatio`（`"消耗8x"` → `x8`），
magpie 的模型选择器、`magpie quota`、窗口里的额度卡片都会显示；
静态表里也写了同样的值，目录拉取失败时照样有倍率。

```bash
magpie plugin list          # 已装插件与模型
magpie quota                # 账号额度 + 各模型倍率
```

> ⚠️ 模型目录接口 `user-ability-gallery/v1/agent/user/query` **必须带 `x-prd-pkg-name` 头**，
> 否则回 `400 Parameter is not valid. Parameter is [x-prd-pkg-name]`，插件会静默回退到静态表、
> 倍率全变成 0 —— 这个坑踩过，写在代码注释里了。

### 图片输入

上游 chat 接口**原生支持** OpenAI 的 `content: [{type:"text"},{type:"image_url"}]`，
但**不是所有模型都真的看图**。用一张写着 `MAGPIE-7391` 的测试图逐个问编号，结果：

| 模型 | 实测 |
|---|---|
| `DeepSeek_V4.1_Flash_VE` | ✅ 正确读出 `MAGPIE-7391` |
| `GLM_5.3_FLASH_VE` | ✅ `MAGPIE7391` |
| `Kimi_K3.1_Pro_VE` | ✅ `MAGPIE-7391` |
| `MiniMax_M3.1_Flash` | ✅ 读出 `7391` |
| `LLM_DeepSeekV4_Think` | ❌ 答「无法识别」 |
| `LLM_GLM5.3` | ❌ 答「没有看到您上传的图片」 |
| `OpenPanguV2-Pro` | ❌ 空回复 |
| `Auto-Model` | ❌ 答「无」 |

所以插件只给**真能读图**的 4 个模型声明 `modalities.input: ["text","image"]`，
其余保持纯文本 —— 免得 agent 把图发给看不见图的模型、白花点数。

> 插件的 `fetch` 把 `content` 数组原样透传（不做 base64/URL 转换），
> 所以 agent 侧用 data URL 或图片 URL 都可以。
> 小艺Work 桌面端自己另有单独的 vision 模型做「图 → 文字描述」，
> 这条链路本插件没有复刻，直接走上游的多模态能力。

> `context` / `output` 是保守估值（这个接口不返回上下文长度），不是官方数字。

---

## 额度 / 用量

### 两个数字不是一个池子（200 和 1000 从哪来）

`auth.usage` 查的是两路**互不相干**的接口，所以会看到两个数：

| 数字 | 来源 | 含义 | 有效期 |
|---|---|---|---|
| **200** | `agentId=1` → `celiaPremiumPrivilege.aiPoints` | **会员积分池**（`freePoints` 免费 200 / `purchasedPoints` 购买 / `giftPoints` 赠送 / `compstPoints` 补偿，合计 `totalPoints`） | 上游**不给**任何重置日或有效期字段 |
| **1000** | 平台 agentId → `privilegeList[].privilegeDetail` | **权益包**（「首月权益包」）剩余的 1000 点 | 带 `expireTime`，是**作废**时间，不是按月重置 |

所以插件报成两个窗口，显示成 **剩余 / 总计**：

```jsonc
{
  "plan": "小艺体验版",
  "windows": [
    { "name": "会员积分（小艺体验版）",
      "display": "剩余 200 / 总计 200 点（免费 200）",
      "amount": 0, "limit": 200, "unit": "点" },          // amount = 已用，limit = 总量
    { "name": "首月权益包（2026/12/16 23:59 到期）",
      "display": "剩余 1000 / 总计 1000 点 · 2026/12/16 23:59 到期",
      "amount": 0, "limit": 1000, "unit": "点",
      "runsOutAt": "2026-12-16T15:59:59.000Z" }
  ]
}
```

**「总计」是估出来的，不是上游给的。** 上游**没有**发放总量字段：
会员池只有余额分解，权益包只有 `privilegeDetail` 里的「剩余积分：N」。所以插件把
**装好之后观测到的最大值**当分母，存在 magpie 配置目录的 `xiaoyi-points-state.json` 里，
按 uid + 额度名分别记录。首次读取时剩余即总计（对全新权益包是准确的），之后随消耗呈现
`剩余 / 总计` 和百分比。哪天上游真的回了发放量，这份估算就该换掉。

> ⚠️ magpie 的语义：窗口里 `amount` 是**已用**、`limit` 是总量。写反了会被算成
> 「用了 100%、剩 0」，还会给个 `holdsWhy: "clock"` 把账号当额度耗尽——实测踩过。

**关于「重置日期」**：小艺这个账号拿不到。上游只有两类时间字段——
权益包的 `expireTime`（作废）和付费会员的 `subscription.expireTime`（套餐到期）。
免费积分池没有任何 `resetsAt`/周期信息（连积分明细页对当前账号都是关的：`aiPointDetailDisplay: false`），
所以插件不编造重置日：`until` 只在真有付费订阅时给，`resetsAt` 一律不填。

> 上游这个额度接口偶发 `408 Request Timeout`。插件会重试 3 次，仍然失败就回落到
> `xiaoyi-points-state.json` 里上一次成功的结果（带一行说明），免得窗口突然变空。

**没有签到接口。** 小艺Work 主进程里 `签到` 零命中，`auth.checkin` 这个钩子不做。

想看具体到账号的输出：

```bash
magpie quota xiaoyiwork --json      # 指定的 provider
magpie quota                        # 全部（只列有可量化窗口的订阅，本插件可能不在里面）
```

GUI 里的额度卡片、`GET /v1/magpie/quotas` 读到的是同一份数据。

### 灰度模型（Kimi）默认不给选

小艺Work 的模型选择器对上游 `gray: true` 的模型是：

```js
title: m.gray ? m.disabledReason || "灰度中，暂不可选" : …
disabled: m.gray === true
```

也就是**官方自己都不让选**。所以插件默认把灰度模型整条剔除（`Kimi_K3.1_Pro_VE`）。
它的接口其实能跑（实测能正常出结果、也能读图），但按官方口径算未开放、且 13x 最贵，
想放开就：

```bash
magpie plugin options opencode-xiaoyiwork-auth '{"showGray": true}'
```

之后它会以 `Kimi K3.1 Pro（灰度）` 出现，风险自负。

### 插件选项

provider 编辑页底部「插件选项」里有两个开关（本插件在 `auth.options` 里声明，magpie 才会渲染成开关）：

| 开关 | 默认 | 作用 |
|---|---|---|
| 显示灰度测试模型 | 关 | 把上游标灰的模型（Kimi K3.1 Pro，13x）也列出来 |
| 允许同一账号重复添加 | 关 | 默认一个账号只让加一次，打开才能给同一 uid 建第二个槽位 |

命令行等价写法（注意值是 **provider 嵌套**的，这是 magpie 认的形状）：

```bash
magpie plugin options opencode-xiaoyiwork-auth '{"xiaoyiwork":{"show_gray":true}}'
magpie plugin options opencode-xiaoyiwork-auth off     # 复位所有开关（回到默认）
```

> ⚠️ **改完开关，模型列表最长要等一分钟左右才变。** 这是 magpie 自己的模型缓存周期，
> 不是插件慢。想立刻看到就点编辑页的「重新获取模型」，或命令行强制拉一次：
>
> ```bash
> magpie provider models xiaoyiwork     # 输出 "✓ 8 models … · fetched just now"
> ```
>
> 判断依据看输出里的 `fetched just now` 和 `exposed of N`，别只看 `magpie plugin` 那一行（那是缓存）。

开关值的读取做过兜底：优先读 magpie 配置目录下的 `plugins.json`（编辑页和 CLI 写的就是它），
读不到再问 `input.magpie.option(providerId, key)`。之所以这样，是因为 0.1.3313 上
运行时读取会返回过期的 `false`，而且插件工厂执行时选项还没灌进来 —— 所以值必须**用到时再读**，
不能在工厂里存成常量。

> `maxConcurrency` 写在 `package.json`（默认 2）；账号上设置的上限优先。

---

凭据 7 天，`refreshLead = 12h`：快到期时 magpie 调 `auth.refresh`，插件做两步**紧挨着**的请求：

```
businessCredential ──网关代刷──> accessToken(1 小时) ──立刻签票──> 新 businessCredential(7 天)
POST /user-credential/v1/xiaoyiwork/refresh-token   {refreshToken}
POST /user-credential/v1/business-credential/create
```

`refreshToken` 只在首次登录时拿到（`--offline` 授权），之后一直用它代刷。

---

## 图标

用的是**官方小艺Work 图标**，从装机包里取的：

```
D:\software\xiaoyiwork\resources\icon.ico
  → 256×256 帧 → LANCZOS 缩到 160×160 PNG → data:image/png;base64（约 34 KB）
```

放在两个地方（magpie 的读取口径不同）：

| 位置 | 作用 |
|---|---|
| `package.json` → `magpie.icon` | 插件卡片、「已安装」那一行；供应商没有自己的图标时也用它 |
| `index.mjs` → `auth.icon` | 供应商行、账号卡片、额度卡片（优先于 `magpie.icon`） |

`index.mjs` 里没有再抄一份 base64，而是启动时从 `package.json` 读回来（常量 `PLUGIN_ICON`），
所以**换图标只改一处**。实测 magpie 的 `plugin-providers.json` 里 `provider.icon` 长度 = 34054。

换图标：把新的 160×160 PNG 转 base64 塞进 `package.json` 的 `magpie.icon`
（`data:image/…` 或 `https://`，≤ 1 MB）。仓库里留了 `icon.png` 作为源文件，
但它不在发布清单里（`files` 只带 `index.mjs` / `README.md` / `LICENSE`）。

---

## 逆向要点（自己维护时看这里）

这些是踩过的坑，改代码别踩回去：

1. **只吃 SSE**。`accept: application/json` 会 `406`，非流式请求必须在插件里自己聚合成一个 `chat.completion`。
2. **没有 `[DONE]`**。上游发完 `finish_reason` 就断流，插件必须补 `data: [DONE]`，否则不少客户端一直挂着等。同时把上游的 `id: N` SSE 行去掉、补 `object`/`created`/`model`。
3. **accessToken 有"新鲜度"窗口**（实测 0 分钟可用、5 分钟就 `400 clientId is invalid`）。所以「代刷」和「签票」不能拆开做，也不能缓存 token 复用。
4. **签票会作废旧票**。每次 `business-credential/create` 成功，上一张立刻变废票（`401 authFailed`）。这就是为什么本仓库配套的网关会把新票**写回**小艺Work 的注册表 —— 不写回的话，App 手里那张就被顶死了。
5. **`deviceId` 是"已登记设备"校验**，不是随便算的：真实值 = `sha256(MachineGuid).hex(小写) + "_" + uid`（小艺Work 首次登录时登记的）。伪造值即使 token 新鲜也报 `clientId is invalid`（错误信息骗人，其实是设备校验）。
   → 这就是**方式 2 只能在 Windows、且本机 App 得登录过**的原因：它复用已登记的那台设备。
6. **OAuth 的 `refresh_token` 走不通**：`400 {"error":1101,"error_description":"missing required parameter: client_secret","sub_error":20171}`。App 是机密客户端、密钥在服务端，所以只能走网关代刷。
7. 请求头三件套：`businessCredential` + `x-uid` + `x-device-id`，外加 `x-request-from: xiaoyiWork`、`x-businessId: WINPC_XIAOYI_WORK`。
8. Chrome/Edge 往 `127.0.0.1:17355` 会做空闲预连接；登录回调服务器**不能**等 `server.close(cb)` 才继续，否则浏览器那条空闲连接会让流程卡死——先 resolve 再 `closeAllConnections()`。
9. **模型目录必须带 `x-prd-pkg-name: com.huawei.hmos.vassistant`**，缺了就 400，倍率/真实模型表全丢（静默回退，很难发现）。
10. **图片输入要按模型声明**：接口接受任何模型的 `image_url`，但只有 4 个模型真能读图，其余会回"没看到图片"。谎报 `modalities` 只会让 agent 白花点数。
11. **`gray: true` = 官方禁用**，不是"能用但标灰"：渲染层就是 `disabled: true` + 「灰度中，暂不可选」。插件的 `status` 一旦写成 `'deprecated'` 会被 magpie 隐藏，正好用来实现这个默认行为。

---

## 限制

- **方式 2 仅 Windows**（要读注册表 + DPAPI）。其它平台用方式 1，且该设备需在账号名下登记过（一般需要先在 Windows 的小艺Work 登录一次）。
- 模型额度走**你账号的 AI 点**，插件不代付。GLM-5.3（8x）/ Kimi（13x）很贵，注意看倍率。
- 单账号并发建议低（默认 `maxConcurrency: 2`），上游对同一账号并发敏感。
- `context`/`output` 是估值；`gray: true` 的模型会被标为 `deprecated` 隐藏。
- 这是**非官方**插件，接口随时可能变；坏了按上面「逆向要点」重抓一次即可。

## 隐私

- 插件只把请求发往 `hag-drcn.op.dbankcloud.com`（华为小艺自己的网关），不经过任何第三方。
- 凭据保存在 magpie 自己的 `plugin-auth.json`（权限 600），插件不写日志、不外传。
- 方式 2 读取的是当前 Windows 用户自己的注册表项，需要同用户上下文（不需要管理员）。
- 授权页预检、设备 id 计算全部在本机完成。

## 许可

MIT

## 上下文长度

上游不返回窗口大小，实测约 1M tokens（针测试记录见 [docs/context-length.md](docs/context-length.md)）。插件里填 1000000。
