<!-- 本文由AI自动生成 -->
# Pace Board · 额度节奏盘

在 magpie 窗口里解释「到期前用完」（`routing = pace`）这条策略：谁排第一、分数怎么算出来的、额度读数还新不新、哪些额度到期会白白浪费。

A page inside magpie's window that makes the **pace** routing strategy legible: who goes first, how the score is derived, how fresh the numbers are, and which credits will lapse unused.

```sh
magpie plugin add @magpie-community/page-pace-board
```

装好后在侧栏「插件」里打开 **Pace Board**。

## 三个页签

- **排名** —— 按 `pace` 降序。每行给出分值、分解式 `(100 − 已用%) ÷ 距到期小时`、该账号的额度现值、到期时间，以及「其中多少会失效」。顶部一行「下一次请求会先试 X」取的是路由队列里第一个不在冷却的候选，与下面的排序无关。
- **到期账** —— 红点＝积分包过期会真失效；橙点＝本期没用完但下期重置（不是永久损失）；灰点＝已用尽或算不出来。同一笔额度被汇总窗口和子窗口各报一次时会合并。
- **全部账号** —— magpie 上报了额度的所有账号与窗口，平铺看。

## 数据从哪来（全部只读）

| 来源 | 用途 |
| --- | --- |
| `routing/*.jsonl` 里的 `order[]` | 排名、`pace`、已用、到期、冷却 —— **magpie 自己算好的值，面板不重算** |
| `GET /v1/magpie/quotas`（回环，免 key） | 额度现值、剩余、到期失效量 `runsOut` |
| `providers.json` | 哪个路由组在用 `pace` |
| `credits-daily.json` / `quota-history.json` | 日均消耗，仅用于「没有官方 `runsOut` 时」估算到期浪费 |

**不读** `plugin-auth.json`、`caller-keys.json`、`settings.json` —— 那里是凭证。面板不外发任何数据。

## 分数为什么是 `(100 − used%) ÷ max(距到期小时, 1)`

额度在过期那一刻归零，所以「每单位时间能保住的比例」越高越该先用。分母取下限 1 小时避免除零；没有到期日时按 168 小时兜底。到期时间优先取 `resetsAt`，积分更早过期时取 `runsOutAt`。

面板展示的是 `order[]` 里的权威分值；只有在日志缺失、面板自己复算时，才会在界面上标出来。

## 页面与本地服务

`page/index.html` 是带路页。插件页面跑在 `default-src 'none'` 的沙盒里，唯一能做的联网动作是把自己导航到别处，所以它只做 `location.replace`。

真界面由本插件自己的本机服务在 `127.0.0.1:3488` 提供（端口被占时由 magpie 通过 `options.port` 重映射）。注意跳转后文档的 origin 仍是 opaque，浏览器发出的是 `Origin: null`，因此服务放行 `null` 但要求一次性口令；口令只在 HTML 里注入，不写进任何静态文件。

## 与已有页面的区别

- `page-model-quota`：把额度换算成 token，回答「每个模型还剩多少」。
- `page-usage-board`：用量看板与额度到期分层。
- **本页**：回答「magpie 此刻为什么先选它」—— 分值来自路由日志的 `order[]`，并给出分解式与「下一次会先试谁」。这是用量面板给不出的东西。

## 局限

- 排名快照的时间是**最近一次真实请求经过该组**的时刻，不是现在。magpie 没有「只算不发」的重排接口，所以发一条消息才会更新。
- 额度读数是缓存（约 1 分钟 TTL，后台 1–2 分钟自读一次），面板会标出读数有多旧。

## 许可

MIT
