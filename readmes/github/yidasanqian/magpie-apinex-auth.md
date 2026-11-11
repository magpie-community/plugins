# magpie-apinex-auth

APInex 的 magpie 供应商插件。用浏览器设备码登录或 API key 登录，然后在 magpie 里自动完成每日签到，领取免费模型的每日额度。

## 登录方式

| 方式 | 说明 | 保存内容 |
| --- | --- | --- |
| `Sign in with APInex (browser)` | 走 `apinex-cli` 的设备码流程，magpie 打开 `apinex.bond/cli/device`，确认后插件轮询换取 token | `access` / `refresh` / `expires` |
| `APInex API key` | 直接填 `sk-apx…`，保存前会调用 `/v1/models` 校验 | `key` |

设备码流程用的是 CLI 官方接口：`POST /api/cli/oauth/device` 拿码，`POST /api/cli/oauth/token` 换 token。两个请求都要带 `src: <来源>` 头，缺了会被当成未知客户端拒绝。

## 模型

`provider.models` 从 `https://api.apinex.bond/api/public/models` 读实时目录，含上下文窗口、视觉、工具调用、每百万 token 价格和免费标记；接口不可用时回落到插件内置的 20 个模型（带 `magpie.fellBack` 标记）。请求走 OpenAI 兼容的 `/v1/chat/completions`。

## 每日签到

APInex 的签到接口要求 Cloudflare Turnstile token，只能在真实浏览器里拿到。插件用 CDP 驱动本地 Chrome/Edge：

1. 第一次签到没有缓存的 session cookie，会打开一个窗口，请在其中用 Google 登录 APInex；登录完成后自动签到，并把 `apinex_user_session` 存到 magpie 配置目录下的 `apinex/session.json`。
2. 之后的签到用缓存的 cookie，在屏幕外窗口里取 Turnstile token 完成签到，不打扰桌面。
3. 浏览器 profile 每次都是全新的临时目录，用完即删，并整棵进程树一起收掉，避免 Chrome/Edge 的 profile 锁导致下次启动失败。
4. 真无头模式拿不到 Turnstile token，所以静默签到用的是「有窗口但移到屏幕外」的窗口，不占桌面焦点。

签到结果按 magpie 的 `checkin` 约定返回 `claimed` / `done` / `ineligible` / `inactive` / `captcha` / `failed`。今天已签到返回 `done`，不算失败。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `APINEX_BROWSER` | 指定浏览器可执行文件，默认自动找 Chrome / Edge |
| `APINEX_CHECKIN_HEADED=1` | 强制开窗口签到，方便排查 |
| `APINEX_DEBUG=1` | 把签到过程打到 stderr |

cookie 失效时插件会删掉 `apinex/session.json`，返回 `failed` 并提示重新登录；下次签到就会重新开窗口登录。

## 用量

`auth.usage` 读 `/api/cli/account`，显示套餐、余额和免费 token 窗口（`3,990 / 20,000,000 tokens`，按北京时间 00:00 UTC 重置）。今日未签到时会提示「今日签到后才能用免费模型」，此时 `/v1/chat/completions` 对免费模型返回 `billing_error`。

## 安装

从 GitHub 安装：

```bash
magpie plugin add github:yidasanqian/magpie-apinex-auth
magpie plugin login apinex
magpie provider test apinex
```

也可以就地加载本文件夹（改完代码在 magpie 里关掉再打开即生效）：

```bash
magpie plugin add ./magpie-apinex-auth
```

装好后 agent 里用 `apinex/<model>` 选模型，例如 `apinex/free/glm-5.3-flash`。

## 在 magpie 里找到这个插件

三条路径，按可靠程度排列：

| 路径 | 前提 | 是否已验证 |
| --- | --- | --- |
| `magpie plugin add github:yidasanqian/magpie-apinex-auth` | 无 | 已验证，会写明 `magpie-apinex-auth 0.1.0` |
| 插件 → 发现 → 非官方插件 · GitHub | 仓库打了 `magpie-plugin` topic，magpie 每十分钟拉取一次 | 仓库已带 topic 并出现在 topic 搜索结果中 |
| 插件 → 发现 → npm 上的插件 | 发布到 npm，且 keywords 含 `opencode` | 未发布 npm，未验证 |

「npm 上的插件」这一栏的搜索协议是向 npm 查询 `<关键词> opencode`，并要求名字或 keywords 里含 `opencode`；本插件按 magpie 命名，keywords 为 `magpie`、`magpie-plugin`、`apinex`、`provider`，因此即使发布到 npm 也不会出现在这个搜索里。要进入那份列表，需要把 `opencode` 加回 keywords。

## 图标

https://github.com/yidasanqian/magpie-apinex-auth/blob/main/icon.svg 是源文件；`package.json` 的 `magpie.icon` 保存同一份 SVG 的 `data:image/svg+xml;base64` URI。

magpie 的 `magpie.icon` 只认 `https://` 地址或 `data:` URI，不认包内路径，所以不能写 `./icon.svg`。这里用 data URI 是为了让插件在离线、未发布 npm 的情况下也能显示自己的图标。

## 免责声明

非官方插件，与 APInex 无隶属关系。登录凭据只保存在 magpie 自己的配置目录里（`apinex/session.json` 与 `plugin-auth.json`），不会发往第三方。使用需自行遵守 APInex 的服务条款。