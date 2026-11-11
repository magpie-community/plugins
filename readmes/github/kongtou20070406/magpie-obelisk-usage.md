# magpie-obelisk-usage

<p align="center"><img src="assets/hero.png" alt="Obelisk usage — a magpie page showing how often your coding agents call obelisk" width="860"></p>

A [magpie](https://usemagpie.ai) sidebar page that shows how often your coding agents call [obelisk](https://github.com/tommy0103/obelisk) — only call volume, in magpie's native look.

- **Heatmap** of calls per day, switching to hourly bars when you pick "today"
- **By agent**: which agent (Claude Code, Codex, …) made the calls
- **`--query` vs `--attune`** share
- **Recent calls** list

Everything is computed locally from obelisk's own database. The page has no network access and asks magpie for no permissions.

## Install

```bash
magpie plugin add github:kongtou20070406/magpie-obelisk-usage
```

Then open **Obelisk usage** in magpie's sidebar. The first numbers appear within ~30 seconds of the plugin starting.

Update with `magpie plugin update`, remove with `magpie plugin rm`.

## What is obelisk?

[**obelisk**](https://github.com/tommy0103/obelisk) by [@tommy0103](https://github.com/tommy0103) indexes the session history of your local coding agents — Claude Code, Codex, Kiro and more — into a single SQLite database: *queryable by your agent, browsable by you*. Your agent runs `obelisk --query <script>` to search what you did before and `obelisk --attune <script>` to keep conclusions as memories, so work done in one session is not lost in the next. It has a desktop app for browsing too.

```bash
npm install --global @obelisk-apps/cli && obelisk install
```

If you use coding agents every day, it is worth a star and a try. This plugin is an unofficial companion and is not affiliated with obelisk.

## Requirements

- obelisk has run at least once, so `~/.obelisk/obelisk.sqlite` exists.
- magpie (its plugin host runs on Bun). The standalone CLI below also runs on Node 22.13+.

## How it works

| Piece | What it does |
|---|---|
| Host hook | Every 30 s runs the CLI, which reads the database **read-only** and writes `page/live.js` |
| Page | Reloads `live.js` every 5 s and draws the charts |

A "call" is a row in obelisk's `tool_calls` whose input contains `obelisk … --query` or `--attune`; its time comes from `messages`, its agent from `sessions.source`. Rows without a timestamp count toward totals but are not placed on the charts.

### Standalone CLI

```bash
node bin/obelisk-usage.mjs [--db PATH] [--out PATH]
```

Prints a one-line summary (total, query, attune, undated) and writes the data file.

## Develop

```bash
npm test
```

## License

MIT
