# @magpie-community/middleware-circuit-breaker

A circuit breaker for [magpie](https://usemagpie.ai)'s gateway. A model that keeps failing rests for a while: requests to it are refused at once with a **429**, so the agent backs off and retries on its own clock instead of paying a connection timeout every turn.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-circuit-breaker`. Set its options under **Plugins › Installed › Options**, or with `magpie plugin options circuit-breaker '<json>'`.

## Options

```json
{ "failures": 2, "window": 60, "cooldown": 120, "max": 600,
  "status": [429, 500, 502, 503, 504],
  "message": "" }
```

- **`failures`.** How many failures inside `window` rest the model. 2 by default, deliberately low — see [the count is per runtime](#the-count-is-per-runtime).
- **`window`.** Seconds the failures are counted over. 60 by default.
- **`cooldown`.** Seconds the model rests once it reaches `failures`. 120 by default.
- **`max`.** How long a rest may grow to. A model that fails again as soon as its rest is over rests twice as long next time — `cooldown`, `2×`, `4×` … up to `max`. 600 by default. A site that stays down then costs one timeout a round instead of a full `failures` of them.
- **`status`.** Which reply statuses count as a failure. A good reply clears the window and ends the rest, so a model that works again is trusted at once and gets its first rest back.
- **`message`.** The refusal's text, in place of the default one, which names the model and the seconds left.

An option that makes no sense — `failures` of `0`, a `window` of `-5`, a `cooldown` that isn't a number — falls back to its default rather than turning every request away. `max` is never taken below `cooldown`, so a rest can only grow.

## Streams

A streamed reply never reaches `onResponse` and gives this plugin no status, so it reads the events instead: an `error` event counts as a failure, and an event carrying content counts as a good reply. Merely connecting is not answering — a stream that opens and dies at once still counts as a failure. Anthropic, Chat Completions, Responses and Gemini event shapes are all read.

## Why 429

The refusal is what tells the agent to try again, and 429 is the one code every agent already backs off on: Claude Code, Codex and opencode all have a rate-limit retry with backoff. A 503 reads as a broken server — agents retry it a few times and give up.

## What it does not do

It does not fail over to another model, and it cannot. `ctx.reject` stops the request in `onRequest`, and a rejected request never reaches `serve` — the one place magpie's provider loop runs, the loop that hands a failed try to the next model. So there is no fallback for magpie to do here: the agent gets the 429 itself and retries. Model failover is magpie's own, and separate:

```sh
magpie provider fallback <provider-id> <provider/model> <provider/model> …
```

The two do not compose: while a model rests, this plugin refuses the whole request ahead of that chain, so the chain never runs for it. If what you want is for a failing model to be replaced rather than rested, `provider fallback` is the one to set up; this plugin is for holding a model back so the agent stops paying its timeouts.

## The count is per runtime

magpie compiles a middleware once but runs each request in a runtime of its own, taken from a pool. A middleware's module state lives in that runtime, so this plugin's failure count is **sharded over the pool**: a model resting on one runtime is refused for the requests that land on it, not for all of them. There is no cross-request store to keep it in — `ctx.state` is one request's, and `ctx` has no key–value of its own.

So the breaker trips, but for its share of the traffic. Lowering `failures` makes each shard trip sooner, which is why the default is 2 rather than 3. The `resting` seats of magpie's own routings, and `provider fallback`, hold that state in Go and are not sharded, so for a rest that covers all of a provider's traffic those are the ones to reach for.

中文：熔断器。某个模型在窗口期（`window`）内失败到 `failures` 次就先「休息」，休息期间的请求立刻被 **429** 拒绝——429 是各家 agent 都自带退避重试的状态码，让重试跑在 agent 自己的节奏上，而不是每轮干等一次连接超时。休息结束后的探测请求再失败，休息时间翻倍（`cooldown` → 2× → 4× …）直到 `max` 秒封顶；回复正常则立刻清零，休息时长也重置回 `cooldown`。注意两点：**它不换模型**（`ctx.reject` 在 `onRequest` 就把请求截断，magpie 的 provider 候选循环根本进不去），换模型请用 `magpie provider fallback`，两者不叠加；**计数是分片的**（每个请求各拿一个 runtime，模块状态存在里面），所以把 `failures` 调小、或者改用 magpie 自己那些不分片的 routing `resting` 席位。
