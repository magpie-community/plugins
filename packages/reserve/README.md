# @magpie-community/middleware-reserve

Two routings for [magpie](https://usemagpie.ai) that keep something in reserve. Pick one for a provider's accounts or keys, or for a routing group's members, and magpie's gateway tries them in the order it gives.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-reserve`. While it is on, every routing picker offers `reserve/ceiling` and `reserve/accounts-first`. From the command line, a group takes one with:

```sh
magpie group set <id> routing=reserve/ceiling
```

## Routings

**`reserve/ceiling`** fills the accounts in the order listed, but keeps the last share of each one's allowance.

- The first account takes requests until it has used `ceiling` percent of its allowance, then the next one takes over.
- Once every account is past the ceiling, the least used goes first.
- A seat whose allowance isn't known (an API key, or an account not read yet) counts as below the ceiling.
- A seat resting after a failure goes last.

Use it to keep, say, a fifth of your main account's week for when you're at its own app, while the gateway uses the rest.

**`reserve/accounts-first`** puts subscriptions before API keys, so what you have paid for already goes first. A key that bills by the token is used only when no account can take the request.

- Accounts go least used first.
- Keys go by their weight, highest first, then by what they were sent lately.
- Seats resting after a failure go last.

## Options

```json
{ "ceiling": 80 }
```

`ceiling` is the percent of an account's allowance past which `reserve/ceiling` moves on, from 1 to 100. It is 80 when none is set. Set it under **Plugins › Installed › Options**, or with `magpie plugin options reserve '{"ceiling": 70}'`.

## Test

`strategies.json` holds the cases: seats in, the order wanted out. `reserve.test.mjs` runs them with `checkStrategies()` from `scripts/middleware.mjs`, and checks that each answer is a permutation of the seats.

```sh
bun test packages/reserve
```

中文：两种为账号留余量的路由。`reserve/ceiling` 按列出的顺序使用账号，每个账号用到额度的 `ceiling`%（默认 80）就换下一个，全部超过后用得最少的优先；`reserve/accounts-first` 订阅账号优先于按量计费的 API key，key 按权重排序。休息中的总是排最后。
