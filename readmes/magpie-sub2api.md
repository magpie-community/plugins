[English](./README.en.md)

<!-- banner -->

# magpie-sub2api

<a href="https://github.com/broven/magpie-sub2api"><img src="https://img.shields.io/badge/Star-on%20GitHub-f5c518?style=for-the-badge&logo=github" alt="Star on GitHub" height="48"></a>

把任意一个 [sub2api](https://github.com/Wei-Shaw/sub2api) 站点接成 [magpie](https://usemagpie.ai) 的 provider：填站点地址和 API key 登录，magpie 就能用这个 key 所在分组的模型，并按 key 的剩余额度做路由。

- **模型**：取自 `GET /v1/models`（key 所在分组列出的模型）。Claude 系列走 `/v1/messages`，OpenAI 系列（`gpt-*`、`o1`/`o3`…、`codex-*`）走 `/v1/responses`，其余走 `/v1/chat/completions`。
- **思考等级**：取自站点的 Codex 模型清单（`GET /backend-api/codex/models` 里每个模型的 `supported_reasoning_levels`），magpie / Codex 里就能切换。站点给不出时，看 [models.dev](https://models.dev) 上该模型的官方条目（只认模型所属厂商自己那一条，如 `deepseek` 下的 `deepseek-flash`，转售方的不算）：会不会思考、`reasoning_options` 里的 effort 档位、是否要回传上一轮思考（`interleaved`）、上下文和输出上限。没有官方条目时，沿用 magpie 已有的该模型等级（models.dev 或配置里的 `variants`），再没有就给会思考的模型 `low` / `medium` / `high`。models.dev 一天拉一次，结果存在系统缓存目录（`$XDG_CACHE_HOME`，否则 macOS 为 `~/Library/Caches`、其他为 `~/.cache`）下的 `magpie-sub2api/models-dev.json`，magpie 重启也不重拉；拉不到时照旧，不影响模型列表。
- **用量**：取自 `GET /v1/usage`，按 key 的计费方式换成 magpie 的用量窗口（见下表）。magpie 的用量页、菜单栏和路由都读这些窗口：某个窗口用满后，magpie 会先绕开这个 key。

## 为什么不用 magpie 自带的 `balance=/v1/usage`

magpie 给自定义 provider 配 `balance=/v1/usage` 时，只解析响应里的 `rate_limits`（5h / 1d / 7d）。sub2api 的另外两种计费方式它看不到：

- **订阅分组**的日 / 周 / 月额度在 `subscription` 字段里；
- **key 自带的总额度**在 `quota` 字段里。

这两样都不进路由，magpie 会一直把请求发给已经用满的 key。本插件把三种模式都换成窗口，并带上套餐名、到期时间和余额。

## 安装

在 magpie 应用里：**插件 › Discover**，搜索 `sub2api`，安装 `magpie-sub2api`。

或者用命令行：

```sh
magpie plugin add magpie-sub2api
```

## 登录

```sh
magpie plugin login sub2api
```

依次问站点地址（如 `https://api.example.com`，带不带 `/v1` 都可以）、账号名（可留空），最后问 API key（`sk-…`）。在应用里添加 sub2api 账号时填同样几项。

账号名填了就用它（如 `工作 key`）；留空则显示为「站点域名 …key 后四位」，比如 `api.example.com …a1b2`。名字是插件在账号第一次被使用时写进去的，所以刚登录完的第一次用量读取里可能还是 `API key …a1b2`。magpie 按账号名记各账号的模型和能力，**登录后别改名**，要改就删掉重新登录。

## 多站点：池化，还是每个站点一个 provider

**池化（默认）**：每次登录是一个账号，各自带着自己的站点地址和 key。不同站点的 key、同一站点的多个 key 都挂在同一个 provider `sub2api` 下，组成一个池，magpie 按各账号的用量在池内路由。再加一个就是再登录一次。模型统一叫 `sub2api/<模型>`，没法指定「这个请求走哪个站」。

**每个站点一个 provider**：在插件选项里列出站点，每个站点成为一个独立、有自己名字的 provider，模型叫 `<id>/<模型>`，可以在分组、路由里单独引用、排先后：

```sh
magpie plugin options magpie-sub2api '{"sites":[
  {"id":"jmds","name":"JMDS 主站","url":"https://api.jmds.dev"},
  {"id":"backup","name":"备用站","url":"https://api.example.com"}
]}'
magpie plugin login jmds      # 只问账号名和 key，站点地址取自选项
magpie plugin login backup
```

应用里在插件的选项编辑器里填同样的 JSON。改完 magpie 会重新加载插件。

- `url` 必填；`id` 可省，省了取站点域名（如 `api-example-com`）；`name` 可省，省了用 `id`。
- `id` 只能是小写字母、数字、`-`、`_`，最长 40，不能重复，也不能是 `sub2api`（留给池化 provider）。不合规的站点会被跳过，并在 magpie 日志里说明原因。
- 最多 8 个站点。
- 每个站点 provider 下同样可以登录多个 key，在站点内池化。
- 池化 provider `sub2api` 一直都在，两种用法可以并存。
- 显示名只在你没给这个 provider 配过 `name` 时生效；`magpie.json` 里手写的名字优先。
- **别改已用站点的 `id`**：账号是记在 `id` 下的，改了等于换一个新 provider，要重新登录。

## 用量模式

`/v1/usage` 按 key 的情况返回下面三种之一：

| sub2api 的情况 | magpie 里看到的 | 窗口 | 重置时间 |
|---|---|---|---|
| **订阅分组**（group 设了日 / 周 / 月额度） | 套餐名 = 分组名，到期时间 = 订阅到期 | `24 hours` / `7 days` / `30 days`，只列分组设了额度的（额度为空或 0 的不列） | 用 sub2api 返回的 `daily_reset_at` / `weekly_reset_at` / `monthly_reset_at`；没返回时周 = 本周窗口开始 + 7 天，日、月没有重置时间 |
| **key 自带额度或限速**（`mode: quota_limited`） | 套餐名 `API key limits`，到期时间 = key 到期 | `Key quota`（总额度）+ `5 hours` / `24 hours` / `7 days`（限速） | 限速窗口用 sub2api 返回的 `reset_at`；总额度不重置 |
| **余额分组** | 套餐名 + 钱包余额 | 无 | 无 |

订阅过期、key 额度用完或 key 过期时，用量里显示为出错。key 被站点拒绝（401）时，账号标记为需要重新登录。

## 限制

- **余额模式不参与路由**：余额没有时间窗口，magpie 只显示余额，不会因为余额快用完而绕开这个 key。
- **日、月窗口没有倒计时**：当前上游 sub2api（0.2.14）不返回重置时间，日、月两个窗口只有长度。日窗口在服务器时区的下一个零点重置、日和月窗口又是用到时才滚动，客户端从窗口开始时间推算不出来，所以插件不猜。返回 `daily_reset_at` / `monthly_reset_at` 的提案已提交上游 PR（待合并），站点跑上带这些字段的 sub2api 版本后，日、月倒计时就会出现。
- 一个 key 只看得到它所绑定分组的订阅。同一用户在别的分组的订阅，要用绑定那个分组的 key 再登录一个账号。
- 同一个 key 重复登录会多出一个账号，删掉多余的即可。

## 兼容性

sub2api **≥ 0.2.14**。插件只调用上游的公开接口（`/v1/models`、`/backend-api/codex/models`、`/v1/usage`），不依赖任何站点的私有改动。CI 对 0.2.14 和最新版各跑一遍端到端测试。

## 开发与测试

```sh
npm test                              # 等于 ./test/run.sh，默认 sub2api 0.2.14
SUB2API_IMAGE_TAG=latest npm test
```

需要 Docker。测试会起一套临时的 sub2api（含 Postgres、Redis 和一个假的 Anthropic 上游），建好订阅分组、余额分组和带额度的 key，每个 key 发一次请求，再像 magpie 那样调用插件的 `auth.loader`、`auth.usage`、`provider.models` 并断言结果。跑完无论成败都会 `down -v`。各模式的插件输出和上游原始响应写在 `test/artifacts/<tag>/`。

用真实 magpie、真实站点手动验证（沙盒在 `.e2e/`，不碰你自己的 magpie 配置）：

```sh
SUB2API_URL=https://api.example.com SUB2API_KEY=sk-... ./e2e.sh
```

发版流程见 [RELEASE.md](./RELEASE.md)。

## 许可证

MIT

插件图标是 [sub2api](https://github.com/Wei-Shaw/sub2api) 的 logo（`assets/logo.svg`），版权归 sub2api 项目所有，它的许可证是 LGPL-3.0。
