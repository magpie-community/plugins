# magpie-agent-qwen-mm-plugins

A native Magpie Agent, independent VL/Omni settings page, and automatically registered media/search/speech tools for [Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins).

Version: **0.4.0**. Apache-2.0. Independent community wrapper; no vendor endorsement.

```sh
magpie plugin add github:double2tea/magpie-qwen-mm
```

[Install and requirements](INSTALL.md) · [Registration](REGISTRATION.md) · [Changes](CHANGELOG.md)

## Native tools

Magpie automatically registers the plugin's tools as a plugin-owned Library MCP entry. You do not add Python commands or three separate MCP servers. Tool loading and listing do not install upstream dependencies. First execution uses the pinned upstream uv environment.

- **Audio**: `qwen_transcribe_audio`, `qwen_synthesize_speech`, through the existing Magpie audio adapters. The known Bailian WAV placeholder-length repair preserves PCM samples.
- **Search**: `qwen_web_search`, `qwen_web_extractor` follow Magpie Search; `qwen_image_search` uses the original Serper Lens configuration.
- **Video-spatial**: nineteen upstream tools, including scene building, keyframes, camera motion, object counting, geometry and VLM-assisted judgments. Schemas and semantics remain pinned to the upstream version.
- **Tasks**: calls return `completed`, `running` or `failed`. Long work returns a ticket; use `qwen_task_status` or `qwen_task_cancel`. This respects Magpie's native 55-second call limit without truncating long upstream operations.

Existing upstream arguments are preserved; the result envelope adds actual task status. Task ownership follows Agent identity. Host restart discards in-memory tasks/results; see installation notes for runtime and retention limits.

## Model settings

Use the plugin page to select VL and Omni independently from configured Magpie models. Native upstream settings remain separate. The settings service listens on loopback port 3496 and uses a persistent local credential. Agy CLI may be used for visual tasks, but its audio/Omni route is rejected explicitly.

The wrapper normalizes its own media requests, not every Agent's ordinary chat attachments. The separate Magpie Media Adapter covers generic gateway normalization; upstream capability-catalog limitations still apply. Qwen-MM geometry tools are not general perceptual truth: instrument labels, moods, UCS categories and frame-level timing require review.

## Dependencies and lifecycle

Git, uv/uvx and FFmpeg/ffprobe must be on the Magpie process PATH. First use can download the pinned upstream runtime; no system package or model weights are installed by merely loading the plugin. Each call uses a subprocess, so cold-start and imports add latency. Provider keys are not copied into tool arguments or the repository. Calls remain billed by the configured vendor.

Magpie owns automatic Library registration, Agent distribution and removal. With the router enabled, tools follow its current Agent assignments. Otherwise enable desired Agents on the plugin entry. This package no longer exposes a manual MCP launcher or manual setup plan.

## Checks

```sh
npm test
node setup.mjs --check
```

Python regression and schema checks run in the pinned uv runtime; see CI. The fixed tool manifest is checked against the upstream registry. Local UI tests cover settings/save/lifecycle. Native-tool tests cover jobs, errors, cancellation and Agent isolation. Synthetic data and offline geometry avoid live model charges in CI.

Community discovery uses the `magpie-plugin` topic. Maintained-catalog review is pending at [magpie-community/plugins#1091](https://github.com/magpie-community/plugins/issues/1091); pending is not approval.
