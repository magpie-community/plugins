# Credit Balance & Tokens for Magpie

[简体中文](README.zh-CN.md) · [Project repository and stars](https://github.com/crbj621/plugins) · [Latest download](https://github.com/crbj621/plugins/releases/latest)

![Credit Balance & Tokens icon](page/icon.png)

Credits buy different amounts of usage across providers. Providers may offer the same model under different names and charge different rates by time of day. This page uses the provider accounts already configured in Magpie to answer three questions.

- **How much credit do I have in total?** Select a reference provider and model. Convert the included balances to that provider's credits and see separate peak and off-peak totals.
- **How many tokens can I still use with this model?** Pick the corresponding names for each provider and check the capacity per provider and across all included providers.
- **Where did my credits go?** Check recent spend by provider, then expand a row for the model breakdown and data source.

The plugin follows the local page-service pattern used by [Model Quota](https://github.com/magpie-community/plugins/tree/main/packages/page-model-quota) and adds explicit cross-provider model mappings, equivalent credits and account-level spend reconciliation.

## Install

Requires Magpie 0.1.4402 or later. Download the `.tgz` from the [release page](https://github.com/crbj621/plugins/releases/latest), extract it with `tar -xf`, and run the following command from the extraction directory. From a source checkout, you can pass `packages/page-credit-balance` as the path.

```sh
magpie plugin add ./package
```

Open **Credit Balance & Tokens** or **积分与 Token 余量** from the Magpie sidebar. The page currently uses Chinese labels. Once the community listing is published, it can also be installed with `magpie plugin add @magpie-community/page-credit-balance`.

## Use the page

1. **折合积分 · Equivalent credits.** Select a reference provider and an exact model. Use **填入同名型号** to fill exact matches, or expand each provider and pick its corresponding models. The peak and off-peak results use each provider's rate for that period and the reference provider's rate for the same period.
2. **按型号看 Token · Token capacity.** Choose a target model. Select the corresponding names under each provider and choose which providers to include. An account contributes its balance at most once, even when you select multiple models. The forecast uses recent usage proportions for the selected models and shows both peak and off-peak scenarios.
3. **积分消耗 · Credit spend.** Choose a rolling 24-hour window or the last 7 or 30 calendar days in Asia/Shanghai. Expand a provider to see model charges, estimates and any amount that cannot be assigned. The grand total adds the providers' raw numbers. Use Equivalent credits when you need a common unit.

### Example with peak and off-peak rates

Suppose WorkBuddy is the reference provider and a second provider has 200 credits. You have confirmed that both providers offer the model you want. The example uses hypothetical rates.

| Period | Second provider credits per million tokens | WorkBuddy credits per million tokens | Second provider token capacity | Equivalent WorkBuddy credits |
| --- | ---: | ---: | ---: | ---: |
| Peak | 4 | 10 | 50 million | 500 |
| Off-peak | 2 | 8 | 100 million | 800 |

Divide the source balance by the source rate to get capacity in millions of tokens. Multiply that capacity by the reference rate for the same period. With several selected aliases, recent token shares weight the rates and each account's balance contributes once.

## How to read the numbers

- Request charges and available provider counters establish verified spend. Confirmed charges after a counter read can fill its lag. If requests lack a matching account, the plugin avoids adding them on top of potentially overlapping counters. Incomplete records may understate the total.
- The 24-hour view combines rolling snapshots, the current day's official count, and request evidence. A day total alone cannot reconstruct the part of yesterday inside the rolling window. The page queries Magpie's cached quotas; freshness depends on Magpie's reads.
- Provider totals may be verified while model splits are estimated. When historical charges, a local calibration or a manual rate cannot support a forecast, the page marks the result as incomplete. Vendor multipliers are relative. Sign-in rewards, grants, top-ups and resets are balance events. A new balance affects the forecast on the next read.
- If a row needs a rate or balance, expand it to check the model mapping and data source. If you have a billing rate, use **设置费率 · Set rate** to enter peak or off-peak credits per million tokens. Clear the manual value to resume automatic calculation.

## Maintenance and feedback

Open **Homepage** in the Magpie plugin details or visit the [project repository](https://github.com/crbj621/plugins) for releases and GitHub stars. When reporting a spend discrepancy, include the provider, model, time window and the data source shown on the page.

## Data and settings

The host component binds only to loopback and uses a page key to protect report and preference routes. It queries Magpie's local quota API and reads `usage.jsonl`, `credits-daily.json`, `plugin-providers.json` and `providers.json` from the local Magpie config directory. Settings and rolling counter snapshots are stored under `plugin-work`. There is no telemetry or direct request to a vendor. If port 3498 is occupied, change this plugin's `port` option in Magpie.

Run `npm test` in the package directory to check the calculations and local service. This project is MIT licensed.
