# @magpie-community/page-day-card

A page in [magpie](https://usemagpie.ai)'s window that prints a day of your AI usage as a receipt, a "Daily AI statement" on paper over a backdrop of your choice. It has the day's API-equivalent cost, your streak, requests, errors and the day against your average day before it, then each agent and its models with their logos and costs, and the day's tokens: input, output and the cache hit rate. **Background** picks what the paper lies on: nothing (the paper alone, a transparent PNG), teal, fifteen patterns (gingham, graph paper, kraft, cyanotype, seigaiha waves, xuan paper and more), four landscape photos, or a picture of your own (pick one, drop it on the page or paste it). A slider sets the margin around the paper; a photo also has blur and dim. The choice is kept in the plugin's options. **Copy image** puts the card on the clipboard; **Save PNG** saves it in Downloads.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/page-day-card`. It then has a tab, **Day card** (titled in the window's language: 每日用量卡, 1日の使用量カード, Tageskarte), under Plugins in the sidebar, in the app and in `magpie web`. Pick an earlier day with the arrows or the date's menu. The card is shown as large as fits under the toolbar, so a whole day is on one screen; the picture you copy or save is full size.

It needs a magpie with the `usage:day` read and `magpie.image` (see `engines.magpie`). An older magpie refuses the read, and the page says to update.

## What it reads

Only `usage:day`, the one permission its `package.json` declares (`magpie.permissions`): a day's totals, each agent's and model's, the days before it that had calls, and the agents' and providers' logos. Nothing in it is a key, an account, a session or a prompt.

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

中文：在 magpie 窗口里加一个「每日用量卡」页面，把某一天的用量打印成一张小票（Daily AI Statement）：当天按 API 价计的费用、连续使用天数、请求数、错误数、与此前日均的倍数，每个 Agent 及其模型（带图标和费用），以及输入、输出 token 和缓存命中率。「背景」可以换成 15 种图案、4 张风景照片或自己的图片（选择、拖入或粘贴），边距可调，照片还可调模糊和压暗。可以「复制图片」到剪贴板，或「保存 PNG」到下载文件夹。只读取声明过的 `usage:day`，运行在无网络的沙盒 frame 里。
