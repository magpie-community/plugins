# Magpie Observatory

**A live monitoring cockpit for [Magpie](https://github.com/yetone/magpie).**
Two-way magpies carry requests to providers and answers back; quotas, usage,
sessions and a 53-week rhythm sit around them.

[简体中文](README.zh-CN.md) · **English**

![Magpie Observatory](docs/preview-dark.png)

## What it is

Magpie already knows which provider, account and model every request uses.
Observatory turns that stream into something you can *watch*:

- **Live routing** — Agent → Magpie → Provider/Account, with a filled magpie
  carrying the request out and a mirrored outlined magpie bringing the answer
  back. Failed attempts stay visible as “rerouted”.
- **Five views** — `Route`, `Radar`, `Loom`, `Rhythm`, `Rings`.
- **Four style packs** — `Control`, `Pixel`, `Paper`, `Neon`; each with a light
  and dark variant. Light/dark and style are independent.
- **Layout settings** — Auto / One screen / Comfort, density Compact / Standard /
  Spacious, motion Full / Soft / Off.
- **Quotas** — the shortest window per account in a 3-column ring-card grid
  (2 columns below 1400 px, 1 on phones), with reset countdowns and balances.
- **Usage** — 24h/7d/30d Token + cost, model donut, a 53-week heatmap that
  compresses on narrow screens, and a searchable request ledger.
- **Sessions** — active requests, subagents, TPS and reroute counts; recent
  completed requests stay in the rail.
- **Responsive** — one screen at desktop sizes, a single column with a compact
  rail on phones; the same data, no separate mobile build.

## The mark

<img src="docs/icon.png" width="88" alt="Magpie Observatory icon">

A magpie in orbit: the white bird is the request/response pair, the dashed ring
is the observatory, and the cyan eye is the live gateway.

## Install as a Magpie plugin

Requires a recent Magpie build with **plugin pages** and **page services**
(`magpie.page.service`). Then:

```bash
magpie plugin add github:JohnWangggg/magpie-observatory
```

Or in Magpie: **Plugins → Add plugin**, paste the GitHub URL or search for
**Magpie Observatory**. Enable it under **Plugins → Installed**; an
**Observatory** tab appears in the sidebar's Plugins group.

The plugin starts a local read-only service on `127.0.0.1:3488` (configurable in
the plugin's options). The Magpie page is a launcher; the dashboard is served by
that service so it can read all of Magpie's live APIs without relaxing the
page's `connect-src 'none'` sandbox.

### Install from a local checkout

```bash
git clone https://github.com/JohnWangggg/magpie-observatory.git
magpie plugin add ./magpie-observatory
```

### Discovery

Magpie's Discover finds this plugin through the GitHub topic
**`magpie-plugin`** and the committed `magpie.page.file`
(`page/index.html`). The listing text comes from `magpie.name` and
`magpie.summary.en` / `.zh`; search keywords live in `package.json`. See
[`docs/publishing.md`](docs/publishing.md) for the exact topic list and release
commands.

## Preview without Magpie

Node.js 18+:

```bash
node preview.mjs
# → http://127.0.0.1:8777
```

The dashboard starts in demo mode. Click **演示数据 / 实时连接** to try the local
Magpie gateway (`http://127.0.0.1:3425`). Override it with:

```bash
MAGPIE_URL=http://127.0.0.1:3425 MAGPIE_KEY=... node preview.mjs
```

The preview is for development only; the plugin uses the same service internally.

## The five views

| Route · two-way magpies | Radar · provider ring and quotas |
| --- | --- |
| ![route](docs/preview-dark.png) | ![radar](docs/mode-radar.png) |

| Loom · requests woven into bands | Rhythm · provider lanes and beats |
| --- | --- |
| ![loom](docs/mode-loom.png) | ![rhythm](docs/mode-rhythm.png) |

![Rings · half a year as a polar calendar](docs/mode-rings.png)

- **Route**: the default. Magpies fly the whole `Agent → Magpie → Provider`
  path; failures remain visible.
- **Radar**: providers on a dial, quota rings, in-flight sessions on the left,
  quota and cache on the right.
- **Loom**: the last requests become coloured bands — colour is provider,
  brightness is token density, the shuttle moves down the weave.
- **Rhythm**: each provider gets a lane; requests land on a 16-step grid, a
  playhead sweeps through, and the footer keeps the combo / cache.
- **Rings**: the last 26 weeks as a polar calendar — seven weekday rings, one
  column per week; bead size and colour carry token volume, and today keeps a
  green ring.

## Styles and themes

| Control | Pixel |
| --- | --- |
| ![control](docs/preview-dark.png) | ![pixel](docs/style-pixel.png) |

| Paper | Neon |
| --- | --- |
| ![paper](docs/style-paper.png) | ![neon](docs/style-neon.png) |

- **Control**: glass cards, iris/cyan accents, balanced density.
- **Pixel**: hard 2 px borders, 4 px hard shadows, monospace, scanlines, Game Boy
  green. Light variant is a daylight Game Boy.
- **Paper**: cream, serif, brown ink, paper grain; a report-like dark variant.
- **Neon**: black, magenta/cyan glow, radar-friendly; a daylight variant.

Use the **明暗** button for light/dark and the **风格** button for a pack. Both
choices persist separately.

The same Control pack in light mode:

![Control light](docs/preview-light.png)

| Style menu | Layout & motion |
| --- | --- |
| ![style menu](docs/style-menu.png) | ![layout settings](docs/settings-menu.png) |

## Layout and motion

The **设置** button opens:

| Setting | Options |
| --- | --- |
| Layout | `Auto` · `One screen` · `Comfort` |
| Density | `Compact` · `Standard` · `Spacious` |
| Motion | `Full` · `Soft` · `Off` |

One-screen mode forces the whole dashboard into the viewport at ≥1200×900, with
lists scrolling inside their cards. Smaller windows fall back to scrolling and
say so. Comfort always uses natural heights. Motion off leaves the magpies at
the midpoint of their paths and stops radar sweep, loom shuttle and rhythm
playhead.

## On a phone

Below 680 px the rail becomes icon-only, the quota cards stack, the request
ledger drops secondary columns and the hero views reflow vertically. The
dashboard is still the same document; there is no separate mobile app.

![Mobile layout](docs/preview-mobile.png)

## Data sources

The local service proxies only documented read APIs:

| Magpie endpoint | Used for |
| --- | --- |
| `GET /v1/magpie/trace?after=0` | routes, attempts, rules, sessions |
| `GET /v1/magpie/quotas?kept=1` | account windows and balances |
| `GET /v1/magpie/usage?period=…` | USD estimate, series, models |
| `GET /v1/magpie/concurrency` | in-flight and queued requests |
| `GET /v1/magpie/usage/requests?period=…` | request ledger |
| `GET /api/usage/heatmap?period=all` | heatmap (GUI / `magpie web` only) |

When the GUI heatmap route is absent (a headless/tray gateway answers 404), the
service builds the same day cells from `/v1/magpie/usage?period=all` and caches
them for five minutes. No prompt or response body is read.

No prompts, replies, credentials or model-call keys are stored. The service
listens on loopback; the plugin page reaches it through its own origin.

### Privacy

- **Screenshots use demo data.** Every account shown in this README is
  synthetic (`demo-…@example.com`); no provider account, key or personal email
  is published.
- **Read-only by design.** The service only issues `GET` requests to the six
  documented endpoints above. It never writes to Magpie or to provider APIs.
- **No prompt storage.** Requests, responses, model-call keys and gateway keys
  pass through Magpie; Observatory keeps only the counters and metadata it
  renders.
- **Loopback only.** The service binds `127.0.0.1`, and the plugin page is
  served from that same origin.

## Project layout

```text
index.mjs              plugin entry; starts the local service
server.mjs             read-only Magpie proxy + static server
preview.mjs            standalone preview (node preview.mjs)
page/index.html        Magpie plugin launcher page
page/boot.js           reads magpie.service / port and navigates the frame
page/icon.svg          plugin icon
public/                the dashboard (index.html, assets/)
docs/research.md       research & design notes (简体中文)
docs/research.en.md    research & design notes (English)
docs/publishing.md     GitHub release + Magpie store topics
docs/visual-forms.md   visual-form research (中文)
docs/visual-forms.en.md visual-form research (English)
scripts/               publish helper
```

## Development

```bash
npm run check          # node --check on entry, server and browser scripts
node preview.mjs        # demo + optional live gateway
```

The dashboard is plain HTML/CSS/JS — no build step, no runtime dependencies.
The plugin host runs it on Bun; the preview runs on Node 18+.

## Links

- Magpie: https://github.com/yetone/magpie
- Plugin docs: https://github.com/yetone/magpie/blob/main/docs/subsystems/plugin-runtime.md
- Research notes: [`docs/research.md`](docs/research.md) (中文) ·
  [`docs/research.en.md`](docs/research.en.md) (English)
- Visual forms research: [`docs/visual-forms.md`](docs/visual-forms.md) (中文) ·
  [`docs/visual-forms.en.md`](docs/visual-forms.en.md) (English)
- Publishing & store topics: [`docs/publishing.md`](docs/publishing.md)
- Issues: https://github.com/JohnWangggg/magpie-observatory/issues

## License

MIT © 2026 JohnWangggg. Icons are bundled from Magpie and LobeHub Icons (MIT);
see [`public/assets/icons/LICENSE`](public/assets/icons/LICENSE).
