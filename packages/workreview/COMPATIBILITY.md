# Compatibility

## Platforms

| | `config.json` | followed |
|---|---|---|
| Windows (standard) | `%APPDATA%\work-review\config.json` | yes |
| macOS | `~/Library/Application Support/work-review/config.json` | yes |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/work-review/config.json` | yes |

Work Review is a Tauri app and uses Rust `dirs::data_dir()`, so the file moves
with the platform. An agent descriptor runs on moejs (no `process`, no `os`, no
`fs`) and cannot branch on the platform, so this package splits the job:

```text
magpie Agents row
  └─ connect() writes text_model.* into ~/.magpie-workreview/agent.json
        │  (magpie-owned; magpie backs up and restores these keys)
        ▼
  index.mjs (Bun host)
        resolves the real config.json, merges the four keys in, and keeps the
        user's own text_model to put back when the bridge is disconnected
```

The agent is detected only after the host has found Work Review's
`config.json` and created the bridge, so a machine without Work Review does not
show the row. Work Review installed after magpie started is picked up within 30
seconds; refresh the Agents page after that.

## Custom data dir

Work Review → Settings → Storage can move the data dir. That choice is saved as
`data_dir` in `data-location.json` under the config dir
(`%APPDATA%\work-review`, `~/Library/Application Support/work-review`, or
`~/.config/work-review`), and the host follows it.

## Portable mode and unusual layouts

On Windows, a `Data` folder next to `WorkReview.exe` turns on portable mode and
puts `config.json` there. The host cannot see another app's executable, so set
the folder explicitly before starting magpie:

```sh
WORK_REVIEW_HOME="D:\Apps\WorkReview\Data" magpie
```

`WORK_REVIEW_HOME` wins over `data-location.json` and the platform default.

## Behaviour and limits

- Work Review reads `config.json` only at startup; restart it after a model
  change.
- Saving AI settings in Work Review rewrites `text_model` from its own state,
  overwriting magpie's four keys. Choose the model in magpie again afterwards.
  The host does not fight the app over the file.
- Run `magpie workreview default` before removing the plugin, so the user's own
  `text_model` is restored while the host is still running.
- Work Review writes `workreview.db` next to `config.json`. Its MCP server's
  default is `work_review.db`, so `WORK_REVIEW_DB_PATH` must be set to the real
  file when the MCP server is configured. That is separate from this agent
  plugin.
