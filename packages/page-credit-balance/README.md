# Credit Balance & Tokens for Magpie

[简体中文](README.zh-CN.md) · [Project repository and stars](https://github.com/crbj621/plugins) · [Latest download](https://github.com/crbj621/plugins/releases/latest)

![Credit Balance & Tokens icon](page/icon.png)

Credits buy different amounts of usage across providers. Providers may offer the same model under different names and charge different rates by time of day. This page uses the provider accounts already configured in Magpie to answer four questions.

- **How much credit do I have in total?** Select a reference provider and model. Convert the included balances to that provider's credits and see separate peak and off-peak totals.
- **How many tokens can I still use with this model?** Pick the corresponding names for each provider and check the capacity per provider and across all included providers.
- **Where did my credits go?** Check recent spend by provider, then expand a row for the model breakdown and data source.
- **Which credits will expire unused?** Use Magpie's 45-day reset history to estimate credits lost at each reset, review the next 7, 30 or 45 days of expiring credits, and see the earliest expiry date for every included provider.

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
4. **积分到期 · Credit expiry.** Select **只看未来** (upcoming, the default), or **只看过去** (already wasted), then choose a 7-, 30- or 45-day window. Each provider card shows one total for the selected direction and window, followed by the affected account names, exact times and credit amounts. Magpie's history estimates unused credits lost at completed quota resets; current cards supply approaching package expiries. Expand a provider for the full batch list and statistical reasons.

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
- Reset-history estimates use the last remaining percentage for a completed quota window multiplied by the current limit for the same resettable component. Aggregate and carry-over packs are excluded so they do not repeat a component. Current-card expiry uses the provider's stated `runsOutAt` and batch amount. A later zero clears a prefixed amount. Grants, check-ins and top-ups themselves are not treated as expiry. When a provider has no historical percentage or current limit, the page leaves its amount unknown instead of inventing one. If Magpie's history route is unavailable, the page labels the degraded state and keeps only explicit batches that the plugin sampled.

## Maintenance and feedback

Open **Homepage** in the Magpie plugin details or visit the [project repository](https://github.com/crbj621/plugins) for releases and GitHub stars. When reporting a spend discrepancy, include the provider, model, time window and the data source shown on the page.

## Data and settings

The host component binds only to loopback and uses a page key to protect report and preference routes. It queries Magpie's local quota and 45-day history APIs, then reads `usage.jsonl`, `credits-daily.json`, `plugin-providers.json` and `providers.json` from the local Magpie config directory. While Magpie is running, the expiry ledger samples the quota cache once an hour; Magpie's own quota reader refreshes the vendor cards. Settings, rolling counter snapshots and the expiry ledger are stored under `plugin-work`. There is no telemetry or direct request to a vendor. If port 3498 is occupied, change this plugin's `port` option in Magpie.

Run `npm test` in the package directory to check the calculations and local service. This project is MIT licensed.