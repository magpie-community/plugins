<p align="center">
  <img src="https://raw.githubusercontent.com/wawaTuna/magpie-free-pi/main/assets/banner.png" alt="magpie-free-pi" width="100%">
</p>

# magpie-free-pi

Free models for Magpie, funded by ads — no API key, no card, one GitHub sign-in.

**DeepSeek V4.1 Flash, DeepSeek V4 Flash, GLM 5.3 Flash and Particle, free and unlimited in [Magpie](https://usemagpie.ai).**

![CI](https://github.com/wawaTuna/magpie-free-pi/actions/workflows/ci.yml/badge.svg) [![npm](https://img.shields.io/npm/v/magpie-free-pi)](https://www.npmjs.com/package/magpie-free-pi) ![License](https://img.shields.io/badge/license-MIT-blue.svg)

**[Quick start](#quick-start) · [Multiple accounts](#multiple-accounts) · [How it works](#how-it-works) · [Privacy](#privacy) · [简体中文](README.zh-CN.md)**

## Quick start

**1 · Install.**

```bash
magpie plugin add github:wawaTuna/magpie-free-pi
```

<details>
<summary>Other install routes</summary>

```bash
# Local clone / folder (loaded in place)
git clone https://github.com/wawaTuna/magpie-free-pi
magpie plugin add ./magpie-free-pi
```

</details>

**2 · Sign in.** (Accepts free-pi's terms — read [Privacy](#privacy) first.)

```bash
magpie plugin login free-pi     # GitHub device flow, 90-day token
```

**3 · Verify.**

```bash
magpie provider test free-pi    # one real chat call
magpie quota                    # today's remaining budget
```

Models are then available to every agent as e.g. `free-pi/deepseek-v4.1-flash`. Sample quota output:

```
$ magpie quota
free-pi · free-pi (young) · chenbeigao (free-pi)
  subscription · today · 15000 / 15000 credits left · ↻ tomorrow 08:00
  $1.1250 left today
```

## What you get

- **Free Unlimited models cost nothing.** The models free-pi marks Free Unlimited (DeepSeek V4.1 Flash, DeepSeek V4 Flash, GLM 5.3 Flash, Particle at the time of writing) never touch your budget.
- **Everything else runs on a daily budget.** 15,000 credits (≈ $1.125) per account per day, refilled at 00:00 UTC. Metered models (DeepSeek V4 Pro, GPT-6 series, Kimi, …) deduct their real upstream cost × a catalogue multiplier.
- **The model list is live.** It comes from free-pi's own catalogue endpoint, so models appear and disappear as free-pi changes them — no plugin update needed.
- **Quota is visible.** Remaining budget per account shows in `magpie quota`, the Providers UI, and Magpie's routing decisions.

## Multiple accounts

Each free-pi account is a GitHub account with its own daily budget, and Magpie keeps several accounts per provider natively. This plugin stores a sign-in under your free-pi handle, so signing in again with a *different* GitHub account **adds** an account instead of replacing the first:

```bash
magpie plugin login free-pi     # repeat with another GitHub account
```

Magpie then fails over between accounts on its own (a rate limit or a refused token moves the request to the next account) and weighs them by the quota this plugin reports. Two accounts = 2 × 15,000 credits a day for metered models; Free Unlimited stays free on every account.

The same sign-ins also join a shared on-disk account pool (`~/.free-pi/agent/`, 0600) used by the sibling project [dsh-free-pi](https://github.com/wawaTuna/dsh-free-pi) and by the standalone proxy in the free-pi-plugins monorepo — sign in once per machine, use everywhere.

## How it works

Magpie provider plugins are OpenCode v1 plugins; this one is a thin adapter over a small shared core:

- **Provider declaration.** `config` registers the provider as `@ai-sdk/openai-compatible` with `api: https://api.freepi.ai/v1`.
- **Sign-in.** `auth` offers free-pi's GitHub device flow as an oauth method, plus a paste-a-JWT fallback for a token you already have.
- **The loader's fetch is the reverse proxy.** free-pi's backend requires three things a normal OpenAI client doesn't send — `Authorization: Bearer <JWT>`, a stable per-install `x-session-id`, and `x-client-version` (the server blocks clients below a minimum version). The fetch injects all three, per account.
- **Live catalogue.** `provider.models` maps free-pi's unauthenticated `/client-version` catalogue to Magpie's model shape (upstream has no `/v1/models`).
- **Quota reporting.** `auth.usage` reads the account's `/me` record and reports today's window (used / 15,000 credits, refill time, USD left).

A standalone OpenAI-compatible proxy with the same core (for hosts without a plugin system) lives in the free-pi-plugins monorepo.

## Privacy

free-pi is funded by ads **and by training on session data**. Its consent text — which you accept when you sign in — says your coding sessions (prompts, code, files, model responses) are saved as traces, used to train models, and may be shared or sold to third parties; the ad provider receives excerpts of your recent conversation to pick ads. Full terms: https://freepi.ai/terms

Only sign in with accounts and code you are comfortable with that trade. This applies to everything you send through free-pi, from any host.

## FAQ

#### When does the budget refill?

Daily at 00:00 UTC. `magpie quota` shows the exact countdown per account.

#### Is "Free Unlimited" permanent?

No — it's free-pi's promotion and can end at any time. Metered models keep working on the daily budget either way.

#### My token expired. What now?

Tokens last ~90 days. Magpie marks the account; run `magpie plugin login free-pi` again — nothing else to redo.

#### Could free-pi block this kind of client?

Its backend officially serves free-pi's own terminal client. This plugin talks to the same backend the same way, but free-pi could tighten its checks (for example, require live ad sessions).

## Contributing

Issues and PRs are welcome.

## License

MIT — see [LICENSE](LICENSE).

*Unofficial plugin. Not affiliated with free-pi, Magpie, or the model providers. "free-pi" and model names belong to their respective owners.*
