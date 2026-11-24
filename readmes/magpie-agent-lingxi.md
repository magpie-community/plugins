# magpie-agent-lingxi

WPS 灵犀 (Lingxi) on magpie's **Agents** page. magpie's models appear in 灵犀's
「自定义模型」 menu as `magpie/<model>`, served through magpie's gateway and
routing groups.

> **Unofficial.** Not affiliated with Kingsoft / WPS. Windows only.

## What it does

- Adds **WPS 灵犀** to magpie's Agents page, so you can pick one of magpie's
  models for it.
- A small detached daemon syncs magpie's model list into 灵犀's own
  custom-model storage over the Chrome DevTools Protocol.
- A local proxy on `127.0.0.1` keeps the display name `magpie/<model>` while
  forwarding `<model>` to magpie (the gateway does not accept the prefix).
- Models from the `wps-lingxi/*` provider are excluded, so 灵犀 does not call
  itself through magpie (which would loop and spend credits twice).

## Requirements

- Windows 10/11.
- magpie with agent-plugin support (0.1.x).
- WPS 灵犀 installed. It is detected from the Windows uninstall registry or
  common install paths; `LINGXI_EXE` / `LINGXI_HOME` override the detection.
- No Node install is needed: magpie's Bun runs the daemon.

## Install

- From magpie → 插件 → 发现: search `magpie-agent-lingxi` and install.
- Or: `magpie plugin add github:dongv88/magpie-agent-lingxi`
- Or local: `magpie plugin add C:\path\to\magpie-agent-lingxi`

After installing, if **WPS 灵犀** does not appear on the Agents page, restart
magpie once: the plugin creates its detection marker on first run.

## Use

1. Quit WPS 灵犀 completely (including the tray icon).
2. Run `launch-lingxi.cmd`. It finds 灵犀 and starts it with
   `--remote-debugging-port=9222`.
3. In magpie: **Agent → WPS 灵犀 → pick a model**.
4. In 灵犀: **选择其他模型 → 自定义模型 → `magpie/<model>`**.

The debug port is only needed **for syncing**. After the models are synced you
can go back to your normal 灵犀 shortcut; the local proxy keeps working. Start
with `launch-lingxi.cmd` again whenever you want to refresh the model list or
apply a model chosen in magpie.

## Enable / disable

- magpie → 插件 → `magpie-agent-lingxi` → toggle.
- CLI (use the folder path the plugin was installed from):

```bat
magpie plugin off C:\path\to\magpie-agent-lingxi
magpie plugin on  C:\path\to\magpie-agent-lingxi
```

Turning it off disconnects the agent. About 90 seconds after the plugin host
stops, the daemon removes the `magpie/*` entries from 灵犀, restores the model
灵犀 had before, and exits. Turning it on again requires reconnecting the agent
(Agent page) or `magpie lingxi deepseek/deepseek-flash`.

## Data and privacy

- Data dir: `%USERPROFILE%\.config\magpie\lingxi-agent`
  (`daemon.log`, `host.log`, `heartbeat`, `daemon.lock`, `install.json`,
  `installed/` marker).
- The proxy listens on `127.0.0.1:3426` (falls back to 3427-3435).
- The plugin writes only 灵犀's `claw_custom_model_configs` and
  `cowork_model_option_v2` in its own storage.
- It does **not** read or store your WPS credentials. Requests use magpie's
  per-agent gateway key (`magpie-lingxi`).
- While 灵犀 is open with the debug port, a local process can control its
  renderer. Close 灵犀 or restart it normally when you are not syncing if that
  matters to you.

## Troubleshooting

- **Agent missing**: restart magpie once; check that 灵犀 is installed.
- **Models missing in 灵犀**: 灵犀 must run with `--remote-debugging-port=9222`
  for a sync; check `daemon.log`.
- **Models show but fail**: check the proxy port in `daemon.log` and that the
  magpie gateway is at `127.0.0.1:3425`.
- **After a 灵犀 update**: the app may restart without the debug port; run
  `launch-lingxi.cmd` again.

## Disclaimer

Unofficial integration. "WPS" and "WPS 灵犀" are trademarks of Kingsoft. Use at
your own risk.

## License

MIT
