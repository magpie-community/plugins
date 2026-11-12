# magpie-comate-auth

给 magpie 加一张**文心快码（Baidu Comate）**账号卡片：会员席位积分、增购积分、赠送积分一眼看全。

## 为什么要单独一个插件

百度搭子的 Pro / Max 会员和文心快码**共用同一份会员权益**：在搭子那边下单买的会员，积分（席位积分，Pro 25,000 分/月、Max 100,000 分/月）落在 **comate.baidu.com** 的账号上，不在搭子自己的配额接口里。

所以只看 `magpie-dumate` 那张卡片，会看到「只有签到赠送积分、会员那 25,000 分不见了」。装上这个插件，同一份百度登录态就能把会员积分显示出来。

## 它做什么 / 不做什么

- 做：`auth`（复用 magpie 里已登录的百度账号，或浏览器粘贴 Cookie）+ `usage`（读 `/api/user/agent/balance`）。
- 不做：不提供模型。文心快码的模型只能通过 IDE 调用，没有公开的 OpenAI 兼容端点，所以这张卡片只显示额度，不会出现在模型列表里。
- 不写任何本地文件、不改 magpie 其它 provider 的配置。卸载干净：`magpie plugin rm magpie-comate-auth`。

## 安装

```bash
magpie plugin add D:/AI/hermes/magpie-comate-auth
```

（或先把仓库推到 GitHub，`magpie plugin add github:ikashana/magpie-comate-auth`；仓库需要带 `magpie-plugin` topic。）

## 登录

三种方式，卡片右上角「登录」里任选：

1. **复用 magpie 里已登录的百度账号（零操作）** —— 只读 `<data>/plugin-auth.json` 里 `dumate`（或 `comate`）的 cookies，验证后直接建账号。已经在 magpie 里登录过百度搭子的话，选这个即可。
2. **百度账号浏览器登录（粘贴 Cookie）** —— 登录 `comate.baidu.com`，F12 → Network → 点任意 comate.baidu.com 请求 → 复制 Request Headers 的 `Cookie` 整行。关键 cookie `BDUSS` 是 httpOnly，`document.cookie` 拿不到，必须从 Network 面板复制。
3. **手动粘贴 Cookie 字符串** —— 同上，给已经手上有 cookie 串的场景。

## 显示内容

| 字段 | 含义 |
| --- | --- |
| `plan` | 会员等级从席位积分反推：`会员 · 席位 25,000 分/月`，后面附下期补满日期或最近到期日 |
| `balance` | 席位 + 增购 + 赠送 + 独立积分包 的**可用**合计 |
| `windows[]` | 每类积分一行（只列总额 > 0 的）：已用 / 总额 |
| `user` | 百度账号名 |

## 接口（实测）

```
GET https://comate.baidu.com/api/user
GET https://comate.baidu.com/api/user/agent/balance
GET https://comate.baidu.com/api/user/agent/addon/detail
GET https://comate.baidu.com/api/user/agent/gift/detail
```

`balance` 返回：

```json
{
  "seatPoints":            { "totalPoints": 25000, "usedPoints": 0,      "availablePoints": 25000 },
  "addonPoints":           { "totalPoints": 0,     "usedPoints": 0,      "availablePoints": 0 },
  "giftPoints":            { "totalPoints": 500,   "usedPoints": 472.13, "availablePoints": 27.87 },
  "seatPointsNextUpdate":  "2026-12-13 00:25:57"
}
```

## 踩过的坑

- **不能带 `bce-*` cookie。** 从百度搭子（`console.bce.baidu.com`）复用的登录态里有一堆 `bce-sessionid`、`bce-passport-stoken` 等百度智能云控制台的会话 cookie；带着它们访问 `comate.baidu.com`，服务端会走 BCE 鉴权路径并直接返回 `{"status":"UNAUTHORIZED","message":"没有授权!"}`。`buildCookieHeader` 里把它们剔掉即可（`x-bce-login-redirect-url` 这几个要留着）。
- **别保存服务端下发的 `SESSION`。** 无 SESSION 请求 `balance` 会成功并 `Set-Cookie: SESSION`，但**带着这个 SESSION 再请求反而变成 `没有授权!`**。所以插件不维护 cookie jar、不写回任何 cookie，每次都用登录时那份快照。
- **连打会被限流。** 同一个登录态短时间内发好几次请求，之后会连续返回 `没有授权!`（几分钟到十几分钟自己恢复）。插件因此：只打 `balance` 一个接口、不重试、结果缓存 10 分钟、失败时回落到上次的数据。别把它当故障去疯狂刷新。
- **`/api/user` 比 `balance` 更容易被拒。** 拿账号名只在登录时试一次，拿不到就退回 `balance` 判断登录态；卡片上的用户名用登录时存下的。
- **插件可能被原地加载。** `magpie plugin add <路径>` 不会把插件拷进 `data/plugins/node_modules`，所以 `import.meta.url` 相对定位找不到 `plugin-auth.json`。要按 `MAGPIE_DATA` → `process.execPath`（magpie.exe 同级 `data/`）→ 插件自身位置 → `cwd` 依次找。
- **`/api/user/agent/balance` 才是积分本体。** 个人中心页面上那几个数字是从这个接口来的；`/api/user/score/balance`、`/api/user/vip` 一类路径不存在（404）。
- Cookie 必须按域名过滤到 `.baidu.com`，passport 的 `BDUSS` 是 httpOnly。
- 日期直接按接口原串（`2026-12-13 00:25:57`）显示，别经 `Date` 转 ISO —— 会掉到 UTC 前一天。

## 许可

MIT