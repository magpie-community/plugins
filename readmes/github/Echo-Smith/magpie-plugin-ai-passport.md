# magpie-plugin-ai-passport

Send Magpie routing activity and token usage to an **AI Passport** — a small
ESP32-C3 wearable with a 240×320 screen that sits on your desk (or your chest)
and shows which agent is working, how many tokens you have burned this week, and
how much quota is left.

This plugin only reports. It never changes a request, never reads prompts or
credentials, and never blocks a model call.

## What it shows on the device

- **Activity** — every model call appears briefly with its agent, model and
  working directory, so you can see at a glance which agent is busy.
- **Usage** — 7-day token total plus the remaining quota of up to three
  subscription accounts, refreshed every 30 seconds.

## Requirements

A running [approval-bridge](https://github.com/Echo-Smith/ai-passport) hub on the
same machine (or any host reachable over the network). The bridge is what talks
to the device over Wi-Fi; this plugin only pushes data to it over HTTP.

```bash
cd ~/Codex/AI-Passport/approval-bridge
python3 bridge.py hub --token test123 --lan
```

## Install

```bash
magpie plugin add magpie-plugin-ai-passport
```

Or add it from a local checkout:

```bash
git clone https://github.com/Echo-Smith/magpie-plugin-ai-passport.git
magpie plugin add ./magpie-plugin-ai-passport
```

Then open the Magpie plugin list and make sure it is **on**.

## Configuration

All settings are optional environment variables read when the plugin loads:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PASSPORT_HUB` | `http://127.0.0.1:7789` | Approval-bridge HTTP endpoint |
| `PASSPORT_TOKEN` | `test123` | Must match the bridge token |
| `MAGPIE_GATEWAY` | `http://127.0.0.1:3425` | Magpie's own gateway, for usage and quotas |
| `PASSPORT_DISABLE` | unset | Set to `1` to switch all reporting off |

## Privacy

Reported: agent name, model name, last path segment of the working directory,
7-day token totals, and per-account remaining percentages.

Never reported: prompt or completion text, session IDs, account identities,
API keys, or file contents. Requests are passed through untouched — the plugin
returns `undefined` from the hook.

## Notes

- Uses `node:http` instead of `fetch`: the Magpie host process often runs with
  proxy environment variables, and `fetch` would route these loopback calls
  through the proxy and fail.
- Activity is throttled to one push per agent/model pair per 10 seconds, usage
  polling to once per 30 seconds, so a busy agent cannot flood the device.
- If the bridge is not running, pushes fail silently and model calls continue
  normally.

## License

MIT
