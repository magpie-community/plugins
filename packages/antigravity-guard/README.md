# @magpie-community/middleware-antigravity-guard

A [magpie](https://usemagpie.ai) gateway middleware that spreads work across
Antigravity accounts and stops sending requests to an account Google has
suspended.

**This does not prevent a suspension.** Google's abuse detection looks at
usage patterns — request volume, concurrency, accounts sharing one IP — not
just at what a request says. Nothing a gateway middleware can do makes a
third-party tool using an Antigravity product login compliant with the
product's terms. This middleware is about spreading load and, once a
suspension happens, **stopping the damage**: a suspended account that keeps
being retried is the clearest possible signal to keep it suspended.

It deliberately does **not** rewrite requests, cloak prompts, change headers
or disguise the client. For that, see
[antigravity-cloak](../antigravity-cloak), which solves a different problem:
the fake `429 Resource has been exhausted` caused by a system prompt that
Antigravity recognises. A `403 TOS_VIOLATION / PERMISSION_DENIED` is a real
suspension; cloak does not help with it.

## What it does

| Hook | Effect |
|---|---|
| `strategies.guard` | Orders a pool's seats so resting, over-budget, denied or suspended accounts come last. Returns a full permutation, as the gateway requires. |
| `onAccount` | Returns `{skip: true}` for denied/suspended accounts. When every candidate is skipped, magpie sends nothing (`gateway-middleware.md`: "no fail-open") — this is the one reliably fail-closed path. |
| `onUsage` | Counts requests per account and marks an account blocked after `suspension403` consecutive `403`s. |
| `onRequest` | Rejects with a clear `429` while `pauseUntil` is in the future. |

## Honest limits

Per `docs/subsystems/gateway-middleware.md`, only `strategies` and `onUsage`
share module state across requests. `onRequest` and `onAccount` run in
per-request runtimes, so the counters above are **best effort** and a hook
that times out or throws is fail-open. The reliable switches are the ones
that come from options on every request:

- `deniedRefs` — account refs to skip (from `onAccount`'s stable `account.ref`,
  which does not reveal the email).
- `pauseUntil` — unix milliseconds. Set it after a suspension; clear it once
  the account is restored. An external guard process can set this from a
  403 watcher.

A real global circuit breaker and per-account daily budgets belong in the
gateway itself, not in a plugin. This package does not pretend otherwise.
Pair it with a request-rate guard in front of magpie's gateway if you need
hard limits.

## Install

```sh
magpie plugin add @magpie-community/middleware-antigravity-guard
magpie plugin options antigravity-guard '{"deniedRefs": [], "dailyCap": 300}'
magpie group set <group> routing=antigravity-guard/guard
```

Needs a magpie with `onAccount`, `onUsage` and gateway strategies
(`docs/subsystems/gateway-middleware.md`).

## Options

```json
{
  "off": false,
  "deniedRefs": [],
  "pauseUntil": 0,
  "dailyCap": 300,
  "cooldownMinutes": 1440,
  "suspension403": 2
}
```

- `off` — leave every request alone.
- `deniedRefs` — account refs `onAccount` skips and `guard` ranks last.
- `pauseUntil` — unix ms; until then `onRequest` rejects and `onAccount` skips.
- `dailyCap` — best-effort per-account request ceiling; `0` disables it.
- `cooldownMinutes` — how long a detected suspension blocks its account.
- `suspension403` — consecutive `403`s before an account is treated as banned.

## If an account is suspended

The `403` carries Google's appeal form link. Stop all traffic to that account,
submit the form, and do not reuse the account with third-party tools: the
appeal form states that a repeat violation leads to a permanent suspension.
Google recommends a Vertex AI or AI Studio API key for third-party agents
instead of a product login.

---

中文：这个中间件**不能防止封号**。Google 判定的是使用模式（请求量、并发、多账号同
IP），不是请求内容。它做的是把请求分散到多个账号，以及一旦某个账号被停权（403
`TOS_VIOLATION`），就别再往它发请求——被封后还持续重试是最容易加深封禁的行为。
它不改写请求、不伪装客户端，与 `antigravity-cloak` 处理的「假 429」是两回事。

受 magpie 插件架构所限，只有 `strategies` / `onUsage` 能跨请求共享状态，
`onRequest` / `onAccount` 是每请求独立 runtime 且异常时 fail-open，因此计数是尽力而为；
真正可靠的开关是每次都会传入的 `deniedRefs` 和 `pauseUntil`。硬性的全局限流建议放在
magpie 网关前面的一层代理里。账号被停权后请走 403 里的申诉表单，不要再用第三方工具
复用该账号——表单明确写了再次违规会永久封禁；Google 建议第三方 agent 改用 Vertex /
AI Studio 的 API key。
