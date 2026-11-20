# Kapibala （卡皮巴拉API) Magpie 插件

把 [kapibala.asia](https://kapibala.asia) 接进 [Magpie](https://usemagpie.ai) 做供应商：登录、按分组走模型、看钱包和订阅余额、每日签到。

kapibala.asia 是一个基于 [New API](https://github.com/QuantumNous/new-api) 的中转站。它的 newApi 接口只能查到钱包余额，读不到订阅余额（订阅余额只能在网页上看到）。这个插件直接读面板接口，让你在 Magpie 里登录、签到，并同时看到钱包余额和订阅余额。

## 功能

- **登录**：用 kapibala 的 API key（`sk-...`）登录。一把 key 就是一个 Magpie 账号；开了几把 key，就登录几次。
- **模型按分组走**：一把 key 属于一个分组（比如 `vip`、`default`）。不同分组的模型可能重名，插件在列表里把模型显示为 `<分组>/<模型>`（比如 `vip/gpt-5`、`default/deepseek-chat`），选哪个就走哪个分组的那把 key，不会串。分组是登录时插件去面板查的，不用手动填；查不到分组的账号，模型直接显示原名、不带前缀。
- **用量卡片**：同一张卡片上显示订阅和钱包两行。订阅按 Magpie 的订阅卡片样式显示已用 / 总量和占比（比如 `12.50 / 100 $ · 12.5% used`，设了显示剩余会变成 `87.50 / 100 $ · 87.5% left`），到期日显示在卡片的截止日期上；下面一行是钱包余额。没有生效中的订阅时，卡片只显示钱包余额。
- **每日签到**：Magpie 每天自动帮你签到。签到前先查今天签过没有，签过就不再重复签。

## 安装

### 从 Magpie 的插件发现页安装

在 Magpie 的 **Plugins（插件）** 页面搜索 **Kapibala**，点安装即可。

### 从 GitHub 仓库安装

在 Magpie 的 **Plugins（插件）** 页面 → **Add plugin（添加插件）**，输入仓库地址：

```
github:stillmoon/magpie-kapibala
```

### 从文件夹安装

1. 把这个仓库克隆或下载到电脑上一个固定的位置，不要再移动它。
2. 打开 Magpie → **Plugins（插件）** 页面 → **Add plugin（添加插件）** → 选择 **from a folder（从文件夹）**，选中这个文件夹。

装好后，到 **Providers（供应商）** 页面，会出现 **Kapibala**，点 **Sign in（登录）**。

## 登录要填的东西

登录时只问两样，都是在 kapibala 网站上拿的，**不要发给任何人**。分组不用填，插件登录时直接去面板查这把 key 的分组。

| 要填的 | 在哪拿 |
| --- | --- |
| API key（`sk-...`） | kapibala.asia → **API 密钥**（`/keys`）里你要用的那把 key。 |
| 面板访问令牌（`nap_...`，可空） | kapibala.asia → **安全与访问**（`/security`）→ **访问令牌**。新建一个，权限勾上钱包查看和钱包编辑。**第一个账号必须填**——额度（钱包和订阅余额）和签到都是靠它查的，不填就不显示；**分组也是靠它查的**，不填就查不到分组，模型会不带分组前缀显示。**同一个 kapibala 账号的第二把 key 可以留空**——用量和签到会走已经登好的那个账号，不用重复填；只有换了另一个 kapibala 账号时才需要填它自己的令牌。 |

**多个分组要登录多次**：有几把 key 就登录几次，分组是登录时自动查的，不用手动填。同一 kapibala 账号的几把 key 用同一个 `nap_` 令牌就行，第二把登录时令牌那一栏可以直接留空（留空的话这把 key 查不到分组，模型会不带前缀显示，但走的还是它自己的那把 key）。

凭证只存在本机 Magpie 的 `plugin-auth.json` 里，不会发到别处。

## 用量卡片按访问令牌分组

同一个 `nap_` 令牌就是同一个 kapibala 账号，所以用量卡片按令牌分组：同一账号的几把 key 用同一个令牌时，看板上只显示一份（订阅 + 钱包余额），不会重复出现多份。只有用了不同令牌的另一个 kapibala 账号，才会再显示一份它自己的。

## 模型找不到怎么办

插件的模型列表就是拿你那把 key 去问 `GET /v1/models` 拿到的，有多少列多少，插件自己不过滤。所以先查 key 本身：

1. 到 kapibala.asia 的 **API 密钥**（`/keys`）点进这把 key，看它允许用的模型有没有勾上你要的那个。newApi 的 key 可以限制可用模型，没勾上的模型不会出现在接口返回里，插件也就列不出来。勾上之后，在 Magpie 里重新登录一次（或重启 Magpie）刷新列表。
2. 如果某个模型你已经在 Magpie 里手动加过，插件再刷新列表时不会把它覆盖掉；接口那次没返回或报错时，也会保留本分组已有的模型，而不是清空。

## 签到有个限制

签到接口挂了 Cloudflare Turnstile（人机验证），插件发不出那个票据。所以：

- 如果今天还没签、且网站那次没要验证，插件能帮你签下来，Magpie 会显示领到了多少。
- 如果网站那次要人机验证，插件会返回“需要验证”，Magpie 会提示你去 kapibala.asia 的个人资料页（`/profile`）点一下签到——点一下就行，当天就不会再重复签。

## 余额怎么算

newApi 的配额单位是 500000 配额 = $1，插件按这个换算：

- 钱包余额 = `quota / 500000`
- 订阅剩余 = `(amount_total - amount_used) / 500000`
- 签到奖励 = `quota_awarded / 500000`

## 模型接口

- 模型接口基址：`https://api.kapibala.asia/v1`（chat completions，OpenAI 兼容）
- 面板接口基址：`https://kapibala.asia/api`（钱包 `/api/user/self`、订阅 `/api/subscription/self`、套餐 `/api/subscription/plans`、签到 `/api/user/checkin`、令牌列表 `/api/token/`）

## 文件

- `index.mjs`：插件本体（登录、模型、用量、签到、转发）
- `opencode.mjs` / `opencode2.mjs`：OpenCode 1.x / 2.x 入口
- `package.json`：包信息

## 许可证

MIT
