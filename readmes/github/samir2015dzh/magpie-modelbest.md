# magpie-modelbest

[English](#english) · [中文](#中文)

---

## English

ModelBest (面壁智能 / MiniCPM) provider plugin for [magpie](https://usemagpie.ai) and OpenCode. Credit balance and daily check-in show up on the account card, and the console token renews itself before it expires.

```
user_xxxxxx                     积分
1250 / 1500 积分 · 剩余 83.3%
  ● 今日已签到                   自动签到
```

### Install

```bash
# from GitHub
magpie plugin add samir2015dzh/magpie-modelbest

# or from a local folder
magpie plugin add /path/to/magpie-modelbest
```

Then:

```bash
magpie plugin login modelbest
magpie provider test modelbest
magpie quota
```

In the app: 插件 → 添加插件, log in on the `ModelBest 面壁智能` row, and turn on 自动签到 for that provider.

### What you log in with

Two credentials, because ModelBest uses two different ones and neither works for the other's job:

| Input | Where to get it | Used for |
| --- | --- | --- |
| **API key** `sk-live-…` (required) | Platform console → 密钥 | Inference at `https://api.modelbest.cn/v1` |
| **Console account** (optional) | The phone/email you sign in to platform.modelbest.cn | Auto-renewal |
| **Console password** (optional) | Same | Auto-renewal |
| **Console token** (optional) | Signed-in page, DevTools Console: `copy(localStorage.map_token)` | One-time import; account+password renew it after |

With only the API key, inference works but the card has no credits, no check-in and no renewal. With account + password you never touch the token again. With only the token, you re-paste it every 7 days.

### Where credentials are stored

`~/.config/magpie/plugin-auth.json` (mode 600), the same file magpie uses for every other provider login. The account password is stored there in plaintext, exactly like every other credential magpie keeps.

### Models

Seven chat models, refreshed per account from `GET /v1/models`:

| Model | Context | Notes |
| --- | --- | --- |
| `MiniCPM-V-4.7-35B-A3B` | 256k | free, vision, video, reasoning, tool calls |
| `MiniCPM-V-4.7-1B` | 256k | free, vision, video, reasoning, tool calls |
| `MiniCPM-V-4.6` | 256k | vision, video, tool calls |
| `MiniCPM-V-4.5` | 40k | vision, video, tool calls |
| `MiniCPM5-2B` | 128k | text |
| `MiniCPM5-1B` | 128k | text, tool calls |
| `MiniCPM-OCR-Jev` | 32k | vision, file input |

Not listed on purpose: `MiniCPM-OCR-1.0` (only speaks the `document_parse` protocol), `VoxCPM2` (speech synthesis), `MiniCPM-o-4.5-Realtime` (realtime channel) — none of them accept chat completions.

### How auto-renewal works

The console token is a 7-day JWT. There is no refresh endpoint (`/auth/refresh`, `/auth/token/refresh`, `/auth/renew`, `/auth/session/refresh`, `/auth/token` all 404), `/me` does not reissue it, the `sk-live-…` key is rejected by every console endpoint (`10001`), and a guest token only reaches the playground (`10010`). The only way to a new token is `POST /auth/login`, which enforces a slider captcha (`captcha_enabled: true`).

So `ensureConsole()` solves the slider itself when the token has under 3 days left:

1. `POST /auth/captcha` → background image + puzzle piece
2. Find the gap: the target is a half-transparent dark block, so locate the window that is darker than its surroundings (integral image, ~10 ms)
3. `POST /auth/captcha/verify {id, x, y}` → one-shot `captcha_id`
4. `POST /auth/login {account, password, captcha_id}` → new token
5. `client.auth.set()` writes `consoleToken` / `consoleExpires` back to the account

Single-shot success is roughly two in three; a miss just fetches a new image, up to 8 tries. Measured 10/10 runs passed on the first try.

One gotcha worth repeating: `x` is the gap's **absolute horizontal coordinate in the background image**, not the drag distance. go-captcha's `confirm` callback reports `F = M + J*L`, i.e. the puzzle piece's final `left`. Passing the delta instead keeps you at `20014 人机验证未通过` forever.

### Hooks

| Hook | Behaviour |
| --- | --- |
| `config` | Declares provider `modelbest`, `@ai-sdk/openai-compatible`, with a static model table so it works offline |
| `auth.loader` | `baseURL = https://api.modelbest.cn/v1`; magpie sends the key as `Authorization: Bearer` |
| `auth.usage` | Reads `/billing/account`, `/rewards`, `/billing/credit-packages`, `/me`; builds the 积分 and 每日签到 windows |
| `auth.checkin` | `POST /rewards/daily-checkins`, returns `claimed` / `done` |
| `provider.models` | Refreshes context/output limits from `/v1/models`; falls back to the static table |

Where the credit numbers come from: remaining = sum of `remaining_amount` over active credit packs + `other_available_balance`; total = sum of `original_amount` + `other_available_balance`; the earliest `expires_at` becomes the card's expiry hint.

### Limitations

- The renewal path has never been run end-to-end with a real password — only the whole chain up to `/auth/login` was verified (a fake account reaches the endpoint and returns 账号或密码错误, which proves the captcha was solved and accepted).
- If the account has email step-up enabled, login returns `step_up_required`; the plugin says so instead of pretending, and you paste a fresh token.
- A console redesign can break the solver. The symptom is `滑块没解出来` / `人机验证未通过`; pasting a `consoleToken` keeps things working for another 7 days.
- Credit totals only count currently active packs; expired ones are not in the denominator.

### Self-check

```bash
MB_KEY=sk-live-… MB_CONSOLE=… node verify.mjs
```

Runs every hook, then the two expiry branches: invalid token with no account/password (expects `signIn: expired`) and invalid token with a fake account (expects a login failure). `checkin` really calls the endpoint — idempotent once already checked in.

Slider only:

```bash
node _login_sim.mjs 8 4    # 8 tries max, 4 rounds; prints which attempt passed
```

### Dependencies

`vendor/jpeg-js` (0.4.4) and `vendor/pngjs` (7.0.0) — pure JS, no build step, MIT, committed to the repo so installing from git needs no `npm install`. They only decode the captcha images. Everything magpie calls is `.mjs` and runs on Bun.

---

## 中文

ModelBest（面壁智能 MiniCPM）的 [magpie](https://usemagpie.ai) / OpenCode 供应商插件。账号卡片上显示积分余额和每日签到，控制台 token 到期前自动续。

### 安装

```bash
magpie plugin add samir2015dzh/magpie-modelbest   # 从 GitHub
magpie plugin add /path/to/magpie-modelbest       # 或本地文件夹
magpie plugin login modelbest
magpie provider test modelbest
magpie quota
```

应用里：插件 → 添加插件 → 在 `ModelBest 面壁智能` 那一行登录 → 给这个供应商打开「自动签到」。

### 登录要填什么

两套凭据，因为 ModelBest 推理和积分走的是不同鉴权，互相不通用：

| 输入 | 从哪拿 | 用途 |
| --- | --- | --- |
| **API key** `sk-live-…`（必填） | 控制台「密钥」页 | 推理，`https://api.modelbest.cn/v1` |
| **控制台账号**（可选） | 登录 platform.modelbest.cn 的手机号/邮箱 | 自动续期 |
| **控制台密码**（可选） | 同上 | 自动续期 |
| **控制台 token**（可选） | 已登录网页 F12 Console：`copy(localStorage.map_token)` | 一次性导入，之后靠账号密码续 |

只填 API key：推理正常，但卡片没有积分、签到和续期。填了账号密码：再也不用管 token。只填 token：7 天后重填一次。

### 凭据存在哪

`~/.config/magpie/plugin-auth.json`（权限 600），和 magpie 存其它供应商登录信息是同一个文件。账号密码按 magpie 的惯例明文存本地。

### 自动续期怎么做的

控制台 token 是 7 天的 JWT，没有 refresh 接口（`/auth/refresh` 等一律 404），`/me` 不换发，`sk-live-…` key 读不了控制台（`10001`），游客 token 只到体验中心（`10010`）。唯一的路是重新 `POST /auth/login`，而它强制滑块（`captcha_enabled: true`）。

所以 token 剩不到 3 天时 `ensureConsole()` 自己解滑块：

1. `POST /auth/captcha` 拿背景图 + 拼图块
2. 定位缺口：目标是一块半透明压暗的方块，找「比外圈暗得最多」的窗口（积分图，约 10ms）
3. `POST /auth/captcha/verify {id, x, y}` 换一次性 `captcha_id`
4. `POST /auth/login {account, password, captcha_id}` 拿新 token
5. `client.auth.set()` 把 `consoleToken` / `consoleExpires` 写回账号

单次通过率约六七成，失败换一张重来，最多 8 次。实测 10/10 都是第 1 次过。

一个值得重复的坑：`x` 是缺口在背景图里的**绝对横坐标**，不是拖拽位移。go-captcha 的 `confirm` 回调给的是 `F = M + J*L`，即拼图最终 `left`。传位移会一直 `20014 人机验证未通过`。

### 限制

- 自动续期没做过「真密码换真 token」的端到端实测，只验到整条链路能走到 `/auth/login`（假账号会返回「账号或密码错误」，说明滑块确实过了并被接受）。
- 账号开了邮箱二次验证时登录返回 `step_up_required`，插件会明说，此时手动填一次 token。
- 控制台改版可能让求解器失效，表现是「滑块没解出来」。填一次 `consoleToken` 仍可继续用 7 天。
- 积分总量只统计当前有效的额度包。

## License

MIT
