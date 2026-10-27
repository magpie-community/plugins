# @magpie-community/page-usage

A page in [magpie](https://usemagpie.ai)'s window with your usage at a glance. It shows calls, errors, tokens and cost for today, 7 days or 30 days, and the models that took them.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/page-usage`. It then has a tab, **Usage glance** (titled in the window's language: 用量速览, 用量速覽, 使用量の概要, Nutzung im Überblick), under Plugins in the sidebar, in the app and in `magpie web`.

## What it reads

Only `usage:summary`, the one permission its `package.json` declares (`magpie.permissions`). That is magpie's totals for a period, and the top models in it. magpie refuses any other read the page asks for.

Like every plugin page, it runs in a sandboxed frame. It has no network (`connect-src 'none'`), no inline scripts, and no access to magpie's API except through `_magpie/bridge.js`.

## Options

```json
{ "period": "today", "sort": "tokens" }
```

The page saves the period (`today`, `7d`, `30d`) and the model sort (`tokens`, `calls`, `cost`) you last picked, so it opens the same next time.

## Files

- `page/index.html`, `page/style.css`: the page. It takes magpie's theme from the `--magpie-*` variables, light or dark.
- `page/view.js`: what the numbers and rows say, in English and Chinese, with no DOM. The test loads it.
- `page/app.js`: reads through the bridge, draws, and refreshes every minute.

## Test

```sh
bun test packages/usage
```

中文：在 magpie 窗口里加一个「用量速览」页面，一眼看到今天、7 天或 30 天的调用、错误、token 和费用，以及用到的模型。它只读取声明过的 `usage:summary`，运行在无网络的沙盒 frame 里。
