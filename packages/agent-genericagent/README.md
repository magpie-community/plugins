# Magpie Agent: GenericAgent

Integrates GenericAgent with Magpie for unified model configuration management.

## Installation

```bash
magpie plugin add /path/to/magpie-plugin-genericagent
# or from npm
# magpie plugin add @magpie-community/agent-genericagent
```

## How It Works

1. Select GenericAgent in Magpie's Agent settings
2. Choose a model and configure the API gateway
3. Magpie writes the configuration to `~/.genericagent.json`
4. GenericAgent's `mykey/__init__.py` reads from `mykey.json` (which mirrors `~/.genericagent.json`)
5. The selected model becomes GenericAgent's primary model

## Configuration

The plugin writes a JSON object to `~/.genericagent.json` compatible with GenericAgent's model format:

```json
{
  "name": "Model Display Name",
  "apikey": "sk-...",
  "apibase": "https://api.example.com/v1",
  "api_mode": "chat_completions",
  "model": "model-id",
  "max_tokens": 131072,
  "temperature": 1.0,
  "max_retries": 3,
  "connect_timeout": 10,
  "read_timeout": 180,
  "context_win": 1000000
}
```

## Troubleshooting

- **Config not appearing**: Ensure `~/.genericagent.json` exists and is readable by GenericAgent
- **Changes not taking effect**: Restart GenericAgent after changing the model in Magpie
- **JSON errors**: Check that the config file is valid JSON

## See Also

- [GenericAgent](https://github.com/HamsteRider-m/GenericAgent)
- [Magpie](https://magpie.sh)
