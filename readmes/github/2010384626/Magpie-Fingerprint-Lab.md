<p align="center" style="text-align: center;">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" width="96" height="96" alt="Fingerprint Lab">
  </picture>
</p>

<h1 align="center" style="text-align: center;">Magpie Fingerprint Lab</h1>

<h3 align="center" style="text-align: center;">Model fingerprinting for magpie providers and routing groups</h3>

<p align="center" style="text-align: center;">
  Compare model fingerprints from three number samples, and see every route's results on one board.
</p>

<p align="center" style="text-align: center;"><a href="https://www.npmjs.com/package/magpie-fingerprint-lab"><img src="https://img.shields.io/badge/npm-v0.1.1-8c9eff?labelColor=1f2328" alt="npm"></a> <a href="https://usemagpie.ai"><img src="https://img.shields.io/badge/magpie-%E2%89%A50.1.1340-8c9eff?labelColor=1f2328" alt="magpie"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8c9eff?labelColor=1f2328" alt="license"></a></p>

<p align="center" style="text-align: center;"><a href="#quick-start"><b>Install</b></a> · <a href="#features">Preview</a> · <a href="#test-a-provider-or-a-routing-group">Start testing</a> · <a href="#reading-the-results">Reading results</a> · <a href="#privacy--usage">Privacy &amp; usage</a> · <b>English</b> · <a href="README_zh.md">简体中文</a></p>

<p align="center" style="text-align: center;">
  <img src="docs/images/detect.png" width="900" alt="Detect page: three samples are drawn in parallel and the number distribution takes shape live">
</p>

## Who it's for

Relays, aggregators and pools of API keys make models easy to get, and make it hard to say which model is really behind them. Fingerprint Lab is a [magpie](https://usemagpie.ai) page plugin built on the fingerprinting method of [lmfpd / lm-detector](https://github.com/Ikaleio/lm-detector). It checks whether the model a provider actually runs is the one it claims:

- **Test a provider or a routing group**: a routing group is tested member by member, so you can point to the route that is off.
- **See everything on one board**: the latest verdicts for every provider and model on a single grid.
- **History and trends**: every run is saved in full, so you can see when a model started to change.
- **Scheduled checks**: automatic checks at an interval, with random jitter, active hours and a daily cap.
- **Overrides**: pin a few settings for a provider or a family of models; they take precedence over presets.

Detection only exchanges numbers and never touches your conversations. If you only use official APIs and never go through a relay, you probably won't need it most of the time.

## Quick start

**1 · Install**

Pick one:

```sh
magpie plugin add magpie-fingerprint-lab                       # from npm
magpie plugin add github:2010384626/magpie-fingerprint-lab     # from the GitHub repository
magpie plugin add <plugin folder>                              # from a local folder (unpacked zip / tgz)
```

<sub>Requires magpie ≥ 0.1.1340. The page service listens on `127.0.0.1:3497` by default; if the port is taken, change the `port` plugin option.</sub>

**2 · Open** Open "Fingerprint Lab" from the plugins section of magpie's sidebar, or click "Fingerprint" in a provider's context menu to open it with that provider as the target.

**3 · Test** Pick a provider and a model, or a routing group, and click "Start". Each round sends three prompts, and the verdict appears as soon as the three replies are sampled.

## Features

### Test a provider or a routing group

A target can be a **provider** in magpie plus a model (when a provider has several keys, you can choose one), or a **routing group**: the plugin splits the group into its members and tests each one directly with the key the group assigns to it, giving each its own verdict. Add several targets to test them in one batch.

<table>
<tr>
<td width="50%"><img src="docs/images/group.png" alt="Testing a routing group: members are listed one by one and can be ticked for testing"></td>
<td width="50%"><img src="docs/images/result.png" alt="Result: claims gpt-6.2-sol, measured closer to gpt-6-luna"></td>
</tr>
</table>

The result shows the verdict, the measured top candidate, the confidence and the full candidate ranking. If a single sample fails or returns too few numbers, you can redraw it with a new prompt instead of rerunning the whole round. The provider list and its order follow magpie, and you can also set your own order in the plugin.

### Board

A provider × model grid where each cell shows the model's last 12 verdicts: line weight shows severity, color shows the latest verdict. You can tell at a glance which model is off, and whether it's a one-off or ongoing. Routing groups get one cell per member. Show only problems, or run a one-click "Checkup" of every model of a provider or routing group.

<img src="docs/images/board.png" width="900" alt="Board: claude-opus-5.5 and gpt-6.2-sol on 星河中转 have kept mismatching lately">

### History and trends

Every run saves its prompts, replies, scores, request URL and header names. Filter by time range, provider, model, routing group, verdict and origin, overlay two runs to compare them, or export JSON (saved to your system's Downloads folder by default; you can change it in Settings).

Pick one model (or one member of a routing group) and the trend view lays out each run's confidence and verdict over time, and counts problems by hour of day. Whether it has been stable all along, gets swapped now and then, or switched to another model from a certain day, it shows.

<img src="docs/images/history.png" width="900" alt="Trend: gpt-6.2-sol on OpenRouter matched in 45 of its last 48 runs and mismatched in 3">

### Scheduled checks

Set periodic checks for a provider, specific models or a routing group. The list shows each task's last verdict and its next run time; scheduled checks run while magpie is running.

| | |
| :-- | :-- |
| **Interval and jitter** | A fixed interval plus random jitter, so requests don't always go out at the same moment |
| **Active hours** | Run only within set hours, overnight allowed (e.g. 22:00–06:00) |
| **Daily cap** | Limit the number of batches per day to keep quota use in check |

<img src="docs/images/schedules.png" width="900" alt="Scheduled checks: editing a task's interval, jitter, active hours and daily cap">

### Overrides

A preset is a set of detection settings (API protocol, client mode, reasoning effort, rounds, timeout and so on). Three are built in: Quick, Strict and Coding clients. You can also create your own.

An override pins a few settings for a provider or some models, and takes precedence over the preset. For example, if a relay only exposes the Chat API, pin the API protocol for it; if you want more rounds for the Opus family, pin the round count for `claude-opus-*`. Model names support the `*` wildcard. The effective settings stack in this order, later ones winning:

```
preset → provider override → model override → settings changed by hand for this run
```

<img src="docs/images/overrides.png" width="900" alt="Overrides: pin some settings by provider or by model wildcard">

### Also

- **Client presets**: make requests carry the traits of Claude Code or Codex, to see whether a relay treats different clients differently.
- **Reference bank updates**: the reference bank and the detector SDK check for updates automatically (can be turned off); a new bank replaces the old one only after it passes verification.
- **Interface**: Chinese and English; light, dark or follow the system.

## Reading the results

| Verdict | Meaning |
| :-- | :-- |
| **Match** | The measured top candidate is the claimed model, all three samples are valid, and confidence reaches 75% |
| **Low confidence** | The top candidate matches the claim, but confidence is below 75% or fewer than three samples are valid |
| **Same model line, different revision** | Looks more like another snapshot or revision of the same model line |
| **Mismatch** | The top candidate is not in the claimed model's line |
| **Not in bank** | The claimed model isn't in the reference bank; only the closest candidates can be listed |
| **Failed** | The requests failed, the protocol isn't supported, or no sample could be scored |

With several rounds, the top candidate is the majority of each round's top candidate, and the confidence is the average across rounds.

A verdict is a relative ranking within the reference bank. Models outside the bank, fine-tuned or quantized models, and relays that add a system prompt or rewrite requests can all shift the ranking. When you see "Mismatch", test a few more rounds at different times and read it together with the trend.

## Configuration and data

| Item | Details |
| :-- | :-- |
| **Port** | Plugin option `port`, default `3497` |
| **Proxy** | Uses `HTTPS_PROXY` / `HTTP_PROXY` first; targets in `NO_PROXY` and loopback addresses connect directly. Without an environment proxy, Windows uses the system proxy. HTTP and HTTPS proxies are supported |
| **Timeout** | 120 seconds by default, counted from connecting to the first streamed byte (the full reply when not streaming); adjustable in presets or overrides |
| **Record retention** | Keeps the latest 2,000 runs by default; change it in "Settings › Runtime & storage" |

All data stays on your machine under `<magpie config dir>/fingerprint-lab/` (the magpie config dir is usually `~/.config/magpie`). Uninstalling the plugin doesn't delete it; remove it by hand when you no longer need it:

| Path | Contents |
| :-- | :-- |
| `state.json` | Settings, provider list (without keys), presets, overrides, schedules, client presets |
| `secrets.json` | Only the keys and sensitive headers of providers added by hand in this plugin |
| `runs/<id>.json` | The full record of each run |
| `runs-index.json` | Run summaries read by the board, the list and the trends |
| `bank/` | Reference bank |
| `sdk/` | A newer detector SDK, once downloaded (the bundled `vendor/lmfpd-sdk` is used otherwise) |
| `service.lock` | The service instance that currently owns the folder (process id, port, start time) |

Only one service instance writes to a data folder at a time; an instance started separately by the magpie CLI or `magpie web` hands over to the one already running.

## Privacy & usage

The service listens only on `127.0.0.1`, checks `Host` and `Origin`, and its API requires a key generated at random on each start. The interface only shows masked keys (such as `sk-…a1b2`). No API response, log, run record or export contains a key in plain text, and keys echoed back in upstream errors are scrubbed first. For providers in magpie, keys are not copied but read from magpie on every request; subscription and plugin providers send their requests through magpie's local gateway.

The plugin only contacts the API addresses of the providers you test (or magpie's local gateway), the reference bank hosts (`lm.ikale.io` / `cdn.jsdmirror.com`) and the npm registry (`registry.npmjs.org` / `registry.npmmirror.com`, for SDK updates, verified by sha512 after download). There is no telemetry; the last two can be turned off in Settings.

| | |
| :-- | :-- |
| **Per round** | 3 requests, each asking for about 300 numbers; reasoning models use more |
| **Batches and schedules** | Checkups and scheduled checks multiply usage, so set intervals and daily caps with care |
| **Client presets** | For requests through magpie's gateway, the gateway rewrites the headers, so presets have no effect on those targets. Check that a preset fits the provider's terms of use before using it |

## Local development

You can start the page service directly, without magpie (Node ≥ 22; using a proxy needs 22.21+ or 24.5+):

```sh
node serve.mjs [--port 3497] [--config <magpie config dir>] [--data <data dir>]
```

## Acknowledgements and license

Thanks to the [LINUX DO](https://linux.do) community for its support and feedback

[MIT](LICENSE)

The detection method, reference bank and SDK come from [lmfpd / lm-detector](https://github.com/Ikaleio/lm-detector) (`lmfpd-sdk`, MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components.
