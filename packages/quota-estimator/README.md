# Quota Estimator (draft)

**Blocked on a permissioned Magpie page read. This revision does not produce live estimates and is not listed in the community registry.**

The intended page estimates the Token capacity and API-equivalent USD value of a full 5-hour or weekly allowance, separately for local Codex, local Claude Code and Remote magpie. Its calculation functions and tests remain in `estimate.mjs`. Estimates are observations that may understate capacity, not provider-guaranteed limits or subscription bills.

## Page boundary

This is a page-only package: no `main`, `exports`, Bun collector, hooks or timers. It loads Magpie's `_magpie/bridge.js` for the theme and language only. `magpie.permissions` is empty because this waiting page reads no data. It does not read files, credentials or native sessions, connect to a remote gateway, save options, generate snapshots, or write into its installation folder. The community hook checker is unchanged.

The page uses Magpie's theme tokens, responds to language changes, and includes English, Simplified Chinese, Traditional Chinese, Japanese and German text. Both windows show unavailable values and explain the missing interface. It never substitutes aggregate usage for account-specific quota usage.

## Missing host interface

Magpie's current page reads are `usage:summary` (totals for today, 7d or 30d and top models) and `providers:list` (IDs and names). Neither supplies account-specific quota windows, quota sample times or usage aligned to those windows. The existing [usage:breakdown request](https://github.com/yetone/magpie/issues/2574) covers related account aggregates, but fixed calendar periods alone cannot supply a subscription's 5-hour or weekly window.

A host-owned, permissioned aggregate read is needed before this page can be completed. The proposed read needs:

- Opaque, non-secret provider/account identifiers, privacy-aware display labels, and separate local/Remote scope. No gateway keys, addresses, emails, raw account/session/request IDs or conversation content need to reach the page.
- Each window's type, used percentage, reset time and quota sample time.
- Usage aggregated for that same account and window, ending at the quota sample: input/output/cache totals, API-equivalent cost or explicit unknown-price status, coverage and extra-paid-usage uncertainty. Reasoning/output and cache-write subsets must not be counted twice.
- Remote authorization, caching and native-log import handled by Magpie itself. No page-side filesystem scanner or direct remote requests. Unknown or conflicting native identities remain excluded; records must be deduplicated before aggregation.
- Explicit permission text shown before enabling the page, bounded host work, and unavailable/error states for unsupported sources, stale data and incomplete records.

The final read name and response shape need maintainer agreement. This package does not declare or call a speculative permission. Once an approved read ships, the page can declare it, integrate it and restore its registry entry with verified support and version requirements.

## Checks

```sh
bun test packages/quota-estimator
bun scripts/check.mjs quota-estimator
```

The tests use synthetic data and need no personal configuration. `npm pack --dry-run --ignore-scripts` checks the explicit publication allow-list. The page can be inspected from a local folder in Magpie, but currently shows only the waiting state.

## 当前状态

这是等待官方权限接口的纯页面草稿，目前不提供实时预估，也未列入社区市场。旧后台采集、原生日志扫描、Remote key 读取和安装目录快照写入均已移除。页面只接收主题与语言，不读取任何用量数据。

完整功能需要 Magpie 提供按账号、额度窗口和采样时间对齐的匿名汇总接口；现有用量总计不能代替。原生 Claude 与 Remote 的身份核对和数据导入应由宿主负责。接口获准并发布后，才声明对应权限、接入预估并恢复市场条目。现有 `estimate.mjs` 及计算测试保留，未把缺少的数据猜成满额数字。
