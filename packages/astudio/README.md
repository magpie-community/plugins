# @magpie-community/opencode-astudio-auth

把 **AStudio（科大讯飞 Astron Studio）** 的账号额度接入 [magpie](https://usemagpie.ai/) 与 [OpenCode](https://opencode.ai/)：浏览器登录或复用桌面端登录态，直连云端模型网关（OpenAI Responses 协议），agent 以 `astudio/<model>` 使用它的模型；支持每日登录积分自动签到、积分余额与到期时间显示，每个账号各占账号池一格。

## 与 Providers Hub 的 `hub-astudio` 的区别

AStudio 在 registry 里有两个入口，都保留（[#614](https://github.com/magpie-community/plugins/issues/614)）：

| | 本包（`astudio`） | [magpie-providers-hub](https://www.npmjs.com/package/magpie-providers-hub)（`hub-astudio`） |
| --- | --- | --- |
| 登录 | 浏览器登录（推荐，可多账号）、读取本机 AStudio 桌面端的登录态，或粘贴 `modelBearerToken` | 本机打开一个登录页：手机验证码、账号密码或微信扫码（含极验验证），不依赖桌面端 |
| 适合 | 装了桌面端就复用登录态；没装也可以用浏览器登录（可多账号）；两者都不方便时粘贴凭据 | 任何平台，没装桌面端也行 |
| 模型端点 | `…/model-gateway/v1/responses`（OpenAI Responses，与桌面端一致） | `…/model-gateway/v1/chat/completions` |
| 每日积分 | 先读当日获得流水（与网页后台「获得明细」同源）：有当日 GRANT 行即已发放，此时一个写请求都不发；流水为空才做一次会话活跃再读流水，流水不可用才退回余额差 + `client-popups/pending` 弹窗观测；不调用领取接口 | 调用 `client-popups` 领取每日奖励和新人礼包弹窗 |

两者用同一个 AStudio 账号时，读的是同一个 `points/balance`，模型调用也扣同一份积分：**每日登录积分是一个池子，装两个不会多一份。** 同一账号两边都登录只会重复显示同一笔余额。

English: two entries serve AStudio. This one signs in through a browser
(each account gets its own pool slot), reuses the AStudio desktop's sign-in,
or takes a pasted `modelBearerToken`, and calls the Responses endpoint;
Providers Hub's `hub-astudio` signs in on a local page (SMS code, password
or WeChat QR) and calls chat/completions. On one account both draw on the
same daily points balance.

## 登录什么

三种方式（登录时选一种）：

1. **浏览器登录（推荐，可多账号）**——弹出的浏览器里登录讯飞账号（手机验证码或扫码），插件收割网页会话 Cookie（`ssoSessionId` + `account_id` 必需，`token` 有则一并带上），再调桌面端启动时的同款 `POST auth/bearer-token` 换发模型凭据（JWT，实测 3 年有效；换发后旧 token 仍可用）。不装桌面端也能用。每次登录用全新浏览器 profile，绝不带旧票；登录收尾后连 profile 一起删掉（会话已进账号 metadata，浏览器目录不留第二份凭据）。网页会话 Cookie 过期后积分/签到会提示重新登录（重新走一次浏览器登录即可；模型凭据是 3 年 JWT，聊天不受影响）。需要本机有 Chrome 或 Edge（或用 `ASTUDIO_CHROME_PATH` 指到可执行文件）；profile 根目录是 `<配置目录>/magpie/astudio-browser-profiles`——Windows 为 `%APPDATA%`、macOS/Linux 为 `~/.config`（`XDG_CONFIG_HOME` 可改），`ASTUDIO_BROWSER_PROFILE` 可整体覆盖；登录收尾即删。
2. **读取 AStudio 桌面端登录态**——本机装有 AStudio 桌面版并登录过即可，插件自动从它的数据目录读出模型凭据与网页会话（积分/签到用），不用填任何东西。没装/没登录时这一步会给出 [AStudio 官网](https://agent.xfyun.cn/) 链接并自动等待：装好登录后自动完成，不用回来点按钮。本机已有数据但读不出来（会话不是有效 JSON、没有凭据、账号被封禁）会直接说明原因，登录/修好后同样自动完成。数据目录按以下顺序查找：
   - `ASTUDIO_HOME`（或 `SYNARA_HOME`）环境变量指定的目录；
   - Windows 注册表 `HKCU\Software\AStudioStorage` 的 `Production/Canary/DevelopmentDataRoot`；
   - 兜底 `~/.acode/acode/`。
   - 目标文件：`<数据根>/userdata/astron-session.json`（其次 `<数据根>/runtime/acode-home/config.toml`，该方式无网页会话，积分/签到不可用）。
3. **粘贴 modelBearerToken**——从 `astron-session.json` 的 `modelBearerToken`（或 `config.toml` 的 `experimental_bearer_token`）复制粘贴；可选填账号面 `accountId` 与网页会话 `token`（两者齐才能用积分/签到，另有 `ssoSessionId`/uid 可选）。

每个 AStudio 账号登录一次即得 magpie 账号池里的一格：签到、用量、模型调用都按账号各算各的，网关在账号间故障切换。同一账号用浏览器登录和桌面端登录会归到同一格（`accountId` 都是 uid）。凭据保存在 magpie 的 `plugin-auth.json`（权限 600），不上传。

## 模型

供应商 id `astudio`。目录**按账号实时拉取**（`GET /api/v1/model-manager/models`，读取不计费），含思考档位与限免标记。2026-11 实测目录：

| modelId | 名称 | context | 备注 |
| --- | --- | --- | --- |
| `astronclaw-auto` | Auto | 256k | 智能路由 |
| `spark-x2.6` | Spark-X2.6 | 256k | 抢先体验 |
| `spark-x2.6-4b` | Spark-X2.6-Lite | 1M | **限免** |
| `spark-x2.5` | Spark-X2.5 | 256k | |
| `xopglm52` | GLM-5.2 | 1M | |
| `xopdeepseekv4pro0813` | DeepSeek-V4-Pro | 1M | |
| `xopdsv4flash0731in` | DeepSeek-V4-Flash | 1M | |

思考档位（none / high / max，随模型）映射为 magpie 的推理档位；上游字段变化以实时目录为准。

## 每日签到（每日登录积分）

AStudio 有「每日登录积分」：服务端在当天账号会话首次活跃时发放（体验版 100 分/天，标准版 200，高级/畅享 400；活动期 31 天有效），客户端弹窗只做通知、没有领取接口。

插件为此提供 magpie 的 `auth.checkin`，**先读当日获得流水**（`points/details?direction=CREDIT`，与网页后台「获得明细」同源，时间窗口按北京时间算）：有 `GRANT` 且 reason 为「每日登录赠送」的入账即已发放——此时**一个写请求都不发**，连会话活跃也不做。流水为空才替账号做一次会话活跃（`POST tenant-app/v2/init-app`，带桌面端 `clientType` / `studioVersion` 身份头；缺 `clientType` 会被服务端以 `11001001` 拒绝），再读一次流水：新出现的 GRANT 行记为本次领取；流水接口不可用时退回余额差 + `client-popups/pending` 的 `DAILY_REWARD_DIALOG` 弹窗观测。余额涨了但流水还没入账也记领取（流水滞后）；流水通畅、余额没涨、也没有当日弹窗则如实报「未观测到新发放」，**不谎称已签**。

签到**不调用** `client-popups/complete`：桌面端的「知道了」是桌面端的交互，插件只读弹窗、不替用户点掉。除 init-app 外，签到发出的都是只读请求。发放由服务端按账号会话判定，插件不能代替桌面端登录，也不保证某天一定有积分到账。签到需要账号带网页会话（浏览器登录与桌面端登录态方式默认有）。

## 用量

有网页会话时显示真实数据：会员档（体验版/标准版/高级版/畅享版）、通用积分余额（含最近到期批次与时间）、星火积分余额与最早到期时间（`runsOutAt` / `runsOut`：60 天流水里未过期批次按到期日聚合，翻页读取，金额按余额封顶）。星火积分 7 天内到期时，签到消息会追加提醒。所有读取均不计费；模型调用本身才消耗账号额度。401/403/登录异常会把账号标记为需要重新登录。

## 协议与上游

- 模型调用：`POST https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/responses`（OpenAI Responses，`Authorization: Bearer`）——与 AStudio 桌面端写进 acode 内核的 `base_url` / `wire_api` 完全一致。
- 模型目录：`GET https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models`。
- 账号面：`https://agent.xfyun.cn/xingchen-studio/`（`points/balance`、`membership/me`、`membership/plan-config`、`points/summary`、`client-popups/pending`，Cookie 会话鉴权 + `clientType` / `studioVersion` 身份头）。

## 风险提示

非官方集成，凭据与协议来自桌面客户端逆向，上游随时可能变更；共享登录态的自动化使用可能违反 AStudio 服务条款，账号风险自担。请勿用于批量/滥用场景。

## 安装与开发

```
magpie plugin add @magpie-community/opencode-astudio-auth
magpie plugin login astudio                 # 选「浏览器登录」「读取 AStudio 桌面端登录态」或「粘贴 modelBearerToken」
magpie provider test astudio spark-x2.6-4b  # 限免模型，验收一发
```

测试（零依赖，Node ≥18 或 Bun）：

```
npm test          # = node --test
# 或 bun test
```
