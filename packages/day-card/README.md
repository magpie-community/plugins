# @magpie-community/page-day-card

A page in [magpie](https://usemagpie.ai)'s window that draws a day of your AI usage as a card. It shows the day's tokens, cost and calls, input, output, cache reads and the cache hit rate, then each agent with its models and logos, your streak and your average active day, and the last two weeks as small bars. **Copy image** puts the card on the clipboard; **Save PNG** saves it in Downloads.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/page-day-card`. It then has a tab, **Day card** (titled in the window's language: 每日用量卡, 1日の使用量カード, Tageskarte), under Plugins in the sidebar, in the app and in `magpie web`. Pick an earlier day with the arrows or the date's menu.

It needs a magpie with the `usage:day` read and `magpie.image` (see `engines.magpie`). An older magpie refuses the read, and the page says to update.

## What it reads

Only `usage:day`, the one permission its `package.json` declares (`magpie.permissions`): a day's totals, each agent's and model's, the days before it that had calls, and the agents' and providers' logos. Nothing in it is a key, an account, a session or a prompt.

Like every plugin page, it runs in a sandboxed frame with no network (`connect-src 'none'`) and no inline scripts. The card is drawn on a canvas in magpie's theme, light or dark, and its PNG goes to magpie through `_magpie/bridge.js`. In `magpie web` the browser copies or downloads it itself.

## Files

- `page/index.html`, `page/style.css`: the page.
- `page/view.js`: what the card says, in English, 简体中文, 繁體中文, 日本語 and Deutsch, with no DOM. The test loads it.
- `page/app.js`: reads through the bridge, draws the card, copies and saves it, and refreshes today's every minute.

## Test

```sh
bun test packages/day-card
```

中文：在 magpie 窗口里加一个「每日用量卡」页面，把某一天的用量画成一张卡片：token、费用、调用次数、缓存命中率，每个 Agent 及其模型（带图标）、连续使用天数、活跃日均和最近两周的小柱状图。可以「复制图片」到剪贴板，或「保存 PNG」到下载文件夹。只读取声明过的 `usage:day`，运行在无网络的沙盒 frame 里。
