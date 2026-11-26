# dao

A QianDao gateway built into Magpie. Shared concurrency, bounded retries, and Fast mode run inside one plugin, with an editable upstream URL and a settings page.

## Install

```sh
magpie plugin add github:xinxinxiaoxin/dao
```

You can also find **dao** under **Plugins → Discover → Unofficial plugins · GitHub** after the catalog refreshes. Updates are installed from **Plugins → Installed → dao**.

To install a local checkout or an extracted release archive:

```sh
magpie plugin add /path/to/dao
```

Keep Magpie's Middleware feature enabled. Magpie manages the plugin runtime.

## Set up

1. Open the **dao** page in Magpie. Enter your QianDao Base URL and concurrency limit, then save. The manual model field is optional.
2. Open the **dao** provider and sign in with **dao API Key**.
3. In the **dao** provider editor, click **Fetch models** (or **Fetch models again**), select the models you want, and save.
4. Enable Fast with the model picker's lightning button. Codex does not need its own Fast control.

A bare origin receives the `/v1` suffix automatically. An explicit path prefix is preserved. The address is editable; new requests use the saved address while requests already in progress keep their original destination.

The default shared concurrency limit is **5**, across conversations, models, and accounts. Saving a new limit takes effect without restarting the plugin host. Lowering the limit lets existing requests finish and queues new ones until capacity is available.

The native **Fetch models** button reads QianDao's current `/v1/models` list using the saved API key. dao supplies candidates; your selections stay in Magpie's provider editor. Magpie may also request the list when signing in or starting its plugin host. dao does not poll for models. The provider ID remains `qiandao-gateway`.

Explicit model selections remain exact when the candidate list grows. Selecting only Astra and saving keeps only Astra selected when the editor reopens. New candidates remain available for selection. **Select none** is also preserved.

You can still add models by hand in the settings page or provider editor. Refresh the list to load their Fast capabilities. Manually added names remain available even when absent from the upstream list. Clear the optional settings field if you want candidates to follow only the upstream list. Removing a settings model takes effect on the next refresh, unless it remains explicitly configured elsewhere. Existing saved settings are preserved during updates.

## Balance and availability

The provider account's usage information shows QianDao's balance, or its key/subscription allowance where applicable. It reads `/v1/usage` with the existing API key; no separate management token is required. The same information is available through `magpie quota qiandao-gateway --json`.

QianDao may close its gateway between availability periods. A failed or empty model-list response preserves the last successful list and existing selections. A failed balance query reports that it is unavailable; Magpie can retain the previous balance beside a read-error notice. That value is historical, not a fresh balance, and an unavailable query is never converted to zero or an expired login.

Model and balance queries each make one request with an eight-second timeout. Chat can still use configured models when these queries are unavailable. HTML closure pages are treated as temporary upstream failures under the normal bounded chat retry policy. After reopening, use **Fetch models again** to get the currently offered models; Magpie manages removal and restoration of previously selected upstream models.

## Request handling

The plugin buffers a complete upstream response before delivering it. Temporary failures can be retried without exposing discarded partial output or tool calls to the client.

Completed Responses with no answer, refusal, or usable output are recovered inside the same budget. This includes empty output, reasoning-only output, and commentary without a tool call. Valid final answers and explicit incomplete responses retain their meaning. [Recovery policy](docs/recovery-policy.md) documents the full decision flow and host boundaries.

On its native Codex route, dao forwards QianDao's tool events without rewriting them. Tool discovery, free-form patches and namespaced calls keep their original formats. If Magpie takes over web search and offers it as a function, dao sends the request Magpie prepared and lets Magpie translate the reply. A streamed batch with a missing client tool call is recovered before any of its calls are delivered.

For Codex V2 subagents, dao offers `spawn_agent`, `send_message` and `followup_task` upstream as plain functions. Magpie maps them back to Codex's collaboration tools, with the message readable by the recipient. Existing sealed tasks cannot be reopened: start a new task after updating. The plugin does not decrypt stored messages or change other providers or Codex settings.

| Policy | Default |
| --- | --- |
| Maximum upstream attempts | 7, including the first request |
| Rate-limit retry delays | 3, 6, 10, 20, 40, 60 seconds |
| Other transient-error delays | 0.75, 1.5, 3, 3, 3, 3 seconds |
| Admission window for new attempts | 300 seconds |
| Timeout for an attempt already in progress | 900 seconds |

For each request, the first valid `Retry-After` over 30 seconds schedules one retry after 30 seconds, provided another attempt and sufficient admission time remain. Later responses use the greater of the upstream's current `Retry-After` and the original backoff; the 30-second exception is not repeated. Values of 30 seconds or less retain the original behavior. Concurrency and cooldown state are shared, including during overlapping plugin-host generations: a 30-second retry never shortens a longer cooldown already set by another request. Queueing and backoff do not occupy an upstream execution slot. Client cancellation stops queued work, backoff, and the active upstream request.

Magpie calls belonging to the same client request share one attempt budget and final result. Repeated host calls do not start a fresh round of upstream retries. Calls without a middleware request marker make at most one upstream attempt.

Explicit terminal errors retain their meaning. A `response.failed` event with `context_length_exceeded` reaches the client so Codex can compact its context; authentication failures are not retried as temporary outages.

The plugin preserves the selected model, reasoning effort, cache-related fields, client identity headers, and the request's service tier. Enabling Fast in Magpie sends `service_tier: "priority"`, even when Codex supplies no tier. Retries keep that choice. An explicit rejection of Fast is not silently retried as Standard.

## Settings and storage

Magpie stores the API key. dao stores settings, scheduling metadata, manually added model IDs, and the last successful model list per account under `qiandao-gateway/` in Magpie's data directory. These files contain neither conversation bodies nor API keys. Model caches are scoped to the configured Base URL. The settings page shows active requests, queued requests, cooldown, and the current host's latest 20 results.

The **报错记录** tab shows each failure's local date and time, original numeric status or error code, attempt number and a plain-language explanation. It has category filters and lists 20 errors per page. The page shows the retry schedule, remaining shared cooldown, and each failure's earliest retry wait or observed wait if the next attempt has been recorded. The observed wait includes queueing. Older rows without a recorded wait display **未记录**. A later success in the same request marks the earlier failure as recovered. The percentage is based on the most recent 100 recorded upstream attempts, not on conversations or final request failures. The log survives host reloads and excludes client cancellations.

The plugin configures header forwarding and disables additional patience waiting and rate-limit rests for its own provider. Codex's default timeout and unrelated providers are left unchanged.

The settings page uses loopback port **38418**. It serves configuration only; model traffic goes directly from the provider plugin to QianDao. If the port is occupied, chat remains available with the saved settings; change `settingsPort` in the plugin options to restore the page. Unlike routine URL and concurrency edits, changing that plugin option reloads Magpie's shared plugin host.

The page's local access token is stored in the plugin data directory and remains valid across host restarts. An open page can therefore save edited URLs and concurrency after a restart. When upgrading from a release that used temporary page tokens, reload the page once before editing.

## Development

Use Node.js 24 or later:

```sh
npm test
node tests/magpie-host.mjs /path/to/magpie /path/to/bun
npm pack
```

Pass a release archive as the final argument to test its contents:

```sh
node tests/magpie-host.mjs /path/to/magpie /path/to/bun dao-0.1.0-rc.11.tgz
```

For comparison with the original gateway:

```sh
git clone https://github.com/xinxinxiaoxin/qiandao.git docs/research/qiandao-source
npm run test:parity
```

You can also pass the original gateway file to `node tests/parity.mjs /path/to/gateway.mjs`.

Core and contract tests cover error-log visibility during recovery, reload persistence, numeric codes and cancellation. Isolated host checks cover V2 handoff calls, tool discovery, native model refresh and selection, balance queries, closures and reopening, manually added models, native Fast controls, request-field preservation, live settings changes, shared concurrency during host reload, terminal errors, bounded 429 recovery, and cancellation. Browser checks exercise the settings page inside Magpie's `allow-scripts` iframe: clicking Save writes the URL and concurrency, invalid values remain unsaved, Enter saves, and the provider successfully uses the saved URL.

For the browser regression, `node tests/settings-browser-fixture.mjs` serves the actual settings page in an `allow-scripts` iframe with 100 simulated attempts. It writes its test URL and settings path to `.sandbox/settings-browser-session.json`. The **报错记录** tab has multiple pages and examples of planned, observed, unavailable and skipped retries. Run the exported `checkSettingsSave(page, { settings, baseURL: "https://example.invalid" })` from `tests/settings-browser.mjs` to check the persisted file and the visible success message. Stop the fixture with Ctrl+C when finished.

Set `QIANDAO_UI_MODE=1` when running the isolated Magpie host test to exercise the complete embedded-page flow. Read `.sandbox/ui-session.json`, open its authenticated test URL, enter the **dao** page, and run `checkSettingsSave` using its `settings` and `upstreamURL` fields. Write `.sandbox/ui-done` after the browser check; the host test then verifies a request reaches that saved upstream.

In the same isolated session, open the dao provider editor and run `checkModelSelections(page)` from `tests/provider-browser.mjs`. It selects all four candidates, saves, deselects the other three, and verifies that reopening shows only Astra selected. The settings fixture also accepts `POST /restart` to restart its service while a page is open, allowing edited URL and concurrency values to be saved afterward.

Host tests use isolated configuration, fake credentials, and a local upstream. They shorten delays and use a three-attempt limit to detect retry multiplication; core tests verify the production defaults.

Set `QIANDAO_RETRY_AFTER=1` for a real-time host check: the upstream first returns `Retry-After: 120`, and the test verifies that the second request arrives after 30 seconds with the same body. Deterministic clock tests cover later upstream delays and budget boundaries.

For streaming Responses, successful delivery requires usable item events before completion. The final aggregate alone does not deliver a tool call to Codex. Missing aggregate output, reasoning-only streams, and aggregate-only tool calls are recovered before delivery. The original reasoning context and summary are retained while Magpie's selected effort still applies.

Set `QIANDAO_CODEX_LOOP=1` with `QIANDAO_OMITTED_OUTPUT=1` or `QIANDAO_AGGREGATE_ONLY=1` to exercise these two stop cases with the real Codex CLI. Set `QIANDAO_PATH_COMPARE=1` to compare the original gateway and dao behind the same isolated Magpie using identical Responses tool events.

Set `QIANDAO_CODEX_SEARCH=1` to run the real Codex CLI with the isolated host's model catalog and a local MCP tool. The test requires discovery, two calls in one batch, both results matched by call ID and a final answer. Set `QIANDAO_HOST_SEARCH=1` to test Magpie's web-search takeover with a fixture credential. The upstream does not invoke a search service. Neither test needs QianDao credentials.

The plugin retains the latest 100 attempt records in `qiandao-gateway/scheduler.json`, including version, request identifier, attempt number, timestamp and, when available, HTTP status, numeric error code and response structure. Transport failures without an HTTP response have no HTTP code. Records exclude raw error messages, prompts, answers, reasoning text, tool arguments and credentials. The settings service health response includes its running version.

## Limitations

- Complete-response buffering delays visible output. A long response can hit the client's default idle timeout before the gateway's own budget ends.
- A client reconnect or a manually resent request receives a new budget, while still sharing the global plugin concurrency limit and cooldown.
- Magpie may still process a plugin's final error. dao bounds actual upstream sends; it cannot disable every host error-handling behavior.
- During a shared-host reload, Magpie allows the retiring host up to ten minutes to finish. Longer requests may be interrupted by the host.
- Live QianDao model-list and balance queries, and a real Codex turn with two JavaScript tool calls and a final answer, have been verified. Requesting Priority does not guarantee the upstream grants that service tier or a cache hit.

## Related projects

- [Original QianDao gateway](https://github.com/xinxinxiaoxin/qiandao)
- [AG Relay for Magpie](https://github.com/xinxinxiaoxin/magpie-agentrouter-relay)
- [Magpie plugin development guide](https://usemagpie.ai/docs/plugins)

## License

[MIT](LICENSE). See [attribution](THIRD_PARTY_NOTICES.md) for related project credits.
