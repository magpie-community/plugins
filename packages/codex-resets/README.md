# @magpie-community/page-codex-resets

**Draft — waiting for Magpie’s page-open controlled networking interface.** The maintainer [accepted Codex Resets as an attributed community source](https://github.com/yetone/magpie/issues/3609#issuecomment-6489178822), with the first version limited to announcements, reset-credit grants and original-post links. [plugins#338](https://github.com/magpie-community/plugins/pull/338) remains Draft and the market listing is withheld until the host interface is available and integrated.

A separate Codex reset news page using Magpie’s light/dark theme, a two-column announcement/credit overview and collapsible sources. The complete interface is available in English, Simplified Chinese, Traditional Chinese, Japanese and German. Probability forecasts are neither parsed, persisted nor displayed, including when present in older saved snapshots.

## Architecture

The agreed production flow, pending the interface in [#3609](https://github.com/yetone/magpie/issues/3609), is:

```text
Open page requests public data through Magpie
  → host fetches from declared public HTTPS hosts
  → validated announcement/credit snapshot
  → sandboxed page renders the snapshot
Close page → updates pause
```

Magpie will perform GET requests on the page’s behalf, without cookies or credentials, rejecting private addresses and redirects outside the declared hosts. Requests run on the Magpie host, including remote `magpie web`, while the iframe retains `connect-src 'none'`. This feature does not need a background scheduler or a local helper. The page explicitly says updates pause when it closes.

**That host interface is not defined or implemented here.** No speculative manifest fields or bridge methods are introduced. The current page only uses `magpie.ready`, theme events and `magpie.options.get()`, and renders saved test snapshots. It makes no requests and declares no private reads. Its empty state explains the pending support; do not publish this preview as a working live-data plugin.

`syncOnce({request, save, options, signal, now})` is reusable internal code for one bounded check, not a Magpie API. It requires an injected transport and publisher, retains a five-minute check deadline and `Retry-After`, and supports cancellation before requesting or publishing. It starts no scheduler and has no default global fetch. The future page-lifetime adapter must use the official host interface, prevent overlapping checks, and cancel requests/publication when the page closes. That adapter and host security/lifecycle behavior remain unimplemented and untested.

There is no shipped CLI, npm bin, terminal watcher, bell, installation hook, daemon or OS scheduler. Desktop notifications and reset-card dialog changes are out of scope. A new explicit announcement can be returned by the internal sync module as data; it does not send a notification.

## Meaning of the information

- Public announcements help users notice a possible upcoming reset before spending a saved credit. They offer no private or exclusive signal.
- Global resets and credit grants are distinct. A grant adds resets to use later; it does not refill the current allowance.
- Scheduled announcements retain Tibo’s original X URL. An announcement without an exact time remains without one; this page does not derive a probability from vague wording.
- An announced time passing becomes **Awaiting confirmation**, not proof of completion. Eligibility and actual allowance belong to the user’s account.
- Failed, malformed or stale data is unavailable, never “no reset.” Snapshot freshness is 15 minutes; scheduled announcements older than 48 hours are treated as unverifiable.
- In this draft, the page rereads its snapshot every 30 seconds while loaded. **Refresh page** rereads that snapshot and does not fetch a public service. Source addresses can be selected and copied because the current iframe sandbox forbids popups.

## Attributed community source

[Codex Resets](https://codex-resets.com) and its [public API](https://codex-resets.com/api/docs) are the community source. API documentation allows keyless use with attribution; the maintainer has separately accepted this source for the limited first-version scope. Community tracking is not an OpenAI guarantee. Attribution and original X addresses are retained; no website code or X scraping is included.

The intended destination is **`https://codex-resets.com/api/v1/status`**. The internal module uses GET, an eight-second timeout, no credentials, rejects all redirects, and caps the body at 64 KiB. Backoff respects `Retry-After` with a five-minute floor and 24-hour cap. Only required validated public fields are retained; upstream forecast fields are ignored. Host-side destination/private-address enforcement must come from the future official interface. No accounts, credentials, quotas or agent files are read.

## Development and verification

Install the local preview into a **dedicated sandbox HOME**, then seed fixture options through the official CLI or the browser test below. This is for reviewing the UI, not an end-user installation workflow:

```sh
magpie plugin add ./packages/codex-resets
```

`dev/sync.mjs` is an optional single-request smoke helper for a developer's sandbox, excluded from the package. It explicitly supplies `fetch` and uses the official CLI to write only this plugin's options. It has no watch/bell mode. Do not run it as a background service or recommend it to marketplace users. Normal tests never contact the public service.

Run the repository checks in a temporary HOME so no real sign-in is touched:

```sh
HOME=$(mktemp -d) bun test
bun scripts/check.mjs
```

Focused tests cover parsing, source URLs, expiry, exclusion of legacy prediction fields, failure/backoff, data minimization, cancellation, explicit transport, script/permission policy, complete translated messages and placeholder parity. Node can also run them with `node --test packages/codex-resets/*.test.mjs`.

`browser.test.mjs` is optional and uses a **separately running, isolated** Magpie web and development Playwright. Set:

- `MAGPIE_UI_TEST=1`.
- `HOME` and `MAGPIE_TEST_HOME` to the same dedicated directory containing `sandbox` in its name; isolate `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` there too. Install this preview into that Magpie.
- Configure its gateway on an unused port and run `magpie web --addr 127.0.0.1:<unused-web-port> --no-open`. Never target everyday Magpie.
- `MAGPIE_TEST_URL` to the localhost link including its test key; `MAGPIE_TEST_BIN` to the tested binary.
- `PLAYWRIGHT_MODULE` to Playwright's development `index.mjs`; `PLAYWRIGHT_BROWSERS_PATH` if its browsers are outside the sandbox.
- Optionally `MAGPIE_TEST_CHROMIUM_CHANNEL=chrome` to use installed Chrome with a fresh temporary browser profile; the default uses Playwright's bundled Chromium.
- Optionally `MAGPIE_TEST_ENGINES=chromium,webkit` (default Chromium). The tested host's scheme-less CSP sources are rejected by Playwright WebKit before scripts load; the test does not bypass that host limitation.
- Optionally `MAGPIE_SCREENSHOTS` for rendered previews.

Run `node --test packages/codex-resets/browser.test.mjs`. It restores the sandbox settings/options and checks all five languages, light/dark, 1100/760/420px, source selection, refresh, exclusion of legacy predictions and unavailable/empty states. Fixtures and screenshots use fictional October 23, 2026 data, with an obsolete forecast field to verify its exclusion; they are not live announcements.

中文：此版本仍为草稿。维护者已接受署名的 Codex Resets 社区数据源，首版仅显示公告、发卡及原帖链接，已移除概率预测。计划由 Magpie 在页面打开期间代为联网，关闭页面即暂停更新；不做后台调度，不需要本地终端。仍需等待 #3609 的官方接口定义后完成接入，暂不上架。
