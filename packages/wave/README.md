# @magpie-community/agent-wave

[Wave Terminal](https://waveterm.dev) as a magpie agent. magpie has no setup of
its own for Wave; with this plugin it is on magpie's Agents page like the agents
magpie ships with.

```sh
magpie plugin add @magpie-community/agent-wave
```

Then pick one of magpie's models in Wave's row. magpie writes one mode,
`magpie`, into `~/.config/waveterm/waveai.json`:

```json
{
  "magpie": {
    "display:name": "Magpie",
    "ai:model": "v2ex/glm-5.3-flash",
    "ai:endpoint": "http://127.0.0.1:3425/v1/chat/completions",
    "ai:apitype": "openai-chat",
    "ai:apitoken": "magpie-wave",
    "ai:capabilities": ["tools"]
  }
}
```

Your other modes and settings stay. Picking a model of your own again, or
switching Wave off, takes the `magpie` mode out entirely and puts your
settings back as they were. Wave watches its config directory, so the mode
shows up in the dropdown right away — pick **Magpie** there to use it (or set
`"waveai:defaultmode": "magpie"` in `~/.config/waveterm/settings.json`).

Wave reads its AI modes from `~/.config/waveterm` by default; on another setup
it may use `$XDG_CONFIG_HOME/waveterm`, `$WAVETERM_CONFIG_HOME` or the legacy
`~/.waveterm/config`. This plugin targets the default `~/.config/waveterm`.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
