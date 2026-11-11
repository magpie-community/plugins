# @magpie-community/page-day-card

A page in [magpie](https://usemagpie.ai)'s window that prints a day of your AI usage (or a week, a month or all of it) as a receipt, a "Daily AI statement" on paper over a backdrop of your choice. It has the day's API-equivalent cost, your streak, requests, errors and the day against your average day before it, then each agent and its models with their logos and costs, and the day's tokens: input, output and the cache hit rate. Its foot credits [nowdex](https://nowdex.app), whose share card the receipt's design follows. **Background** picks what the paper lies on: nothing (the paper alone, a transparent PNG), teal, fifteen patterns (gingham, graph paper, kraft, cyanotype, seigaiha waves, xuan paper and more), four landscape photos, or a picture of your own (pick one, drop it on the page or paste it). A slider sets the margin around the paper; a photo also has blur and dim. The choice is kept in the plugin's options. **Copy image** puts the card on the clipboard; **Save PNG** saves it in Downloads.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/page-day-card`. It then has a tab, **Day card** (titled in the window's language: 每日用量卡, 1日の使用量カード, Tageskarte), under Plugins in the sidebar, in the app and in `magpie web`. The switch at the left picks **Day**, **Week** (the seven days ending on the date shown), **Month** (the thirty) or **All** (every day with calls, up to today); a week's or a month's card has its period, the days that had calls and the cost of one such day in place of the streak against an average day. Pick an earlier day, or the date a week or month ends on, with the arrows (which step a whole week or month) or the date's menu. The card is shown as large as fits under the toolbar, so a whole day is on one screen; the picture you copy or save is full size.

It needs a magpie with the `usage:day` read and `magpie.image` (see `engines.magpie`). An older magpie refuses the read, and the page says to update; one from before the week, month and all-time spans (a `from` in `usage:day`) shows days only, and says to update when you pick another.

## What it reads

Only `usage:day`, the one permission its `package.json` declares (`magpie.permissions`): a day's (or a span's) totals, each agent's and model's, the days before it that had calls, and the agents' and providers' logos. Nothing in it is a key, an account, a session or a prompt.

Like every plugin page, it runs in a sandboxed frame with no network (`connect-src 'none'`) and no inline scripts. The card is drawn on a canvas, the same in a light or dark theme, and its PNG goes to magpie through `_magpie/bridge.js`. In `magpie web` the browser copies or downloads it itself.

## Files

- `page/index.html`, `page/style.css`: the page.
- `page/view.js`: what the card says, in English, 简体中文, 繁體中文, 日本語 and Deutsch, with no DOM. The test loads it.
- `page/app.js`: reads through the bridge, draws the card, copies and saves it, and refreshes today's every minute.
- `page/backgrounds.js`: the backdrops, drawn on the canvas, and what a saved choice may be.
- `page/bg/`: the four photos and their thumbnails, as JPEG data in scripts the page loads when it needs them. A picture the frame loads from a URL would taint the canvas, and the card could no longer be copied or saved.
- `page/fonts.js`: the receipt's face, a subset of [JetBrains Mono](https://www.jetbrains.com/lp/mono/) 2.304 as woff2 data (`page/fonts.LICENSE.txt`, SIL OFL 1.1). The frame can't fetch a font file, so the page loads these bytes with `FontFace`.

## Test

```sh
bun test packages/day-card
```

中文：在 magpie 窗口里加一个「每日用量卡」页面，把某一天（或最近 7 天、30 天、全部）的用量打印成一张小票（Daily AI Statement）：当天按 API 价计的费用、连续使用天数、请求数、错误数、与此前日均的倍数，每个 Agent 及其模型（带图标和费用），以及输入、输出 token 和缓存命中率。小票底部注明设计灵感来自 [nowdex](https://nowdex.app)。「背景」可以换成 15 种图案、4 张风景照片或自己的图片（选择、拖入或粘贴），边距可调，照片还可调模糊和压暗。左上角的开关切换「日 / 周 / 月 / 全部」。可以「复制图片」到剪贴板，或「保存 PNG」到下载文件夹。只读取声明过的 `usage:day`，运行在无网络的沙盒 frame 里。
