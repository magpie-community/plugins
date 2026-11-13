# ModelScope VideoGen for Magpie

A Magpie video generation plugin with a local, headless-browser service for all nine current ModelScope AIGC video models: MiniMax-H3, LTX 2.3, WAN 2.2 and WAN 2.1.

The package runs locally. Magpie calls fourteen tools; the Python service queues the request and continues polling ModelScope after the tool call returns:

- `videogen_generate_flf2v`: generate from a first frame and a required final frame.
- `videogen_generate_i2v`: generate from a first frame.
- `videogen_generate_t2v`: generate from text without input frames.
- `videogen_estimate`: fetch the official magicube quote without uploading or generating.
- `videogen_search_models`: search matching Checkpoint, LoRA and VAE versions and trigger words.
- `videogen_get_video_status`: check progress.
- `videogen_get_video_result`: download the completed video, input-frame previews, manifest and local HTML preview.
- `videogen_get_config`: show allowed input directories and account connection/balance snapshots.
- `videogen_prepare_frames`: validate frames; explicitly set `copy_to_media_root=true` to stage outside images.
- `videogen_list_video_jobs`: list and paginate tasks, optionally filtered by project.
- `videogen_get_models`: list adapter model capabilities and local download verification times.
- `videogen_diagnose`: inspect plugin/service version compatibility, workers, accounts and affected jobs.
- `videogen_control_job`: pause/resume/cancel unsubmitted local jobs or explicitly reassign them.
- `videogen_reconcile_job`: reconcile an ambiguous submission with its original provider task.

The service exposes `GET /v1/models`, `POST /v1/videos`, `GET /v1/videos/{id}` and `GET /v1/videos/{id}/content`. It binds to loopback by default. It does not require or store a ModelScope password or API key; it uses the browser sessions you configure.


## VideoGen 0.0.2 model and parameter support

The npm/plugin name is **`magpie-modelscope-videogen`**. Local folder installs
load the package name from `package.json`; disable and enable the installed
plugin after updating. Existing local paths, Python module/command
(`magpie-wan-service`), `WAN_*` environment variables, browser profiles, database,
job IDs and result/watch directories are retained to preserve existing data.
The repository is now [tviber/magpie-modelscope-videogen](https://github.com/tviber/magpie-modelscope-videogen).
The renamed plugin advertises only the new
`videogen_*` tools, so update explicit tool allowlists and MCP assignments.
Magpie truncates the plugin portion of exposed MCP names: the installed prefix
is `magpie-modelscope-videog_`, for example
`magpie-modelscope-videog_videogen_generate_i2v`. The per-plugin endpoint follows
that prefix: `/mcp/magpie/tools/magpie-modelscope-videog`. The combined endpoint
is still `/mcp/magpie/tools`.

| Model ID | Text | First frame | First/last frames |
| --- | --- | --- | --- |
| `minimax-h3` | Yes | Yes | Yes |
| `ltx-2.3` | Yes | Yes | Yes |
| `wan2.2-ti2v-5b` | Yes | Yes | No |
| `wan2.2-i2v-a14b` | No | Yes | No |
| `wan2.2-t2v-a14b` | Yes | No | No |
| `wan2.1-flf2v-14b` | No | Yes (legacy adapter) | Yes |
| `wan2.1-i2v-14b` | No | Yes | No |
| `wan2.1-t2v-14b` | Yes | No | No |
| `wan2.1-t2v-1.3b` | Yes | No | No |

Generation parameters are persisted with jobs, included in request deduplication,
and exported in manifests:

| Parameter | Behavior |
| --- | --- |
| `accelerate_lora` | H3 default true, others false; true uses 4 steps |
| `num_inference_steps` | 1–50, requires acceleration off unless set to 4 |
| `guidance_scale` | 1.5–20; omitted uses the official model default if present |
| `checkpoint_version_id` / `vae_version_id` | Compatible custom version IDs from model search |
| `loras` | Up to 6 objects: `model_version_id`, `scale` (−10 to 10, default 1), optional `trigger_words` array |
| `add_watermark` | Boolean, default false |
| `seed`, `negative_prompt`, `style` | Per-request controls; no implicit prompt or style added |
| `size`, `seconds` | Custom dimensions and whole-second duration; actual specs reported on completion |

Search uses ModelScope's official AIGC catalog, filtered to the selected model
family. It returns version IDs and trigger words; select compatible versions.
Trigger words are appended to the effective provider prompt. The manifest
retains the original prompt and the LoRA configuration. Explicitly supplied
checkpoint/VAE/LoRA IDs are ultimately validated by ModelScope.

For example, call `videogen_generate_t2v` with:

```json
{
  "model": "ltx-2.3",
  "prompt": "A red ball rolls across a wooden table. Static camera.",
  "seconds": 3,
  "size": "1280x768",
  "accelerate_lora": false,
  "num_inference_steps": 30,
  "guidance_scale": 4
}
```

`videogen_estimate` accepts generation parameters plus `mode: "t2v" | "i2v"`;
image mode validates local frame paths but does not upload them. Omitting mode
infers it from the presence of `first_frame`. `videogen_search_models` accepts
`model`, `model_type: "Checkpoint" | "LoRA" | "VAE"`, `query`, `page`, `page_size`
and optional `account`. Both operations serialize with the selected account's
worker and return busy if that account is currently submitting a job.

## Requirements

- Magpie with its plugin tools enabled.
- Node.js 20 or later and npm for installing the local plugin dependencies.
- Python 3.11 or later, `pip` (or `uv`), and `ffprobe` from FFmpeg.
- Chrome or Chromium browser sessions signed in to ModelScope, each exposed on its own local CDP port.

## Install the Python service

From this package directory, create and activate a virtual environment.

macOS/Linux:

```sh
python3 -m venv .venv
. .venv/bin/activate
```

Windows PowerShell:

```powershell
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1
```

Then install the service in either environment:

```sh
python -m pip install --upgrade pip
python -m pip install -e .
```

Install FFmpeg if `ffprobe` is not already available. The service checks downloaded MP4 files with `ffprobe` before marking a job complete.

## Configure one or many ModelScope accounts

For a new device, set `WAN_MEDIA_ROOTS` and start `magpie-wan-service` without
`WAN_MODELSCOPE_ACCOUNTS` or `WAN_MODELSCOPE_CDP_URLS`. The service starts with zero
accounts. Use **登录新账号** in Magpie to create each isolated browser session;
saved sessions restart automatically. Chrome must be installed on that device.
SMS/CAPTCHA and any new-device verification are completed by the user on the
official site. Existing profiles and fingerprint databases are local to that
installation; do not copy only the database onto a new device.

For manual CDP configuration (an alternative to the managed GUI login below), start a separate Chrome/Chromium process with a separate user-data directory for each ModelScope account. Sign in to each profile and expose a different local CDP port. Keep each browser open while the service is running; do not share a profile between accounts. For example, on macOS:

```sh
open -na "Google Chrome" --args --remote-debugging-port=9223 --user-data-dir="$HOME/.modelscope-profiles/account-1"
```

For another account, use a different port and profile directory. Configure stable, non-personal account IDs mapped to CDP endpoints in `WAN_MODELSCOPE_ACCOUNTS`:

```sh
WAN_MODELSCOPE_ACCOUNTS='{"account-1":"http://127.0.0.1:9223"}' \
WAN_MEDIA_ROOTS="$HOME/wan-inputs" \
magpie-wan-service
```

Three accounts, for example:

```sh
WAN_MODELSCOPE_ACCOUNTS='{"account-1":"http://127.0.0.1:9223","account-2":"http://127.0.0.1:9224","account-3":"http://127.0.0.1:9225"}' \
WAN_MEDIA_ROOTS="$HOME/wan-inputs" \
magpie-wan-service
```

Windows PowerShell (after starting the signed-in browser profiles):

```powershell
$env:WAN_MODELSCOPE_ACCOUNTS = '{"account-1":"http://127.0.0.1:9223","account-2":"http://127.0.0.1:9224"}'
$env:WAN_MEDIA_ROOTS = "$HOME\wan-inputs"
$env:WAN_SERVICE_DATA_DIR = "$env:LOCALAPPDATA\magpie-wan"
magpie-wan-service
```

There is no two-account limit. The service starts one serial worker queue per configured account ID and assigns plugin jobs by the selected VideoGen routing mode (direct HTTP requests without a mode keep queue-based selection). Open `https://modelscope.cn` or `https://www.modelscope.cn` and sign in in each browser profile. Other domains, HTTP pages, and redirects are rejected. Upload destinations must be official HTTPS ModelScope hosts or bucket-specific Alibaba OSS HTTPS endpoints; upload redirects are rejected.

Each ID is bound to a salted local fingerprint of its ModelScope login. The service checks the fingerprint before processing jobs, and the adapter checks the login before API operations. You can reorder the mapping or change a CDP port while keeping each ID with its original login. A different login or a duplicate identity blocks that worker. Use a new ID for a new account; never rename an ID with unfinished jobs. Choose generic IDs, since they appear in tool responses. Raw login IDs and CDP addresses are not persisted by the service. Display names are held in memory; connecting an account in Magpie saves its display label and configured account ID there.

The legacy comma-separated `WAN_MODELSCOPE_CDP_URLS` is still accepted when `WAN_MODELSCOPE_ACCOUNTS` is absent; it assigns `account-1`, `account-2`, etc. by position. Prefer the explicit mapping. Identity checks prevent a reordered legacy list from silently switching previously bound accounts. `WAN_MEDIA_ROOTS` is a path-separated list (`:` on macOS/Linux, `;` on Windows) of directories the service is allowed to read input frames from. It is required; use the narrowest directory that contains your frames. Frame paths passed to the tools must be absolute and inside one of these roots.

The service listens on `127.0.0.1:8765`. You can set `WAN_SERVICE_HOST`, `WAN_SERVICE_PORT`, `WAN_SERVICE_TOKEN`, `WAN_SERVICE_POLL_SECONDS`, and `WAN_SERVICE_DATA_DIR`. Keep the host on loopback: frame inputs are local paths. If you set `WAN_SERVICE_TOKEN`, also set the same token in the Magpie plugin options. Do not put tokens in this package or share the local service endpoint over a network.

## Install the Magpie plugin

From this package directory:

```sh
npm ci --ignore-scripts
magpie plugin add .
```

The folder install loads the source in place, so install its npm dependencies first. `@opencode-ai/plugin` is declared and locked; a pre-existing Bun cache is not an installation requirement. For a package extracted from `npm pack` (without the repository lockfile), use `npm install --ignore-scripts` instead of `npm ci`.

The default plugin service URL is `http://127.0.0.1:8765`. If you use a different local port, set its URL:

```sh
magpie plugin options magpie-modelscope-videogen '{"serverUrl":"http://127.0.0.1:8766"}'
```

If you also set `WAN_SERVICE_TOKEN` for the service, give Magpie the same token in its local plugin options. Keep the real token out of shell history and source control.

As described in the [official plugin documentation](https://usemagpie.ai/docs/plugins), Magpie automatically adds a tools plugin as its own MCP server in Library → MCP. Assign it to the intended agents there, or use the MCP router. Plugins → Installed also offers Hide from agents. Manual MCP setup is needed only for clients outside this integration; the combined endpoint is `/mcp/magpie/tools` on your Magpie gateway.

These remain dedicated video tools, including first/last-frame generation; they do not register a native `generate_video` model. Each call must fit Magpie's 55-second limit, so generation stays in the Python worker. The plugin does not install or supervise that service; optional plugin pages and `page.service` do not replace service setup.

## Accounts in Magpie Providers and Usage

After upgrading, restart the Python service and reload the plugin (toggle it off/on). In Magpie's existing Login dialog, choose **登录新账号**. This is the only login method: clicking it immediately opens the browser, without asking for an email or account ID. The service opens an isolated, visible Chrome window for the official ModelScope site. Complete SMS verification and the slider CAPTCHA directly in that window. Magpie's native dialog waits for the result; no custom frontend, localhost webpage or embedded website is created. Once identity is verified, the service closes the visible browser, restarts the same private profile headlessly, transfers session cookies in memory, and verifies identity again before Magpie saves the account. Ordinary browser profiles are not read or modified. Logging into a previously bound ModelScope identity reuses its existing account ID and refreshes its browser session at a worker boundary; jobs are never reassigned. The original configured browser must still be reachable for legacy CDP accounts.

Login has a nine-minute service deadline. Cancel from Magpie's login dialog or close the login Chrome window. Cancelled/expired new accounts are removed and their browsers stopped. A failed re-login preserves the existing account/profile. Repeat logins refresh the original account between worker operations, preserving unfinished jobs. Each login has an independent random task ID. Magpie's `method: auto` callback polls authenticated service status and only completes for the matching verified account. No SMS codes, screenshots or mouse/keyboard input are relayed through the service API.

Managed browsers use one private profile per account, run headless after login, and stay running after login to serve video tasks. They are stopped when the service stops and restarted with their saved profiles when the service starts. Session expiry still requires login again. Headless mode removes visible windows; it does not eliminate per-account Chrome memory consumption. Existing manually configured CDP browsers remain externally managed. Existing saved Magpie accounts continue to work; there is no separate browser-sync option in the login UI.

A configured account with a private `browser-profiles/<account-id>` directory in the service data directory is managed by the service too. Its debugging port is allocated at startup and restored automatically; its database identity and job ownership remain unchanged. Manually configured accounts without such a directory remain externally managed. Managed ports never reuse another configured account's reserved port, even when that external browser is offline.

To remove a saved sign-in, expand that account card's **设置** and click Magpie's native **移除** button. This removes that account's Magpie login, not the entire provider or the ModelScope account. It does not delete browser profiles, stop the independent video queue, or erase video history. The provider-level **移除** button has a different effect; use the per-account button.

Each connected account has its own label and **可用魔粒** wallet in Providers and Usage. The optional [native Magpie wallet-trend patch](patches/README.md) adds per-account balance history when expanded and a combined history when folded; it requires a patched Magpie build, not only this plugin. The plugin reads ModelScope's `available_balance`, not total credits including frozen amounts. Snapshots refresh about every 60 seconds when idle, and after submission/completion; a snapshot older than 120 seconds is marked stale and its balance hidden. A browser busy uploading/submitting can temporarily make its wallet stale. Unknown balances are not displayed as zero. `estimate_unit` is `魔粒`; `estimate` is a quoted generation cost, not seconds or a confirmed charge.

This provider is an account/usage integration with no chat models. Generate through the VideoGen tools. Magpie's provider account switches do not control the service's independent video queues; use the submission's optional `account` ID when a specific queue is needed. Browser logins are not automatically written into Magpie's sign-in store: use the native login flow, so signing out in Magpie stays signed out until you explicitly sign in again.

### VideoGen account routing

The provider editor's **VideoGen 均衡负载（剩余魔粒最多优先）** switch is on by default.
It controls all VideoGen video tools, independently of Magpie's general model routing.
Every submission picks the connected account with the largest fresh, positive
`available_balance` (a max-priority-queue top). Equal balances prefer the shorter
active queue, then account ID for a stable tie. Expired snapshots, unknown/zero
balances, rejected sessions and accounts signing in are excluded. If none are
eligible, the service returns an error instead of queuing against a broken login.

Turn the switch off for **preferred** mode. The plugin's `preferredAccount`
option supplies the preferred account ID; when omitted, the first eligible
account in service order is used. An explicitly configured unavailable preferred
account returns an error. Each generation call can override with
`routing: "balanced" | "preferred"` and `preferred_account: "account-2"`.
An explicit `account` always pins the job to that account. `videogen_get_config`
reports the effective mode. Outside Magpie the plugin's `routing` option defaults
to `balanced`. Direct HTTP requests omitting `routing` retain legacy queue-only
selection for compatibility.

Selection and insertion are serialized for concurrent submissions; retries with
the same idempotency key retain their original job/account. Balances are official
snapshots (normally refreshed every 60 seconds and after submission/completion),
not speculative cost reservations: consecutive requests may choose the same
highest-balance account until its reported balance changes. This is not a
guarantee that the wallet can cover a job's as-yet-unknown quote.

## Frame preparation, projects and completion

Run `videogen_get_config` to see `WAN_MEDIA_ROOTS`. Submission preflight resolves symlinks, validates each image through the service and reports allowed directories before any generation. With `copy_to_media_root=true`, the plugin copies only the explicitly supplied files into a private staging subdirectory of the first allowed root. This requires the plugin and service on the same computer. The service still validates roots, size and image contents; it never gets an unrestricted filesystem-copy endpoint. Failed preparation removes staging copies. Successful staging copies remain until you delete them; this permits retries after ambiguous network failures.

Example tool arguments:

```json
{
  "prompt": "A red ball rolls slowly across a wooden table.",
  "first_frame": "/absolute/workspace/first-frame.png",
  "seconds": 8,
  "size": "1280x720",
  "project": "Demo Project",
  "shot": "01 Sample Clip",
  "account": "account-1",
  "copy_to_media_root": true,
  "idempotency_key": "demo-clip-01-v1"
}
```

`project` and `shot` persist across restarts and are included in request deduplication. `videogen_list_video_jobs` accepts `project`, `limit` (1–200) and `offset`; pass the returned `next_offset` to continue. Omitting project lists all recent jobs.

Status now includes an explicit phase, queue position, elapsed seconds, the last successful provider poll and a stale indicator. A running task's percentage and ETA are `null`: ModelScope does not supply reliable values and the former fixed 50% was not measured progress. On completion, `requested` and ffprobe-measured `actual` show duration, dimensions and FPS, with `spec_warnings` for mismatches. FPS is chosen by ModelScope, so requested FPS is `null`. Existing completed files are measured lazily when their status/result is requested; a missing file or ffprobe leaves actual specs unavailable.

The result includes `video.mp4`, `first_frame.png`/`last_frame.png`, `manifest.json` and `preview.html`. Open `preview_url` locally for a video player, requested/actual comparison, prompt and input-frame thumbnails. The manifest preserves project/shot/account/model information for editing. The plugin constructs authenticated download routes itself; no token or signed provider URL is written into previews or manifests.

By default, tasks submitted through the plugin are watched every 15 seconds while its host is running. Completion downloads the preview bundle and calls Magpie's `client.tui.showToast` with specs, prompt, frame names and preview location. Watched IDs persist under `outputDir` and resume when the host starts again. **Magpie versions may log this hook rather than show an OS notification**; this is not a guaranteed push notification to a chat. Set `watchJobs:false` in plugin options to disable automatic watching/downloads. The Python worker continues independently; manual status/result tools always work. Watch state is local to one plugin host/output directory.

## Requests and output

Requests have no built-in style or negative-prompt defaults. The prompt is sent as provided; `style` and `negative_prompt` apply only when supplied on that request. `size` is optional and must preserve the frame aspect ratio; dimensions must be multiples of 16 and at most 1536 pixels. Without `size`, the service selects a supported size from the first frame. Duration is 1–10 whole seconds and defaults to 5.

The service copies inputs and completed videos to its private local data directory: `~/Library/Application Support/magpie-wan` on macOS, `$XDG_DATA_HOME/magpie-wan` or `~/.local/share/magpie-wan` on Linux, and `%LOCALAPPDATA%\magpie-wan` on Windows. Service status responses use relative `output_path` and `content_url` values. When authentication is enabled, that HTTP content URL requires a Bearer header.

Call `videogen_get_video_result` to retrieve the file: the plugin supplies the token in a header, streams the video to `~/.magpie-wan/results/wan-*/video.mp4`, and returns an absolute `output_path` plus `file_url`. Set the plugin's `outputDir` option to change the local destination. This path is on the plugin host machine and can be opened by local agents; it is not a public download link. No token is included in a URL or tool response. Aborts, failed downloads and the 50-second retrieval timeout remove partial files; call the result tool again to retry. Completed copies remain until you delete them. First-to-last-frame input supports `wan2.1-flf2v-14b`, `minimax-h3` and `ltx-2.3`.

### MiniMax-H3 through the headless browser

Use the existing tools with `model: "minimax-h3"`: `videogen_generate_i2v` takes a
first frame, and `videogen_generate_flf2v` takes first and last frames. The same
headless account sessions, wallet routing, durable queue, status polling and
result downloads serve both model families. Restart the Python service and
reload the plugin after upgrading. All exposed tool names now start with
`videogen_`. The internal provider ID remains `modelscope-wan` to preserve saved
logins, routing preferences and wallet history; its display name is ModelScope VideoGen.

```json
{
  "model": "minimax-h3",
  "prompt": "A red ball rolls smoothly from left to right across the table.",
  "first_frame": "/absolute/workspace/first.png",
  "last_frame": "/absolute/workspace/last.png",
  "seconds": 3,
  "size": "1280x720",
  "copy_to_media_root": true
}
```

The adapter discovers `MINIMAX_H3` and its current checkpoint version from
ModelScope's `defaultTemplateV2`; it does not pin a checkpoint ID. New H3 jobs default to `accelerate_lora: true` (4 steps), matching the web UI.
Other models default to false, matching the current web UI, which only shows
this switch for H3. Explicit acceleration is forwarded for every model; a quote
alone does not prove that a model's accelerated generation works. Disable
acceleration to use custom sampling steps. Old queued records without saved
parameters retain acceleration off. Text-only generation is available through
`videogen_generate_t2v`; Omni Reference inputs are not exposed.

Live official quotes verified on **2026-11-13** using a signed-in headless
Chrome session, first/last-frame requests and 1280×720 output:

| Model / setting | 3 seconds | 5 seconds | 10 seconds |
| --- | ---: | ---: | ---: |
| MiniMax-H3 — acceleration off | 68 魔粒 | 113 魔粒 | 225 魔粒 |
| WAN 2.1 FLF2V 14B — default, acceleration off | 17 魔粒 | 28 魔粒 | 56 魔粒 |
| MiniMax-H3 — default, acceleration on | 34 魔粒 | 56 魔粒 | 113 魔粒 |
| WAN 2.1 FLF2V 14B — explicit acceleration on | 3 魔粒 | 6 魔粒 | 11 魔粒 |

These are responses from
`/api/v1/muse/predict/getEstimateConsumeComputeQuota`, not final charges or
generation times. Each submitted job fetches and stores its own current quote;
pricing can change. Use `videogen_estimate` with the same model, mode and
parameters as the intended generation for a current quote.

The same day's headless end-to-end check submitted a 3-second H3 first/last-frame
job, observed `PENDING → PROCESSING → UNDER_REVIEW → SUCCEED`, downloaded its
MP4, and retrieved the preview bundle through `videogen_get_video_result`. ffprobe
measured **3.05 seconds, 1280×704, 24 FPS, with audio** for a requested 1280×720.
The existing specification warning reports that size difference. This confirms
the generation/download path, not exact dimensions or visual quality acceptance.

Jobs persist across restarts. A service interruption during submission is marked `unknown_submission`; the service will not silently submit the job again. Inspect the matching ModelScope account, then reconcile the task:

```sh
curl -X POST http://127.0.0.1:8765/v1/videos/JOB_ID/resolve \
  -H 'Content-Type: application/json' \
  -d '{"provider_task_id":"MODELSCOPE_TASK_ID"}'
```

If you confirmed ModelScope did not create a task, explicitly requeue it:

```sh
curl -X POST http://127.0.0.1:8765/v1/videos/JOB_ID/resolve \
  -H 'Content-Type: application/json' \
  -d '{"confirm_no_task":true}'
```

When `WAN_SERVICE_TOKEN` is set, pass the matching bearer token to these requests too.

## Diagnose and recover tasks

Run `videogen_diagnose` after upgrading. It compares plugin/service version and protocol,
checks live worker threads and input roots, and lists jobs affected by unavailable
accounts or ambiguous submissions. `compatible` means matching code versions,
not that the account network checks all passed; inspect `accounts` and `workers`.

Status and list tools preserve `provider_status` / `last_confirmed_provider_status`
as the last observed provider fact. `phase` and `progress_message` highlight the
current obstacle; `execution_phase` retains the original local processing phase.
`connection`, `blockage` and `timing` expose account availability, the blocking job,
waiting job IDs, queue duration, time since submission and last successful poll.
Generation elapsed time is wall time since submission, not measured compute time.
Connection outage time is measured since this service process detected it; old
jobs without submission timestamps report that duration as unknown.

`videogen_get_video_status` includes the latest 100 persistent `events`. History starts
with this upgrade and cannot reconstruct earlier uploads or submissions. Poll
success time is stored on each query; events record provider state changes and
poll failures/recovery rather than every identical poll. `failure` includes stage,
allowlisted error code/reason and HTTP status where supplied. Raw exceptions and
entire provider responses are not persisted. No supplied reason means **服务端未提供原因**.
`recovery.safe_to_resubmit` describes duplicate-generation safety, not the chance
of visual success. Actual charges remain unknown unless the provider verifies
one; `estimate` is only a quote.

Use `videogen_control_job` with `action: "pause" | "resume" | "cancel" | "reassign"`
and `job_id`; reassign also requires a connected destination `account`. Only
`queued` or `paused` jobs without a provider task ID qualify. Paused jobs leave
the runnable queue; cancelled jobs retain their inputs/history. Cancel means
cancel local waiting only, not cancel a ModelScope generation or delete a file.
If the worker is currently operating on that account, the operation returns busy
and can be retried. Existing provider IDs and uncertain submissions cannot be
cancelled or reassigned locally. Reassignment preserves the job ID and records
the account change; the idempotency key continues referring to that same job.

For `unknown_submission`, use `videogen_reconcile_job` with **exactly one** of
`provider_task_id` or `confirm_no_task: true`, after checking the original
ModelScope account. Linking an ID only resumes querying that ID; it is not an
assertion that a remote task exists. Never confirm absence just because a status
query failed. The original account and history are retained.

`videogen_get_models` exposes all nine current adapter-supported models including
`ltx-2.3`, `wan2.2-ti2v-5b` and `minimax-h3`. Limits describe local validation, not live provider guarantees.
`last_local_download_success_at` is evidence of a downloaded file, not content
acceptance; `quality_acceptance` remains `not_evaluated`. No model is marked as
meeting an action requirement solely because its prompt requested that action.

## Upgrade and migrate existing jobs

1. Stop the old service and back up the entire private data directory. Copy it only while the service is stopped, including the database, any SQLite sidecars, input frames and videos.
2. On the original machine, configure `WAN_MODELSCOPE_ACCOUNTS` with the existing `account-1`, `account-2`, etc. IDs and their original browser logins. Old databases do not contain identity evidence, so the first association must be checked manually. After checking, run `magpie-wan-service --bind-accounts` once, then back up/copy the stopped service data again. This command binds previously unbound identities; it cannot override a mismatch.
3. On the new machine, install the Python service, ffprobe and plugin dependencies. Set `WAN_SERVICE_DATA_DIR` to the copied directory, configure new media roots, and map the same account IDs to the new browser endpoints. Sign in to the same ModelScope accounts. Login fingerprints and their salt travel in the database; browser cookies do not.
4. Start the service. Existing Windows backslash paths are converted to forward slashes automatically; relative paths resolve on Windows, macOS and Linux. Queued inputs already copied to the data directory do not require the original source paths. A missing account ID or changed identity cannot silently resume another account's jobs.

If the old machine is unavailable, perform step 2 on the destination only after manually confirming the original account-to-job correspondence. Without that evidence, leave those jobs blocked. Newly created databases bind accounts automatically on their first worker connection.

Expired video URLs (401/403, or three other failed downloads/validations) are cleared. The worker queries the original provider task for a fresh URL and continues downloading without generating again. `unknown_submission` still requires the explicit reconciliation described above.

## Validation and release

Run `python -m pip install -e '.[test]'`, `python -m pytest -q`, and `npm test` for the offline regression suite. These tests use mocked provider sessions and local HTTP servers, not browsers. The CI workflow checks Linux, Windows and macOS, installs an npm tarball into a clean directory with an isolated npm cache, imports its fourteen tools, and installs the Python service from the same packaged source. A configured workflow is not evidence of a successful run: require it to pass before release. Real ModelScope login, upload and generation still need a separate end-to-end check on a suitable machine.

Before distributing, run `npm pack --dry-run --json` and inspect the whitelist (entry point, package metadata, Python source and documentation only). `npm pack` creates the distributable tarball; a recipient can extract it, follow the Python setup above, install npm dependencies, and run `magpie plugin add .`. No npm registry release is assumed to exist. Publishing requires a chosen license, release destination and a successful clean-install CI run; this change does not publish anything. Never distribute the runtime data directory, browser profiles or an unrelated workspace.

## Privacy

See [PRIVACY.md](PRIVACY.md) for data flow, local storage, and the privacy audit scope.

## GitHub discovery (instructions only)

The [official Magpie plugin documentation](https://usemagpie.ai/docs/plugins#publishing) says that a public, non-fork, non-archived repository with the GitHub **topic** `magpie-plugin` appears under **Plugins → Discover → Unofficial, on GitHub**. This is a repository topic, not a Git tag/release or an npm keyword.

On the repository page, use the gear next to **About**, add `magpie-plugin` under **Topics**, and save. Keep `package.json` at the repository root and the loaded `index.mjs` committed. Magpie checks GitHub at most every ten minutes; indexing can also take time. With a published npm package whose `repository` points here, Magpie installs npm; otherwise it installs the committed repository. Optional `magpie.name`, `magpie.summary` and `magpie.icon` metadata customize its card. Choose a license before public distribution. This work does not add the topic, publish a package, or submit to the curated community catalog.

### Video calls in Magpie Routing

The generation tools opt into the [native plugin-video routing patch](patches/README.md).
With that patched Magpie installed, agent submissions appear in Routing
with agent, model, account, duration, submission result and video job ID.
Open **Request and response** for the returned job status. HTTP 200 means
submission succeeded; use `videogen_get_video_status` for the ongoing generation
and `videogen_get_video_result` for the completed video. Polls and downloads do
not create duplicate generation rows. Older calls are not backfilled.
Official Magpie without this patch continues running all tools normally.


### VideoGen 0.0.2 live validation

On 2026-11-13, the complete nine-model alias set matched the official
`defaultTemplateV2` video list. Catalog search returned matching H3 and LTX
LoRA versions. Two headless generation checks completed and downloaded:

- LTX 2.3 text-to-video, 30 steps, CFG 4, acceleration off: quote 10 魔粒;
  actual 3.041667 seconds, 1280×720, 24 FPS, audio and video.
- H3 first/last-frame, acceleration on, custom LoRA version 1076964 at scale 0.1:
  quote 34 魔粒; actual 3.05 seconds, 1280×704, 24 FPS, audio and video.

These verify the specified paths and settings, not every combination of model,
LoRA, VAE, duration or output size. In particular, lower quotes for explicit
acceleration on non-H3 models are not generation-success evidence.
