# agent2api-plugin-astudio

AStudio（讯飞星辰 Agent Studio）作为 [agent2api](https://github.com/zp-innovation/agent2api) / magpie provider：**微信扫码登录 + Responses 协议对话 + 模型目录 + 积分余额 + 每日登录签到**。

> Provider id: `astudio`　对话: `https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1`　账号面: `https://agent.xfyun.cn/xingchen-studio/`
> 仓库: https://github.com/zp-innovation/agent2api-plugin-astudio　当前版本: `0.7.2`

---

## 为什么需要这个插件

AStudio 把能力拆在两个面上，而这两个面用的不是同一份凭据：

| 用途 | 凭据 | 能读到什么 |
| --- | --- | --- |
| 对话（`/model-gateway/v1`，Responses 协议） | `modelBearerToken`（Bearer） | 只有推理 |
| 积分 / 会员 / 签到 / 账号可用模型（`/xingchen-studio/*`） | SSO Cookie 会话（`ssoSessionId` + `account_id`） | 这些面**不认 Bearer** |
| 换 `modelBearerToken` | 同一份 SSO Cookie 会话（`POST auth/bearer-token`） | — |

所以「一个 API Key 就够」这条路走不通：粘贴进来的 Bearer 能对话，但余额与签到永远读不到。官方桌面端自己也是这么走的 —— 扫码/手机号拿到会话，再用会话换 Bearer。

**扫码登录的关键在于二维码是一张公网 HTTPS 图片**，不是本机回环页：

1. 插件生成 8 位 `fd`，`GET sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd=` 拿到二维码**图片 URL**；
2. 宿主把这张图片画在内嵌窗口里（`allowedHosts` 为空数组 ⇒ HTTPS 不限域）；
3. 插件自己 `GET .../uids?fd=` 轮询，扫到就把 `ssoSessionId`/`uid` 换成会话，再换 `modelBearerToken`。

全程不需要开本机端口、不需要调起浏览器、不需要过极验，因此**跨机部署（网关在远端、人在本地）天然可用**。

> 实现是照着协议重写的，没有复制 new-api 的 `pkg/astudio/scanlogin.go`（该仓库无许可证）。

## 安装

面板 → 插件 → 添加脚本插件：

```text
github:zp-innovation/agent2api-plugin-astudio
```

或用本地目录（写**网关主机**上的绝对路径）：

```text
file:/data/projects/agent2api/data/script-plugins-src/agent2api-plugin-astudio
```

装到别的机器上时，`file:` 后面必须是**网关进程能看见**的绝对路径 —— 网关跑在容器里的话，
要写容器内路径（宿主的 `data/` 目录就是容器的 `/data`）。这台部署（gk，192.168.10.10）的实际做法：

```bash
scp -r AStudio gkserver:/home/gk/astudio-upload
ssh gkserver "sudo cp -a /home/gk/astudio-upload /data/projects/agent2api/data/script-plugins/incoming/AStudio"
curl -sS -X POST http://127.0.0.1:3065/api/plugins/scripts/install \
  -H 'Authorization: Bearer <任意有效网关 API Key>' -H 'Content-Type: application/json' \
  -d '{"source":"file:/data/script-plugins/incoming/AStudio","trusted":true}'
```

`trusted:true` 是硬性的（`operations.rs:62`：`安装脚本插件前必须确认信任来源；脚本并非操作系统沙箱`）。
管理接口认网关 API Key 而不只是面板口令（`http.rs:1288`），所以脚本化安装走 Key 就行。

**provider id 就是 `astudio`，面板显示「AStudio · zp」**。这个 id 原本被官方 wasm 包
`agent2api-wasm-astudio` 占着（脚本插件不能申报「已经有执行体申报过的 id」：
`plugin_host/script/runtime.rs:290-297` 的 `reserved` 含所有 Supported 包的 `declared_ids`），
所以早先只能叫 `astudio-zp`。那个包不支持扫码登录，卸掉之后 `astudio` 就空了 ——
它不在 `core::providers::PROVIDERS`、不在 `BUILTIN_SUBSCRIPTION_IDS`，旧原生包
`agent2api-providers` 是 Legacy 状态、按 `ownership.rs:59-61` 直接跳过。于是本插件正当地接管
`astudio`：库里那几个 `provider=astudio` 的老账号继续归这张卡，面板只剩一张卡。

> 老账号是 wasm 包时代落盘的 **api 型**凭据（只有 `key`，没有 `refresh`/`expires`），
> 宿主的「401 自动续期」只认 oauth 型（`host/allowance.mjs:29-38`）。所以插件会在第一次
> `usage` 读数时顺手升级一次：先用会话换一个新凭据（同时验证会话还活着），换到了才把 secret
> 补成 oauth 型（`lib/legacy.mjs`）。会话已经死掉的账号保持原样，不会被改成「每次请求都要
> 续期、续期必失败」的坏状态。
## 登录方式

面板里的顺序就是方法序号（`host/login-policy.mjs:9` 取数组下标）：

| # | 方式 | 类型 | 需要什么 | 说明 |
| --- | --- | --- | --- | --- |
| 0 | 微信扫码登录 | `oauth` | 微信 + **已绑定星辰账号** | 推荐。落 oauth 账号，可读余额、可签到 |
| 1 | 手机验证码登录 | `oauth` | 手机号 | 装了面板补丁：滑块 + 验证码全在面板里；没补丁：打开 AStudio 登录页，验证码粘回面板 |
| 2 | 粘贴模型凭据 | `api` | `modelBearerToken` | 救急用：能对话，但**没有会话** ⇒ 余额/签到读不到 |
| 3 | 导入凭据 JSON | `oauth` | 含 `ssoSessionId`/`account_id` 的 JSON 或 Cookie 串 | 把别处的登录态搬过来 |
| 4 | 导入本机登录态 | `oauth` | 网关本机的会话文件或目录 | 同上，但自己去读文件；跨机部署用不了 |

除「粘贴模型凭据」外都是 `type: "oauth"` —— 宿主 `login.mjs:41` 只肯为 oauth 型方法跑
`authorize`，而 `host/login.mjs:27` 又只保留 oauth/api 两种类型，所以「输入框 + 后台换凭据」
这条路必须挂在 oauth 上。

不开窗口的（`browserMode: "none"` ⇒ url 为空 ⇒ 客户端走 auto ⇒ 点按钮即完成）是**导入类两条**。
「手机验证码登录」是唯一一条「开窗口 + 收回执」的：`browserMode: "external"` 让宿主打开登录页，
`authorize` 返回 `method: "code"` 让宿主再弹一个一次性输入框
（`login-policy.mjs:128-129`：`manualCallback = authorization.method === "code"`、
`callbackInput = "code"`），验证码就从那个框回到插件。

### 扫码这条的交互

二维码 60 秒有效、2 秒轮询一次（过期后降频到 5 秒，接住「过期前一秒扫上」的确认）。窗口下方那行提示会随状态变化（靠 `authorize` 返回对象上的 `instructions` getter 实时刷新）：

| 状态 | 提示 |
| --- | --- |
| 刚取到码（第 1 次轮询之前） | 二维码已就绪，请在微信中扫码 |
| 还没人扫 | 等待微信扫码… |

> 第一行只会出现在窗口的**静态说明**里：宿主 poll 的提示取 `authorization.instructions`，
> 但要求它与 start 时烘进流程的文案**不同**才会显示（`login.mjs:112-124`），而 start 时拿到的
> 正是「二维码已就绪…」。所以第一次轮询就把 hint 换成「等待微信扫码…」，否则面板前 1.5 秒会显示
> 宿主的默认提示「等待插件完成登录」。

| 超过 60 秒 | 二维码已过期：请取消这次登录，再点一次「微信扫码登录」 |
| 扫了，但 `infoList` 空 | 微信已扫码，但这个微信还没有绑定星辰账号：请先在星辰网页端完成绑定，再扫一次 |
| 已确认 | 微信已确认，正在换取模型凭据… |

「换一张二维码」就是宿主再点一次登录：插件会生成新的 `fd`，旧流程随之作废。

实测（2026-11-20，无 Cookie、无 clientType）：

```jsonc
// GET /SSOService/wx/scanlogin/qrcode?fd=k7Qm2Zx9
{"flag":true,"code":0,"desc":"获取成功","data":"https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=gQFU8DwAA…"}
// GET /SSOService/wx/scanlogin/uids?fd=k7Qm2Zx9   （还没人扫）
{"flag":false,"code":-1,"desc":"暂无数据","data":null}
```

二维码图片落在 `mp.weixin.qq.com`，正是「公网 HTTPS 图片」这条路成立的原因。

### 手机验证码这条：验证码要你自己取

上游 `login/mobile/send-verify-code`（发短信）与 `login/check-account`（账号密码）都强制要极验滑块三件
（`geetest_challenge` / `geetest_validate` / `geetest_seccode`），而极验只有宿主能渲染 —— wasm 包靠
`login.captcha.geetest` 能力，**脚本宿主里一个 captcha 字样都没有**（`plugin_host/script/` 全目录只有
`reports.mjs:43` 的签到 outcome 白名单里出现过 "captcha"）。实测（2026-11-21）：

| 请求 | 结果 |
| --- | --- |
| `POST login/mobile/send-verify-code`（不带极验） | `{"flag":false,"code":19901001,"desc":"参数无效"}` |
| `POST login/mobile/send-verify-code`（带假极验） | `{"flag":true,"code":20009,"desc":"geetest verify failed"}` |
| `POST login/check-account`（同上两种） | 同上两种结果 |
| `POST login/phone-quick-login`（假验证码，**不带极验**） | `{"flag":false,"code":10501002,"desc":"验证码无效，请重新获取并验证"}` |

也就是说：**发码**这一步必须由能跑极验的地方完成，**登录**这一步（`phone-quick-login`）不要滑块。
所以取码这一步必须由能跑极验的地方完成：装了面板补丁就在**面板里**做（下面 C），没装时退回
「打开 AStudio 网页自己取码」（下面 A）。

**C. 面板内一条龙（装了宿主补丁 `astudio-sms-login.js` 时的默认路径）**

点「登录并添加」→ 面板自己弹框 → 确认手机号 → 点「获取验证码」→ **极验滑块直接浮在面板上** →
拖完由插件在服务端发短信 → 面板切成「填验证码」→ 填 4-8 位数字 → 落账号。
全程不开新标签页、不粘回调地址。补丁没装时自动退回 A。

**A.「手机验证码登录」——宿主开网页 + 一次性粘贴框**

1. 面板里只填**手机号**，点「登录并添加」；
2. 宿主打开 <https://agent.xfyun.cn/studio-portal/overview>（AStudio 门户首页，未登录会自动弹出
   「手机号登录 / 账号登录」模态框），你在那里填手机号 → **勾选协议** → 点「获取验证码」→ 拖滑块；
3. 面板同时（10 秒后）弹出一个输入框，标题是「需要粘贴授权令牌或 code」——**那里只填短信里的 4-8 位数字**；
4. 插件拿到验证码后调 `login/phone-quick-login` 完成登录、落账号。

> ⚠️ 那个框**不要**填网页地址、也不要填手机号。宿主自己的覆盖层文案对「非 code 型」流程写的是
> 「复制浏览器地址栏中的完整回调地址粘贴提交」，很容易让人以为登录完要把地址栏交上来 ——
> 而 `core/login.rs:820-830` 会把整条地址原样当成 code 交给插件，这一次登录就白费了。
> 插件现在会认出来并直接说「你粘进来的是网页地址，不是短信验证码」；顺带也接受带
> `?code=` 的回调地址。

> 代价：A 的回调是**一次性的**（`login.mjs:126-133` 只 `run` 一次），验证码填错要重新点
> 「登录并添加」再取一次码。所以填的内容不是 4-8 位数字时先在本地拦下，不浪费那次机会。
> ⚠️ 登录页地址是 **`/studio-portal/overview`**，不是 `/login`。门户是挂在 `/studio-portal` 下的
> SPA，路由表里只有 `/`、`/overview`、`/studio-price`、`/studio-download` 等和一个 `*` 兜底；
> 登录不是独立路由，而是未登录时自动弹出的模态框。`/login` 会命中兜底渲染「404 页面不存在」，
> `/studio-portal/login` 一样，`/xingchen-studio(/login)` 则是接口命名空间（直接回 80000）。
> 另外弹窗要求先勾选「已同意《服务协议》和《隐私协议》」，「获取验证码」才会弹滑块。

（同一形态在宿主里有先例：`login-policy.mjs:19-34` 给 wps-lingxi 造的「内嵌窗口登录」就是
`{url: WPS_SITE, method: "code", callback(cookie)}`。）

### 为什么没有「账号密码登录」

`login/check-account` 是唯一的密码入口，它**强制**极验（上表第 3 行），没有别的免滑块路径 ——
盲试的 7 个常见路径（`login/account-login`、`login/password-login` 等）全部回该站对未知路径的
通用信封 `{"code":80000,"flag":false,"desc":"登录异常，请重新登录"}`。geetest v3 的离线兜底公式
（`validate = md5(md5(challenge)) + "|jordan"`，`seccode = validate + "|jordan"`）三种变体也全部被判
`20009`，说明上游是在线校验、绕不过去。所以这条**不做**：宁可少一个点不动的 tab，也不做一个
点了必然失败的按钮。

### 导入凭据 / 导入本机登录态

两条共用一个解析器（`lib/import.mjs`），认三种输入：

```text
ssoSessionId=…; sso_sessionid=…; account_id=…; token=…        ← Cookie 串
{"modelBearerToken": "eyJ0eXAi…"}                              ← 只要凭据
{"access": "eyJ…", "session": {"accountId": "…", "ssoSessionId": "…"}}  ← 本插件自己落盘的 secret
```

有会话（`ssoSessionId` + `account_id`）就先换一次模型凭据，换得到才落账号 —— 顺带证明会话还活着；
只有 `modelBearerToken` 时退成 api 型账号（能对话，读不到余额）。「导入本机登录态」多一层：
输入可以是文件，也可以是**目录**，插件在两层内（最多 80 个 ≤512 KiB 的候选文件）找第一个认得出
会话的文件。它读的是**网关这台机器**的磁盘，跨机部署时网关本机没有 AStudio 客户端，请改用粘贴。

## 二维码在面板内弹窗（宿主补丁）

面板点「微信扫码登录」时，**展示方式是宿主决定的，插件改不了**：桥接脚本 `shim_js()` 被编译进
agent2api-server 二进制（`web_shim.rs:47`），只要 `login/start` 回了非空 `authUrl`，它就
`window.open("about:blank", "_blank")` 再 `location.replace(authUrl)`（`web_shim.rs:1206-1225`）
—— 于是二维码图片跑到了新标签页。想让它变成面板内弹窗，只能在宿主侧动手。

`host-patch/` 就是这件事的成品：

| 文件 | 作用 |
| --- | --- |
| `astudio-qr-modal.js` | 覆盖 `window.open`，只拦截「`about:blank` + `_blank`」这一种签名；URL 像二维码图片时画面板内弹窗，否则退回原生新标签页 |
| `install.sh` | `docker cp` 到容器 `/app/ui/`，并在 `index.html` 的 `</body>` 前幂等注入 `<script>`（先备份成 `index.html.a2a-orig`）；`install.sh uninstall` 还原 |
| `verify-modal.py` | 用 playwright 取一张**真二维码**跑补丁：断言弹窗出现、图片真加载、`context.pages` 仍是 1、取消按钮生效、非图片 URL 仍开新标签页 |

`host-patch/` 里还有两个补丁，各自在下面单独一节：`astudio-sms-login.js`（手机验证码登录搬进面板）、
`astudio-usage-compact.js`（余额列改成单条读数 + 弹窗）。`install.sh` 一次把三个都装上。

```bash
# 在网关宿主机上（容器名默认 agent2api，可用 CONTAINER=xxx 覆盖）
sudo bash install.sh          # 安装
sudo bash install.sh uninstall # 还原
```

**为什么拦截点是安全的**：整个 `/app/ui` 里 `window.open(` 出现 0 次、`about:blank` 0 次；
宿主 shim 里也只有 `web_shim.rs:1217` 这一处是「`about:blank` + `_blank`」。所以这个签名只可能
来自动态登录流程。非图片 URL（例如以后接入需要网页授权的登录）照旧开新标签页，行为不变。

弹窗跟着 `workbuddyDesktop.getLoginState()` 走：流程结束/取消/超时 → 自动关闭；hint 实时显示
「等待微信扫码…」「二维码已过期…」等状态；Esc 等于点「取消登录」（在捕获阶段吞掉事件，不会连带关掉
面板下层的「添加账号」弹窗）。

> **镜像升级会覆盖 `/app/ui`** —— 拉新镜像后重跑一次 `sudo bash install.sh` 即可。补丁只改容器内
> 静态文件，不碰二进制、不碰数据卷；卸载时恢复备份的 `index.html`。

### 短信登录也搬进面板：滑块 + 验证码（`astudio-sms-login.js`）

**为什么插件自己做不到**：脚本宿主只认 `oauth`/`api` 两种方法（`host/login.mjs:17-27`），没有
wasm 包才有的 `login.captcha.geetest` 能力；发码接口 `login/mobile/send-verify-code` 又强制极验三件。
但**滑块可以画在面板页面里**，因为：

- `GET xingchen-studio/chat/gee-captcha` 是 CORS 全开的（`access-control-allow-origin: *`），面板任意源都能取到 `{gt, challenge, success, new_captcha}`；
- 极验 v4 的来源校验读的是 **`document.referrer`**（实测：只改 Referer 头 → 通过；只伪造 `document.referrer` → 同样通过），页内 `Object.defineProperty(Document.prototype,"referrer",…)` 即可；
- `send-verify-code` / `phone-quick-login` 的 OPTIONS 只要求 `content-type`，不需要自定义身份头 —— 所以发码交给插件在服务端做（带 `clientType`/`studioVersion`，与后面的登录同一出口 IP）。

补丁做四件事：

1. **拦 `/api/session/login/start`**：只认 `provider==="astudio" && methodIndex===1 && !inputs.captcha`，其余原样透传；
2. 弹自己的框（手机号 → 「获取验证码」），加载 `gt.js` 用 `initGeetest({product:"bind"})` 出滑块，用户拖完拿
   `{geetest_challenge, geetest_validate, geetest_seccode}`；
3. **带 `inputs:{mobile, captcha:JSON}` 重发 start** → 插件 `lib/sms.mjs` 发 multipart（seccode 先 base64）打
   `send-verify-code`，回 `{method:"code", url:""}`；
4. 把响应的 `manualCallback` **改成 false** 再交回宿主：否则 `web_shim.rs:1179-1182` 会在 10 秒后弹它自己的
   「粘贴回调地址」覆盖层（`MANUAL_CALLBACK_GRACE_MS`），跟我们的输入框抢 UI。改成 false 后宿主只轮询
   `/wait`（`:1232`），`url:""` 又让 `:1189` 判定 `mode='auto'` 不建窗口。用户在补丁框里填 4-8 位数字 →
   `workbuddyDesktop.submitLoginCallback(state, code)` → 插件 `phone-quick-login` → 落账号。

> **为什么方法 1 上挂了一个什么都不问的 `ask: () => null`**：宿主 `api/session.rs:405` 只对「动态表单」方法放行
> 未申报的 `inputs` 字段，而动态表单的判定在 `host/login.mjs:22`（`typeof method.ask === "function"`）。
> 没有这个标记时，第 3 步带 `captcha` 重发 start 会被 400「inputs 包含未申报的字段或非字符串值」挡回来
> （实测就是这个错）。返回 `null` 时 `resolvePrompts`（`login-prompts.mjs:59`）不追加任何字段，面板上仍然
> 只有手机号一个输入框 —— 而面板前端（`/app/ui/islands/ui.js`）根本不读 `dynamicPrompts`，所以外观零变化。

> 已知抖动：极验偶尔回 `{"msg":"服务端forbidden： 请联系极验官网客服"}`（短时间重复校验会被拒，实测约 1/4，
> 补上真实 Referer 头也一样）。补丁把这条翻译成「极验暂时拒绝了这次校验（短时间内重试太频繁）：等几秒再点
> 「获取验证码」」，重试即可，不会白费一次登录（发码还没发生）。
> 补丁依赖上游 CORS 与 `document.referrer` 可伪造这两点，属于**非承诺行为**：哪天极验改成校验真实 Referer 头，
> 这条会退化回 A/B 两条老路，微信扫码不受影响。

### 余额列：单条读数 + 弹窗（`astudio-usage-compact.js`）

面板里 AStudio · zp 的余额格原本是**整块内联卡片**（体验版徽章 + 每个积分池一行 + 「额度详情 ⌄」），
WorkBuddy 那种是**一行「可用 466 ▾」**、明细收进浮层。这件事插件决定不了：

- 余额格形态由宿主 `reports.mjs:11-39 usageReport()` 透出的字段决定，它只透
  `{success, windows[], user, signIn, resets, subscription, available, availableView, balanceView, warnings}`；
- WorkBuddy 的单行读数走的是 `totalLeft`、明细走的是 `credits`（`ui.js` 里 `lOe()` 判 `hasOwnProperty("totalLeft")`、
  弹层读 `t.credits`）——这些键由宿主自己的 native provider 直接产出，脚本插件这条路上**全部被裁掉**；
- `wallets` 那条路（`uOe`/`dOe`）同样要求 `wallets` 非空，脚本插件也没有。

所以 `lib/usage.mjs` 怎么填，余额列都只会落到 `.usage-window-cell`（分窗口卡片）那一支。补丁因此做的是
**换皮不换数**：在 `tr.acct-row[data-provider="astudio"]` 里隐藏 React 渲染的 `.usage-window-cell`，
在同一个 `td.cell-usage` 里插入一枚**与 WorkBuddy/AutoClaw 完全同款**的胶囊按钮「可用 1,500 积分 ▾」，
点开浮层显示套餐、总积分（各池相加）、各池余额、更新时间。

**样式统一靠复用宿主类，不是自造**：按钮直接挂 `usage-toggle ok`，内部是 `.val` + `.caret`（`▾`），
底色/描边/圆角/绿字/悬停/展开翻转全由 `/app/ui/css/page-accounts-table.css` 提供；浮层内容整段用
`usage-pop` / `usage-pop-total` / `usage-pop-group` / `usage-pop-row` / `usage-pop-line` / `usage-pop-name` /
`usage-pop-view`（0 值 `muted`、有值 `ok`）。补丁只保留浮层容器的 fixed 定位（宿主走 Popover portal，
我们没法直接用它的定位层）和按钮宽度收敛到单元格内。主题切换、深浅色自动跟随宿主。

- 数据**从被隐藏的那张卡片 DOM 里读**（`.usage-window-value` 的 `title` 优先，因为面板把 `title` 设成原始读数、
  显示文本可能被换成「剩余 43%」），不碰接口、不需要面板 Key；
- MutationObserver 跟着 React 的重渲染走（面板每 15 秒刷一次读数，单元格节点会被整体替换）；
- 卡片没渲染时（未登录 / 读额度中 / 该账号只有 Bearer）补丁什么都不做，面板保持原样 —— 补丁失效也不会把余额列弄空；
- 分组表头那行「可用合计 5,298」来自 `usage.available`（`lib/usage.mjs` 的顶层 `balance`），与余额格无关，不受影响。

`verify-usage.py` 用**面板自己的 `tokens.css` + `ui.css` + `page-accounts-table.css`** 加一段仿真的账号行做验证
（WorkBuddy 那一行直接造一枚真的宿主 `usage-toggle` 当对比基准）：断言 AStudio 按钮 class 含
`usage-toggle ok`、`.val` 读数和 `.caret` 都是 `▾`、浮层复用的是 `usage-pop-*` 那一套类、
只装饰 `data-provider="astudio"` 的行、原生卡片被隐藏、点外面/Esc 能关、整格替换后能自动重新装饰。
截图 `preview/usage-1-closed.png` / `usage-2-open.png` 里上下两行的胶囊完全同款。

## 账号记录长什么样

`authorize` 返回的 secret 是 **oauth 型**，不是死 Key：

```json
{
  "type": "oauth",
  "access": "<modelBearerToken>",
  "refresh": "astudio-sso",
  "expires": 1763700000000,
  "name": "星辰用户",
  "uid": "10086",
  "accountId": "10086",
  "source": "scan",
  "session": { "accountId": "10086", "uid": "10086", "ssoSessionId": "…", "token": "" },
  "metadata": { "provider": "astudio", "source": "scan" }
}
```

为什么必须是 oauth 型：

- `host/accounts.mjs:65-89`：`if (auth?.type !== "oauth") return auth` —— api 型账号宿主**根本不会**调 `hooks.auth.refresh`；
- `host/allowance.mjs:29-38`：只在 401 + oauth + 有 refresh + `expires` 未过时保留账号（把 `expires` 置 1），下一请求才会触发续期。

因此插件把 `expires` 设成本地 30 分钟，到期或上游 401 时用 **Cookie 会话**重铸一次 `modelBearerToken` —— 会话还在就永远不用重新扫码。会话本身被拒（401/403 或 `code=80000` / desc 含「重新登录」）才算登录过期。

## 面板显示

**余额**（两行，都是 `aside: true`）：

- `通用积分` —— `GET points/balance` 的 `totalBalance`；`activityBalance > 0` 时附带 `runsOutAt`（那部分积分的到期时刻）。
- `星火积分` —— `sparkTotalBalance`。

`aside` 是刻意的：积分是**余额型**读数，恰好一池为 0 时不能触发宿主的配额拦截（`host/allowance.mjs:5-27` 只看非 aside 窗口的 `remainingPercent/balance === 0`）。

**可用合计**（报告顶层的 `balance` 一个数）：

上面两行只是明细，账号页列表里那一列「可用合计 / 可用最低」来自**顶层标量**——宿主 `host/reports.mjs:37` 只读 `available: number(value.balance)`，再由 `core/accounts_list/balance.rs:40-58` 聚合成各组的 `{sum, counted, total, additive}`。所以 `lib/usage.mjs` 额外返回 `balance = 通用积分 + 星火积分`（两池都是「剩余多少就能用多少」，可以直接相加）；只读到一池时用另一池的 0 补齐，两池都读不到时**整个字段不出现**——那样这一格的 `counted` 才不会虚增，面板显示「—」而不是假的 0。

这个字段还有第二个用处：它会落进 `account_usage_records.remaining`（`core/usage_records.rs:319-332`），转发选路时按「余额不足跳过」用。本插件没有申报 `defaultLimiters`，所以宿主用默认阈值 `1.0`——两池同时为 0 的账号会被选路跳过（这种账号本来也打不动上游，行为可接受，但别把它当成 bug）。

**会员**：`membership/me` 的 `planName` 作计划名、`endTime` 作到期时间、`uid` 作账号标识。

读不到时不会染红整列：带 `plan` 的返回会被 `host/reports.mjs:29` 降级成 warnings 里的一条提示。

**签到**：`checkin` 读一次积分 → `POST tenant-app/v2/init-app` → **领取推广位里的登录积分** → 等 2.5 秒再读一次积分，用实际差额报告结果。

第三段是关键，0.5.0 才补上：`init-app` 只记录「今天登录过」，**不发积分**。积分在推广服务里，面板左下角「限时每日福利 · 今日可领 100 积分 · 领取」按钮发出的就是这条请求：

1. `GET client-popups/pending` → 当天的 `DAILY_LOGIN_REWARD_V1`（`componentType: "DAILY_REWARD_DIALOG"`，`instanceKey` 是当天日期如 `20261121`）；
2. `POST client-popups/complete {popupId, instanceKey, completed: true}` → 到账。

实测（2026-11-21，账号 18122032590）：只调 `init-app`，余额 1300 一动不动；补一次 `complete`，2 秒后 1400。**所以以前「面板显示已签到、积分没到账」不是上游延迟，而是少调了这一步。** 这两个接口必须带 `clientType` + `studioVersion` 身份头，缺了上游回 `{"code":11001001,"desc":"客户端平台、版本或构建号无效"}`（Linux 容器里没有 `process.platform`，插件按官方 Windows 桌面端身份 `clientType: 21` 兜底）。

| outcome | 什么时候 |
| --- | --- |
| `claimed` | 领到了：观测到新增积分（`credit` 形如「通用积分 +100」），或服务端已确认领取但余额读数还没刷新 |
| `done` | 登录已完成，今天没有待领取的登录积分（已经领过） |
| `inactive` | `membership/plan-config` 的 `dailyLoginEnabled` 为 false |
| `ineligible` | 只有 Bearer、没有会话（粘贴方式登录的账号） |
| `failed` | 上游拒绝（含「登录成功但没领到登录积分」）、或读数不完整 |

## 模型目录

两份来源合并（`lib/catalog.mjs`）：

1. **账号目录** `GET bot/models/configs` —— 这个账号能用哪些模型，带 `api_key`/`is_default`；
2. **平台目录** `GET /api/v1/model-manager/models`（Bearer） —— 元数据：`context_window`、`max_output_tokens`、`supported_reasoning_levels`、`input_modalities`、`badge`。

账号目录在前，平台目录按 `slug` / `display_name` 去重后追加；两份都拿不到时用官方兜底清单，并打上 `magpie.fellBack` 标记，让宿主保留已有模型而不是清空目录：

| id | 名称 | 上下文 | 输出 |
| --- | --- | --- | --- |
| `astronclaw-auto` | Auto（默认） | 262,144 | 32,768 |
| `spark-x2.6` | Spark-X2.6 | 262,144 | 32,768 |
| `spark-x2.6-4b` | Spark-X2.6-Lite | 1,048,576 | 110,000 |
| `spark-x2.5` | Spark-X2.5 | 262,144 | 32,768 |
| `xopglm52` | GLM-5.2 | 1,048,576 | 32,768 |
| `xopdeepseekv4pro0813` | DeepSeek-V4-Pro | 1,048,576 | 32,768 |
| `xopdsv4flash0731in` | DeepSeek-V4-Flash | 1,048,576 | 32,768 |

## 已知边界

1. **二维码只有 60 秒**，上游定的，不能延长；过期只能重开一次登录（宿主自己在 10 分钟时判「登录等待超时」）。
2. **没扫码时 `uids` 一定返回业务拒绝，而且文案会变**：实测两种 —— `code=20003`「请求地址错误」、`code=-1`「暂无数据」。这都是正常态而不是故障，插件把已知的这两种（以及**任何**「还没扫到人」的业务拒绝）翻译成「等待微信扫码…」，绝不把上游文案抛给用户；取码那一步的业务拒绝才是真失败。
3. **扫了但没绑定**：`infoList` 为空表示这个微信没有绑定星辰账号，提示去网页端绑定，而不是判失败。
4. **内嵌窗口能显示二维码**，是因为宿主 `host/login-policy.mjs:95-135` 对非 `wps-lingxi`/`joycode` 的 provider 返回 `allowedHosts: []`，而壳 `login.rs` 的 `DynamicNavigation` 把空数组解释为「HTTPS 不限域」。老的 `run_embedded` 静态白名单（`WORKBUDDY_ALLOWED_HOSTS` 那条路径）不参与动态登录。
5. **`browserMode` 写的是 `plugin` 而不是 `embedded`** —— 面板校验只接受 `choice|external|plugin|none`；真正强制内嵌窗口的是 `embeddedOnly: true`。
6. **不声明思考档位（variants）**：`supported_reasoning_levels` 里的 `effort` 值还没在上游验证过，随便给可能让对话请求直接 400，所以只把 `reasoning: true` 摆出来。
7. **粘贴方式没有会话**，所以余额 / 签到不可用，面板会明说「只有模型凭据（没有网页会话）」，不假装读到了数字。
8. **`studioVersion` 参与门控**：客户端版本 3.4.4 的目录只有 7 条，3.6.0 起 8 条。请求头必须带 `clientType`/`studioVersion`/`User-Agent: AStudio/3.6.0`，否则目录会被裁。
9. 扫码取码 / 轮询两条 SSO 请求**不带 Cookie、不带 clientType/studioVersion**，只有 `Accept: application/json` 与 `User-Agent`；账号面请求才带 Cookie 与身份头。
10. 手机验证码的**发码**卡在极验滑块上，**账号密码登录**也卡在同一处（`login/check-account` 强制极验，盲试的 7 条替代路径全回 80000，geetest v3 离线兜底公式被判 20009）。0.7.0 起滑块由宿主补丁画在面板里（见上文），没装补丁时退回「打开 AStudio 网页自己取码」；**账号密码登录仍然不提供**。
11. **粘贴框只认短信里的数字**：宿主 `core/login.rs:820-830` 会把提交内容整条当 code 交给插件（URL 里带 `code`/`authorization_code` 才会先被摘出来），所以粘地址栏只会白费这一次登录。插件按提交内容分别回「这是网页地址」/「这是手机号」/「里面没有 4-8 位验证码」，并顺带接受带 `?code=` 的回调地址。
12. **方法 1 的验证码只有一次机会**：宿主的登录回调是一次性的（`login.mjs:126-133`），填错就得重新点「登录并添加」并重新取码；插件对非 4-8 位数字的粘贴在本地拦下，不消耗那次机会。方法 2 可以重填（但码本身是一次性的，重填也要重新取码）。
13. **`github:` 安装走的是官方 CDN 中转，不是直连 GitHub**：宿主 `script/website.rs:35-47` 把 `api.github.com/repos/*/commits` 与 `codeload.github.com/*/tar.gz` 换成 `agent2api.dev/api/plugins/community/github-commits|github-archive`。那个中转会限流，实测返回 `429 {"error":"社区插件来源暂时限流，请稍后再试"}`（此时直连 GitHub 是 200）。碰上就隔几分钟重试，或改用下面的 `file:` 路径安装 —— 与仓库内容无关。
14. **二维码弹窗是宿主侧补丁，不是插件能力**：面板怎么展示 `authUrl` 由编译进二进制的桥接脚本决定（`web_shim.rs:1206-1225` 的 `window.open("about:blank","_blank")`），插件无法影响。`host-patch/` 覆盖 `window.open` 把「图片 URL」改画成面板内弹窗；**镜像升级会覆盖 `/app/ui`**，升级后要重跑 `sudo bash install.sh`。
15. 动态登录流程里宿主的超时是 **5 分钟**（壳 `LOGIN_TIMEOUT`），比二维码的 60 秒长得多 —— 过期提示是插件自己按 `expires_at` 判的，宿主不会替你关窗口。
16. **短信登录的滑块同样是宿主侧补丁**（`host-patch/astudio-sms-login.js`）：它依赖上游 CORS 全开与 `document.referrer` 可伪造，也依赖宿主 `manualCallback` 可被响应改写的既有行为。镜像升级后要重跑 `install.sh`；补丁缺失时方法 1 自动退回「开网页 + 粘码」。

## 开发

```bash
node --test "test/*.test.mjs"     # 76 条：协议常量、SSO 状态机、六种登录方式、验证码解析、滑块发码、目录合并、登录/续期/余额/签到全链路、老账号升级
python scripts/gen-icon.py        # 重画图标（需要 Pillow），同时写 assets/icon.png 与 icon.mjs
```

源码结构：

| 文件 | 职责 |
| --- | --- |
| `index.mjs` | 插件工厂（**唯一导出**，宿主会把每个导出函数当候选调用，多导出会炸整包） |
| `lib/endpoints.mjs` | 上游地址与常量（版本号、TTL、轮询间隔、兜底模型名） |
| `lib/http.mjs` | 信封解析、Cookie 头、身份头、超时、错误分类（`failed`/`expired`） |
| `lib/scan.mjs` | SSO 取码 / 轮询、提示文案状态机 |
| `lib/login.mjs` | 六种 `authorize`：扫码、手机验证码（面板内滑块 / 开网页 + 粘码两种形态）、手机验证码（先取码再填）、凭据 JSON、本机登录态 |
| `lib/sms.mjs` | 极验三件的归一化与校验、手机号打码、multipart 发码（`login/mobile/send-verify-code`） |
| `lib/import.mjs` | 凭据解析（Cookie 串 / JSON / 嵌套 secret）与本机文件、目录读取 |
| `lib/session.mjs` | 会话与凭据（`settle` / `accountSecret` / `renew`） |
| `lib/legacy.mjs` | 把 wasm 时代落盘的 api 型 secret 升级成 oauth 型（先验会话，换到新凭据才写盘） |
| `lib/catalog.mjs` | 两份目录的合并与兜底 |
| `lib/provider.mjs` | 运行时模型清单与 `config` 写入 |
| `lib/usage.mjs` / `lib/checkin.mjs` | 余额与签到 |
| `host-patch/astudio-qr-modal.js` | 宿主补丁①：二维码改在面板内弹窗 |
| `host-patch/astudio-sms-login.js` | 宿主补丁②：手机号 + 极验滑块 + 短信验证码全在面板内完成 |
| `host-patch/install.sh` | 把三个补丁 `docker cp` 进容器并注入 `index.html`（`uninstall` 还原） |
| `host-patch/verify-modal.py` / `verify-sms.py` / `verify-usage.py` | 三个补丁的无头验证（真二维码 / 真极验滑块 / 面板真 CSS 下的余额列） |
