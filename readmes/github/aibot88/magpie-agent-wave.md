# magpie-agent-wave

[Wave Terminal](https://www.waveterm.dev) as a [magpie](https://usemagpie.ai) agent. magpie has no setup of its own for Wave; with this plugin Wave is on magpie's Agents page like the agents magpie ships with.

```
magpie plugin add magpie-agent-wave   # from npm
magpie plugin add ./agent-wave        # or this folder, loaded where it is
```

Then pick one of magpie's models in Wave's row. magpie writes a `magpie` mode into `~/.config/waveterm/waveai.json`:

```json
{
  "magpie": {
    "display:name": "Magpie · Kimi K3",
    "display:order": 1,
    "display:icon": "crow",
    "ai:model": "<magpie's model, e.g. tokenservice/kimi-k3>",
    "ai:endpoint": "http://127.0.0.1:3425/v1/chat/completions",
    "ai:apitype": "openai-chat",
    "ai:apitoken": "<Wave's own key, so Usage names it>",
    "ai:capabilities": ["tools"]
  }
}
```

Everything stays on localhost: Wave talks to magpie's gateway directly, no cloud in between. Your other modes and the rest of the file stay untouched; picking Wave's own mode again, or switching the row off, removes exactly what magpie wrote.

After connecting, select the **Magpie** mode once in Wave AI's mode dropdown, or make it the default:

```
wsh setconfig waveai:defaultmode=magpie
```

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
