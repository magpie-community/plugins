# Magpie CLIProxyAPI Plugin

A universal, zero-setup AI gateway plugin for [Magpie Desktop](https://usemagpie.ai/docs/plugins) that embeds and supervises **[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** directly inside your Magpie environment. It bridges **any AI coding agent, IDE, terminal client, or software SDK** to your local Magpie gateway and models.

Compatible with **[EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)** with automatic registration support in the **Agent Configuration** tab.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)](test/plugin.test.mjs)
[![Tip: Wise](https://img.shields.io/badge/Tip-Wise-00b9ff.svg)](https://wise.com/pay/me/terenceooit)

> [!NOTE]
> **Current Status & Usage Notice**:
> This plugin is currently not actively used in Magpie because Magpie already has its own built-in similar feature. However, it can still be utilized as a reliable fallback or guard for similar edge cases, proxy troubleshooting, or compatibility issues across external AI clients and coding tools.

---

## Overview

```text
┌────────────────────────────────────────────────────────────────────────┐
│  Any AI Client / Software                                              │
│  (Cursor, Windsurf, Claude Code, Terminal Agents, OpenCode, SDKs, etc.)│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ OpenAI / Claude API (:8080 or :8317)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  CLIProxyAPI Plugin (Supervised inside Magpie Desktop)                 │
│  - Auto-manages daemon lifecycle (starts & stops with Magpie)          │
│  - Multi-client routing, protocol conversion, model aliases           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Upstream bridge (:3425/v1)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Your Magpie Gateway (serves local & routed models)                    │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Highlights
- **Universal Software Compatibility**: Connect any client or IDE that supports OpenAI-compatible or Claude-compatible endpoints.
- **Automated Lifecycle Supervision**: Automatically starts with Magpie and terminates immediately upon quitting Magpie via an internal termination watchdog, preventing orphaned background processes.
- **Auto-Download & Cross-Platform**: Automatically fetches and verifies official SHA-256 binary releases for Windows (`x64`/`arm64`), macOS (`Apple Silicon`/`Intel`), and Linux (`x64`/`arm64`).
- **EasyCLIProxyAPI Integration**: Seamlessly works alongside [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI), auto-registering client profiles for the **Agent Configuration** tab.
- **Embedded Web Dashboard**: Dedicated visual control panel inside Magpie Desktop with live traffic monitoring, detected client indicators, copy buttons with fallback, and weekly auto-update checks.

---

## Supported Clients & Software

This plugin is client-agnostic and provides an OpenAI-compatible HTTP interface:

| Client / Agent | Connection Method | Endpoint URL | API Key |
| :--- | :--- | :--- | :--- |
| **Cursor IDE** | Custom OpenAI API Base | `http://127.0.0.1:8080/v1` | `magpie` |
| **Windsurf IDE** | OpenAI Compatible Provider | `http://127.0.0.1:8080/v1` | `magpie` |
| **Claude Code** | Custom Base URL | `http://127.0.0.1:8080/v1` | `magpie` |
| **Terminal Coding Agents** *(Aider, Pi, OpenCode, Devin CLI)* | Environment Variables | `OPENAI_BASE_URL=http://127.0.0.1:8080/v1` | `OPENAI_API_KEY=magpie` |
| **Python SDK (`openai`)** | `OpenAI(base_url=..., api_key=...)` | `http://127.0.0.1:8080/v1` | `magpie` |
| **Node.js SDK (`openai`)** | `new OpenAI({ baseURL, apiKey })` | `http://127.0.0.1:8080/v1` | `magpie` |
| **cURL / HTTP Clients** | Direct REST / Chat Completions | `http://127.0.0.1:8080/v1/chat/completions` | `Bearer magpie` |

---

## Setup for Different Magpie Conditions

The plugin dynamically adapts to your environment and requires zero manual configuration out of the box, but can be fully customized for different setups:

### Condition 1: Default Setup (Zero Configuration)
If you run Magpie Desktop normally on `127.0.0.1:3425`:
1. Add the plugin to your Magpie plugins list (in `~/.config/magpie/plugins.json`):
   ```json
   {
     "plugins": [
       {
         "spec": "path/to/magpie-cli-proxy-api-plugin"
       }
     ]
   }
   ```
2. Launch Magpie. The plugin automatically downloads the CLIProxyAPI binary if missing, generates configuration pointing to your local Magpie gateway, and launches on `127.0.0.1:8080`.

---

### Condition 2: Custom Magpie Host, Port, or Network Gateway
If your Magpie instance runs on a custom port, LAN server, or remote address:
```json
{
  "spec": "path/to/magpie-cli-proxy-api-plugin",
  "options": {
    "magpieBaseUrl": "http://192.168.1.100:3425/v1",
    "magpieApiKey": "your-custom-magpie-key",
    "defaultModel": "group/gpt-6.1-sol"
  }
}
```

---

### Condition 3: Custom Local Proxy Port
If port `8080` is in use by another application on your system:
```json
{
  "spec": "path/to/magpie-cli-proxy-api-plugin",
  "options": {
    "port": 9090
  }
}
```
All connected clients will now connect to `http://127.0.0.1:9090/v1`.

---

### Condition 4: Offline / Air-Gapped Environment (Pre-Installed Binary)
If your computer has no internet access to download binaries from GitHub:
1. Download the `cli-proxy-api` executable for your OS from [CLIProxyAPI Releases](https://github.com/router-for-me/CLIProxyAPI/releases).
2. Place the binary directly inside `cli-proxy-api/bin/` (e.g. `cli-proxy-api/bin/cli-proxy-api.exe`), or specify a custom path in options:
   ```json
   {
     "spec": "path/to/magpie-cli-proxy-api-plugin",
     "options": {
       "autoDownload": false,
       "binaryPath": "C:\\Tools\\cli-proxy-api.exe"
     }
   }
   ```

---

### Condition 5: EasyCLIProxyAPI Integration (`router-for-me/EasyCLIProxyAPI`)
If you use **[EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)** as your GUI management panel:
1. Enable `easyCliProxyApi` in your plugin options:
   ```json
   {
     "spec": "path/to/magpie-cli-proxy-api-plugin",
     "options": {
       "easyCliProxyApi": true,
       "easyCliProxyApiPort": 8317,
       "autoRegisterVsCode": true
     }
   }
   ```
2. When enabled, the plugin coordinates with EasyCLIProxyAPI (defaulting to port `8317`) and automatically registers the client profile into your system configuration so it appears immediately available in the **Agent Configuration** tab of EasyCLIProxyAPI.
3. You can also trigger registration on-demand via the agent tool `register_vscode_agent`.

---

## Code Examples

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8080/v1",
    api_key="magpie",
)

response = client.chat.completions.create(
    model="group/gpt-6.1-sol",
    messages=[{"role": "user", "content": "Hello!"}],
)

print(response.choices[0].message.content)
```

### Node.js / TypeScript (OpenAI SDK)
```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8080/v1",
  apiKey: "magpie",
});

const response = await client.chat.completions.create({
  model: "group/gpt-6.1-sol",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

### cURL
```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer magpie" \
  -d '{
    "model": "group/gpt-6.1-sol",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## Options Reference

Configure options inside `~/.config/magpie/plugins.json` or via the visual dashboard in Magpie Desktop:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `autoStart` | `boolean` | `true` | Automatically starts CLIProxyAPI when Magpie starts, and stops it when Magpie quits. |
| `autoDownload` | `boolean` | `true` | Automatically downloads and verifies latest `CLIProxyAPI` binary if missing. |
| `host` | `string` | `"127.0.0.1"` | Bind host for local proxy. |
| `port` | `number` | `8080` | Bind port for local proxy. |
| `magpieBaseUrl`| `string` | `"http://127.0.0.1:3425/v1"` | URL of your Magpie gateway upstream. |
| `magpieApiKey` | `string` | `"magpie"` | Authentication key for upstream Magpie gateway. |
| `defaultModel` | `string` | `"group/gpt-6.1-sol"` | Default model forwarded to Magpie. |
| `extraModels` | `array` | `["group/gpt-6.1-sol", "group/free-model-magpie"]` | Explicitly declared model IDs to expose. |
| `syncAllMagpieModels` | `boolean` | `true` | Automatically syncs all live models from Magpie into the proxy catalog. |
| `copilotAliases` | `array` | `["gpt-4o", "gpt-4", "gpt-4.1", ...]` | Client model aliases mapped to your default model. |
| `easyCliProxyApi` | `boolean` | `false` | Enables integration mode for EasyCLIProxyAPI. |
| `easyCliProxyApiPort` | `number` | `8317` | Port used by EasyCLIProxyAPI. |
| `autoRegisterVsCode` | `boolean` | `false` | Automatically writes client endpoint config for Agent Configuration tab. |
| `binaryPath` | `string` | `""` | Optional manual path to a local `cli-proxy-api` executable. |

---

## Testing

Run unit and contract tests using Node.js built-in test runner:

```bash
npm test
```

All tests run locally without external network dependencies.

---

## Contributing

Contributions, issues, and feature requests are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on code style, testing, and pull requests.

---

## Author & Tipping

Developed and maintained by **Terence Ooi Teng Wei** ([@terenceooit](https://github.com/terenceooit)).

If this project saves you time and simplifies your AI agent workflow, please consider supporting continued open-source development:

☕ **[Tip via Wise - Terence Ooi Teng Wei (@terenceooit)](https://wise.com/pay/me/terenceooit)**

Your support is deeply appreciated!

---

## License

This project is licensed under the [MIT License](LICENSE).
