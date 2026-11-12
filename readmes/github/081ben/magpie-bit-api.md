# baipiao — bit-api 提供商插件

[magpie](https://usemagpie.ai) 的提供商插件,接入
[bit-api](https://ai.baipiao.co/)。

名称说明:

- **bit-api** — 站点名,即 https://ai.baipiao.co/ (域名属 baipiao.co);
- **bitapi** — 该站点使用的网关程序(https://github.com/kingenbomb/bitapi),
  站点的接口行为以它为准;
- **baipiao** — 本插件的名字与提供商 id(取自域名,避免与站点名混淆)。

功能:登录账户、列出分组可用模型、查询余额、每日自动签到。

提供商 id:`baipiao`

## 免责声明

本项目是社区开发的第三方插件,与 bit-api(ai.baipiao.co)、bitapi 及任何模型服务商
均无隶属或合作关系。插件仅调用站点公开的网页接口,按站点规则登录和使用;
签到、余额、模型可用性等均取决于站点自身的配置与变动,随时可能改变或失效。
使用本项目产生的账号安全、费用、数据与合规问题由使用者自行承担。
请遵守站点服务条款与当地法律法规。


## 登录方式

两种,二选一:

### 一、浏览器登录(账户)——推荐

走站点自己的网页登录,能查余额、能签到。magpie 会**连着问两格**——先粘会话 cookie,
点「下一步」,再粘聊天密钥:

1. 选这种登录方式时,插件会**自己打开** bit-api 的登录页
   (https://ai.baipiao.co/portal#/login)。若浏览器没弹出,手动打开该地址即可。
   在页面上用「社区登录」完成登录(整个登录流程都发生在你的浏览器里——登录流绑定
   一个只有浏览器持有的 HttpOnly cookie,插件无法代劳);
2. 登录完成后,bit-api 把会话存在 **HttpOnly cookie `bitapi_session`** 里
   (旁边还有一个 `bitapi_csrf`)。页面脚本读不到它,站点自己还会在每次加载时
   `localStorage.removeItem("bitapi_token")`,所以**不能再从 localStorage 取 token**。
   在该页面按 **F12**,打开 **Application → Cookies → https://ai.baipiao.co**,
   复制 `bitapi_session` 的值;也可以从 **Network** 面板任一 `/api` 请求里复制整条
   `Cookie` 头,插件会自己取出其中的 `bitapi_session`。把这段粘进**第一格**,
   点「下一步」;
3. 到控制台的 **Keys** 页复制一把聊天密钥(`sk-…`),粘进**第二格**,点「登录」。

两格都必填。插件用会话验真身份并查余额、签到,聊天与拉模型用你给的这把 key。

为什么是两格提问而不是登录后一个粘贴框:magpie 在浏览器步骤之后只给**一个**
单行粘贴框(换行会被吞掉),而 magpie 的提问框(`ask` 钩子,pi 的登录就用它)
可以一个接一个地问,所以插件把登录页的打开放在第一问发生时,登录完再问第二问。
插件也不会去猜账户里"第一把"密钥(`/api/keys` 与 reveal 接口从不调用),用哪把
由你决定。

cookie 里装的就是站点签发的会话 JWT,默认 7 天有效;`bitapi_session` 本身是
HttpOnly,而插件用的是同一个 JWT 的 `Authorization: Bearer`(bitapi 对脚本客户端
保留 Bearer,GET 请求不需要 CSRF 头)。站点不签发 refresh token,过期后照原样
重来一遍(重新登录、粘贴新 cookie 与 key)即可。

### 二、API key

在控制台的 Keys 页复制一把聊天密钥(`sk-…`)直接粘贴。只能拉模型、发请求;
**查余额和签到需要账户登录**,纯 key 不支持。

## 插件读取的接口

| 接口 | 凭据 | 用途 |
|---|---|---|
| `GET /v1/models` | API key | 账户分组可用模型(`https://ai.baipiao.co/v1`) |
| `GET /api/overview` | 会话 token | 余额(卡片余额行)、今日消费与请求数 |
| `POST /api/checkin` | 会话 token | 每日签到,UTC+8 自然日一次 |

站点的密钥列表(`/api/keys`)与明文 reveal 接口插件**不调用**:聊天用哪把 key
由登录时你粘的那把决定。

站点把浏览器登录态放在 HttpOnly cookie `bitapi_session` 里,同一份 JWT 也接受
脚本客户端用 `Authorization: Bearer` 发来;插件走的就是 Bearer,因此 POST
(`/api/checkin`)不需要 `X-CSRF-Token`。

网关本身兼容 OpenAI chat completions、Responses 与 Anthropic Messages 三种协议,
模型条目一份即可服务所有协议。

## 签到

在 magpie 的 **Settings → Usage → Plugins** 里打开 baipiao 的 Daily check-in 开关。
奖励金额由站点在自己配置的区间内随机;当天已签返回 `done`,当日首次返回 `claimed`。

## 凭据存放

存在 magpie 自己的 auth store 里(`~/.config/magpie/plugin-auth.json`,条目名为
`baipiao`),文件权限 0600。浏览器登录的条目是 `{type: "oauth", access, refresh:
"none", expires: 0, apiKey, accountId}`,纯 key 的是 `{type: "api", key}`。

浏览器登录用的是 magpie 的 `ask` 钩子(pi 的登录也用它),所以提问可以发生在
打开登录页之后:第一问粘 cookie 时插件打开登录页,第二问粘 key。magpie 的
`prompts` 做不到这一点——它在 `authorize` 之前就把问题问完。

## 本地测试

```sh
bun test packages/baipiao
```

## 许可

MIT
