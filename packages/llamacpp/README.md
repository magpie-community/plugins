# Local llama.cpp for Magpie

A [Magpie](https://usemagpie.ai) provider plugin that runs local [llama.cpp](https://github.com/ggml-org/llama.cpp) GGUF models. It starts and stops `llama-server` on demand, discovers models by scanning a folder you configure, and exposes each model through the protocol that fits its type — chat, decisions, embeddings or text completions.

No cloud service, no API key, no telemetry. Everything stays on `127.0.0.1`.

## Features

- **Your folder, your call.** There is no implicit model directory. You set `modelsDir` explicitly; until then the plugin exposes no models and its tools tell you what to set.
- **Recursive discovery.** Scans `modelsDir` up to `scanDepth` subdirectory levels (default 3) for `*.gguf`. A model's id is its path relative to `modelsDir` without the extension (`chat/llama.gguf` → `llamacpp/chat/llama`), so identically named files in different subfolders never collide.
- **Four model types, one provider.** Each model is classified automatically from GGUF metadata (or overridden by you) and wired to the right API:
  - `chat` → `/v1/chat/completions`
  - `decision` → `/v1/systemone`, Magpie's native decision API (marked `decides: true`, hidden from the regular model list)
  - `embedding` → `/v1/embeddings`
  - `completion` → `/v1/completions`
- **On-demand server.** No daemon, no autostart. The first request starts `llama-server`; switching models stops the old one and starts the new one (one instance at a time).
- **Management tools.** `llamacpp_status`, `llamacpp_models`, `llamacpp_start`, `llamacpp_stop`, `llamacpp_restart`, `llamacpp_logs` — usable from any agent.

## Requirements

- [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` on your machine. The binary is **not bundled**. Install it from your package manager (e.g. `pacman -S llama-cpp`), build it yourself, or point the `server` option at any `llama-server` executable. It must expose the OpenAI-compatible `/v1` endpoints; decision models also need `/v1/systemone` (present in recent llama.cpp builds).
- Node.js >= 20 (Magpie's plugin host already provides one).
- One or more `.gguf` files in a folder you own.

> **Backend note (OpenVINO):** some distro builds of llama.cpp with the OpenVINO GPU backend fail during generation with a `tensor size is not equal to model` compute error. If that happens, either use another backend (Vulkan/SYCL/CPU) or build llama.cpp from source against your GPU. This is a llama.cpp/OpenVINO issue, not a plugin issue.

## Install

```bash
magpie plugin add @magpie-community/opencode-llamacpp-auth
magpie plugin login llamacpp      # any string; the local server does not check keys
```

## Configure

There is no default model folder — set one before use:

```bash
magpie plugin options @magpie-community/opencode-llamacpp-auth '{"modelsDir":"/absolute/path/to/your/ggufs"}'
```

`~/` is expanded. To inspect the current options, run the command with no JSON argument.

| Option | Default | Meaning |
|---|---|---|
| `modelsDir` | **none (required)** | Folder to scan for `.gguf`. No models are exposed until it is set. |
| `scanDepth` | `3` | How deep to recurse into subdirectories (`0` = top level only). |
| `port` | `18081` | Local port for `llama-server`. |
| `ctx` | `32768` | Context size (`-c`). |
| `ngl` | `99` | Layers offloaded to GPU (`-ngl`). |
| `backend` | `GPU` | `GPU` or `CPU`; sets `GGML_OPENVINO_DEVICE`. |
| `autoStart` | `true` | Start the server on the first request. When `false`, use the `llamacpp_start` tool. |
| `server` | `null` | Path to `llama-server`; `null` uses PATH or `/usr/bin/llama-server`. |
| `extraArgs` | `""` | Extra `llama-server` arguments (space separated). |
| `noWebui` | `true` | Pass `--no-webui`. |
| `detect` | `true` | Guess each model's type from GGUF metadata. |
| `types` | `{}` | `{ "model-id": "chat"|"decision"|"embedding"|"completion" }`, overrides detection. |

Reload after changing options:

```bash
magpie plugin off @magpie-community/opencode-llamacpp-auth
magpie plugin on  @magpie-community/opencode-llamacpp-auth
```

Drop a GGUF into the folder and reload — it appears as `llamacpp/<relative-path>`.

### Model types

With `detect: true`, the plugin reads `general.architecture` and decision metadata from the GGUF header: a `*.decision.type` key means `decision`; a BERT/embedding architecture means `embedding`; everything else is `chat`. Override any entry with `types`:

```bash
magpie plugin options @magpie-community/opencode-llamacpp-auth \
  '{"types":{"chat/mistral":"chat","classifiers/router":"decision","embedders/e5":"embedding"}}'
```

Decision models carry `decides: true` and are used by Magpie's router over `/v1/systemone`. A minimal request:

```bash
curl -s -X POST http://127.0.0.1:18081/v1/systemone -H 'content-type: application/json' \
  -d '{"state":{"input":"hello"},"questions":{"q":{"type":"choice","instructions":"Is this a greeting?","criteria":{"yes":"greeting","no":"other"}}}}'
```

### Management tools

Ask your agent, e.g. *"show the local llama.cpp status"* or *"stop the local server"*. `llamacpp_models` lists the discovered models with their resolved types and source paths.

## Privacy

All traffic is loopback-only (`127.0.0.1`). The plugin reads GGUF headers to classify models and shells out to your local `llama-server`. The sign-in key is a placeholder and is never sent anywhere.

## License

MIT
