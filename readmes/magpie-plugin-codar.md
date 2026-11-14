# magpie-plugin-codar

A [magpie](https://github.com/yetone/magpie) plugin for **Codar (科搭)**, the research desktop app by SpeedAI. It adds Codar's models to magpie as a provider, handles the daily check-in, and reports the account's points on the usage card.

## Features

- **Provider** — registers a `codar` provider with Codar's model list (15 models as the vendor lists them today: the `auto` router plus the DeepSeek, GLM, GPT and Claude families; the count is the vendor's, not a promise). The list is embedded in `lib/catalog.mjs` and refreshed from `GET /v1/codar/models` when signed in. Chat goes from magpie straight to Codar's gateway (`https://api.claw.speedai.com/v1`) — OpenAI-compatible for most models, Anthropic Messages for the Claude ones.
- **Sign-in** — three methods: “科搭令牌（留空读本机）” (one optional token field: leave it empty and the plugin reads the desktop app's own token file itself — read-only, never written — or paste a Codar access token and that is the one used; either way the token is checked for an account name and an unexpired exp before saving), “科搭OAuth登录” (one page the plugin serves on `127.0.0.1`, with the two ways in the vendor's own login dialog offers as tabs: 扫码登录, where the plugin draws the code the vendor issued and polls its own status endpoint every two to three seconds, and 手机号登录, where you enter the phone number, solve the vendor's own Aliyun captcha and type the SMS code; every vendor call is made by the plugin, and the page never sees the token), and signing in with the Codar account's own name and password (`POST /v1/login` on `api.kuaipaper.com`; the password is sent once and kept nowhere; it sits after the page because the vendor's IP check commonly hands it on there). A sign-in is kept with the token's own expiry when the token states one (a token that states none is kept as `expires: 0`, not invented one), and magpie renews it through `POST /v1/token/refresh` before it runs out; a token that has already expired cannot be renewed (the vendor refuses it with 401) and asks to sign in again. The vendor refuses to send an SMS code without a solved captcha (measured: `{"code":400,"message":"请完成人机验证"}`), which is why the SMS tab is a page rather than a prompt. When a password sign-in comes back `code 201` / `ip_verify_required` — the vendor's IP risk check — the plugin remembers the temp token it was handed for ten minutes at most — one handover finishes at most one check, and any other sign-in attempt clears it — and “科搭OAuth登录” then opens straight on that check instead of the tabs, finishing it through `POST /v1/user/verify_ip` (code type `ip_verify`), so the account is not asked for its password a second time.
- **Daily check-in** — `POST /v1/daily-sign`, once per rolling 24 hours. The answer reports the claim (including the points it added) or that the day was already claimed. It carries `until` (magpie ≥ 0.1.1795) whenever a wait is known — always on an already-claimed answer, and on a claim when the vendor states the next window — so magpie re-asks exactly when the next claim opens.
- **Usage** — points (general + agent), today's check-in state, and any free-model activity still running. The general points are also reported as a wallet reading (magpie #3950) so routing has a figure for the account; if the first balance endpoint fails, the card still shows what the second one answered.

## Install

```bash
magpie plugin add magpie-plugin-codar                  # from npm
# magpie plugin add github:MisonL/magpie-plugin-codar  # or from GitHub
# magpie plugin add "$PWD"                             # or from a checkout
magpie plugin login codar      # press Enter to read this machine's Codar login, or paste a token
```

If `magpie` is not on your `PATH`, use the app's own binary — for example
`/Applications/magpie.app/Contents/MacOS/magpie` on macOS — with the same
arguments. The plugin row also installs from magpie's Discover page (插件 →
发现), which is the same npm package.

Then select a `codar` model in magpie, and turn on its check-in under
Settings (设置) → 额度 (Quota) → 预热与签到 (warm-up & check-in) → 插件 (Plugins).

## Signing in

Codar keeps its JWT in its own config file:

- macOS / Linux: `~/.codar/config.json`
- Windows: `%USERPROFILE%\.codar\config.json`
- `$CODAR_HOME/config.json` when `CODAR_HOME` is set (the app honours it, and so does this plugin)

The value is `provider.speedai.token`. The “科搭令牌（留空读本机）” method reads it for you when its field is left empty — read-only, never written — and checks it has an account name and has not expired before saving it; a token pasted into that same field gets the same checks. To copy the value to your clipboard yourself instead:

```bash
# macOS / Linux — honours CODAR_HOME the way the app does. The config is read
# as utf-8-sig: a file Codar wrote on Windows carries a BOM, and plain UTF-8
# makes JSON refuse the whole file (the same reason the plugin strips one).
python3 -c 'import json,os,sys,subprocess;h=os.environ.get("CODAR_HOME") or os.path.expanduser("~/.codar");t=json.load(open(os.path.join(h,"config.json"), encoding="utf-8-sig"))["provider"]["speedai"]["token"];subprocess.run(["pbcopy"] if sys.platform=="darwin" else ["xclip","-selection","clipboard"],input=t,text=True)'
```

```powershell
# Windows - honours CODAR_HOME the way the app does
$p = if ($env:CODAR_HOME) { Join-Path $env:CODAR_HOME "config.json" } else { "$env:USERPROFILE\.codar\config.json" }
(Get-Content $p | ConvertFrom-Json).provider.speedai.token | Set-Clipboard
```

(The first command puts the token on the clipboard; `pbcopy` on macOS, `xclip` on Linux. Linux needs `xclip` installed and a display — on a headless box there is no clipboard to fill, so read the same value another way. If your `python3` lacks `subprocess.run` with `input`, pipe the `print(...)` output into your clipboard tool instead — the point is to avoid the token scrolling through your shell's history or visible output.)

The token carries the account name and an expiry (7 days after the app's last login). When it runs out the plugin says so instead of calling the API — open Codar once to refresh it there, then sign in again.

## Notes

- **An installed plugin is not a listed provider until it is signed in.** `magpie plugin list` (and Plugins → Installed) shows this plugin and its models as soon as it loads, and `magpie plugin list --json` shows the `codar` provider record it registers. `magpie providers` only lists providers that can actually serve a request, so `codar` appears there after a successful sign-in, not before. If a sign-in was removed from magpie earlier, the next successful sign-in brings the provider back on its own (magpie clears the “removed” mark on sign-in); there is nothing to edit by hand.
- **Prices stay as magpie sets them.** Codar lists prices in CNY and magpie's cost column is USD, so the plugin reports no price of its own rather than inventing an exchange rate. magpie still prices models by what models.dev says their makers charge, and a per-model price you set in magpie overrides everything. What each model does carry is the vendor's own credit multiple (`rate_badge`, e.g. `0.20x`), shown by magpie beside the model; a model the vendor does not badge carries none.
- **Reasoning levels are not mapped to variants.** The vendor's `reasoning.levels` describe request-body rewrites (`set`/`omit`) the desktop app applies itself; magpie's variants only name levels, so the models carry `reasoning: true` and no variants.
- **Free-model activities are reported, and the one-time campaign is claimed.** The card shows the activities still running; beside the check-in, the plugin also claims the vendor's one-time free-model campaign (`GET`/`POST /api/codar/activities/free-model[/claim]` on the gateway) when its status is `available`, and says so in the check-in line. It is best-effort: a campaign already claimed, none open, or a refused call changes nothing about the check-in. It rides on the check-in, so it only happens for an account whose check-in is switched on in magpie.
- **The vendor fields read here are measured shapes, not a published schema.** `user_quota_limit` (an activity's total), `remaining_quota` (a null means unlimited; an unreadable value hides the activity instead of being drawn as unlimited), `free_until`, `isSigned`/`signed`/`hasSigned` and `retry_after` (check-in and status) are the spellings the app's answers have carried. If the vendor renames one, the card drops that row or field rather than inventing a value.
- **Concurrency is a queue of 3 per account** (measured 2026-10-27: a fourth request at once answered 429 `concurrent_limit_exceeded`; the vendor publishes no figure). magpie queues past it, and the provider setting can raise the queue — but the vendor's own limit is per model, so raising it trades queueing for 429s and magpie's retries. If the catalog ever states `max_concurrency`, the plugin records the smallest figure it names and queues by it from the next start of magpie (the host reads the figure once, when it starts); `package.json` states the measured 3 as the figure a fresh start begins with.
- **The check-in is a text row, not a percentage** — a check-in is not an allowance that runs out. A wait it cannot use (missing, zero, past year 9999, or over a week) falls back to a 30-minute trust floor, so a rolling 24-hour window cannot lose the next claim.
- **Fallback list.** If `GET /v1/codar/models` cannot be reached, the plugin hands back the model table magpie gave it, marked as the fallback, so magpie keeps the list it had and says it fell back; the embedded `lib/catalog.mjs` is what the provider starts from, and its sizes may trail the live list — the live list wins whenever it can be fetched. A model's reply ceiling is the vendor's own (`max_tokens.maximum` → `limit.output`), so magpie lowers over-asking requests instead of letting the vendor refuse them.
- Models you add to this provider yourself survive list refreshes; the vendor's entries follow the vendor. A provider name or `api` you set in magpie survives restarts.
- The plugin follows the vendor client's own reading rules (field spellings, body codes, the “already claimed” wording in both Chinese and English), omits times it cannot write down rather than guessing, and never prints credentials — every vendor string is cut where it echoes the token (folded, split, spelled in fullwidth, base64 or hex) or a credential shape, and an oversized vendor answer is refused while it is read, counted over the decoded body (a gzip answer is read like any other: every transport used here hands back decoded bytes).
- **The card's requests go out through the desktop's own transport when it can.** The catalog, check-in, account and activity requests are made by a small Go proxy (`native/cmd/codar-proxy`) that rebuilds the Codar desktop sidecar's provider client from the 0.3.13 binaries: the sidecar's `http.DefaultTransport.Clone()` — TLS left to net/http — with its last-known-address `DialContext`, and its direct connection to the gateway with `HTTP(S)_PROXY` ignored — built with Go 1.24.3 where the macOS and Linux sidecars are, and with Go 1.26.7 over a go 1.24 module where the Windows one is, which reproduces that sidecar's own `DefaultGODEBUG` (`tlssecpmlkem=0` among them) — so the TLS ClientHello and HTTP headers are the sidecar's rather than Bun's. The plugin talks to the proxy over a private socket in the temp directory; the proxy forwards only the four hosts the desktop's own cloud-network controller accepts, and sends only the headers the plugin listed — `Authorization` and `Content-Type` for a card request, plus `X-Api-Key` and `Anthropic-Version` for a chat one — while Host, `User-Agent` (`Go-http-client/1.1`), `Accept-Encoding` and everything else are Go's, as on the sidecar's requests. The binaries are built per platform by `node scripts/build-native.mjs` and ship in the package (`native/bin`). Without a binary for the platform, or if it cannot start, those requests fall back to the plugin's ordinary fetch — the old fingerprint — and nothing pretends otherwise.
- **Chat goes through it too.** The loader answers a `fetch` (host.js runs `typeof o.fetch === "function" ? o.fetch : fetch`), so a conversation to the gateway leaves with the same transport instead of Bun's, and the answer is streamed back as it arrives — the proxy flushes every piece and bounds silence rather than total length, so a long answer is not cut at a deadline meant for short ones. A provider the user re-pointed elsewhere, a platform without a binary, or a proxy that did not start falls back to the ordinary fetch; chat never fails because the native path is missing. `chat.headers` still sets the Go client's `User-Agent` for the host's own outbound requests, which is a separate path from the loader's fetch.
- **A vendor-side account restriction is not a sign-in problem.** Chat can answer `403 {"detail":{"code":"account_restricted"}}` while the card is healthy: the card reads the account endpoints (points, check-in), which need no chat access. That refusal is the vendor restricting the account, so the plugin says `account_restricted` and points at Codar support instead of asking you to sign in again. A `429` with `Retry-After` is passed through with the wait the vendor named.

## Development

```bash
node --test                       # the whole suite, no network
bun test                          # the runtime magpie actually loads plugins on
node scripts/catalog.mjs --check  # is lib/catalog.mjs still what the vendor says?
node scripts/catalog.mjs          # regenerate it from the signed-in app
node scripts/build-native.mjs     # rebuild native/bin (this machine's OS; needs Go)
node scripts/build-native.mjs --all  # ...every platform, for a release
(cd native && go test ./...)      # the proxy's own tests
```

The proxy needs a Go toolchain to build (`scripts/build-native.mjs` fetches the 1.24.3 and 1.26.7 toolchains through `GOTOOLCHAIN`); the suite never starts a Go binary — `test/native.test.mjs` drives the client against a socket of its own, `native/cmd/codar-proxy/main_test.go` pins what the proxy sends and how it decides, and the tests that need a running proxy start a scripted stand-in through `CODAR_PROXY_BIN` instead (it speaks unix sockets only, and skips where that does not exist). On Windows the proxy itself listens on loopback TCP rather than a unix socket. The built binaries are not committed (`.gitignore` keeps `native/bin` out), so a checkout without a build simply uses fetch.

`lib/catalog.mjs` is generated with the plugin's own reader (`catalogOf`), so the fallback and the live list are built by the same rules. Its exit codes keep failures apart: `0` the run succeeded (`--check`: nothing moved), `1` a record moved (`--check` only), `2` the run could not finish — the vendor's answer was a refusal or its shape had moved (no list, a record with no context window), the local file could not be read or written, or an argument was not one it knows (only `--check` is). A failed run writes nothing and never empties the fallback. It needs a signed-in app, so it is a local command, not a CI step.

The suite also pins the formatting in `.editorconfig` (LF, one final newline, no trailing whitespace, two-space indent) — `test/style.test.mjs` walks the tree for `.mjs` and `.md` files (dot-directories such as `.git` are skipped; `.github` is scanned), so a new one of those is covered the moment it lands. `CONTRIBUTING.md` has the invariants the tests defend.

CI runs the suite on Node 20–24, on Bun across Linux / macOS / Windows, and on Node on Windows and macOS — the plugin reads a file under the home directory, and that is where per-platform differences show up. A separate job tests the Go proxy on Linux with Go 1.24.3 and then cross-builds all five targets, checking each finished binary's `DefaultGODEBUG` against the platform sidecar's; the proxy's behaviour is the same code on every platform, so it is tested once rather than five times. A separate job packs the npm tarball and runs the suite inside it on both runtimes (`node scripts/tarball.mjs --require-bun`), because `files` decides what ships and a test that references something outside it only fails for users; the Windows job runs the same gate, where its Windows-only branches are exercised.

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html); [CHANGELOG.md](CHANGELOG.md) records every release, and the release process is described in `CONTRIBUTING.md`.

## Licence

MIT.
