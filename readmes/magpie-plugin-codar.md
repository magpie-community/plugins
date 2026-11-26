# magpie-plugin-codar

A [magpie](https://github.com/yetone/magpie) plugin for **Codar (科搭)**, the research desktop app by SpeedAI. It adds Codar's models to magpie as a provider, handles the daily check-in, and reports the account's points on the usage card.

## Features

- **Provider** — registers a `codar` provider with Codar's model list (20 models as the vendor lists them today: the `auto` router plus the DeepSeek, GLM, Gemini, GPT and Claude families; the count is the vendor's, not a promise). The list is embedded in `lib/catalog.mjs` and refreshed from `GET /v1/codar/models` when signed in. Chat goes from magpie straight to Codar's gateway (`https://api.claw.speedai.com/v1`) — OpenAI-compatible for most models, Anthropic Messages for the Claude ones.
- **Sign-in** — three methods: “科搭令牌（留空读本机）” (one optional token field: leave it empty and the plugin reads the desktop app's own token file itself — read-only, never written — or paste a Codar access token and that is the one used; either way the token is checked for an account name and an unexpired exp before saving), “科搭OAuth登录” (one page the plugin serves on `127.0.0.1`, with the two ways in the vendor's own login dialog offers as tabs: 扫码登录, where the plugin draws the code the vendor issued and polls its own status endpoint every two to three seconds, and 手机号登录, where you enter the phone number, solve the vendor's own Aliyun captcha and type the SMS code; every vendor call is made by the plugin, and the page never sees the token), and signing in with the Codar account's own name and password (`POST /v1/login` on `api.kuaipaper.com`; the password is sent once and kept nowhere; it sits after the page because the vendor's IP check commonly hands it on there). A sign-in is kept with the token's own expiry when the token states one (a token that states none is kept as `expires: 0`, not invented one), and magpie renews it through `POST /v1/token/refresh` at magpie's own lead (five minutes) before it runs out; a token that has already expired cannot be renewed (the vendor refuses it with 401) and asks to sign in again. The vendor refuses to send an SMS code without a solved captcha (measured: `{"code":400,"message":"请完成人机验证"}`), which is why the SMS tab is a page rather than a prompt. When a password sign-in comes back `code 201` / `ip_verify_required` — the vendor's IP risk check — the plugin remembers the temp token it was handed for ten minutes at most — one handover finishes at most one check, and any other sign-in attempt clears it — and “科搭OAuth登录” then opens straight on that check instead of the tabs, finishing it through `POST /v1/user/verify_ip` (code type `ip_verify`), so the account is not asked for its password a second time.
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

### Where the password goes

The account's name and password are sent in one request, `POST /v1/login {username, password}` on `api.kuaipaper.com` — the same endpoint the vendor's own client signs in through — and nowhere else. The password is not written to disk, to magpie's saved account, to the plugin's memory after that call, or to a log line: what comes back from it is the token, and the token is what is kept. If the vendor stops that sign-in with its IP check (`code 201`), the plugin keeps the temp token the refusal carried for at most ten minutes so the SMS method can finish the check without asking for the password again; that temp token, like the account's own, is held in memory only. A message about a failed sign-in is scrubbed of both the account and the password before it is shown.

## Notes

- **An installed plugin is not a listed provider until it is signed in.** `magpie plugin list` (and Plugins → Installed) shows this plugin and its models as soon as it loads, and `magpie plugin list --json` shows the `codar` provider record it registers. `magpie providers` only lists providers that can actually serve a request, so `codar` appears there after a successful sign-in, not before. If a sign-in was removed from magpie earlier, the next successful sign-in brings the provider back on its own (magpie clears the “removed” mark on sign-in); there is nothing to edit by hand.
- **Prices stay as magpie sets them.** Codar lists prices in CNY and magpie's cost column is USD, so the plugin reports no price of its own rather than inventing an exchange rate. magpie still prices models by what models.dev says their makers charge, and a per-model price you set in magpie overrides everything. What each model does carry is the vendor's own credit multiple (`rate_badge`, e.g. `0.20x`), shown by magpie beside the model; a model the vendor does not badge carries none.
- **Reasoning levels are not mapped to variants.** The vendor's `reasoning.levels` describe request-body rewrites (`set`/`omit`) the desktop app applies itself; magpie's variants only name levels, so the models carry `reasoning: true` and no variants.
- **Free-model activities are reported, and the one-time campaign is claimed.** The card shows the activities still running; beside the check-in, the plugin also claims the vendor's one-time free-model campaign (`GET`/`POST /api/codar/activities/free-model[/claim]` on the gateway) when its status is `available`, and says so in the check-in line. It is best-effort: a campaign already claimed, none open, or a refused call changes nothing about the check-in. It rides on the check-in, so it only happens for an account whose check-in is switched on in magpie.
- **The vendor fields read here are measured shapes, not a published schema.** `user_quota_limit` (an activity's total), `remaining_quota` (a null means unlimited; an unreadable value hides the activity instead of being drawn as unlimited), `free_until`, `isSigned`/`signed`/`hasSigned` and `retry_after` (check-in and status) are the spellings the app's answers have carried. If the vendor renames one, the card drops that row or field rather than inventing a value.
- **The plugin declares no concurrency limit.** magpie reads the number a plugin states (the auth hook's `maxConcurrency`, else `package.json`'s) as a queue; nothing stated is no limit at all (`internal/provider/concurrency.go`: 0 takes no slot and never waits). The vendor's own `concurrent_limit_exceeded` was met once (measured 2026-10-27: a fourth request at once answered 429), and that reading cannot tell whether the vendor counts per model or per account; an account-wide number risks throttling idle models beside the busy one. Most of the other community plugins in magpie's registry state none either (measured 2026-11-21 against the installed set: devin, qoder, trae and workbuddy declare nothing; zcode declares 3). The vendor's 429 then reaches magpie as the vendor's own refusal, and a person who knows their account can set a queue in the provider settings. The catalog's `max_concurrency` is not read for one, for the same reason.
- **The check-in is a text row, not a percentage** — a check-in is not an allowance that runs out. A wait it cannot use (missing, zero, past year 9999, or over a week) is left off the answer rather than guessed, so magpie asks again at its own 30-minute retry instead of waiting out a wrong window — a rolling 24-hour window cannot lose the next claim either way.
- **Fallback list.** If `GET /v1/codar/models` cannot be reached, the plugin hands back the model table magpie gave it, marked as the fallback, so magpie keeps the list it had and says it fell back; the embedded `lib/catalog.mjs` is what the provider starts from, and its sizes may trail the live list — the live list wins whenever it can be fetched. A model's reply ceiling is the vendor's own (`max_tokens.maximum` → `limit.output`), so magpie lowers over-asking requests instead of letting the vendor refuse them.
- Models you add to this provider yourself survive list refreshes; the vendor's entries follow the vendor. A provider name or `api` you set in magpie survives restarts.
- The plugin follows the vendor client's own reading rules (field spellings, body codes, the “already claimed” wording in both Chinese and English), omits times it cannot write down rather than guessing, and never prints credentials — every vendor string is cut where it echoes the token (folded, split, spelled in fullwidth, base64 or hex) or a credential shape, and an oversized vendor answer is refused while it is read, counted over the decoded body (a gzip answer is read like any other: every transport used here hands back decoded bytes).
- **The card's requests go out through the desktop's own transport when it can.** The catalog, check-in, account and activity requests are made by a small Go proxy (`native/cmd/codar-proxy`) that rebuilds the Codar desktop sidecar's provider client from the 0.3.13 binaries: the sidecar's `http.DefaultTransport.Clone()` — TLS left to net/http — with its last-known-address `DialContext`, and its direct connection to the gateway with `HTTP(S)_PROXY` ignored — built with Go 1.24.3 where the macOS and Linux sidecars are, and with Go 1.26.7 over a go 1.24 module where the Windows one is, which reproduces that sidecar's own `DefaultGODEBUG` (`tlssecpmlkem=0` among them) — so the TLS ClientHello and HTTP headers are the sidecar's rather than Bun's. The plugin talks to the proxy over a private socket in the temp directory; the proxy forwards only the four hosts the desktop's own cloud-network controller accepts, and sends only the headers the plugin listed — `Authorization` and `Content-Type` for a card request, plus `X-Api-Key` and `Anthropic-Version` for a chat one — while Host (the vendor's name alone — the sidecar builds every URL from a bare `https://<host>` base, so no `:443` ever appears), `User-Agent`, `Accept-Encoding` and everything else are Go's, as on the sidecar's requests. The User-Agent is Go's automatic one and follows the ALPN choice the server makes (`Go-http-client/1.1` where the server selects http/1.1, as `api.claw.speedai.com` does today; `Go-http-client/2.0` where it selects h2, as `api.kuaipaper.com` does), which is also what the sidecar's own client would send. The binaries are built per platform by `node scripts/build-native.mjs` and ship as per-platform packages (see [The native proxy binaries](#the-native-proxy-binaries)). Without a binary for the platform, or if it cannot start, those requests fall back to the plugin's ordinary fetch — the old fingerprint — and nothing pretends otherwise. How the shipped binaries are made, and what a review of them can check, is in [The native proxy binaries](#the-native-proxy-binaries) below.
- **Chat goes through it too.** The loader answers a `fetch` (host.js runs `typeof o.fetch === "function" ? o.fetch : fetch`), so a conversation to the gateway leaves with the same transport instead of Bun's, and the answer is streamed back as it arrives — the proxy flushes every piece and bounds silence rather than total length, so a long answer is not cut at a deadline meant for short ones. A provider the user re-pointed elsewhere, a platform without a binary, or a proxy that did not start falls back to the ordinary fetch; chat never fails because the native path is missing. `chat.headers` still sets the Go client's `User-Agent` for the host's own outbound requests, which is a separate path from the loader's fetch.
- **A vendor-side account restriction is not a sign-in problem.** Chat can answer `403 {"detail":{"code":"account_restricted"}}` while the card is healthy: the card reads the account endpoints (points, check-in), which need no chat access. That refusal is the vendor restricting the account, so the plugin says `account_restricted` and points at Codar support instead of asking you to sign in again. A `429` with `Retry-After` is passed through with the wait the vendor named.
- **A login credential the vendor restricts to its own client is not a sign-in problem either.** Some accounts are refused at the chat gateway with `403 {"detail":{"code":"client_not_supported","message":"This login credential is restricted to Codar. Use an API key for other clients."}}` — the vendor is telling third-party clients to use an API key rather than the desktop login token. Signing in again does not change it, and this plugin does not pass itself off as the vendor's client to get through it: every request is the plugin's own — none carries the desktop's `codar-web-v1` content type, and no conversation gets the Codar runtime system prompt injected into it. What the plugin does mirror is the transport the desktop uses for these same endpoints (the TLS client, headers and Host described above), which is what makes its login-token requests ordinary; it does not claim to be a Codar runtime in the conversation itself. The vendor documents no client API key for third-party clients today (its docs cover third-party keys going *into* Codar, the other direction); if Codar support issues one for your account, say so in an issue and a way to use it can be added. Otherwise the fix is on the vendor's side. The balance reads and the check-in line name this refusal and stop at it, instead of asking for a sign-in that cannot help.

## Development

```bash
node --test                       # the whole suite (installs packages from a
                                  # registry served on 127.0.0.1; no vendor calls;
                                  # one preflight reads registry.npmjs.org for
                                  # what is already published — CODAR_OFFLINE=1
                                  # skips it)
bun test                          # the runtime magpie actually loads plugins on
node scripts/catalog.mjs --check  # is lib/catalog.mjs still what the vendor says?
node scripts/catalog.mjs          # regenerate it from the signed-in app
node scripts/build-native.mjs     # rebuild native/bin (this machine's OS; needs Go)
node scripts/build-native.mjs --all  # ...every platform, for a release
node scripts/native-packages.mjs  # stage the platform packages (native/packages)
(cd native && go test ./...)      # the proxy's own tests
```

The proxy needs a Go toolchain to build (`scripts/build-native.mjs` fetches the 1.24.3 and 1.26.7 toolchains through `GOTOOLCHAIN`), but nothing in the suite invokes that toolchain: it runs a real built proxy in two places — one test kills the host of the checkout's own build, and the install check below starts the proxy a package manager installed from the platform packages — and everywhere else `test/native.test.mjs` drives the client against a socket of its own, `native/cmd/codar-proxy/main_test.go` pins what the proxy sends and how it decides, and the tests that need a running proxy start a scripted stand-in through `CODAR_PROXY_BIN` instead (it speaks unix sockets only, and skips where that does not exist). On Windows the proxy itself listens on loopback TCP rather than a unix socket. The built binaries are not committed (`.gitignore` keeps `native/bin` out), so a checkout without a build simply uses fetch.

Two environment variables exist for troubleshooting the native transport:
`CODAR_PLUGIN_DISABLE_NATIVE=1` turns the proxy off (every request takes the
plain fetch, and the tests that need a proxy skip), and `CODAR_PROXY_RETRY_MS`
sets the pause before a failed proxy start is tried again (default 30 000).
`CODAR_PROXY_BIN` names a different executable — the tests use it for their
scripted stand-in.

`lib/catalog.mjs` is generated with the plugin's own reader (`catalogOf`), so the fallback and the live list are built by the same rules. Its exit codes keep failures apart: `0` the run succeeded (`--check`: nothing moved), `1` a record moved (`--check` only), `2` the run could not finish — the vendor's answer was a refusal or its shape had moved (no list, a record with no context window), the local file could not be read or written, or an argument was not one it knows (only `--check` is). A failed run writes nothing and never empties the fallback. It needs a signed-in app, so it is a local command, not a CI step.

The suite also pins the formatting in `.editorconfig` (LF, one final newline, no trailing whitespace, two-space indent) — `test/style.test.mjs` walks the tree for `.mjs`, `.md`, `.json`, `.yml` and `.yaml` files (dot-directories such as `.git` are skipped; `.github` is scanned), so a new one of those is covered the moment it lands. `CONTRIBUTING.md` has the invariants the tests defend.

CI runs the suite on Node 20–24, on Bun across Linux / macOS / Windows, and on Node on Windows and macOS — the plugin reads a file under the home directory, and that is where per-platform differences show up. A separate job tests the Go proxy on Linux with Go 1.24.3 and then cross-builds all five targets, checking each finished binary's `DefaultGODEBUG` against the platform sidecar's; the proxy's behaviour is the same code on every platform, so it is tested once rather than five times. A separate job packs the npm tarball and runs the suite inside it on both runtimes (`node scripts/tarball.mjs --require-bun`), because `files` decides what ships and a test that references something outside it only fails for users; it also installs the packed main package against the platform packages staged from the same builds with both bun and npm, and requires each install to land that machine's package and the plugin to start it — on Linux, so linux-x64 is the package that install path is proven for. The Windows job runs the same gate without `--require-bun` or `--require-builds`, where its Windows-only branches are exercised, but it has no builds to stage, so the gate says the install check was skipped there rather than checked: the Windows install path is not checked by CI. It is checked by hand (0.3.0 installs `win32-x64` under bun and npm on Windows 10 x64 and the proxy starts); the test itself leaves Windows out because npm's `.cmd` shims broke it there ("Child returned status 128").

### The native proxy binaries

Each platform's build ships in its own npm package, and the main package names
all five in `optionalDependencies`:

| package | os | cpu |
| --- | --- | --- |
| `magpie-plugin-codar-darwin-arm64` | `darwin` | `arm64` |
| `magpie-plugin-codar-darwin-x64` | `darwin` | `x64` |
| `magpie-plugin-codar-linux-arm64` | `linux` | `arm64` |
| `magpie-plugin-codar-linux-x64` | `linux` | `x64` |
| `magpie-plugin-codar-win32-x64` | `win32` | `x64` |

The proxy lives in a private (0700) directory under the temp root, made for it
by the plugin and holding its socket and ready file. The plugin removes that
directory when the proxy exits, and so does the proxy itself on its way out —
so a plugin process killed outright, whose own cleanup never runs, still
leaves nothing behind once the proxy it started sees its stdin close. When
both die without a handler, the next start sweeps such a directory away, and
only on proof: the ready file records the proxy's pid, and a shell is dropped
only when that process is gone. A directory the sweep cannot judge (an older
build's ready with no pid, no ready at all) is left standing rather than
guessed at.

A package manager installs the one whose `os`/`cpu` match the machine and skips
the other four, so an install is one 5.8–6.6 MB build (2.4–2.8 MB of tarball,
plus the main package's 0.4 MB) instead of all five: 32.0 MB unpacked became
about 7 MB on disk and a 13.3 MB download became about 3 MB. The `cpu` field is
npm's spelling — `x64`, never Go's `amd64`, which npm refuses outright with
`EBADPLATFORM` — while the binary inside keeps the Go-flavoured file name
(`codar-proxy-darwin-amd64`), which is the name the plugin looks for.

The plugin finds the build by resolving the platform package it was given
(`lib/native.mjs`, `binaryPath`), not by computing a path from `process.arch`:
what landed was the package manager's decision, and on Apple Silicon an x64
runtime under Rosetta reports `x64` and needs the x64 build. A working tree
without those packages falls back to `native/bin`, and an install with no
platform package at all (an `npm install --omit=optional`, say) falls back to
the plugin's ordinary fetch — the old fingerprint, see [Notes](#notes).

Nothing runs at install time: there is no postinstall script. That is deliberate
— Bun blocks postinstall scripts of packages it does not trust (measured on Bun
1.4.4), so a package that placed its build in an install script would silently
have no proxy on the runtime magpie actually uses.

Where the builds come from:

- **Built locally, not in a release workflow.** `npm run native:all` (the first release step in `CONTRIBUTING.md`) builds every target on the machine running the release, with `CGO_ENABLED=0`, `GOOS`/`GOARCH` per target, and `GOTOOLCHAIN=go1.24.3` (darwin, linux) or `GOTOOLCHAIN=go1.26.7` (win32) — the exact toolchains the Codar 0.3.13 desktop sidecars use — with `-trimpath` and `-buildvcs=false`. `npm version` does not run it, and `prepublishOnly` does not build; it only refuses to publish when a build is missing, is not what its header and machine say it is, or predates the proxy's own source (`build-native.mjs --check --strict`).
- **The binaries in the published platform packages are not byte-reproducible from the tag.** `native/bin` is not committed, so a fresh checkout of `vX.Y.Z` has no binaries, and a rebuild from the same tag gives a different file and checksum than the one that shipped. What a tag *does* fix is the source and the inputs: `native/go.mod`, `native/cmd/codar-proxy/`, and the toolchain, `GOOS`/`GOARCH`, `GOEXPERIMENT` and flags in `scripts/build-native.mjs`. The binaries that ship are the ones built from that source on the releasing machine. Since 0.2.4 each one carries no VCS stamp (`-buildvcs=false`) and no build path (`-trimpath`), so `go version -m` reports the module as `(devel)` rather than naming a commit — a stamp read from the checkout the build ran in named the wrong commit on the 0.2.0–0.2.3 builds.
- **What can be checked, and what CI checks.** Anyone can rebuild with `go run`/`npm run native:all` and run `go vet ./... && go test ./...` in `native/`, where the proxy's tests pin what it sends and how it decides (the forwarded hosts and headers, the proxy decision, the last-address dialer). Every release also ships the source in the package, so the code the binary was built from is readable side by side. CI's `native` job builds all five targets from the same source with the same toolchains and refuses a binary whose `DefaultGODEBUG` differs from its platform sidecar's; it uploads the result only for the `tarball` job to test — the binaries in CI are not the ones published, and the publish gate checks names and shapes, not bytes. The gate also installs the packed main package into a scratch project through a registry served from a local directory, and requires that install to land exactly this machine's platform package and that the plugin starts it: a bare unpack cannot show that, and the release that shipped five builds in one package shipped for two minor versions because nothing checked the install path.

What the proxy does, briefly: it listens on a private socket in the temp directory (loopback TCP on Windows) and forwards only the four vendor hosts the desktop's cloud-network controller accepts, with only the headers the plugin lists. It holds no credential of its own — the token is passed in per request — and it writes one file, the ready file in its own temp directory that tells the plugin where it is listening, its own pid (so a later start can tell a dead shell from a wedged live one), on Linux its PID namespace (so a sweep running in another namespace cannot read its live proxy as gone), and on Windows the per-run header token that proves a request came from the plugin (mode 0600); it writes nothing else.

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html); [CHANGELOG.md](CHANGELOG.md) records every release, and the release process is described in `CONTRIBUTING.md`.

## Licence

MIT.
