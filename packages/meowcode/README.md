# @magpie-community/agent-meowcode

[MeowCode](https://github.com/MuLiuSaMa/MeowCode) as a magpie agent.

Pick one of magpie's models in the MeowCode row. magpie writes a file of its
own, `%APPDATA%\MeowCode\agent\magpie.json`, and leaves your `settings.json`
alone:

```json
{
  "magpieKey": "magpie-meowcode",
  "providerId": "magpie/deepseek/pro",
  "providers": [
    {
      "id": "magpie/deepseek/pro",
      "name": "Magpie",
      "baseUrl": "http://127.0.0.1:3425/v1",
      "model": "deepseek/pro",
      "protocol": "openai-chat-completions",
      "authStyle": "none",
      "extraHeaders": { "Authorization": "Bearer magpie-meowcode" },
      "enabled": true
    }
  ]
}
```

MeowCode 1.3 and later reads that file as an overlay when it starts: every
magpie model shows up in MeowCode's own model list as the Magpie provider,
beside the providers you set up yourself, and the model picked in the row is
the one MeowCode starts on. Your own providers, keys and settings are left as
they are — MeowCode never writes the overlay, and writing settings from
MeowCode never writes magpie's models into `settings.json`.

MeowCode reads the overlay at start-up only: **restart MeowCode** after
connecting, after switching MeowCode's model in the row, or after switching
magpie off. The Magpie group in MeowCode's settings is read-only, since its
models come from magpie; their enabled state and reasoning effort are kept in
MeowCode across restarts.

MeowCode keeps only loopback gateway addresses (`127.0.0.1`, `localhost`,
`[::1]`) from the overlay. If magpie writes another address — a gateway shared
on the LAN, say — those records are left out and no magpie models appear.

Switching magpie off clears the keys it wrote; MeowCode ignores the empty file
and, after a restart, is back on your own providers. Disconnect MeowCode
before uninstalling magpie.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
