# @magpie-community/opencode-opendesign-auth

**Open Design** ([open-design.ai](https://open-design.ai), the cloud behind
[nexu-io/open-design](https://github.com/nexu-io/open-design)) on your own
account, provider id `opendesign`: its models on the account's credits and
Coding Plan, the same way Open Design's own CLI (`vela`) and desktop app use
them.

> **Experimental — not tried against a real account.** Everything here was
> worked out from Open Design's open-source daemon
> (`apps/daemon/src/integrations/vela*.ts`, `packages/contracts`), the names
> in the published `vela` CLI binary (`@powerformer/vela-cli` 0.1.4), and
> other community clients. No request in it has been sent to Open Design
> from here. It talks to the endpoints Open Design's own client uses, not a
> documented public API, so Open Design may change them, or may not want
> them used this way; using them is at your own risk under Open Design's
> terms. If something fails, open an issue and include the error magpie
> shows.

## Signing in

An Open Design account has two keys:

- the **runtime key** (`sk-amr-…`), which pays for model requests at
  `amr-link.open-design.ai/v1`;
- the **control key** (`vela_ctrl_…`), which reads the wallet, the plan and
  the Coding Plan's limits at `amr-api.open-design.ai`.

There are three ways in:

| Method | What it does |
|---|---|
| **Sign in to Open Design (browser)** | Open Design's device sign-in, as `vela login` runs it: a page opens with a code to approve, and both keys come back. |
| **Open Design app's or vela CLI's sign-in** | Uses the account in `~/.amr/config.json` (`$AMR_HOME` if set; profile `$OPEN_DESIGN_AMR_PROFILE`, else `$VELA_PROFILE`, else `prod`). Nothing in the file is changed, and a later `vela login` is followed. |
| **Open Design keys** | Paste the runtime key, or the runtime key and the control key separated by a space. Without the control key the models work but the balance can't be read. |

The keys don't expire and there's nothing to renew; a key Open Design turns
away marks the account to sign in again.

## Models and requests

The model list is the account's own, from `GET /v1/models` on the link host
(the plan decides which models an account gets). A model's context window is
the list's `metadata.context_limit`, else its `context_budget`. Before the
first listing, a few models named in the `vela` CLI are shown.

Requests are OpenAI Chat Completions (`POST /v1/chat/completions`), the
protocol `vela` sets up for its own OpenCode, with the runtime key. The key
goes only to the link host. Open Design's refusals are passed on as magpie
reads them:

| Open Design says | magpie sees |
|---|---|
| `insufficient_balance`, or `accountAction: "recharge"` | 429, with the top-up page |
| `tier_model_not_entitled`, `tier_request_kind_not_entitled` | 403: the plan doesn't include it |
| `auth_required`, `accountAction: "relogin"`, a 401 | 401, and the account is marked to sign in again |
| `upstream_provider_unauthenticated` / `_forbidden` | 502: an outage on Open Design's side, not the sign-in |

## Usage

With the control key, the account's card shows:

- **Plan**: the membership tier from `GET /api/v1/billing/summary`, and the
  subscription's status when it isn't active; the period's end and whether
  it renews.
- **Balance**: the wallet's dollars (`GET /api/v1/wallet/balance`), with the
  plan's and the topped-up credits beside them.
- **Coding Plan limits**: each window of the workspace's Coding Plan
  (`GET /api/v1/workspaces/{id}/billing/preflight`, the workspace being
  `$VELA_WORKSPACE_ID` or `GET /api/v1/workspaces/current`), with used credits
  out of the limit and when it resets. If these can't be read the card says
  so and still shows the balance.
