# Alysis Code 免费额度 for magpie

把 Alysis Code 免费账号里的 DeepSeek、GLM、GPT-6、Claude 接进 magpie：**不充值、不粘贴 API key**，插件直接复用本机 Alysis Code 客户端已经登录的免费账号。

```text
免费额度      $0.5 / 月（自动 refill）
滚动上限      5 小时 $0.1 · 7 天 $0.2
可用模型      DeepSeek V4.1 Flash · GLM 5.3 Flash · GPT-6 Luna · Claude Haiku 5.5
上下文        1M
```

## 功能

- **一键登录**：读取本机 Alysis Code 的 `slk_` 凭证，不用在 magpie 里粘贴任何东西。
- **模型自动发现**：目录来自本机 alysis2api 的 `/v1/models`，上游新增模型不用等插件发版。
- **按协议分流**：DeepSeek / GLM 走 Chat Completions，GPT-6 Luna 走 Responses，Claude 走 Anthropic Messages —— 每种模型都用它原生的 API 形状。
- **额度卡片**：5 小时 / 7 天公平使用窗口 + 免费余额，读的是上游真实的 account-status。
- **429 不砸给 agent**：上游容量忙时由 alysis2api 排队重试并保持 SSE 连接，agent 侧看到的是正常的慢响应，不是报错。
- **没装反代时明确报错**：503 + 一句「先启动 alysis2api」，不静默空转。

## 模型

**DeepSeek**（`deepseek-flash`）、**智谱 GLM**（`glm-5.3-flash`）、**OpenAI**（`gpt-6-luna`，Responses API）、**Anthropic**（`claude-haiku-5-5`，Messages API）。同一个模型只有一个名字，不做别名去重。

模型目录随账号与上游上下架变化，装好后以 magpie 里显示的为准；插件只保证四个发行商都有兜底条目。

## 签到

没有每日签到：Alysis 免费额度按月自动补充（`free_next_refill_at`），`checkin` 返回 `inactive`。

## 安装

前置两件事：

1. 在 **Alysis Code** 桌面端登录（免费账号即可）。
2. 启动本机的 **alysis2api** 反代（`http://127.0.0.1:8788/v1`），它是本插件的数据通道：

```bat
cd <你的 alysis2api 目录>
node src/index.mjs
```

然后安装插件：

```bash
# npm（发布后）
magpie plugin add magpie-alysis-code

# 或从仓库源码（拿最新代码）
magpie plugin add github:MYCF711/magpie-alysis-auth
```

装好后在 magpie 的供应商列表点 **Alysis Code 免费额度** → 登录。两种方式，都不碰默认浏览器：

| 方式 | 做什么 | 打开浏览器？ |
| --- | --- | --- |
| **使用本机 Alysis Code 登录态**（默认） | 读 `%LOCALAPPDATA%\alysis\alysis\credentials.json` 里的 `slk_` key | 不打开 |
| **在隔离浏览器里登录**（备选） | 设备码 + 一次性 Chromium `user-data-dir` 打开 `/activate`，批准后拿 key，窗口关闭即删 profile | 只开隔离窗口，不复用日常浏览器的登录态 |

### 浏览器隔离

插件绝不调用默认浏览器去打开登录页。备选方式用的是 `src/device-login.mjs` + `src/browser-login.mjs`：

- 启动参数带独立的 `--user-data-dir=%TEMP%\magpie-alysis-login-*`，没有用户日常浏览器的 Cookie / 扩展 / 同步；
- 用完立刻 `kill` 并删除整个临时 profile；
- 找不到 Chromium 内核浏览器时明确报错，不会退回默认浏览器；
- 设备码流程只在 https 上走，`device_code` 与 `slk_` key 不经过明文连接。

### 命令行

```bash
magpie plugin list
# magpie-alysis-code  on
#   alysis (Alysis Code 免费额度, 6 models)  signed in as Alysis Code
```

## 常见问题

**装上了但模型列表是空的？**
先看 alysis2api 是否在跑：`curl http://127.0.0.1:8788/healthz`。反代没起来时插件会退回内置的 6 个静态模型，不会整张卡消失。

**登录点了没反应？**
默认方式不弹浏览器，它读的是本机 Alysis Code 的登录态。确认 Alysis Code 已经登录（`alysis whoami` 能显示账号），再点一次。本机客户端没登录时，改用「在隔离浏览器里登录」。

**某个模型报 `model_not_allowed` / `Unknown hosted model`？**
这个模型不在你账号的可用目录里（免费层没有 DeepSeek V4 Pro）。换 `deepseek-flash` 或 `glm-5.3-flash`。

**一直 429 / 排队很久？**
免费层的 DeepSeek 与 GLM 容量池在高峰会满员。反代会在预算内自动排队；错峰（凌晨/清晨）成功率更高。额度不会因为 429 被扣（上游明确 `No generation was started or credits charged`）。

**卡片显示「额度未知」？**
alysis2api 连不上上游 account-status 时会这样显示，不代表账号被封；先确认 Alysis Code 仍登录、反代日志里没有 401。

## 参考源

| 来源 | 用了什么 |
| --- | --- |
| [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 九钩子骨架、`src/quota.mjs`、`src/refresh-lock.mjs`、`src/usage-cache.mjs`、检查脚本与文档 |
| [magpie-ima-local-auth](https://github.com/MYCF711/magpie-ima-local-auth)（MIT） | 「读本机已登录客户端」的导入式登录形态 |
| [usemagpie.ai 插件文档](https://usemagpie.ai/docs/zh/plugins) | 钩子契约、`used` 作为路由输入、403/404 与 401 的语义区分 |

## 许可

MIT。版权与衍生说明见 [NOTICE.md](./NOTICE.md)。

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)
