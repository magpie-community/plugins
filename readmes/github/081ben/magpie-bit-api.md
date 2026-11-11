# baipiao — bit-api 提供商插件

[magpie](https://usemagpie.ai) / [OpenCode](https://opencode.ai) 的提供商插件,接入
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

走站点自己的网页登录,能查余额、能签到:

1. magpie 里选择该登录方式,插件会打开 bit-api 的登录页;
2. 在页面上完成登录(整个登录流程都发生在你的浏览器里——登录流绑定一个只有
   浏览器持有的 HttpOnly cookie,插件无法代劳);
3. 登录完成后,bit-api 页面会把会话 token 存起来:在该页面按 **F12** 打开控制台,
   运行 `localStorage.bitapi_token`,复制输出的那串 JWT,粘贴回 magpie;
4. 插件验真 token 后,自动抓取账户第一把启用的聊天密钥(与控制台"复制"按钮走同一个
   reveal 接口),聊天与拉模型都用它。

token 是站点自己签发的 JWT,默认 7 天有效。站点不签发 refresh token,过期后照原样
重来一遍(打开浏览器、粘贴新 token)即可。

### 二、API key

在控制台的 Keys 页复制一把聊天密钥(`sk-…`)直接粘贴。只能拉模型、发请求;
**查余额和签到需要账户登录**,纯 key 不支持。

## 插件读取的接口

| 接口 | 凭据 | 用途 |
|---|---|---|
| `GET /v1/models` | API key | 账户分组可用模型(`https://ai.baipiao.co/v1`) |
| `GET /api/overview` | 会话 token | 余额(卡片余额行)、今日消费与请求数 |
| `POST /api/checkin` | 会话 token | 每日签到,UTC+8 自然日一次 |
| `GET /api/keys` + `GET /api/keys/{id}/reveal` | 会话 token | 密钥列表只给脱敏串,明文按 id 单取 |

网关本身兼容 OpenAI chat completions、Responses 与 Anthropic Messages 三种协议,
模型条目一份即可服务所有协议。

## 签到

在 magpie 的 **Settings → Usage → Plugins** 里打开 baipiao 的 Daily check-in 开关。
奖励金额由站点在自己配置的区间内随机;当天已签返回 `done`,当日首次返回 `claimed`。

## 凭据存放

存在 OpenCode / magpie 自己的 auth store 里(`~/.local/share/opencode/auth.json`,
magpie 同结构),条目名为 `baipiao`。

## 本地测试

```sh
bun test packages/baipiao
```

## 许可

MIT
