<div align="center">
  <img src="https://raw.githubusercontent.com/maxlee/magpie-token-receipt/main/assets/icon-card.svg" width="56" height="56" alt="Token receipt" />
  <h1>Token receipt</h1>
  <p>A <a href="https://usemagpie.ai">magpie</a> page that prints your daily, weekly, monthly, last-7/30/90-day or all-time token usage and cost as a tactile receipt.</p>
  <p><strong>English</strong> · <a href="README.zh.md">简体中文</a> · <a href="README.ja.md">日本語</a></p>
</div>

| Light · daily | Dark · weekly |
| :---: | :---: |
| ![Light theme](https://raw.githubusercontent.com/maxlee/magpie-token-receipt/main/assets/screenshots/light.png) | ![Dark theme](https://raw.githubusercontent.com/maxlee/magpie-token-receipt/main/assets/screenshots/dark.png) |

## Features

- **Seven periods.** Day, calendar week (from Monday), calendar month, the last 7, 30 or 90 days, and all time (from the first recorded call). Step back and forth, pick a date, or jump to today.
- **Cost per model.** A model reached through several agents or providers prints as one row. Input, output, cache read and cache write are listed as token counts.
- **Currencies.** Follows the language, or pick `USD`, `CNY` or `JPY`. CNY uses the rate in magpie's settings.
- **Receipt printer.** Stepped paper feed, torn edge and barcode. The animation is skipped when the system asks for reduced motion.
- **Save or copy.** A 3× PNG, saved to Downloads or copied to the clipboard.
- **Languages and themes.** English, 简体中文, 繁體中文 and 日本語, in magpie's light or dark theme.

> [!NOTE]
> Usage and cost come from magpie's local records through the read-only `usage:day` permission. The page runs in magpie's sandboxed frame with no network access. When some calls have no known price, the total reads "Priced subtotal" and the receipt notes how many requests were left out.

## Install

In magpie, open **Plugins → Add plugin** and enter this folder's path, or run:

```sh
magpie plugin add /absolute/path/to/magpie-token-receipt
```

**Token receipt** then appears under Plugins in the sidebar.

## Differences from dsh-token-receipt

This page is ported from [dsh-token-receipt](https://github.com/maxlee/dsh-token-receipt). magpie's page sandbox changes a few things:

| dsh-token-receipt | This plugin |
| --- | --- |
| Print / PDF | Copy image (the sandbox can't open a print dialog) |
| A cost for input, output and cache | Token counts for those rows; magpie gives each model's total cost |
| Requests / sessions | Requests / errors, plus an Agents row with each agent's logo in black and white |
| Prices from models.dev | magpie's own computed cost |

## Development

```sh
npm run check   # syntax-check every script
npm test        # node --test
```

- `page/model.js`: periods, `usage:day` parameters, model merging, money and bill numbers. Pure functions; the tests load it.
- `page/view.js`: a small `h()` with an in-place patch that renders the printer and the receipt.
- `page/export.js`: paints the on-screen receipt onto a canvas, piece by piece, for the PNG.
- `page/app.js`: theme, options, reads and the print stage machine.

After a change, turn the plugin off and on in magpie's Plugins page, or reload in `magpie web`.

## License

MIT. Fonts and other notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
