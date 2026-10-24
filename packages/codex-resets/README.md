# @magpie-community/page-codex-resets

A separate **Codex reset news** page in [Magpie](https://usemagpie.ai), with global-reset announcements, community probability estimates and reset-credit grants. It follows Magpie's light/dark theme and keeps sources behind a disclosure. English, Simplified Chinese and Traditional Chinese are supported; other page languages fall back to English.

**Live data requires an explicitly started local sync command.** Installing the package starts no process and sends no request. The page itself is offline and reads only its own options through Magpie's documented bridge. It adds no panel to Usage and replaces no built-in page.

## Try it from this repository

With Node 22+ (or Bun) and `magpie` on PATH, from a checkout of this repository:

```sh
magpie plugin add ./packages/codex-resets
node packages/codex-resets/sync.mjs          # one source check
node packages/codex-resets/sync.mjs --watch --bell
```

Open **Plugins → Codex reset news** in the sidebar. `--watch` stays in the foreground and checks at most every five minutes per sync process. `--bell` optionally rings the terminal bell for a new, unexpired, explicit global-reset announcement. Terminal bell behavior depends on your terminal. A forecast or credit grant never produces a reset alert. Use one sync process per Magpie installation.

Stop with **Ctrl-C**. No scheduler, launch agent or background service is installed. Turning off/removing the page in Magpie does not itself stop the separate command; stop that command too.

To select a Magpie binary or an installed plugin by exact name/path:

```sh
node packages/codex-resets/sync.mjs --magpie /path/to/magpie --plugin codex-resets --watch
```

After the package is listed, Magpie can install it with `magpie plugin add @magpie-community/page-codex-resets` (including its community dist fallback). The sync files are in that installed package. If it is also available on npm, its bin can be run with `npx --package @magpie-community/page-codex-resets magpie-codex-resets --watch --bell`. Availability on npm is separate from merging this package; the repository checkout commands above work during review.

## What it can and cannot do

- The three columns separate a global reset, a **community** forecast, and a credit grant. Missing probability is not 0%. Grants do not mean your current allowance was refilled.
- An announced time passing becomes **Awaiting confirmation**, not proof that a reset happened. The source is community tracking, not an OpenAI guarantee or evidence about an individual account.
- Missing, failed, malformed or stale source data shows **Current status is unavailable**. Data older than 15 minutes is not displayed as current. A scheduled announcement older than 48 hours is treated as unverifiable. An expired forecast is omitted.
- The page rereads saved options every 30 seconds while loaded. **Refresh page** rereads those options; it does not fetch the public service.
- Source addresses are selectable for copying into a browser. The host's page sandbox does not permit popups. The attribution link selects the website address instead of attempting a blocked navigation.
- The current page bridge has no network, desktop-notification or reset-card interception API. This version provides an in-page advisory and optional terminal bell; it cannot warn in Magpie's manual reset dialog or send desktop notifications.

## Data and permissions

Data from [Codex Resets](https://codex-resets.com), using its [public API](https://codex-resets.com/api/docs). Its documentation allows free, keyless use with attribution. The page retains the attribution and original X post addresses. No website code or X scraping is included.

The explicit helper makes a GET to **`https://codex-resets.com/api/v1/status`**, with an eight-second timeout, no credentials, no redirect following and a 64 KiB body limit. It honors `Retry-After` (five-minute floor, 24-hour cap). Only the validated public fields needed by the page are retained.

The helper invokes `magpie plugin options codex-resets` to read this plugin's options and to save its public snapshot, check deadline and up to 64 announcement IDs for deduplication. It preserves unrelated keys in those options and uses argument arrays, not a shell. It never reads Magpie's account, credential, quota or agent files. The page declares **no read permissions**, and never calls the host's private APIs, reaches out to a network or writes options.

## Testing

Like this repository's other tests, run in a temporary HOME so no real sign-in is touched:

```sh
HOME=$(mktemp -d) bun test packages/codex-resets packages/usage
bun scripts/check.mjs codex-resets
```

The normal suite checks public parsing, source URLs, expiry, probability boundaries, failure/cooldown behavior, notice deduplication, CLI parsing, page permissions, script policy and translations. It signs in to nothing and never contacts the public service.

`browser.test.mjs` is an optional integration test against a **separately running, isolated** `magpie web` and a development installation of Playwright. It is skipped by the normal unit suite. Set these before running `node --test packages/codex-resets/browser.test.mjs`:

- `MAGPIE_UI_TEST=1`.
- `HOME` and `MAGPIE_TEST_HOME` to the same dedicated directory containing `sandbox` in its name; also isolate `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` there. Install this local package into that Magpie first.
- Configure the sandbox's gateway on an unused port, then run its `magpie web --addr 127.0.0.1:<unused-web-port> --no-open`. Do not point the test at your everyday Magpie.
- `MAGPIE_TEST_URL` to that localhost web link, including its test key; `MAGPIE_TEST_BIN` to the tested binary.
- `PLAYWRIGHT_MODULE` to the development Playwright `index.mjs`, and `PLAYWRIGHT_BROWSERS_PATH` if browsers are stored outside the sandbox.
- Optionally `MAGPIE_TEST_ENGINES=chromium,webkit`; the default is Chromium. The tested Magpie web host emits scheme-less CSP sources which Playwright WebKit rejects before loading any plugin scripts. This host compatibility issue is not bypassed by the test.
- Optionally `MAGPIE_SCREENSHOTS` to a directory for the six Chromium screenshots.

The test temporarily changes only the sandbox's language/theme and this plugin's options, restoring both afterward. It uses fictional October 23, 2026 data, including a sample 75% forecast, and checks each selected engine at 1100, 760 and 420 pixels in both themes. The screenshots are illustrative, not live announcements.

中文：这是独立社区页面插件，需主动运行附带的本地同步命令。默认不联网、不启动后台服务、不读取账户。页面分别显示全局重置预告、社区概率与发卡信息；提醒仅限页面和可选终端响铃，不修改本体用卡弹窗。停止同步请退出命令（Ctrl-C）。
