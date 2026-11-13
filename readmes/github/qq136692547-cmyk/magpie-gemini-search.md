# magpie-gemini-search

Google Search Grounding hook plugin for [Magpie](https://github.com/magpie-ai/magpie).

## Features

- Uses Gemini models with built-in Google Search grounding via AI Studio API
- Multi-key failover (comma, semicolon, or whitespace separated)
- Aggregates grounding chunks and supporting text into deduplicated citations
- Optional redirect resolution (1.2s timeout)
- Full abort signal passthrough

## Install

```sh
magpie plugin add qq136692547-cmyk/magpie-gemini-search
```

## Configure

Set your Google AI Studio API key in Magpie settings. Multiple keys can be separated by commas, semicolons, or whitespace for automatic failover.

## Options

| Option | Default | Description |
|---|---|---|
| `model` | `gemini-3.8-flash` | Gemini model to use for grounding |
| `includeSummary` | `true` | Include summary text when no grounding chunks are found |
| `resolveRedirects` | `false` | Resolve `grounding-api-redirect` URLs via HEAD request |

## Test

```sh
npm test
```

## License

MIT
