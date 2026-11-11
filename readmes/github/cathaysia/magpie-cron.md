# magpie-cron

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Magpie Plugin](https://img.shields.io/badge/Magpie-Plugin%20%26%20Middleware-purple.svg)](https://usemagpie.ai)

> [Magpie](https://usemagpie.ai) plugin and gateway middleware to periodically disable or enable models under specific providers via cron schedules.

---

## 🌟 Features

- ⏰ **Scheduled Model Disabling**: Automatically disable or block specific models or entire providers during configured cron time windows (e.g. night-time quotas, peak-hour rate limits, scheduled maintenance).
- 🛡️ **Gateway Middleware Interception**: Operates at the Magpie gateway layer (`onRequest` and `onProvider` hooks), cleanly rejecting forbidden requests with `403` status before token expenditure.
- 🔄 **Configurable Duration Windows**: Set `durationMinutes` to define auto-reverting blackout periods (e.g., disable for 480 minutes / 8 hours after 22:00 every night).
- 🎛️ **Integrated UI Panel**: Embedded settings panel under Magpie's **Settings → Plugins → Model Cron Scheduler** for zero-friction rule management.
- ⚡ **Zero Runtime Dependencies**: Written in clean, lightweight modern JavaScript (ESM) that runs directly on Magpie's Bun host without heavy external libraries.

---

## 📦 Installation

Add this plugin directly to your Magpie instance via CLI:

```bash
# Install directly from GitHub repository:
magpie plugin add github:cathaysia/magpie-cron

# Or install from local directory:
magpie plugin add /path/to/magpie-cron
```

Verify that the plugin is installed and running:

```bash
magpie plugin
```

---

## ⚙️ Configuration & Options

Rules can be configured either via the Magpie UI settings panel or by setting plugin options directly via CLI:

```bash
magpie plugin options magpie-cron '{
  "rules": [
    {
      "name": "Nightly Blackout for Expensive Models",
      "provider": "remote-magpie",
      "modelId": "coderelay/claude-sonnet-4-6",
      "cron": "0 22 * * *",
      "durationMinutes": 480,
      "action": "disable",
      "enabled": true
    }
  ]
}'
```

### Rule Properties

| Property | Type | Description |
| :--- | :--- | :--- |
| `name` | string | Human-readable name for the schedule rule. |
| `provider` | string | Provider ID (e.g., `remote-magpie`, `zcode`, `workbuddy-ai`, or `*` for all). |
| `modelId` | string | (Optional) Specific model ID or wildcard pattern (e.g. `*claude*`). Omit or leave empty to match all models under the provider. |
| `cron` | string | Standard 5-field cron expression (`min hour dom month dow`). |
| `durationMinutes` | number | (Optional) Duration in minutes for which the model remains disabled after the cron trigger time. |
| `action` | `"disable"` | Action to take when the schedule is active (defaults to `"disable"`). |
| `enabled` | boolean | Toggle the rule on or off without deleting it. |

---

## 📄 License

MIT © [cathaysia](https://github.com/cathaysia)
