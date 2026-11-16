<p align="center">
  <img src="./icon.png" width="120" height="120" alt="magpie-lightvela-plus logo">
</p>

<h1 align="center">magpie-lightvela-plus</h1>

<p align="center">
  一个插件，接入 LightVela 国内版与国际版<br>
  登录、读 key、用量显示、每日打卡，开箱即用
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.3-blue" alt="version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/magpie-plugin-orange" alt="magpie plugin">
  <a href="https://github.com/alanbulan/magpie-lightvela-plus/stargazers"><img src="https://img.shields.io/github/stars/alanbulan/magpie-lightvela-plus" alt="stars"></a>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#登录方式">登录方式</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="#english">English</a>
</p>

---

**magpie-lightvela-plus** 是 [MagPie](https://github.com/yetone/magpie) / OpenCode 的第三方插件，把 **LightVela** 账号接入为一个标准模型供应商。LightVela 为每个账号提供一个 OpenAI 兼容的模型端点，其凭证（`CUSTOM_API_KEY`）存放在账号名下实例的 `~/.hermes/.env` 中。本插件在你登录后自动读取这把 key 并完成验证，省去手工翻找文件的全部步骤。

本插件将社区插件 [ikashana/magpie-lightvela](https://github.com/ikashana/magpie-lightvela)（国内版，MIT 许可）与国际版适配合并为一个插件：**国内版、国际版、多个账号，在同一个插件里切换使用。**

## 功能特性

- **双版本合一**：国内版（`lightvela.com`）与国际版（`lightvela.ai`）共用一套代码，登录时按账号选择入口。
- **五种登录方式**：手机短信验证码、粘贴会话 token、说明页引导粘贴、直接粘贴、token + API key 兜底，覆盖两版的全部登录形态。
- **自动读取并验证 key**：登录后自动从你的实例读取 `CUSTOM_API_KEY`，并当场请求一次模型列表验证可用，失败立即报错，不留隐患。
- **用量卡片**：套餐名称、积分余额 / 总量、到期日在供应商页面直接可见。
- **每日自动打卡**：MagPie 每日自动执行一次打卡，保持账号活跃；满足条件时自动领取活跃续期奖励。
- **多账号并行**：同一插件可同时登录多个账号（国内、国际、小号），互不干扰。
- **模型列表净化**：自动过滤平台内部端点（`ep-*`）与模拟模型，只呈现真实可用模型。

## 版本对照

| | 国内版 | 国际版 |
|---|---|---|
| 站点 | `lightvela.com` | `lightvela.ai` |
| 控制台 API | `https://api.lightvela.com` | `https://api.lightvela.ai` |
| 模型端点 | `https://token.lightvela.com/v1` | `https://token.lightvela.ai/v1` |
| 账号形态 | 手机号注册 | Google 登录 |
| 推荐登录方式 | 手机短信验证码 | 说明页粘贴会话 token |

两个版本的认证方式一致：`Authorization: Bearer <CUSTOM_API_KEY>`；模型列表以账号 `/v1/models` 的实时返回为准。

## 快速开始

### 安装

**方式一：在 MagPie「发现」中安装**

打开 MagPie → 插件 → 发现 → 非官方插件 · GitHub，搜索 `magpie-lightvela-plus` 并安装（本仓库带有 `magpie-plugin` 主题标签）。

**方式二：按标识安装**

在 MagPie 插件页的「添加插件」中填入：

```
github:alanbulan/magpie-lightvela-plus
```

**方式三：本地目录安装**

将本仓库克隆到本地，在「添加插件」中填入仓库的本地路径即可。适合开发者调试。

### 使用

安装完成后，在 MagPie 的供应商列表中找到 **LightVela（国内+国际）**（provider id：`lightvela-plus`），点击登录，按下文选择对应版本的登录方式。登录成功后，该账号的模型即出现在模型列表中，用量卡片同步显示套餐与积分。

## 登录方式

### 国内版

| 方式 | 说明 |
|---|---|
| 手机验证码（推荐） | 插件在本机起一个仅监听 `127.0.0.1` 的登录页，输入手机号并填写短信验证码，登录成功后插件自动读取 key |
| 粘贴会话 token | 将浏览器中 `api.lightvela.com` 的 `lc_session` 值粘贴进来 |

### 国际版

国际版仅支持 Google 登录、无短信通道，因此都先在网页完成登录，再粘贴会话 token（`lc_session`）：

| 方式 | 说明 |
|---|---|
| 说明页粘贴（推荐） | 插件在本机起一个仅监听 `127.0.0.1` 的说明页，按图文步骤在 `lightvela.ai` 登录后复制 `lc_session` 粘贴进来，插件自动读取 key |
| 直接粘贴 | 在 MagPie 的输入框中直接粘贴 `lc_session` |
| token + API key（兜底） | 当平台的实例执行通道不可用时（见「已知限制」），将 `lc_session` 与实例 `.env` 中的 `CUSTOM_API_KEY` 一起粘贴，跳过自动读取步骤 |

获取 `lc_session` 的路径：登录 `lightvela.ai` → 打开浏览器开发者工具（F12）→ 应用（Application）→ Cookie → `https://api.lightvela.ai` → 复制 `lc_session` 的值。

> **安全提示**：`lc_session` 是完整的登录凭证，等同于账号密码。不要把它发给任何人、不要截图外传；它只应粘贴到本插件的登录框中。

## 登录之后

- **模型**：以账号 `/v1/models` 的实时返回为准（如 `auto`、`deepseek-v4-pro-202606`）；平台内部的 `ep-*` 端点与模拟模型会被过滤。
- **用量卡片**：套餐名、积分余额 / 总量、到期日，数据来自平台套餐接口，短时缓存。
- **每日打卡**：MagPie 每天自动运行一次——当天尚未活跃时发出一条最短的模型调用点亮活跃（成本约 20 token），并查询活跃续期资格，够格时自动领取奖励（免费续期 1 个月）。
- **会话失效的影响**：会话 token 过期或失效只影响用量卡片与打卡，API key 本身不受影响、模型调用照常；重新登录一次即可恢复。

## 工作原理

```
会话凭证（短信验证码 / lc_session）
        │  确认账号身份与所属版本
        ▼
经控制台「云存储」同款文件通道（tat/session + WebSocket）读出
~/.hermes/.env 中的 CUSTOM_API_KEY（debug/exec 仅作回退）
        │  用该 key 请求 /v1/models 验证可用
        ▼
以标准供应商形式交给 MagPie（端点 + key），后续调用与普通供应商无异
```

插件只与 LightVela 官方域名（`lightvela.com` / `lightvela.ai` 及其 token 网关）通信，文件通道的 WebSocket 地址由平台接口下发（腾讯云 TAT 中继，与官方控制台用的是同一条）；key 只保存在本机 MagPie 的配置目录中，不经过任何第三方服务器，不写入日志。

## 已知限制

- **平台通道故障（平台问题）**：自动读 key 首选控制台「云存储」的文件通道，与 `debug/exec` 是两套独立中继——后者出现过整段不可用（返回 502），期间本插件不受影响；只有两条通道同时不可用时，「自动读 key」类登录才会失败，那时可改用「token + API key」兜底方式登录。
- **网页退出登录会连带失效**：在 LightVela 网页端退出登录，会使该账号的会话 token 在所有地方一并失效（包括已粘贴到本插件的副本），用量与打卡随之暂停，模型调用不受影响；保持网页登录状态或重新粘贴一次 token 即可。
- **平台共享限流**：`auto` 模型与实例自带的在线助手共用平台限流（约 60 RPM），高频调用偶尔返回 429，属平台配额，并非插件故障。

## 安全说明

- 本插件运行在你本机的 MagPie 中，登录页仅监听 `127.0.0.1`，不对外开放。
- 会话 token 与 API key 仅存储于本机 `~/.config/magpie/` 的插件配置中，与 MagPie 其他供应商同等待遇。
- 插件代码完全开源、无混淆、无第三方上报；所有网络请求的目标域名见「工作原理」。

## 常见问题

**Q：国内版和国际版可以同时登录吗？**
可以。每个账号是一条独立的登录记录，版本信息随账号保存，互不影响。

**Q：登录时提示 unauthorized 怎么办？**
先确认版本选对（`.com` 账号选国内版、`.ai` 账号选国际版）；再确认 token 复制完整且未过期（重新登录网页后复制最新值）。国际版若仍失败，多半是执行通道故障，请用兜底方式。

**Q：用量卡片显示会话过期，但模型还能用，是坏了吗？**
没有坏。key 与会话是两套凭证：会话只管用量与打卡，key 管模型调用。重新登录一次即可恢复卡片。

**Q：打卡的续期奖励为什么没有自动领取？**
领取需满足平台的活跃天数要求（如窗口期内活跃天数达标）；未达标时打卡只点亮当日活跃，达标后自动领取，无需手动操作。

**Q：这个插件是 LightVela 官方的吗？**
不是。本插件为第三方社区作品，与 LightVela 官方无关。

## 项目结构

```
magpie-lightvela-plus/
├── index.mjs        # 插件主体：双版本登录、读 key、用量与打卡
├── opencode.mjs     # OpenCode 入口（转发 index.mjs）
├── opencode2.mjs    # OpenCode 2 通用适配层
├── package.json     # 包信息与 MagPie 插件声明（名称 / 简介 / 图标）
├── icon.png         # 插件图标
├── LICENSE          # MIT 许可证
└── README.md        # 本文档
```

## 卸载

在 MagPie 插件页移除本插件，或执行 `magpie plugin rm lightvela-plus`。卸载只移除插件自身，不影响 MagPie 的其他供应商与配置。

## 致谢

国内版的短信登录、读 key、用量与打卡逻辑源自社区作者 **ikashana** 的 [magpie-lightvela](https://github.com/ikashana/magpie-lightvela)（MIT 许可），本插件在其基础上合并国际版适配与双版本路由，并沿用其许可证。

## 许可证

[MIT](./LICENSE)。国内版原作 © ikashana。

---

# English

**magpie-lightvela-plus** is a third-party plugin for [MagPie](https://github.com/yetone/magpie) / OpenCode that signs in to a **LightVela** account — China edition (`lightvela.com`, phone + SMS code) or international edition (`lightvela.ai`, Google sign-in + pasted `lc_session` token) — and exposes its OpenAI-compatible endpoint as a regular provider.

After sign-in, the plugin reads the account's `CUSTOM_API_KEY` from its instance (`~/.hermes/.env`) with a read-only command, verifies it against `/v1/models`, and hands it to MagPie. Plan name, credits and expiry show on the usage card, and a daily check-in keeps the account active and auto-claims the activity renewal reward when eligible. Multiple accounts across both editions can be signed in at the same time.

Install from MagPie → Plugins → Discover → Community (GitHub), or by spec:

```
github:alanbulan/magpie-lightvela-plus
```

Notes: signing out on the LightVela website revokes the session token everywhere (usage card and check-in pause; model calls are unaffected). The plugin reads the API key primarily through the console's Cloud Storage file channel (tat/session + WebSocket), with debug/exec as fallback, so an exec outage (HTTP 502) no longer blocks sign-in; only if both channels are down should you use the fallback sign-in (token + API key). Merged from the community plugin [ikashana/magpie-lightvela](https://github.com/ikashana/magpie-lightvela) (MIT) with an international-edition adaptation. Not affiliated with LightVela.

License: [MIT](./LICENSE).
