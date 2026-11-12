# Magpie Media Adapter

[简体中文](README.zh-CN.md) · [Install](INSTALL.md) · [Changelog](CHANGELOG.md)

A standalone gateway middleware for [Magpie](https://github.com/yetone/magpie) that normalizes audio and video attachments for the selected model. Keep using your existing model or routing group. No MCP tool, additional server, provider key or runtime dependency is required.

**Version:** 0.2.1 · **License:** Apache-2.0

## What it does

- Converts inline Chat video files into `video_url` before routing.
- Encodes audio independently for every provider attempt, using the actual candidate model name rather than a personal provider ID.
- Recognizes Qwen Omni, Gemini, MiMo and GPT Audio format profiles. Unknown audio models retain their original format.
- Preserves supplied bytes, explicit output modalities, reasoning settings, images, PDFs and tool declarations.
- Rejects known unsupported audio-document paths explicitly instead of allowing a text-only request to silently replace the media.

This adapter changes representations. It does not add media capabilities to a model, rank answers, fix provider quotas or repair Magpie's model catalog.

## Install

```sh
magpie plugin add github:double2tea/magpie-media-adapter
```

Or clone into a stable local directory:

```sh
git clone https://github.com/double2tea/magpie-media-adapter.git "$HOME/.config/magpie/local-plugins/media-adapter"
magpie plugin add "$HOME/.config/magpie/local-plugins/media-adapter"
```

Choose one installation method. Keep using your usual model or group after installation. There is no new model selector or MCP entry.

Magpie must support native middleware with `onRequest`, `onProvider`, `ctx.protocol`, `ctx.model` and actual candidate metadata in `ctx.provider`. Live checks were performed on macOS arm64 with Magpie 0.1.3820 and 0.1.3830. An earlier minimum version and other operating systems have not been verified. See [INSTALL.md](INSTALL.md) for updates and removal.

## Default behavior

| Request | Behavior |
| --- | --- |
| Chat inline audio → Qwen Omni / MiMo | `input_audio` with a Base64 data URI |
| Chat inline audio → Gemini | `file` attachment |
| Chat inline audio → GPT Audio | `input_audio` with bare Base64 bytes |
| Chat video `file` | `video_url`, preserving MIME information |
| Unknown audio model | Original format retained |
| Native Gemini protocol | Unchanged |
| Responses / Anthropic audio documents | Explicit 400; current gateway conversion is unreliable |
| Responses / Anthropic video documents | Left to the gateway's existing support |

Non-streaming audio is accepted for recognized direct models such as Gemini and MiMo. Qwen Omni, groups with unknown candidates and unidentified aliases require streaming by default. Existing audio in retained history or tool results is included in this check. You can explicitly allow a route you have tested.

Remote audio is accepted only for a requested direct profile that supports file URLs. Other targets and groups require inline audio. The synchronous middleware does not download media and cannot reject an individual candidate after routing. Remote video remains a URL.

Existing `video_url` sampling hints are retained. An explicitly configured conversion to generic `file` rejects requests with `fps` or `detail`, because those options cannot be preserved in that representation.

## Optional configuration

Most supported model names need no options. Private aliases and unusual relays can use a provider override. The provider ID is the one configured in your Magpie instance.

```json
{
  "providers": {
    "my-audio-relay": { "audio": "base64", "streamingRequired": false },
    "my-native-relay": { "audio": "file" }
  }
}
```

Set this as the plugin's `options` in Magpie, or use:

```sh
magpie plugin options github:double2tea/magpie-media-adapter '{"providers":{"my-native-relay":{"audio":"file"}}}'
```

Use the exact installed plugin spec from `magpie plugin list` for local-path installations.

| Option | Default | Values |
| --- | --- | --- |
| `models` | All requested models/groups | Exact IDs, `["*"]` for all, `[]` to disable request processing |
| `nonStreamingAudio` | `auto` | `auto`, `reject`, `pass` |
| `providers[id].audio` | Inferred from candidate name | `data-uri`, `base64`, `file`, `preserve` |
| `providers[id].video` | `video_url` | `video_url`, `file`, `preserve` |
| `providers[id].streamingRequired` | Inferred where known | Boolean |
| `providers[id].textOnly` | Enabled for Qwen audio when unspecified by caller | Boolean |
| `providers[id].disabled` | `false` | Skip that candidate's encoding |

`disabled` does not undo normalization already performed before routing. `nonStreamingAudio: "pass"` permits an explicitly tested route; it cannot repair upstream media loss.

## Verified scope and limits

- 35 regression tests cover non-throwing `ctx.reject`, candidate-independent byte preservation, renamed providers, arbitrary group names, MIME aliases/conflicts, URLs, history, tool results, scope selection and unchanged reasoning settings.
- Live checks covered direct and grouped requests on two Macs. One MiMo response omitted the full transcript, and a targeted follow-up transcribed correctly but extracted the wrong numeric code. Media delivery does not guarantee semantic accuracy.
- GPT Audio, arbitrary relays and remote-file behavior have structural test coverage; they were not all exercised against paid live services.
- A 5.76 MB request exercised the native rejection path. This does not certify all attachment sizes or long histories.
- Magpie has a 250 ms hook budget and fails open on hook errors/timeouts. Known input errors are rejected in `onRequest`; the plugin cannot replace that runtime policy.
- The upstream video-catalog issue [#6210](https://github.com/yetone/magpie/issues/6210) may still filter out a capable model before a provider attempt. This middleware does not alter capability metadata or routing priorities.

## Development

Node.js 22 or newer is recommended for tests; production code runs inside Magpie's JavaScript engine.

```sh
npm run check
npm test
npm pack --ignore-scripts
```

No dependency installation or real API credentials are needed for the tests. The package is marked private to prevent accidental npm-registry publication; GitHub installation and release archives remain supported.

## Security and attribution

The middleware runs inside the gateway and receives request bodies. It does not log prompts, write files, access credentials or make network requests. Magpie still sends media to the provider you selected, under that provider's billing and data policies.

See [SECURITY.md](SECURITY.md) for safe reporting. This is an independent community plugin; Magpie and model names identify compatibility and do not imply endorsement.

See [Client and workload checks](COMPATIBILITY.md) for actual client capture results, stress-test boundaries and the unchanged-body fast path.
