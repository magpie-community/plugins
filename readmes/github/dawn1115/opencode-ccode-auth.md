# opencode-ccode-auth

[magpie](https://usemagpie.ai)（兼容 [OpenCode](https://opencode.ai)）供应商插件：**CCode（[ccode.si](https://ccode.si)）**。

一个 API key 接通 CCode 的全部模型，并在 magpie 里显示套餐余额与用量。

- **登录什么**：CCode 账号的 API key（在 [app.ccode.si/keys](https://app.ccode.si/keys) 创建，前缀 `sk-lg-`）。需要 Starter 或 Pro 套餐才能从其他工具调用；Free 套餐只能在其官方 App 里用，外部调用会返回 `403 plan_required`。
- **怎么登录**：一行命令，粘贴 key；或在 magpie 应用里点供应商那一行登录。
- **登录信息存哪里**：magpie 保存在 `~/.config/magpie/plugin-auth.json`（权限 600，格式兼容 OpenCode 的 `auth.json`，两者可互相迁移）。OpenCode 里则存在它自己的 `auth.json`。
CCode API 的两种认证头（`Authorization: Bearer` 与 `x-api-key`）都会被设置。插件发送 `x-ccode-client: ccode/1.12.1`——这是 CCode 官方 App/CLI 用来标识自己的请求头，服务端据此判定为官方客户端，从而让 **Free 账号的免费额度在 magpie 里也能用**（额度会被正常扣减，见下方额度查询）。

- **模型清单**：登录后从 `GET /v1/models` 动态拉取；Free 账号该接口返回空，插件会保留内置的 32 个模型（26 个付费模型 + 6 个 `-free` 免费模型）。实测 Free 账号可调用 `glm-5.3`、`qwen-4-max` 以及 6 个 `-free` 模型。

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

## 额度查询（所有额度种类分类显示）

插件查询 CCode 的 **`GET /v1/limits`**（和 App 页面同一套数据），把每一类额度分窗口显示：

- 当前档位（如 `free` / `paid`）的三个窗口 → `Free · 5-hour window`、`Free · Weekly window`、`Free · Monthly window`（参与路由决策）
- 充值额度 `tiers.topup` → `Top-up · Weekly window`（`aside` 窗口，只显示不影响路由）
- 付费档位 `tiers.paid` 有值时也会显示为 `Plan · …`
- `/v1/key` 作为兜底（key 自身的 `credits`）

`magpie quota` 示例（Free 账号）：

```
ccode · free · API key …IHyn  subscription  Free 5-hour window 0%  Free Weekly window 0%  Free Monthly window 0%  Top-up Weekly window 0%  $5.00 left
```

> Free 账号现在可以实际调用模型（已实测 `magpie provider test ccode` 返回 200，额度正常扣减）。如果某个付费模型返回 403，说明该模型不在当前套餐内，换 `-free` 模型或升级套餐。

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
