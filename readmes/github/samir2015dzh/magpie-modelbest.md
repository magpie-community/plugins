# magpie-modelbest

[English](#english) · [中文](#中文)

---

## 中文

ModelBest（面壁智能 MiniCPM）的 [magpie](https://usemagpie.ai) / OpenCode 供应商插件。

**登录只要两样：账号 + 密码，一次。** API key、控制台 token、每日签到、到期续期全部由插件自己在服务端完成——不需要浏览器，不依赖本机任何东西，`magpie` 跑在 Docker 里就行。

```
user_xxxxxx                    积分
1250 / 1500 积分 · 剩余 83.3%
  ● 今日已签到                 自动签到
```

### 安装

```bash
magpie plugin add samir2015dzh/magpie-modelbest
magpie plugin login modelbest            # 选「ModelBest 账号登录（推荐）」，填手机号/邮箱 + 密码
magpie provider test modelbest
magpie quota
```

应用里：插件 → 添加插件 → 在 `ModelBest 面壁智能` 那一行登录 → 给这个供应商打开「自动签到」。

### 为什么是账号密码

magpie 一般装在服务器或容器里，那里没有浏览器可以借。而 ModelBest 的积分和签到只认控制台会话，那个会话是 7 天的 JWT，**没有 refresh 接口**（`/auth/refresh`、`/auth/token/refresh`、`/auth/renew`、`/auth/session/refresh`、`/auth/token` 一律 404），`/me` 也不换发。要新 token 只能重新 `POST /auth/login`，而登录强制滑块（`captcha_enabled: true`）。

于是只剩一条能在服务端全自动跑的路：**插件自己解滑块、自己登录**。这也是为什么需要账号密码——它是唯一能让服务器在没有你的情况下拿到新 token 的东西。

登录时发生的事：

1. `POST /auth/captcha` 取背景图和拼图块
2. 定位缺口：目标是背景图上一块半透明压暗的方块，找「比外圈暗得最多」的窗口（积分图，约 10ms）
3. `POST /auth/captcha/verify` 换一次性 `captcha_id`（单次通过率约六七成，失败换一张，最多 8 次）
4. `POST /auth/login` 拿 console token
5. `GET /keys` → `GET /keys/{id}/secret` 把你的 API key 也取出来（没有就 `POST /projects/{id}/keys` 建一个）

之后 magpie 在 token 到期前自动调 `auth.refresh`，用同一套流程静默换新——**你不必再碰它**。

### 账号开了二次验证怎么办

有些账号密码登录后会要求「确认是你本人」，`/auth/login` 返回 `step_up_required`。这时插件不会直接失败，而是走这个流程：

1. 服务端在返回 `step_up_required` 时已经往你的手机/邮箱发了一条 6 位验证码，插件把这件事写进提示
2. magpie 弹出一个输入框（`method: "code"`），你把 6 位数字填进去
3. 插件用 `challenge_token` + 验证码调 `/auth/password-login/verify` 换 token，然后照常取 API key

填错会给一次自动重发的机会。

**但很多情况下连框都不弹**：服务端判定这个登录环境可信时，会把验证码直接放进响应体的 `code` 字段（控制台前端把它显示成「当前环境验证码」），插件拿到就直接自己验掉了。拿不到、或者猜错，才退回来让你填。

**自动续期做不到填码这一步**——后台刷新时没人能填。所以要求二次验证的账号每 7 天要重新登录一次（到时候 magpie 会提示，点一下、填个码就好）；不需要二次验证的账号则完全静默。

### 凭据存在哪

`~/.config/magpie/plugin-auth.json`（权限 600），和 magpie 存其它供应商登录信息是同一个文件。账号密码按 magpie 的惯例明文存本地，容器里就是数据卷里的那个文件。

不想存密码的话，用第二个登录方式「直接填 API key」：只填 `sk-live-…`，推理能用，但没有积分和签到；再补一个控制台 token 就有积分，但 7 天后要手动补一次。

### 思考（reasoning）实测

后端把 `reasoning_effort` 当**开关**用，不是档位：

| 请求里加什么 | 结果 |
| --- | --- |
| 什么都不加 | 看模型默认：`MiniCPM5-*` 默认就思考，`V-4.6` / `V-4.5` 默认不思考 |
| `reasoning_effort: "none"` | 关 |
| `reasoning_effort: "minimal" / "low" / "medium" / "high"` | 开，**四个档位推理量完全一样**（都跑满预算） |
| `chat_template_kwargs: {enable_thinking: true}` | 开，同上 |
| `enable_thinking: true` / `thinking: {type:"enabled"}` | 无效，被忽略 |
| `MiniCPM-OCR-Jev` 上的任何 effort | 无效，这个模型完全不认 |

所以 magpie 里的低/中/高三档选哪个都一样：选任一档 = 开思考，不选 = 用模型默认。

**简单问题实测都正常**（正文照常给出）：

| 模型 | 不给参数 | 给 high |
| --- | --- | --- |
| `MiniCPM5-1B` | 已在思考，正文 77 字 | 思考 177 字，正文 50 字 |
| `MiniCPM5-2B` | 已在思考，正文 45 字 | 思考 66 字，正文 37 字 |
| `MiniCPM-V-4.6` | 不思考，正文 79 字 | 思考 105 字，正文 50 字 |

**但难题下它们可能停不下来**：思考会把 `max_tokens` 全吃光，`finish_reason: length`、正文为空。`V-4.7-1B`、`V-4.6`、`V-4.5` 用奥数题都复现过（256/1024/4096 三档全是空正文），`V-4.7-35B-A3B` 则能正常收尾（1826 reasoning tokens + 193 字回答）。这是模型本身的行为，不是插件能修的——遇到空回复就把思考档位取消，或者换 35B。

### 模型

七个 chat 模型，按账号从 `GET /v1/models` 实时刷新：

| 模型 | 上下文 | 思考档位 | 说明 |
| --- | --- | --- | --- |
| `MiniCPM-V-4.7-35B-A3B` | 256k | 低/中/高 | 免费，视觉、视频、工具调用，思考最稳 |
| `MiniCPM-V-4.7-1B` | 256k | 低/中/高 | 免费，视觉、视频、工具调用 |
| `MiniCPM-V-4.6` | 256k | 低/中/高 | 视觉、视频、工具调用 |
| `MiniCPM-V-4.5` | 40k | 低/中/高 | 视觉、视频、工具调用 |
| `MiniCPM5-2B` | 128k | 低/中/高 | 文本，默认就思考 |
| `MiniCPM5-1B` | 128k | 低/中/高 | 文本、工具调用，默认就思考 |
| `MiniCPM-OCR-Jev` | 32k | 无 | 视觉、文件输入，不认 reasoning 参数 |

不列出的：`MiniCPM-OCR-1.0` 只有 `document_parse` 协议、`VoxCPM2` 是语音合成、`MiniCPM-o-4.5-Realtime` 走实时通道，都不吃 chat completions。

最大输出：后端除 `MiniCPM-o-4.5-Realtime`（4096）外一律报 `max_output_tokens: 0`，插件填 8192 是保守默认，不是真实上限，可以在 magpie 的模型设置页直接改。



### 限制

- 「真密码换到真 token」这段没有端到端实测：手上没有可用的账号密码。已验证的是整条链路能走到 `/auth/login`——假账号会返回「账号或密码错误」，说明滑块确实解出来并被服务端接受。第一次真登录就是它的首飞。
- 账号开了邮箱二次验证时自动登录走不通（返回 `step_up_required`），插件会明说，此时只能用「直接填 API key」。
- 控制台改版可能让滑块求解失效，表现是「滑块没解出来」或「人机验证未通过」。
- 积分总量只统计当前有效的额度包，已过期的不计入分母。

### 自测

```bash
node verify.mjs                          # 静态检查 + 假账号跑一遍登录链
MB_ACCOUNT=... MB_PASSWORD=... node verify.mjs   # 真账号，跑完整钩子
```

`verify.mjs` 会用假账号真解一次滑块，看到「账号或密码错误」就说明服务端这条路通了。

### 依赖

`vendor/jpeg-js`（0.4.4）和 `vendor/pngjs`（7.0.0），纯 JS、无构建、MIT，已提交进仓库，从 git 安装不需要 `npm install`。只用来解验证码图片。全流程只有 HTTP，没有浏览器、没有外部二进制。

---

## English

ModelBest (面壁智能 / MiniCPM) provider plugin for [magpie](https://usemagpie.ai) and OpenCode.

**Sign in with an account and a password, once.** The plugin obtains the API key, the console token, the daily check-in and the renewal by itself, entirely server-side — no browser, nothing needed on the host, fine inside a Docker container.

### Install

```bash
magpie plugin add samir2015dzh/magpie-modelbest
magpie plugin login modelbest      # pick 「ModelBest 账号登录（推荐）」, enter phone/email + password
magpie provider test modelbest
magpie quota
```

### Why account and password

magpie usually runs on a server or in a container, where there is no browser to borrow. Credits and check-in only accept the console session, which is a 7-day JWT with **no refresh endpoint** (all of `/auth/refresh`, `/auth/token/refresh`, `/auth/renew`, `/auth/session/refresh`, `/auth/token` return 404) and `/me` does not reissue it. A new token requires `POST /auth/login`, which enforces a slider captcha (`captcha_enabled: true`).

So the only fully automatic server-side path is: the plugin solves the captcha and logs in itself. That is why it needs the password — it is the only thing that lets a server obtain a new token without you.

During login it: fetches the captcha, locates the gap (a half-transparent dark block — the window darker than its surroundings, via integral image, ~10 ms), verifies it for a one-shot `captcha_id` (single-shot success about two in three, retried up to 8 times), calls `/auth/login`, then pulls your API key from `/keys` → `/keys/{id}/secret` (creating one if the account has none).

After that magpie calls `auth.refresh` before expiry and the same flow runs silently. You never touch it again.

### Credentials

`~/.config/magpie/plugin-auth.json` (mode 600), the same file magpie uses for every provider login. The password is stored there in plaintext, as magpie does for every other credential.

### Limitations

- The real-password → real-token hop has never been run end-to-end (no usable account at hand). Verified is the whole chain up to `/auth/login`: a fake account returns 账号或密码错误, proving the captcha was solved and accepted.
- Accounts with email step-up cannot auto-login (`step_up_required`); the plugin says so and you fall back to pasting an API key.
- A console redesign can break the captcha solver.
- Credit totals count only currently active packs.

## License

MIT
