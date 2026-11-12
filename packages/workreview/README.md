# Work Review

[Work Review](https://github.com/wm94i/Work-Review) as a magpie agent: its daily reports, work assistant, hourly summaries and semantic categorization run on magpie's models and routing groups.

```sh
magpie plugin add @magpie-community/agent-workreview
```

Then pick a model in **Agents → Work Review**, or:

```sh
magpie models workreview
magpie workreview group/cheap-first
```

Restart Work Review: it reads its settings when it starts. **Settings → AI models** then shows the custom provider at `http://127.0.0.1:3425/v1`, and requests are attributed to `workreview` in magpie's usage and routing.

## What it writes

Work Review keeps `config.json` in a different folder on each platform, and an agent descriptor runs in a sandbox with no filesystem or platform APIs. So magpie writes a small bridge file, `~/.magpie-workreview/agent.json`, and the package's host part (`index.mjs`, Bun) resolves the real `config.json` and keeps it in step:

| Platform | `config.json` |
|---|---|
| Windows | `%APPDATA%\work-review\config.json` |
| macOS | `~/Library/Application Support/work-review/config.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/work-review/config.json` |

Only four keys of `text_model` are written; everything else, including your saved model profiles, stays as it was:

| Key | Value |
|---|---|
| `text_model.provider` | `custom` (Work Review's OpenAI-compatible provider) |
| `text_model.endpoint` | `<gateway>/v1` — Work Review appends `/chat/completions` |
| `text_model.api_key` | magpie's gateway key for `workreview` |
| `text_model.model` | magpie's model id, e.g. `group/cheap-first` |

`magpie workreview default` disconnects and puts your own `text_model` back (the host restores it).

## Notes

- The agent appears once Work Review is installed (the host creates the bridge only when `config.json` exists). If you install Work Review after magpie is already running, give the host up to 30 seconds, then refresh the Agents page.
- Restart Work Review after choosing a model. Saving AI settings inside Work Review overwrites magpie's four keys — choose the model in magpie again afterwards.
- A routing group is an ordinary model id here: `group/<id>` (`magpie groups` lists them).
- A data dir moved in Work Review's settings is followed through its `data-location.json`. For portable mode or another layout, set `WORK_REVIEW_HOME` to the folder holding `config.json` before starting magpie. See [COMPATIBILITY.md](./COMPATIBILITY.md).
- Work Review's own MCP server (`work-review-mcp-server`) is separate from this agent plugin and is not configured by it.
