# opencode-minimax-design-auth

把 [MiniMax Design（Hilo，桌面端创作 Agent IDE，4.0.1 构建）](https://design.minimax.cn)接入 magpie 的插件：用 Hilo 自己的桌面登录态说话——它自己的模型目录、它自己的积分钱包，不借用 MiniMax Code 的任何登录或配置。

状态：登录、模型目录、积分窗口、对话均已实测通过（2026-10-17，4.0.1 构建，Windows）。

## 登录什么、怎么登录

MiniMax Design 桌面端把登录态存在：

- Windows：`%APPDATA%\@hilo\desktop\hub-config.json`
- macOS：`~/Library/Application Support/@hilo/desktop/hub-config.json`
- Linux：`~/.config/@hilo/desktop/hub-config.json`

`tokens.accessToken` 是 `v2enc:<iv>:<tag>:<cipher>` 信封（AES-256-GCM），密钥是旁边 `.token-key` 文件的 32 个原始字节。解出来的明文是 HS256 JWT（`{exp, user{id,name,avatar,deviceID,isAnonymous}}`），约 38 天过期。**文件里没有 refresh token**——过期了就得回到 Hilo 桌面端重新登录，插件会把状态报为 `expired`。

插件提供两种登录方式：

1. `desktop`：直接读上面那份桌面登录态（首选，不用你贴任何东西）；
2. `api`：把 token 手动贴进来。

## 和 MiniMax Code 的区别

MiniMax Design 与 MiniMax Code（mcode）是两条产品线：登录态、对话端点、模型目录和积分钱包都不共用，
所以本插件与 `@magpie-community/opencode-minimax-auth` 是两个供应商，装哪个都不会互相覆盖。
顺带一句：`~/.minimax` 是 MiniMax Code 的目录，不是 MiniMax Design 的。

## 模型

模型目录来自 `GET https://design.minimax.cn/api/v1/config`（`token:` 头，无签名），按 `enabled_providers` 顺序展开，重复 id 时先出现的 provider 赢。桌面端自己加密缓存了一份最后已知配置（`lkgProviderConfig`，同一密钥），端点够不着时插件用它。

当前 9 个模型：`MiniMax-M2.7`、`MiniMax-M3`、`alpha`、`alpha_high`、`gamma`、`gamma_high`、`gamma_mid`、`gamma-6-astra`、`omega-3.1-pro`。其中 `alpha` 与 `gamma-6-astra` 带 `requirement: membership`（会员专属）。

插件**不声明** `free`/`rate`：vendor 目录里没有价格倍率（`agent_model_display.metrics.cost` 不是倍率），插件也不替它发明一个。

## 积分

积分来自 `GET /api/v1/credit/wallet` 和 `/api/v1/credit/balance`（`token:` 头，数字是字符串）。每个钱包一个窗口、每个 `sub_credits` 来源一个侧窗；`end_time` 已过的来源被丢弃；最早流失的那笔显示为 `runsOut`/`runsOutAt`，magpie 的 smart 路由会先烧它。

## 装上 / 试

```sh
magpie plugin add github:cuddlesgiggles/minimax-design-auth   # 或本地 clone 后：magpie plugin add ./minimax-design-auth
magpie plugin login minimax-design
node --test                      # 14 条
npm run mutate                   # 11 个变异，全要变红
```

## License

MIT
