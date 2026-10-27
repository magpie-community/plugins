# @magpie-community/agent-type4me

[Type4Me](https://github.com/joewongjc/type4me), a macOS voice input app, as a
magpie agent. With this plugin Type4Me is on magpie's Agents page like the
agents magpie ships with: pick one of magpie's models for its LLM
post-processing in Type4Me's row.

```sh
magpie plugin add @magpie-community/agent-type4me
```

Until it is on npm, install it from GitHub:

```sh
magpie plugin add github:kchen0x/magpie-agent-type4me
```

Then pick one of magpie's models in Type4Me's row, or
`magpie type4me magpie/deepseek/deepseek-flash`. magpie writes into
`~/Library/Application Support/Type4Me/magpie-agent.json`:

```json
{
  "model": "deepseek/deepseek-flash",
  "baseURL": "http://127.0.0.1:3425/v1",
  "apiKey": "magpie-…"
}
```

In Type4Me, choose **Magpie (Local Gateway)** under Settings › Models and set
it as the default. Type4Me reads the file before each dictation, so a new model
takes effect on the next one, with no restart.

- Type4Me and Type4Me Dev share that folder: one plugin covers both.
- Picking a model in Type4Me's own settings changes it in magpie too (Type4Me
  runs `magpie type4me magpie/<model>`). Type4Me never changes `baseURL` or
  `apiKey`.
- Switching Type4Me off in magpie removes the three keys; Type4Me then talks to
  magpie directly, with the model picked in Type4Me.

Type4Me works with magpie without this plugin too, listing magpie's models
itself. The plugin adds Type4Me to magpie's Agents page, menu bar and profiles.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).

## Develop

The source lives at [kchen0x/magpie-agent-type4me](https://github.com/kchen0x/magpie-agent-type4me)
and is copied to `packages/type4me` in
[magpie-community/plugins](https://github.com/magpie-community/plugins).

```sh
bun test                                # what connect returns
magpie plugin add ./type4me.agent.js    # try it on your own magpie
```

`agent.config` must match `MagpieAgentFile.defaultURL` in Type4Me.
