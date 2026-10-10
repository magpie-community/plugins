# @magpie-community/agent-aider

[Aider](https://aider.chat) as a magpie agent. magpie has no setup of its own
for Aider; with this plugin it is on magpie's Agents page like the agents
magpie ships with.

```sh
magpie plugin add @magpie-community/agent-aider
```

Then pick one of magpie's models in Aider's row. magpie writes into
`~/.aider.conf.yml`:

```yaml
model: openai/deepseek/deepseek-flash   # magpie's model, through litellm's openai/ prefix
openai-api-base: http://127.0.0.1:3425/v1
openai-api-key: magpie-aider            # Aider's own key, so Usage names it
show-model-warnings: false
```

Your comments and other settings stay. Picking Aider's own model again, or
switching it off, puts every key back as it was. Restart Aider after a change:
it reads its settings when it starts.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
