# opencode-venice-auth

Use your own [Venice.ai](https://venice.ai) API key to run Venice text models in OpenCode and magpie. The plugin talks to the OpenAI-compatible endpoint `https://api.venice.ai/api/v1`, fetches the model list live after sign-in, and adds key balances and rate-limit caps to `magpie quota`.

Provider id: `venice`. Models are referenced as `venice/<model-id>`.

Repository: <https://github.com/Tomahawkd/opencode-venice-auth>

## Sign-in

Generate an API key in your Venice account, then run:

```sh
magpie plugin login venice
```

magpie asks for the key once in a single text prompt. The value is used as-is apart from trimming surrounding whitespace; the plugin does not check a prefix or a key format before contacting Venice.

The key is validated with `GET /api_keys/rate_limits`. An invalid key fails with `Venice rejected this API key (HTTP 401)`; the sign-in stops there and nothing is saved. A key that cannot use inference endpoints fails with `This key cannot use Venice inference APIs (accessPermitted=false)`. On success, magpie stores the sign-in state in its local plugin credential store. If a saved key is later rejected with HTTP 401 — for example after it is revoked in Venice — magpie then marks the account as needing to sign in again.

### HTTP 402 is not an expired sign-in

Venice answers HTTP 402 both when the account balance is insufficient and when a per-key spending cap has been reached. The plugin presents this as a balance or cap condition; the usage view reports `Venice reports insufficient balance or a spending cap was reached (HTTP 402)`. It does not mark the account as expired, because signing in again cannot fix it. Check the balance in Venice or raise the key's spending cap instead. Only HTTP 401 marks the account as expired.

## Models

After sign-in, `provider.models` fetches `GET /models?type=text` with the saved key on every load and replaces the account's model list as a whole. If the fetch fails, the existing list is kept (falling back to the built-in catalog); an HTTP 401 marks the account as expired.

Models are skipped when they are offline, in beta, deprecated, end-to-end encrypted (by id prefix, the E2EE capability, or TEE attestation), or do not support function calling. The rest are mapped onto OpenCode's nested model shape:

- `availableContextTokens` and `maxCompletionTokens` become the context and output limits.
- Reasoning, tool-call, vision (as both image input and attachments), and audio-input support become capability flags.
- Venice's input and output prices and the cache read/write prices, in USD per million tokens, become the model costs; a cache read or write price Venice does not report is mapped to 0.

The list changes as Venice changes it, so this README intentionally contains no static model table or model count.

### Venice's default system prompt

The plugin does not send `venice_parameters` in requests. Venice therefore applies its default `include_venice_system_prompt: true`, which means Venice includes its own default system prompt with requests. See the [Venice API reference](https://docs.venice.ai/api-reference) for details and how to override this behavior.

## Usage

`magpie quota`, and the Providers usage card, show what Venice reports for the key as windows ordered by Venice's charge priority:

- `Daily DIEM`: the DIEM balance, shown only when it is greater than zero. It resets at the next daily epoch (`nextEpochBegins`, 00:00 UTC).
- `Plan credits`: the bundled plan credits, shown as a wallet when no plan tier is configured. Without a tier, a zero balance is hidden.
- `Plan credits (est.)`: with a plan tier configured, an estimate of the tier's usage. The display reads `25 of 75 credits left`; magpie derives the percentage. The window is marked as auxiliary (`aside: true`) and has no reset time because Venice does not expose one for the subscription.
- `API balance`: the prepaid USD balance, shown whenever Venice reports the field, including zero (a negative value is displayed as zero).
- Rate-limit caps summarized per limit type as a range (for example `50-100 across 119 models`), with account-wide caps listed first. Only caps are shown: Venice does not report consumption, so the plugin does not invent a used amount. Per-model caps remain available from Venice at `GET /api_keys/rate_limits`.
- `plan option`: added at the end only when the configured plan value is not recognized. It reads `not recognized; use pro, plus or max` and never echoes the bad value; the credits fall back to the untiered wallet window.

An HTTP 402 from a usage request is displayed as the balance or spending-cap condition described in [Sign-in](#http-402-is-not-an-expired-sign-in).

The old single balance line is gone. In `magpie quota --json`, the top-level `balance` field no longer exists: this is a breaking change for scripts that read it. Read the `windows` array instead; wallet windows carry `balance` and `unit`. The top-level `until` field is the API key's expiration, not the subscription's. The plan badge and the estimate window come from the plugin's `plan` option, not from Venice.

### Billing order

Venice charges each request in a fixed order: DIEM, then earned credits, then bundled plan credits, then USD. When one source runs out, the next one is used automatically. A request fails with HTTP 402 when the combined available balance is insufficient, or when a key-level spending cap is reached. There is no plugin switch for this, because Venice fixes the order server-side.

The window order itself expresses that priority: with a plan tier configured, the `Plan credits (est.)` window marks where bundled plan credits sit. To find the next currency Venice will charge, look for the first source with a remaining balance in window order, including the estimate window; scanning only wallet windows is not enough. One exception is that earned credits sit between DIEM and plan credits and are not visible to the plugin, so a missing earned-credits window is normal; a missing window can also simply mean that currency's balance is zero. A Venice per-key consumption limit (for example a USD cap) is configured in the Venice web account, not by this plugin; it can turn an otherwise funded request into a 402.

### Plan estimate (optional)

Set the plan tier to add the `Plan credits (est.)` window:

```sh
magpie plugin options opencode-venice-auth '{"plan":"plus"}'
```

Valid values are `pro`, `plus` and `max`, matched case-insensitively and ignoring surrounding whitespace. Clear the option with:

```sh
magpie plugin options opencode-venice-auth off
```

Use the name or spec the plugin was installed under; `opencode-venice-auth` is the package name. The credit limits are Pro 1, Plus 75 and Max 225 credits, matching Venice's current published values, where 1 credit = $1. These values can go out of date, in which case the estimate is still shown but its percentage is wrong.

The estimate is best effort. Venice does not expose the subscription's total allowance or reset time to an inference key, so the limit comes from the table above, the window has no `resetsAt`, and the estimate carries the `(est.)` suffix and `aside: true`. The `aside` flag tells magpie this is auxiliary data rather than a timed metered quota, so it is not marked as a clock-based hold. The same flag also keeps the estimate out of magpie's balance reminders (quota and balance alerts). If the reported bundled balance is greater than the configured limit (a stale tier or a rollover), the plugin shows a plain `Plan credits` wallet instead of a percentage. A zero bundled balance with a tier configured shows the estimate at 100% used.

Options are resolved once when the plugin loads, and magpie reloads the plugin when the options change. The plan badge can be stale on the host side: after clearing the option, the previous badge may remain until the account is logged out and back in. Signing in again alone does not clear it; run `magpie plugin logout venice` first, then sign in again.

## Install

```sh
git clone https://github.com/Tomahawkd/opencode-venice-auth
cd opencode-venice-auth
magpie plugin add ./
magpie plugin login venice
magpie provider test venice
```

Without cloning, install straight from the repository: `magpie plugin add https://github.com/Tomahawkd/opencode-venice-auth`.

From npm, install the published package: `magpie plugin add opencode-venice-auth`.

The package is also an OpenCode v1 plugin and can be used as an OpenCode plugin.

## Development

Development requires [bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/).

```sh
bun install
bun test
bun run typecheck
uvx pluvy --all
```

Exit codes and results follow the project's rules:

- `bun test` fails on any non-zero exit. Tests must be fixed, not removed, skipped, or weakened.
- `bun run typecheck` must report no errors.
- `uvx pluvy --all` passes only with exit 0 and a reported file count greater than 0. Exit 1 means a code problem that must be fixed in the code; exit 2 means an environment or configuration problem and is not a pass.

Released under the [MIT License](LICENSE). This project is not affiliated with Venice.ai. Bugs and feature requests belong in the [issue tracker](https://github.com/Tomahawkd/opencode-venice-auth/issues).
