# @magpie-community/agent-agy

[Antigravity CLI](https://antigravity.google) (`agy`) as a magpie agent.

```sh
magpie plugin add @magpie-community/agent-agy
```

Pick one of magpie's models in the Antigravity CLI row. magpie writes into
`~/.gemini/antigravity-cli/settings.json`:

```json
{
  "model": "magpie/deepseek/pro",
  "modelProvider": "gemini",
  "customModelsConfig": {
    "customModels": {
      "magpie/deepseek/pro": { "apiProvider": "API_PROVIDER_GOOGLE_GEMINI", "modelName": "deepseek/pro" }
    }
  }
}
```

Your own custom models stay beside magpie's. agy takes the address and key
of a Gemini endpoint only from how it is started, so magpie adds a function
`agy` to your shells' profiles: it runs `magpie agy run`, which starts the
agy on your PATH with `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL` and
`--model` while its model is one of magpie's, and as it is otherwise.
`magpie agy env` prints what it starts agy with.

Picking agy's own model again, or switching it off, puts every key back as
it was and takes the function out. agy in a WSL distro is set up the same
way, from Windows.

This plugin takes the place of the Antigravity CLI magpie shipped with: what
that one set up is handed over as it is.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
