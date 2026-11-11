# 额度下限 · Quota floor

一个 [magpie](https://github.com/yetone/magpie) 插件，两件事：**路由策略** + **只读页面**。

给每个席位（账号/线路）留一点余量：默认留 1%，也就是用到 99% 就主动让位给还宽裕的席位。适合"用多个订阅号拼额度"的场景 —— 别把某个号榨到 100% 触发限流，也别让一个号独自扛满。

## 路由 `quota-floor/keep`

按下面这四层排序，层内按已用比例升序、再按最近 tokens 升序、再按原次序：

| 层 | 谁 | 判定 |
|---|---|---|
| 0 | 还宽裕 | used < softCap（默认 95） |
| 1 | 接近下限 | softCap ≤ used < 100 − floor |
| 2 | 用量读不到 | 不猜它没事，排中间 |
| 3 | 已到下限 | used ≥ 100 − floor |
| 4 | 休息中 | 失败冷却 |

路由**只能排序，不能拒绝**：所有席位都到下限以下时，请求仍然会落到某一个（必须给出一个次序）。真正意义上的"绝不触碰"只有两种做法 —— 把模型从组里摘掉，或停用账号。

## 页面（侧边栏「额度下限 Quota floor」）

- **规则**：floor / softCap 现值与触发线，附一行改参数的命令
- **codex 席位**：每个账号的 5 小时 / 7 天窗口剩余与判定（还宽裕 / 接近下限 / 已到下限）
- **路由现状**：哪些组在用 `quota-floor/keep`、会话粘性、分类模型、成员
- **其它账号**：其它供应商账号的窗口一览

数据全部**只读**：读 magpie 的 `providers.json`、`plugins.json`，以及网关的 `/v1/magpie/quotas`。不写任何文件，不动任何账号。

![页面](screenshots/page.png)

## 安装

```bash
git clone https://github.com/InvisibleGuardian007/magpie-quota-floor
magpie plugin add <克隆下来的目录>
magpie group set <组名> routing=quota-floor/keep
```

然后在 magpie 的 **扩展 › 已安装** 里能看它，侧边栏多出「额度下限 Quota floor」一页。

## 参数

| 键 | 默认 | 说明 |
|---|---|---|
| `floor` | `1` | 留多少余量（百分比）。1 表示用到 99% 就让位 |
| `softCap` | `95` | 超过它算"接近下限"，排到还宽裕的后面 |
| `unknownLast` | `true` | 读不到用量的席位是否往后排 |
| `port` | `4396` | 页面本地服务端口（只监听 127.0.0.1） |

改参数：在 magpie 的 `plugins.json` 里该插件的 `options` 中改，或

```bash
magpie plugin add <目录> --option floor=2
```

## 关于路由 id

路由 id 是 magpie 给插件路由起的名字，形式是 **插件目录名 + `/keep`**，会原样显示在「路由」选择器里，不跟随界面语言。

实测：目录名含非 ASCII 时 id 会退化成 `plugin/keep`，所以目录名用的是 ASCII 的 `quota-floor`。**改目录名 = 改路由 id**，改完记得把用到它的组的 `routing` 一起改掉。

## 许可

MIT
