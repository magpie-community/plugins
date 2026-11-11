# magpie-agent-qwen-mm-plugins

[![Tests](https://github.com/double2tea/magpie-qwen-mm/actions/workflows/test.yml/badge.svg)](https://github.com/double2tea/magpie-qwen-mm/actions/workflows/test.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

A community [Magpie](https://github.com/yetone/magpie) plugin for [Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins): choose **VL and Omni independently**, route ordinary search and speech through Magpie, and keep provider credentials in the gateway.

**中文：** 在 Magpie 中独立管理 VL／Omni，通过网关接入普通搜索、ASR 和 TTS。设置页支持独立保存、重启后继续保存和未保存选择恢复。原版 Qwen-MM-Plugins 在磁盘上保持不变，适配只作用于包装器进程。

This is an independent community plugin, not an official Magpie or Qwen release. Version: **0.3.5**.

## What it provides

| Capability | Integration |
| --- | --- |
| VL and Omni model selection | One Agent connection, two independent model controls |
| Gemini Native media | Audio file attachments; ordered video frames with timestamps and optional audio |
| Qwen Omni media | Existing upstream media representation |
| Web search and page extraction | Magpie Search, including returned citations |
| Speech recognition and synthesis | Magpie standard audio APIs or native Bailian relay |
| Reverse image search | Original Serper Lens backend and configuration |
| Local spatial tools | Original Qwen video-spatio implementation |

The settings page shows its version. A private persistent page credential survives Magpie host handoffs. Model selection never requires putting provider keys into the page.

## Install

Requirements: a current Magpie installation with Agent plugins, page-service proxying and native API relay; Node.js 22+ for development; Python/`uvx` and FFmpeg/ffprobe for Qwen tools. Tested on macOS. No model weights are bundled or downloaded by this plugin.

The repository can be installed through Magpie's GitHub plugin support:

```sh
magpie plugin add github:double2tea/magpie-qwen-mm
```

For a predictable local path for the Python/MCP entrypoints, use a local checkout:

```sh
git clone https://github.com/double2tea/magpie-qwen-mm.git "$HOME/.config/magpie/local-plugins/qwen-mm"
magpie plugin add "$HOME/.config/magpie/local-plugins/qwen-mm"
mkdir -p "$HOME/.qwen-mm-plugins"
magpie qwen-mm provider magpie
```

Use one installation method. If switching methods, remove the old registration through Magpie first so two copies do not compete for the same Agent ID.

Open **Magpie → magpie-agent-qwen-mm-plugins**, then select models from your own configured providers. Model IDs in examples are installation-specific: `google/gemini-3.8-flash`, `qwen-cn/qwen3.8-omni-flash` and `bailian-token-plan/...` work only if you created those provider IDs and have access to those models.

Installing the plugin does **not** automatically create providers, copy credentials, register MCP servers, change default models, or modify Skills. See [INSTALL.md](INSTALL.md) for MCP configuration and clean-install checks.

## MCP entrypoints

Run the wrapper from the actual checkout/install directory:

```sh
./qwen-mm video-spatio
./qwen-mm audio
./qwen-mm search
./qwen-mm api
./qwen-mm core
```

The launcher uses the pinned upstream tag `qwen-mm-plugins-video-spatio-v1.1.0` with the `api,search,video-spatio` extras. The first run resolves and installs those Python dependencies using `uvx`. It does not install model weights. Upstream server/package version strings can differ from this integration's version.

Add the desired entries through **Magpie Library → MCP** and enable them for the relevant Agents. The audio entry offers only `transcribe_audio` and `synthesize_speech`; the API entry includes the wider official tool set.

### Speech

- `transcribe_audio`: local audio/video, optional range selection, `text`/`srt`/`json` output.
- `synthesize_speech`: text, explicit voice and a **new absolute output file path**. Existing files are never overwritten.
- Pass `model: "provider/model"` to select a configured channel. Defaults are `bailian-token-plan/qwen-audio-3.0-asr-flash` and `bailian-token-plan/qwen-audio-3.0-tts-plus`.
- The Bailian Token Plan voice `longanhuan_v3.6` was tested. Other providers require their own supported voice identifiers.
- Supported output formats: WAV, MP3, PCM. ASR subtitle times retain upstream coarse chunk boundaries, not word-level timestamps.
- `enable_itn` is supported only for legacy Qwen3-ASR routes; unsupported parameter use returns an error.

Bailian models use Magpie's `/v1/magpie/native/{provider}/...` relay. Other compatible speech channels use `/v1/audio/transcriptions` and `/v1/audio/speech`. Native-relay requests can appear in gateway records, but exact billing and subscription deductions remain the provider's responsibility. Native relay does not provide the same model-budget guarantees as standard routed APIs.

### Search

While connected, ordinary web search and extraction use Magpie's selected search channel. A failed gateway request is reported; it does not silently fall back to direct provider billing. Reverse image search remains Serper Lens. When disconnected, original search behavior is restored.

## Configuration and lifecycle

| Location | Purpose |
| --- | --- |
| `~/.config/magpie/qwen-mm/config` | Agent gateway connection and independent VL/Omni choices |
| `~/.config/magpie/qwen-mm/page-token` | Local settings-page credential, mode 0600 |
| `~/.qwen-mm-plugins/config` | Original upstream configuration, including reverse-image-search credentials |

The settings service listens on **127.0.0.1:3496**. Magpie Web proxies it using the native plugin service mechanism. Each machine keeps its own configuration. The wrapper uses the default Magpie configuration path; custom configuration roots are not a verified end-to-end deployment mode.

```sh
magpie qwen-mm provider magpie  # connect
magpie qwen-mm default         # disconnect
```

Disconnecting removes the gateway connection and restores native model/API behavior while retaining model choices for reconnection. Original upstream credentials are not deleted. Unwrapped upstream tools, reverse image search and explicit per-call endpoint overrides may make direct provider requests.

The adapter replaces selected Python functions and refreshes the MCP registry **within its own process**. It does not edit the installed upstream files. Run the compatibility tests when changing the upstream version.

## Verified behavior and limits

Version 0.3.2 includes independently reviewed fixes for concurrent token publication, host ownership handoff, out-of-order model saves, first-install state, upstream optional dependencies, and invalid TTS responses.

Verified on two macOS installations:

- Independent model saves and page reuse after plugin service reload.
- Gemini Native image/audio/short audiovisual/silent-video input; Qwen Omni regression.
- Registered speech MCP synthesis → transcription with a valid WAV artifact.
- Registered web extraction and video-spatio startup.
- Local OpenAI-compatible speech forwarding with already cached MLX models.

**Known channel limitation:** `agy-cli/gemini-3.8-flash` recognized adapted video frames in the tested setup but did not receive audio. The adapter reports an explicit error for audio on this channel; the page warns and prevents newly saving it as Omni. Existing selections remain visible and are not automatically replaced. The inspected Anthropic bridge converts audio files to text placeholders, and agy ACP 1.5.3 advertises `audio: false`. See the [root-cause investigation](docs/agy-audio.md) for versioned evidence and the upstream changes needed. This is not a statement about Gemini's general audio capability.

Not exhaustively verified: long videos, dense motion, precise frame/word timing, every upstream tool, every provider, or other operating systems. Reverse image search dependencies and handler preservation are tested; uploading to Serper Lens is not part of the offline test suite.

## Development

```sh
npm test
PYTHONDONTWRITEBYTECODE=1 uvx --from \
  'qwen-mm-plugins[api,search,video-spatio] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@qwen-mm-plugins-video-spatio-v1.1.0' \
  python -m unittest -q test_qwen_mm_gateway test_qwen_mm_audio test_qwen_mm_search
```

The 10 Node and 23 Python tests use isolated configuration and generated fixtures; no real API keys or model downloads are needed. FFmpeg must be on PATH. Real provider tests are performed separately and may incur charges.

Bug reports should include plugin/Magpie versions, provider/model ID, input modality and a small synthetic reproduction. Remove credentials, full request media and private paths before sharing logs. See [SECURITY.md](SECURITY.md).

## Discovery and license

The GitHub repository uses the **`magpie-plugin`** topic and Magpie package metadata so it can be found by the [official plugin discovery mechanism](https://github.com/yetone/magpie/blob/main/docs/reference.md). Listing does not imply official review or endorsement; discovery refresh/indexing can take time.

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
