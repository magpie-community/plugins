# opencode-ccode-auth

[magpie](https://usemagpie.ai)（兼容 [OpenCode](https://opencode.ai)）供应商插件：**CCode（[ccode.si](https://ccode.si)）**。

一个 API key 接通 CCode 的全部模型，并在 magpie 里显示套餐余额与用量。

- **登录什么**：CCode 账号的 API key（在 [app.ccode.si/keys](https://app.ccode.si/keys) 创建，前缀 `sk-lg-`）。需要 Starter 或 Pro 套餐才能从其他工具调用；Free 套餐只能在其官方 App 里用，外部调用会返回 `403 plan_required`。
- **怎么登录**：一行命令，粘贴 key；或在 magpie 应用里点供应商那一行登录。
- **登录信息存哪里**：magpie 保存在 `~/.config/magpie/plugin-auth.json`（权限 600，格式兼容 OpenCode 的 `auth.json`，两者可互相迁移）。OpenCode 里则存在它自己的 `auth.json`。
- **有哪些模型**：登录后从 `GET https://api.ccode.si/v1/models` 动态拉取你的 key 可用的全部模型（最多 26 个，含 Claude Opus/Sonnet/Fable/Haiku、GPT-6.x/5.x、GLM 5.3、Kimi K3.1、Qwen 4/3.8、DeepSeek V4.1）。`-free` 结尾的 App 专用模型自动隐藏。

供应商 id 是 `ccode`，模型写作 `ccode/<model>`。请求被发往 `https://api.ccode.si/v1`（chat completions），两种认证头（`Authorization: Bearer`、`x-api-key`）都会带上，magpie 会把任意 agent 的请求转换成该格式。

## 安装（magpie）

```sh
magpie plugin add opencode-ccode-auth   # 按 npm 包名安装
magpie plugin login ccode               # 粘贴 CCode API key
magpie plugin                           # ccode (CCode, 26 models) signed in
magpie provider test ccode              # ✓ chat … ms · <model>
magpie quota                            # ccode · CCode API · $xx.xx
```

也可以按版本（`opencode-ccode-auth@0.1.0`）、git 仓库或本地文件夹安装：

```sh
magpie plugin add github:dawn1115/opencode-ccode-auth
magpie plugin add ./magpie-ccode-auth
```

应用里：打开 **插件 → 添加插件**，填包名或仓库地址；然后在 `ccode` 供应商那一行登录。

安装链接：`magpie://plugin?name=opencode-ccode-auth`

## 安装（OpenCode）

本插件是标准 OpenCode v1 供应商插件，OpenCode 同样可用：

```sh
opencode auth login   # 选 ccode，粘贴 API key
```

## 给 agent 选模型

登录后，在任意 agent 的模型选择列表里会多出一个 `ccode` 分组，例如 `ccode/claude-opus-5-5`、`ccode/glm-5-3`。选好开新会话即可。

## 余额查询

CCode 的余额模型（已在 app.ccode.si 真实页面确认）：

- 账户余额是 **credits**（美元计）：`user.credits`，Free/套餐每月重置（`creditsAreFree` 标记是否为免费额度）
- 三个用量窗口：**5-hour / Weekly / Monthly**，各有美元上限与百分比用量
- 每个 API key 另有 `spent`（累计花费）、`rpm`、`concurrency`
- 充值余额（top-up balance）与套餐积分在 Billing 页分开显示

插件从 CCode 的用量端点（`GET /v1/key`，必要时依次尝试 `/v1/usage`、`/v1/balance`）读取，字段解析覆盖：

- `credits` / `balance` / `remaining` → 显示为 `balance`（如 `$12.34`）
- `windows`（`five_hour` / `weekly` / `monthly`，对象或数组）→ magpie 用量窗口（名称、百分比、上限美元）
- 平铺的 `used` + `limit` → 兜底的 `Plan usage` 窗口
- 若响应字段都不认识，错误信息里会带上原始 payload，便于排查后更新字段名单

key 无效（401/403）时，账号会被标记为需要重新登录。

## 测试

在独立 HOME 的沙箱里跑，不碰你自己的 magpie、agent 和登录信息：

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache magpie "$@"; }
m plugin add ./magpie-ccode-auth </dev/null
m plugin --json            # 方式、账号、模型、加载错误
m plugin login ccode       # 粘贴 key
m provider test ccode      # 冒烟请求
m quota                    # 余额钩子
```

单元测试：`bun test`（测试放在 `_internal` 上的 `parseUsage`、`fetchUsage` 等函数）。

## 许可

MIT
