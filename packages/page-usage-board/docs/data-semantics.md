# Data semantics

Read this before changing the page or the aggregations. Two different totals are shown on
purpose; they answer different questions and must not be silently reconciled.

## The four exit aliases are two routes

magpie renamed its outbound providers over time:

| Route | Names in `usage.jsonl` | Remote `caller` |
|---|---|---|
| direct | `magpie-direct`, `remote-magpie` | `cloud` |
| Cloudflare | `magpie-cf`, `magpie-2` | `Magpie` |

The page keeps all four in one `REMOTE_ENTRY` set. Never hand-write a single name.

## Charts use real providers

- Local, non-exit providers are taken from the detail log as-is.
- Remote attribution adds per-provider totals under the same provider names.
- When attribution is available, the exit aliases do **not** enter the charts; their traffic
  is already attributed.
- When attribution is unavailable, the four exit aliases collapse into one series labelled
  "remote (unattributed)", so nothing disappears silently.
- The daily chart stacks providers; the provider pie merges aliases.

## Where the remote side comes from

The local service reads the remote magpie's own `/v1/magpie/usage/requests` (provider key
already in `providers.json`) and keeps rows whose `callerKeyName` is in `REMOTE_CALLERS`
(default `cloud`, `Magpie`). The caller breakdown still lists every caller on that instance
(e.g. `hermes`), but provider/account/day/hourly numbers are this machine's only. The 24-hour
remote curve is caller-filtered too; older builds that read the remote log without that filter
over-counted other callers.

The standalone `/usage2` service is retired: it was only a way to run that filter on the
remote log when the magpie API could not give per-caller rows.

## KPI cards use the local gateway ledger

Cost on the KPI cards is magpie's own pricing (subscription quota converted to money), not
money actually spent. It is intentionally different from the chart totals, which follow real
providers. Label both clearly; do not "fix" one to match the other.

## Quota cards deduplicate by subscription

The same subscription can be read through two routes (direct / proxy) and two instances
(local / remote). The quota wall groups by (normalized subscription + account) and shows one
card per group; the `· Magpie direct/proxy` suffix is stripped from the name. Different
accounts (different phone numbers or keys) are different quotas and stay as separate cards.

## Remote cards have three states

- No remote data source (e.g. a VPS-only install): hide the TTFT and account cards.
- Source configured but the fetch fails (45 s client timeout, 10 s per remote page server-side): show a red error card explaining it.
- Success: show the data.

A dead source must never make the card vanish without a trace — silence looks like "zero
usage" and is the one failure mode that misleads.

## What is read

`usage.jsonl` lines are aggregated into daily × provider totals, a 7×24 heatmap, 24-hour
token/cache curves, recent requests and per-account attribution. Probe lines
(`kind: "model_list"`, `source: "probe"`) are filtered out. Prompts, messages and tool output
are never read or displayed.