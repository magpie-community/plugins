# D-message

<img src="page/icon.svg" width="112" height="112" alt="D-message logo" />

**English** · [简体中文](README.zh-CN.md)

Trace and inspect model requests and responses through the Magpie gateway. Edit a captured request and replay it against a model, or send the edited user input to an agent session.

## Install

With Magpie installed, add the published npm package:

```sh
magpie plugin add npm:magpie-page-d-message@1.0.1
```

You can also install the same version from GitHub:

```sh
magpie plugin add github:DeePunk42/D-message#v1.0.1
```

## Record and replay a request

1. Open **D-message** in the Magpie sidebar. Under **Capture scope**, select the client you want to record.
2. Click **Start recording**, then make a request from that client through its usual Magpie gateway.
3. Open the capture in **Trace** to inspect it, or click **Send to Repeater** to edit a draft.
4. In **Repeater**, edit the request, optionally select a model from Magpie’s catalog, and click **Send to model**. Select any run in **Reply** to inspect its response or open **⋯ → View request snapshot**.

## Trace

![Trace showing 12 agent sessions on the left, an 11-request Codex session with a retry and side branch in the center, and expanded test and diff output on the right](docs/screenshots/trace.png)

- **Capture scope** lists clients from Magpie’s agent model mappings and local gateway history. If a client uses `magpie-xxx` as its gateway key, add it as `xxx`. Clients can send `X-Magpie-Session` to distinguish conversations.
- **Search** across requests, responses, and tool calls with `request:`, `response:`, and `tool:`. Combine terms to narrow results, for example `request:"blue sky" response:ok`.
- **Sessions** group requests by session ID. Codex and Claude Code names appear when available locally. Open a session to follow its branches, retries, and compactions. **Active branch only** follows the latest captured request back through its ancestors.
- **Request** shows input added since the parent request, or all input if there is no parent to compare. **History** shows the context sent with the selected request and loads older messages as you scroll up. **Reply** shows the recorded output and tool calls. Use **{}** in **Request** or **Reply** to inspect the corresponding protocol JSON.

## Repeater

![Repeater showing earlier messages and an edited Codex prompt on the left, with the fourth replay’s progress message and release note on the right](docs/screenshots/repeater.png)

- Edit individual messages or use **{}** to edit the full request JSON. **Changes** compares the draft with the source request. Drafts save locally, and each tab keeps its own replay history.
- **Send to model** queues a single inference through Magpie. The run keeps the exact request snapshot it sent. Change the model in the picker to test the same request against a different model. Gateway charges apply.
- **Reply** shows the selected run. Use **{}** for its raw response, or choose **⋯ → Restore draft** to load its request snapshot back into the editor.

### Send to an agent on macOS

All three agents can receive the current **Request** draft directly from Repeater. When switching clients, the destination starts a new session with only the current user message. D-message reuses the source Codex workspace when it can identify it. Other transfers use the local `replay-workspace`. Claude background jobs require a trusted workspace and valid model credentials.

| Action | What it uses |
| --- | --- |
| **Send to Codex** | The current draft from a Codex capture. Forks the original thread before the edited turn, queues the user input, and opens the branch in Codex App. |
| **Send to DSH** | The current draft from a DeepSeek Harness capture. Forks the matching turn in the running local DSH instance and sends the user input there. You can edit the text of one existing user message. |
| **Send to Claude Code** | The current Claude Code request draft. Edit a user text block and send it directly. Claude starts a background session in the source workspace with the history before that input. The first input starts a fresh session. |

Claude Code requires a trusted workspace and a login or model configuration available to its background worker. Repeater shows the job ID and reports when approval is needed. Use `claude attach <job-id>` to take over. This action submits only the user input.

Configure Codex and Claude Code executable paths in **Settings → Replay agents** when automatic detection is insufficient. To connect DSH, open **Settings → Replay agents → DeepSeek Harness**, paste the local launch URL, token, or cookie, and click **Connect**. The credential field’s help shows how to find the startup URL. Use **Host** to override the detected local address and **Forget credential** to remove the saved credential.

## Local data and capture limits

- Recording is off by default. With recording on, Trace saves request JSON and available gateway responses for selected clients that connect locally or use a Magpie key.
- History and drafts are stored in `traces.sqlite` under the data directory listed below. A connected DSH credential is also stored locally. **Trace → Clear → Clear all history** deletes captures, replays, and drafts.
- D-message can read local Codex and Claude Code session data to show session names and recover Codex output missing from the gateway response. When sending to Codex or DSH, it can read the corresponding local session logs to locate the source turn. It checks Magpie’s local request ledger for missing responses and uncertain outcomes.
- The page service and optional MCP listener bind to loopback. **Send to model** sends the edited request through the Magpie gateway using the original protocol.

| Platform | Default data directory |
| --- | --- |
| macOS | `~/Library/Application Support/D-message/` |

Set `D_MESSAGE_DATA_DIR` to use a different directory.

## MCP

Upgrading from 0.0.1? Refresh the MCP tool list in your client. Use `recording` for capture control and `trace_find` / `trace_read` for inspection. To edit and replay, open a shared tab with `repeater_open`, edit it with `repeater_tab`, then call `repeater_send_model`.

The MCP listener is off by default. In **Settings → MCP server**, enable the listener, choose a local port, and click **Apply**. Use **Copy client config**, or configure Streamable HTTP at the displayed address (default `http://127.0.0.1:34892/mcp`) with `Authorization: Bearer <access-token>`. Local clients with the token can read captures, edit shared drafts, start billable model runs, and send requests to agents with native tools.

| Tool | What it does |
| --- | --- |
| `recording` | Check recording status, configure capture scope, or start and stop capture. Starting returns a cursor for following new captures. |
| `trace_find`, `trace_read`, `session_tree` | Search requests, replies, and tool calls across captures and replays. Follow new captures with `after_capture`, browse session branches, or read a record as messages or protocol JSON. |
| `repeater_open`, `repeater_tab` | Open a tab shared with the UI, edit its draft with JSON Patch and the current `revision`, or inspect its diff, model runs, and agent dispatches. |
| `repeater_models`, `repeater_send_model`, `repeater_cancel` | List Magpie models, queue a single inference, and cancel runs still waiting in the queue. Read the returned `run_ref` with `trace_read`. |
| `repeater_agent_options`, `repeater_send_agent`, `repeater_dispatch_status` | Check available native targets for the current draft, send to the selected agent, and look up delivery status with `dispatch_ref`. |

`repeater_send_agent` defaults to `resend_prompt`. Send the current `tab_ref` and `revision` with a `target_agent` of `codex`, `dsh`, or `claude`. This uses the draft’s user input directly, so Claude Code can start a background session without an earlier model run. The legacy Claude Code mode, `continue_from_reply`, uses a completed `run_ref` from the tab. The dispatch receipt can include the native session ID, background job ID, or linked Trace. Check the native session for the task result.

Use a new `request_key` for each intended send and reuse it when retrying that send. The UI and MCP share draft revisions. After upgrading, refresh the tool list in your MCP client at the same endpoint.

## Development and license

Run `bun install --frozen-lockfile` and `bun test` from the repository root. Use `bun setup.js` to register the working copy with Magpie for development.

Development builds run from the `dev` branch. Only stable releases are published to npm. See the [development and release workflow (中文)](CONTRIBUTING.md).

[MIT License](LICENSE)
