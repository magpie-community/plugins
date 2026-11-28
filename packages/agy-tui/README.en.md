# agy-tui

Antigravity's models through agy's own interactive mode (its TUI). Each request starts the real `agy` in a terminal magpie gives it (`magpie tui-helper`), pastes the conversation into its prompt as a person would, and reads the answer from the transcript agy writes. The plugin calls none of Google's endpoints: agy does, as it does for anyone typing at its prompt.

**[中文 → README.md](README.md)**

## Use

1. Install the [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`).
2. Install this plugin from magpie's Plugins page, add **Antigravity (agy TUI)** under Providers and pick "Sign in with Google": magpie opens agy's sign-in link, and you paste back the code the page shows.
3. The models are the ones `agy models` lists.

Each account has a home of its own (`~/.local/state/magpie-agy-tui/accounts/<id>`), where agy keeps its sign-in as a file. Your own `~/.gemini`, skills and MCP servers are neither used nor changed.

## Limits (v0.1)

- Text only: the caller's tools are not offered to the model, and an image or a tool result is refused (400).
- Each request is a new agy conversation; the conversation before it is pasted with it as text.
- The answer comes whole when the turn ends (a streamed request gets keep-alives first, then the answer).
- It needs magpie v0.1.5027 or newer (with `tui-helper`). Not yet tried on Windows.

## Options (environment)

- `AGY_PATH`: where agy is.
- `AGY_TUI_TURN_TIMEOUT_MS`: the longest a turn may take, 15 minutes by default.
- `AGY_TUI_KEEP=1`: keep each turn's folder and agy's conversation, to look into a problem.
