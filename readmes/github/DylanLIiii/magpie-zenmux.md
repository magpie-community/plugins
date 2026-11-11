<img src="logo.svg" width="64" alt="ZenMux">

# @magpie-community/opencode-zenmux-auth

Uses a [ZenMux Builder Plan](https://zenmux.ai/docs/guide/subscription.html)
(Starter, Max, Ultra) in OpenCode and magpie, and shows in magpie how much of
the plan's quota is used and when it refreshes. Provider id: `zenmux-plan`.

## Signing in

One method, **ZenMux subscription API key (`sk-ss-v1-…`)**, which asks for two keys:

- the plan's **subscription API key** (`sk-ss-v1-…`, from the subscription
  page). Requests go with it to `https://zenmux.ai/api/v1` (OpenAI
  Chat Completions) and are taken from the plan's Flows.
- a **Management API key** (`sk-mg-v1-…`, ZenMux Console › Management),
  optional. Only it can read the plan's quota: ZenMux turns other keys away
  from the management API. It is kept with the account (in magpie,
  `plugin-auth.json`) and is never sent with a model request. Left empty,
  `ZENMUX_MANAGEMENT_API_KEY` is used if set; without either, requests work
  and the usage card says the key is missing.

The Free plan has no API access, so it can't be used here.

## Usage

Read from [`GET /api/v1/management/subscription/detail`](https://zenmux.ai/docs/api/platform/subscription-detail.html):

- the plan (`Starter`, `Max`, `Ultra`; the API calls Starter `pro`) and the
  end of the current billing period;
- **5 hours** and **7 days**: the share used, the Flows used of the window's
  maximum, and when the window resets. Both are rolling: they start with the
  first request and reset 5 hours or 7 days later. A window not started yet
  (`resets_at: null`) has no reset time;
- an account ZenMux marks other than `healthy` (`monitored`, `abusive`,
  `suspended`, `banned`) is told on the card.

Not shown, because the API doesn't tell them: the monthly cap's usage (only
its maximum is given), and the window resets a plan gets each month (4, 3 or
2) or how many are left.

## Models

ZenMux's live list (`GET /api/v1/models`), the models that answer in text.
A plan doesn't serve every model on it; which ones it does is on ZenMux's
pricing page. When the list doesn't answer, a few common ones are offered.
