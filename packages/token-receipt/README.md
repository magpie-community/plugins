# @magpie-community/page-token-receipt

A page in [magpie](https://usemagpie.ai)'s window that prints your AI usage as a receipt: a paper printer feeds a ticket with the cost of each model, the tokens, and the agents that made them. Pick a day, a calendar week, a calendar month, the last 7, 30 or 90 days, or all of it. Save the receipt as a PNG or copy it as a picture.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/page-token-receipt`. It then has a tab, **Token receipt** (titled in the window's language: Token 账单, Token 帳單, トークン明細), under Plugins in the sidebar, in the app and in `magpie web`.

## What it shows

- **Seven periods.** Day, **week** (the calendar week, Monday to Sunday), **month** (the calendar month), the **last 7, 30 or 90 days** (ending on the date shown), and **all** (from the first day magpie has calls for). The arrows step by the period, the date opens a picker, **Back to today** returns. A period still running is read again every minute while the page is seen.
- **Models.** One row per model, whichever agents and providers it went through, by tokens: a day prints 4, a week 6, a month or longer 8, the rest folded into "+N more models". A call magpie knows no model for (imported from an agent's session files) has no row of its own; its tokens and requests stay in the totals.
- **Totals.** Input, output, cache read and cache write as token counts, then the cost. When some calls have no price, the total reads "Priced subtotal". Requests, errors, the number of agents and their logos, the bill number and when it was printed.
- **Money.** USD, CNY or JPY, following the language unless you pick. CNY is converted at the rate in magpie's Settings (the `rate` of `usage:day`); JPY at a fixed reference rate, dated on the receipt.
- **Agents.** Each agent's logo is redrawn in one ink (a mark is filled, a tile keeps its symbol), so a receipt prints alike whatever colours the logos came in.
- **Save PNG / Copy image.** The receipt painted at 3× through `magpie.image`: **Save PNG** puts it in Downloads, **Copy image** on the clipboard.
- **Printer.** The stepped paper feed plays when a receipt is printed and is skipped when the system asks for reduced motion.
- Light and dark, in English, 简体中文, 繁體中文 and 日本語. The period and the currency are kept in the plugin's options.

It needs a magpie with the `usage:day` read, `magpie.image` and `from` spans in `usage:day` (see `engines.magpie`). An older magpie refuses the read, and the page says to update.

## How it differs from Day card

[Day card](../day-card) also prints usage as a receipt and reads `usage:day`. This page is the printer:

| | Token receipt | Day card |
|---|---|---|
| Look | A printer that feeds a ticket, on the page's own colours | A card on a backdrop of your choice |
| Week, month | The calendar week and month | The last 7 and 30 days |
| Periods | Day, week, month, 7, 30, 90 days, all | Day, week, month, all |
| Money | USD, CNY or JPY | USD, or CNY at magpie's rate |
| Models | Merged by name, as many rows as the period has room for | Each agent with its models |
| Extras | Agents' logos in one ink, 繁體中文 | Streak, the day against your average day, backdrops |

## What it reads

Only `usage:day`, the one permission its `package.json` declares (`magpie.permissions`): the totals of a day or a span, each agent's and model's, and the agents' logos. Nothing in it is a key, an account, a session or a prompt. The page runs in magpie's sandboxed frame with no network: its fonts, logo and textures are data it carries.

## Files

- `page/index.html`, `page/style.css`: the page.
- `page/model.js`: what the receipt says, with no DOM: periods, `usage:day` parameters, models, money, bill numbers. The test loads it.
- `page/view.js`: a small `h()` with an in-place patch that renders the printer and the receipt.
- `page/export.js`: paints the receipt onto a canvas piece by piece for the PNG.
- `page/ink.js`: redraws the agents' logos in one ink.
- `page/app.js`: theme, options, reads and the print stage machine.
- `page/i18n.js`: the words in four languages.
- `page/fonts.js`, `page/fonts.LICENSE.txt`: [Inter](https://github.com/rsms/inter) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) subsets (SIL OFL 1.1), as data: the frame can't fetch a font file, so the page loads these bytes with `FontFace`.
- `page/logo.js`: magpie's mark, as a path.

## Test

```sh
bun test packages/token-receipt
```

中文：在 magpie 窗口里加一个「Token 账单」页面，把一天、自然周、自然月、最近 7 / 30 / 90 天或全部的用量，用一台打印机打印成小票：按模型列出费用，输入、输出、缓存的 token，用到的 Agent（图标统一成一种墨色），可切换 USD / CNY / JPY。可以「保存 PNG」到下载文件夹，或「复制图片」到剪贴板。只读取声明过的 `usage:day`，运行在无网络的沙盒 frame 里。与「每日用量卡」的区别见上表：这里是打印机，周和月是自然周、自然月。
