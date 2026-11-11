# magpie-token-receipt

把 magpie 记下的 token 用量，打成一张**热敏超市小票**（SVG），放进 magpie 窗口侧栏的一个页面里。
Prints the token magpie counted for you as a thermal supermarket receipt, drawn in SVG, in its own sidebar page.

当日（或近 7 天 / 近 30 天）每个模型花了多少 token、折多少钱，一张票看完：

```
名称......................... 数量(t)  金额($)
model-alpha.................. 439,183  0.1265
model-beta................... 417,999  免费
model-gamma................... 358,934  免费
其他 2 种....................... 607,135  0.2791
--------------------------------------------
合计 TOKENS......................... 9,606,868
应付金额............................... $ 1.3474
```

示例里的模型名和数字都是编的 —— 仓库里的测试夹具（`test/fixture-usage.json`）同样做了通用化：只保留 magpie 真实返回的**字段形状**，名字换成 `model-alpha…theta`，时区写成 `+00:00`。

## 长这样

| 白纸 | 牛皮纸 |
| --- | --- |
| ![白纸](docs/receipt-white.png) | ![牛皮纸](docs/receipt-kraft.png) |

上面两张是作者当天的实票（数字为真实用量）：`已付款` 红章落在积分与条码之间专门留出的空白带上，不压任何一行字；同名模型走多个供应商时并成一件商品，名字后标 `×次数`。

## 装它

```
magpie plugin add ./magpie-token-receipt   # 文件夹就地加载，不装任何依赖
```

应用里：插件 → 添加插件 → 填这个文件夹的路径。开着插件后，侧栏「插件」分组里会出现 **Token 小票**。
终端里每条 `magpie` 命令都按文件夹当前内容加载；在应用里改过代码后，把插件关掉再打开。

## 它读什么、不读什么

纯页面插件：没有 `auth`、没有 `config`、不启动插件宿主、不联网、不需要任何账号或密钥。
它只声明 magpie 允许页面读取的两项，都在 `package.json` 的 `magpie.permissions` 里写死了：

| 读取 | 用来做什么 |
| --- | --- |
| `usage:summary`（`period`: `today` / `7d` / `30d`） | 票面全部数字：笔数、失败数、输入/输出/缓存读 token、金额、按模型的前 20 条 |
| `providers:list` | 票头那行「本店经营 N 家供应商」；读不到就不印这行 |

沙箱页面 `connect-src 'none'`，所以票上的数字**出不了这个页面**：没有 fetch、没有 WebSocket、没有 beacon。
`usage:summary` 不含密钥、账号、登录信息或请求内容，magpie 本来就只给这些。

## 票上的数字怎么对得上

- 一件「商品」= 一个模型名。magpie 的 `models` 列表里同一个名字可能出现多次（同一模型走不同供应商或账号），小票把它们并成一件，票面上只印一次。
- 「数量」= 该模型的输入 + 输出 token。缓存读只有合计数、没有按模型的数，所以它单列在合计里，不参与列示。
- 「条目」选了上限（默认 12）时，剩下的并进 `其他 N 种` 一行；这一行的数量 + 列出的数量 **正好等于** 输入+输出合计，金额同理，票永远平账。
- 金额为 0 的模型印成 `免费` / `free`，不印 `0.0000`。
- 票号、终端号、柜台号、条码都由当次数据算出（FNV-1a），同样的用量永远打出同一张票；换了时段就是另一张。

## 选项

页面顶部的控件（时段、金额列、条目上限、纸张、语言、文本版）会立刻生效，并写回 `plugins.json` 里这一项的 `options`（约 1.2 秒后落盘）。
JSON 里还能直接改这些没有控件的：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `store` | `""` | 店名，留空用「Magpie 模型超市 / MAGPIE MODEL MART」 |
| `cashier` | `"MAGPIE"` | 收银员那一行 |
| `address` | `""` | 地址行；写了就不印供应商那两行 |
| `stamp` | `true` | 「已付款 / PAID」红章 |
| `paper` | `"white"` | `white` / `kraft`（牛皮纸）/ `aged`（旧纸） |
| `animate` | `true` | 出纸动画（跟随 `prefers-reduced-motion`） |
| `auto` | `true` | 页面被看见时每 2 分钟自动续打一次 |
| `lang` | `"auto"` | `auto` 跟窗口语言（zh / en），也可写死 |

```
magpie plugin options token-receipt '{"paper":"kraft","store":"我的模型超市"}'
```

## 测试

```
node --test "test/*.test.mjs"
```

`test/fixture-usage.json` 是从 magpie 真实代码路径抓下来的 `usage:summary` 原样返回（沙箱实例 + 合成 `usage.jsonl`），
所以单测钉的是真形状：平账、同名合并、确定性、转义、空数据、缺字段、`providers:list` 的几种可能形状。

## 两个 magpie 页面插件的坑（写之前值得知道）

1. **页面只能用经典脚本。**沙箱 iframe 里 `type="module"` 会以 CORS 模式取脚本，而 magpie 的插件文件服务不回 CORS 头，脚本直接取不到（`net::ERR_FAILED`），页面卡在空白；`<script src>` 走 no-cors 正常。
   所以 `page/receipt.js` 和 `page/app.js` 都是经典脚本，靠 `globalThis.MagpieTokenReceipt` 传函数。
2. **经典脚本里没有 top-level `await`。**文档示例里 `app.js` 直接 `await magpie.ready` 会在控制台抛语法错，窗口显示「此页面已停止工作」。这里用 `main().catch(...)` 的 async IIFE。

## 打印 / 存档

页面自带 `@media print`：藏掉控件条和文本版，只留纸。`Ctrl-P` 就能把这张票打成 PDF。
沙箱页面不能下载文件（没有 `allow-downloads`，也没有 `fetch`），所以想要图片请打印，或用页面底部的「文本版」复制文字。

## 许可

MIT
