# Strata

Local Strata models in magpie. Provider id: `strata`. This first version
manages processes on Windows and uses an **existing** Strata installation,
Python environment and engine configuration. It installs no runtime or model.

## Install and configure

For local development, add the absolute path of this package:

```sh
magpie plugin add /absolute/path/to/packages/strata
magpie plugin login strata
```

Once published, the package name is
`@magpie-community/opencode-strata-auth`.

Choose **Configure local Strata**. Its normal provider prompts ask for:

| Input | Value |
|---|---|
| Strata directory | The existing installation directory, with `serve/server.py` and `serve/winjob.py` |
| Python | Absolute path to that installation's existing Python executable |
| Engine configuration | Absolute path to an existing Strata JSON configuration |
| Model | The exact target model id from that configuration |
| API URL | Local HTTP URL ending in `/v1`; blank uses `http://127.0.0.1:8080/v1` |
| Environment | JSON object of string values needed by the existing launch script; blank uses `{}` |
| API key | The existing Strata API key, or blank when none is required |
| Stop on exit | **Yes** by default; **No** preserves the managed instance and its manager |

The configuration uses magpie's existing automatic OAuth callback flow
without a browser URL. The host saves its successful key/metadata result
in `plugin-auth.json`. There is no separate editable settings file. Run the
same configuration flow on the existing account to change the exit option;
a successful save updates its running manager without another generation.
The callback includes the current gateway's port and a save revision in the
host-owned metadata. The manager caches the saved exit option immediately
and confirms that gateway before acting on a stop, including after reopening
magpie without another request.
The manager reads only saved records matching its local target, requires a
boolean exit option, and keeps its last confirmed value through missing or
unreadable auth, disable and uninstall. Loaders never write an exit policy.
A stable target identity in metadata keeps same-version reconfiguration and
key changes on one account. Unreleased WIP accounts without that identity
should be backed up and reconfigured in the isolated test profile.
Environment values are passed directly to the process, never through a shell.
Copy the needed environment values from your existing launch setup, including
its cache locations. No machine-specific launch path is shipped.

Use `strata/<model id>`. Before configuration, `configure-strata` is only a
label telling you to configure the provider; requesting it does not start
Strata. After saving, the target model is declared even with no cache and
no running service. Model discovery reads Strata's `GET /v1/models` and
otherwise keeps the supplied declarations and magpie's cache. The existing
`plugin-providers.json` is only read to check whether a successful cache for
this address includes the configured target without the unconfigured placeholder;
only then is magpie asked to retain that cache. Missing, unreadable, placeholder
or stale-target caches cannot override the valid offline target declaration.
The plugin never writes this cache or maintains another model directory. The minimal
declaration does not assume image, reasoning or tool capabilities.

## Requests

Loading the plugin, configuring it and listing models do not start Strata.
A real inference request (including magpie's connection test) checks
`GET /health`. A healthy Strata with `loaded: false` is ready: its real
request handles loading and engine recovery.

When the local service is absent, the plugin launches the existing server
with `--engine strata --config <path> --host 127.0.0.1 --port <port>`.
It omits `--open`, runs in the configured installation directory, hides
auxiliary windows and preserves the engine configuration's loading policy.
It does not force text-only lazy loading on an installation configured
for vision. An occupied or foreign port is reported without stopping its
owner or starting a second service.

The native `fetch` gets the host's original URL, method, headers, body
and cancellation signal and returns its original `Response`. There is
no HTTP proxy, SSE parser, inference queue, prewarm generation or automatic
replay. Cancelling one startup waiter does not stop a shared startup or
another request; cancelling after forwarding keeps native fetch behavior.

## Process ownership and exit

The Python standard-library helper only manages lifecycle. An OS named
mutex coordinates startup across plugin hosts. The manager identifies the
actual gateway via `GET /` reporting `name: "magpie"`, with the same
full Windows listener identity before and after that HTTP check. It finds
the IPv4 gateway listener using
[GetExtendedTcpTable](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable)
and records process creation time and executable identity using
[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes).
It does not match `magpie.exe` names or treat a Bun host exit as a gateway exit.
The gateway endpoint follows `MAGPIE_ADDR`, or magpie's existing
`settings.json` port (default 3425).

The manager, minimal ownership record (including the last confirmed exit
option), request-boundary launch data and error log live under
`<magpie data directory>/strata/127.0.0.1-<port>/`.
The running helper is copied there before launch, so removing the installed
plugin cannot remove the resources needed to manage an existing instance.
Keep an isolated data directory on the intended disk when testing.

The server runner waits for containment before it can start engines. The
helper reuses the installed Strata `serve/winjob.py` and checks its
containment result. Startup ownership writes must succeed; once running,
failed diagnostic/state writes retain the service and are retried. Its Windows Job owns only the tree it created or
reliably recovered; the Job's active process count verifies cleanup.
Existing user-started Strata is connected to without acquiring ownership.

Closing a window to the tray, plugin-host reload, disable and uninstall
preserve the service. With **Yes**, actual gateway-process exit stops the
managed tree immediately, even during generation, then the manager exits.
With **No**, the instance and manager stay; a later host/session uses the
same instance, reconnects the manager to its actual gateway on the next
request or successful reconfiguration and synchronizes the newest saved
option. Gateway handles change
only after the new listener is confirmed. Process identity
uncertainty preserves the unconfirmed process and is recorded in the
manager state/log. Removing the plugin is not a manual stop operation.

Readiness has a fixed **120-second** budget, including the existing
configuration's cold startup; no model load is required by the plugin's
health check. Gateway observation polls every **250 ms**. Stopping the
owned Job has a **5-second** cleanup budget. Startup failures are reported;
after correcting their cause, a later actual request can retry. Service
death is not followed by an unconditional restart.

The Windows helper expects the installed Strata `winjob.py` implementation
that provides `contain` and its Job handle. IPv6-only/remote gateway
management and multiple independent magpie data directories coordinating
one retained instance are outside this first local integration.

## Tests

The hook tests use native HTTP substitutes. Windows lifecycle tests launch
hidden, local substitute gateways and servers on ephemeral ports. They use
the existing Python and a temporary copy of the installed `winjob.py`;
they never start or stop the real Strata service.

On Windows, run the lifecycle suite through an external off-screen desktop
and Job cleanup wrapper. Its environment uses an existing test installation
and a temporary directory on your intended disk. The wrapper runs:

```powershell
bun test packages/strata
bun scripts/check.mjs strata
```

Without Windows and the two test-environment variables, the Windows
lifecycle suite is explicitly skipped; the hook suite still runs.
Coverage includes A01-A05 and A07-A19 at these substitute boundaries:
cold and concurrent startup across independent hosts, no console/browser
launch, untouched SSE and errors, cancellation, saved options, retained
ownership across sessions, host/package removal, owned child cleanup,
startup retry, request-triggered recovery, stopped/mutex races, runtime
state-write failure/recovery, reopening with no inference before a save, authentic
host callback saving, changed-key identity, stale loaders and unreadable or
invalid saved policies. The fake gateway has the real name/version shape
and does not invent a PID field. A06's tray behavior is
represented by keeping the gateway alive while hosts come and go.

These tests do **not** certify the actual magpie GUI/login/reconfiguration
flow, the real model's cold-start time or generation, actual tray behavior,
forced PID reuse/access-denied fault injection, or independent review.
Those remain the main session's integration and acceptance work.

Managed startup uses `pythonw.exe` beside the configured Windows Python to avoid terminal windows. An already running Strata instance does not need this entry point.
