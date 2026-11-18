# Credit Balance & Tokens for Magpie

[简体中文](README.zh-CN.md)

![Credit Balance & Tokens icon](page/icon.png)

Compare the credit balances, token capacity and spending of providers already configured in Magpie. [Model Quota](https://github.com/magpie-community/plugins/tree/main/packages/page-model-quota) estimates quota by model. This page lets you set the model mappings yourself, compare peak and off-peak rates, and express all included balances in a reference provider's credits.

## Install

Requires Magpie 0.1.4402 or later. Extract the `.tgz` package with `tar -xf`, then pass the extracted `package` folder to Magpie. If you have the source checkout, pass `packages/page-credit-balance` instead.

```sh
magpie plugin add ./package
```

Open **Credit Balance & Tokens** or **积分与 Token 余量** from the Magpie sidebar. The page currently uses Chinese labels. Once the community listing is published, it can also be installed with `magpie plugin add @magpie-community/page-credit-balance`.

## Use the page

1. **折合积分 · Equivalent credits.** Select a reference provider and an exact model. Use **填入同名型号** to fill exact matches, or expand each provider and pick its corresponding models. The peak and off-peak results use each provider's rate for that period and the reference provider's rate for the same period.
2. **按型号看 Token · Token capacity.** Choose a target model. Select the corresponding names under each provider and choose which providers to include. An account contributes its balance at most once, even when you select multiple models. The forecast uses recent usage proportions for the selected models and shows both peak and off-peak scenarios.
3. **积分消耗 · Credit spend.** Choose a rolling 24-hour window or the last 7 or 30 calendar days in Asia/Shanghai. Expand a provider to see model charges, estimates and any amount that cannot be assigned. The grand total adds the providers' raw numbers. Use Equivalent credits when you need a common unit.

## How to read the numbers

- Request charges and available provider counters establish verified spend. Confirmed charges after a counter read can fill its lag. If requests lack a matching account, the plugin avoids adding them on top of potentially overlapping counters. Incomplete records may understate the total.
- The 24-hour view combines rolling snapshots, the current day's official count, and request evidence. A day total alone cannot reconstruct the part of yesterday inside the rolling window. The page queries Magpie's cached quotas; freshness depends on Magpie's reads.
- Provider totals may be verified while model splits are estimated. When historical charges, a local calibration or a manual rate cannot support a forecast, the page marks the result as incomplete. Vendor multipliers are relative. Sign-in rewards, grants, top-ups and resets are balance events. A new balance affects the forecast on the next read.

## Data and settings

The host component binds only to loopback and uses a page key to protect report and preference routes. It queries Magpie's local quota API and reads `usage.jsonl`, `credits-daily.json`, `plugin-providers.json` and `providers.json` from the local Magpie config directory. Settings and rolling counter snapshots are stored under `plugin-work`. There is no telemetry or direct request to a vendor. If port 3498 is occupied, change this plugin's `port` option in Magpie.

Run `npm test` in the package directory to check the calculations and local service. This project is MIT licensed and reuses the loopback page-service pattern from Model Quota.
