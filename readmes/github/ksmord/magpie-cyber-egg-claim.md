# 赛博鸡蛋 for zcode

> 每代人有每代人的鸡蛋领取。

`magpie-cyber-egg-claim` 是给 **Magpie** 用的插件：把你在 Magpie 里已经登录的 ZCode 账号接过来，替它们自动盯住客户端的赠礼活动（Start Plan / 赠送 banner），活动一开就自己伸手领，不用一个个点。

版本 **0.0.1**，包名 **`magpie-cyber-egg-claim`**。

---

## 它做什么

| 能力 | 说明 |
|---|---|
| 多账号 | 直接读 Magpie 已登录的 ZCode 账号，登录过就在名单里，不用另外填 |
| 自动领取 | 后台线程按间隔轮流摸每个账号，活动一上线就领，不等页面被点开 |
| 一键领全部 | 页面上「全部领取」手动推一轮 |
| 强推同步 | 「立刻试一轮」会绕过退避，立刻再问服务器一次（撞上验证码除外） |
| 状态可见 | 每个账号上次结果、下次重试时间、累计领到多少，全部落在页面上 |
| 退避保护 | 活动没开时按服务器给的「下次再看」时间退避，最长相隔两个间隔；验证码一律退半小时等人去 App 点 |

结果枚举：`claimed`（领到）/ `done`（今日已领）/ `inactive`（活动未开）/ `ineligible`（无有效登录）/ `captcha`（需人验证）/ `failed`（请求失败）。

## 安装

仓库根就是插件根，`package.json` 在顶层。

```sh
git clone https://github.com/ksmord/magpie-cyber-egg-claim.git
magpie plugin add ./magpie-cyber-egg-claim
```

装完在 Magpie 侧边栏会多一页 **赛博鸡蛋 领取**。浏览器也可以直开回环端口：

```
http://127.0.0.1:3528/dashboard.html
```

端口被占会自动往上顺延（3528 → 3529 → 3530）。

## 用

1. 侧边栏打开「赛博鸡蛋 领取」。
2. 页面上会列出 Magpie 里所有 ZCode 账号，带登录状态。
3. 打开自动领取（默认已开，间隔 120 秒）。
4. 想立刻验一次，按「立刻试一轮」。
5. 看每个账号的状态和下次重试时间。

自动领取默认 **开启**，间隔 **120 秒**，可调范围 30 ~ 3600 秒。

## 目录

```
.
├── index.mjs          # 插件入口，向 Magpie 注册页面与回环服务
├── lib/
│   ├── engine.mjs     # 领取引擎：账号读取、请求构造、claimDaily()
│   ├── auto.mjs       # 自动领取线程：间隔调度、退避、状态落盘
│   ├── server.mjs     # 回环 HTTP 服务与 /api/* 路由
│   └── serve.mjs      # 端口与环境变量解析
├── page/
│   ├── index.html     # Magpie 侧边栏入口卡
│   ├── app.js
│   ├── boot.js
│   ├── dashboard.html # 浏览器工作台
│   └── dash.js
├── assets/icon.svg
└── page/icon.svg
```

状态文件落在 `~/.config/magpie/cyber-egg-claim-auto.json`，进程重启后开关和上次结果都还在。

## API

回环端口上，页面自己用；校验页面口令 + Host + Origin。

| 路由 | 说明 |
|---|---|
| `GET /api/accounts` | 账号清单与登录状态 |
| `GET /api/status` | 概览 |
| `GET /api/balance` | 额度余额 |
| `GET /api/auto` | 自动领取状态 |
| `POST /api/auto?on=1&interval=120` | 开关与间隔 |
| `POST /api/auto?run=1` | 手动推一轮（守退避） |
| `POST /api/auto?run=1&force=1` | 强推一轮（绕过 inactive/failed 退避，captcha 不退让） |
| `GET /api/claim?id=…` | 领单个账号（不带 id = 全部） |

## 更新

```sh
cd magpie-cyber-egg-claim && git pull
magpie plugin add ./magpie-cyber-egg-claim
```

## 卸载

从 Magpie 插件列表里移除即可；状态文件在 `~/.config/magpie/cyber-egg-claim-auto.json`，可一并删掉。

## 许可

MIT