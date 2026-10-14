# @magpie-community/agent-kilo

[Kilo Code](https://kilo.ai) as a magpie agent. magpie has no setup of its own
for Kilo Code; with this plugin it is on magpie's Agents page like the agents
magpie ships with.

```sh
magpie plugin add @magpie-community/agent-kilo
```

Then pick one of magpie's models in Kilo Code's row. Kilo Code is a fork of
OpenCode, so it reaches any OpenAI-compatible endpoint through a provider in
`~/.config/kilo/kilo.jsonc`, which magpie writes:

```jsonc
{
  "provider": {
    "magpie": {
      "name": "magpie",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3425/v1",
        "apiKey": "magpie-kilo"
      },
      "models": {
        "deepseek/deepseek-flash": {
          "name": "DeepSeek Flash",
          "tool_call": true,
          "limit": { "context": 1000000, "output": 393216 },
          "variants": {
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "max" }
          }
        }
      }
    }
  },
  "model": "magpie/deepseek/deepseek-flash"
}
```

Kilo names a model `<provider>/<model>`, so magpie's own id is written after the
`magpie/` prefix. The provider, its address, its key and every model are written
because Kilo has no catalog of its own for a gateway: its model picker reads the
models listed under the provider. Your comments and other settings stay.
Requests use the Chat Completions API. Reasoning variants follow each model's
own levels, weakest first; models without levels have an empty variants set.
Image-capable models also declare image inputs and attachment support. Unknown
context windows are omitted from the configuration.
Picking Kilo's own model again, or switching it off, puts every key back as it
was. Restart Kilo after a change: it reads its settings when it starts.

The Library also reaches it: instructions go in `~/.config/kilo/AGENTS.md`, MCP
servers in `kilo.jsonc`'s `mcp` key, skills in `~/.config/kilo/skills`.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).
