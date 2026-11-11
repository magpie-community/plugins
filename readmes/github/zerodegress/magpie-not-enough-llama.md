# magpie-not-enough-llama

A [magpie](https://usemagpie.ai) provider that starts a local `llama-server` only when a request needs it and stops it when idle, so the model is never resident yet still looks like an ordinary `local/<model>` provider.

## Install

`llama-server` from [llama.cpp](https://github.com/ggml-org/llama.cpp) has to be on the machine. No npm dependencies.

```sh
magpie plugin add .
magpie plugin options magpie-not-enough-llama '{"bin":"/usr/bin/llama-server","model":"/path/to/model.gguf","extraArgs":["-c","8192","-ngl","99"]}'
```

The plugin signs itself in, so `magpie plugin login` is not needed.

## Usage

Agents see the model as `local/<id>`. With `models` empty the id is the file name without its extension: `Some-4B-Q4_K_M.gguf` becomes `local/Some-4B-Q4_K_M`.

```sh
curl http://127.0.0.1:3425/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"local/some-4b","messages":[{"role":"user","content":"hi"}]}'
```

The first request waits for the model to load. `idleMinutes` after the last reply the process gets SIGTERM, then SIGKILL, and the next request starts it again.

### Options

| Option | Default | |
| --- | --- | --- |
| `bin` | `llama-server` | llama.cpp server binary |
| `model` | required | GGUF file |
| `port` | `0` | fixed port; `0` picks a free one |
| `idleMinutes` | `5` | stop after this much idle time, `0` never stops |
| `startTimeoutSeconds` | `180` | how long to wait for `/health` |
| `extraArgs` | `[]` | passed to llama-server as is |
| `models` | `[]` | `{id, name, limit: {context, output}}`; empty derives from the file name |
| `warmup` | `false` | load the model when the plugin host starts |

A model that cannot start comes back as a 503 carrying the command line and the tail of llama-server's stderr.

[中文说明](README.zh.md)
