# D-message

**English** · [简体中文](README.zh-CN.md)

D-message is a local Magpie plugin for debugging LLM traffic. Use **Trace** to record and search requests, responses, and tool calls. Send a request to **Repeater** to edit individual messages, switch models, inspect the diff, and replay it through the same gateway. D-message supports Chat Completions, OpenAI Responses, and Anthropic Messages.

## Installation

With Magpie installed, run:

```sh
magpie plugin add github:DeePunk42/D-mesage
```

Open **D-message** in the Magpie sidebar. On first launch, the plugin creates a local credential and saves it through Magpie. Recording is off by default. Choose a client under **Trace → Capture scope**, turn recording on, and send a request from that client through its usual Magpie gateway. Tested with Magpie 0.1.4520.

## Trace

- **Choose what to record.** Select one or more local agents, or all of them. The scope includes all models used by the selected agents. Magpie supplies the client ID, and clients can send `X-Magpie-Session` to distinguish sessions. Scope changes apply to the next request. Requests already in progress can still receive their responses after recording stops.
- **Find a client.** The picker combines Magpie’s connected-agent model settings, local gateway history, and client IDs observed by the capture hook. Opening the picker or requesting MCP status refreshes the list, with a one-minute cache after a successful refresh. If the gateway is unavailable, you can use a cached entry or enter an ID manually. The default is the first client in alphabetical order and is fixed when recording starts. If the list is empty, start recording to wait for the first client.
- **Search the traffic.** Each row shows the agent and a preview of the last message with its role. Filter by preview, agent, session, or model, or narrow the list by record type and status. For a field-specific search, choose `request:`, `response:`, or `tool:` and press Space or Enter to add a condition. For example, `request:"blue sky" response:ok` requires both matches in the same record. Click a condition to edit it or its × to remove it. Click a result to highlight the matching field, then use `‹` and `›` to move between hits.
- **Inspect a response.** **Response** shows message text, parsed JSON, and tool calls. Expand **Full response JSON** for the complete recorded object. Collapsed messages show tool names beside a wrench icon. Text blocks offer formatted and **Raw** views. Responses instructions and input/output items, and Anthropic system messages and tool blocks, retain their native fields in **Full JSON**. Open **Details** for the protocol, gateway endpoint, session, and original request number. Drag the divider to resize the list or double-click it to reset.

To clear history, click **Clear** at the bottom of Trace and confirm with **Clear all history**. This removes captures, replays, and open and closed drafts, including records hidden by filters. Recording settings and capture scope are preserved.

## Repeater

1. **Open a draft.** Double-click a Trace record or choose **Send to Repeater**. Reopening the same source returns to its tab. Each tab keeps its own draft and replay history.
2. **Edit the request.** Expand a message to change its role or click its content to edit in place. The formatted view decodes escapes and keeps indentation and highlighting while you edit. **Raw** edits the underlying string. Use **{}** for message or block JSON. To insert a message, hover at the far left of the gap between messages, including the first or last gap, and click **+**. You can also focus a gap with Tab and press Enter. The trash icon deletes a message or block. Press Esc to return to preview. Edits save automatically to local SQLite. **Saved** confirms the write. Each tab supports undo and redo with Ctrl/⌘+Z and Ctrl/⌘+Shift+Z, including insertions, deletions, and snapshot restores.
3. **Pick a model and review changes.** New tabs use the source request’s model, marked **Original**. Click the model name to search Magpie’s catalog by model or provider. Routing groups appear separately. The model selection is part of the draft and can be undone. **Request → Changes** shows a unified diff against the source snapshot, even before the first send. Sending again or selecting a different run keeps the same comparison baseline. Duplicated tabs share the original baseline.
4. **Send and inspect.** Click **Send** or press Ctrl/⌘+Enter to make one inference. Each send saves the request as a separate snapshot. Select a run on the right to see its answer, tool calls, response JSON, request snapshot, and duration. **Restore draft** loads the selected request into the editor. Drag the request/response divider, or focus it and use the arrow keys, to resize the panes. Double-click it for an even split. Replays use your gateway’s usual billing.
5. **Return later.** **⋯ → Duplicate tab** copies the current draft. **Rename tab** changes its name. Closing a tab with **×** saves it under **Recently closed**. Refreshing or restarting restores tab order, the active tab, the selected run, and unfinished JSON edits. **Delete draft** permanently removes the tab’s draft. Its sent requests remain under **Trace → All records → Repeater**, marked with the run number and original request number. Double-click a run to start from that exact snapshot. **Source agent** identifies the original client.

## Capture and replay behavior

The request hook records the full JSON object it receives. Concurrent requests get separate IDs. JSON whitespace, HTTP headers, and the final upstream token sequence are outside the capture. If other plugins rewrite requests, their order determines which changes D-message sees. Request bodies may contain credentials or file contents and are stored with the local user’s permissions.

Model traffic continues through the existing Magpie gateway. The authenticated page service listens on loopback port `34891`. Repeater uses a separate client ID and session and sends the edited body using the recorded protocol:

| Protocol | Replay endpoint |
| --- | --- |
| Chat Completions | `/v1/chat/completions` |
| OpenAI Responses | `/v1/responses`, or `/backend-api/codex/responses` for captures from the Codex backend route |
| Anthropic Messages | `/v1/messages` with the standard `anthropic-version` header |

Replays support JSON and SSE responses. A replay sends one request. Client-side tool calls are available for inspection. Provider-hosted tools follow the provider’s behavior. Magpie’s hook does not expose the original authentication or beta headers, so requests that depend on a particular account, beta flag, or `previous_response_id` may require upstream context. Switching models preserves the request protocol. The selected model and gateway determine which fields and tools are supported.

**Missing response content.** Magpie delivers a consolidated reply through an asynchronous callback. In Magpie 0.1.4520, the Responses callback uses `response.completed.response`. When text or tool calls appear only in earlier `response.output_item.done` events, Trace may show a completed request with an empty `output` and a positive output token count. Expand **Full response JSON** to inspect what was captured. The optional [Magpie 0.1.4520 gateway patch](patches/magpie-0.1.4520-responses-output.patch) restores finished items in order when the terminal event omits them. Applying this fix requires building the patched gateway.

**Unconfirmed completion.** If the capturing process exits, or 16 minutes pass without a completion callback, Trace shows **Completion unconfirmed**. The model’s outcome is unknown. A late callback updates the status and response. Original requests and experiment snapshots are stored separately.

## Local storage

D-message stores history and drafts in `traces.sqlite`. Set `D_MESSAGE_DATA_DIR` to choose a different directory.

| Platform | Default data directory |
| --- | --- |
| macOS | `~/Library/Application Support/D-message/` |
| Windows | `%LOCALAPPDATA%\D-message` |
| Linux | `$XDG_DATA_HOME/D-message` or `~/.local/share/D-message` |

To keep history when upgrading from 1.4.0, disable the plugin and wait for its page service to exit. Move the entire previous data directory to the new location, including any SQLite WAL files and the `page.key` file if present. If the destination already contains data, use `D_MESSAGE_DATA_DIR` to select the directory you want to open.

## Local MCP server

Open **Settings → MCP server**, enable it, choose a port, and save. The default address is `http://127.0.0.1:34892/mcp`. The server listens on IPv4 loopback, independently of the page and model gateway. Ports from 1024 to 65535 are supported. A port change takes effect immediately. If binding fails, the previous listener stays active. Settings persist across restarts.

Use **Copy client config**, or select **Streamable HTTP** in your MCP client, enter the displayed URL, and add the header `Authorization: Bearer <access-token>`. A local client with this token can read captured bodies, control recording, and trigger billable replays. The token belongs in the header.

| Tool | Inputs | Result |
| --- | --- | --- |
| `trace_record` | `action`: `start`, `stop`, `status`, or `configure`. `scope` is optional for `start` and required for `configure`. | Recording state, scope, choices, and cursor |
| `trace_list` | Optional `after` (exclusive), `session`, and `limit` | Ordered summaries, next cursor, and `has_more` |
| `trace_get` | `ref`, optional `view` (`summary`, `request`, or `response`) and `path` (JSON Pointer) | A snapshot or one field, with its latest status |
| `trace_edit` | `ref` and `ops` (`test`, `add`, `remove`, `replace`) | New `draft_ref`, source reference, and changed paths |
| `trace_repeat` | `ref` and `request_key` | A `run_ref` to inspect with `trace_get` |

For example, pass `{"action":"configure","scope":{"agents":["claude","codex"]}}` to `trace_record`, or use `"agents":"all"` for all local clients. Capture accepts the three supported protocols from origins marked `local` or `magpie-key` by the gateway and excludes D-message’s own replays. The UI and MCP share the same saved settings.

To follow new captures, start recording and use the returned cursor as `after` in `trace_list`. Advance it with each returned cursor and poll individual references for completion. References use `trace:`, `draft:`, or `run:` followed by a UUID. Any of these can serve as the source for a draft. Patch operations are atomic. Append to a messages array with `/messages/-`.

To replay an edit, use `trace_edit` to replace `/messages/0/content`, pass the returned `draft_ref` to `trace_repeat`, then call `trace_get` with `view` set to `response` on the resulting run. Retrying the same reference with the same `request_key` returns the same run. A new key starts a new inference. Failed or interrupted runs remain in history. MCP drafts are accessible from the original request’s Repeater tab, and MCP replays appear in Trace.

## Development

From the repository root, run `bun install --frozen-lockfile` and `bun test` to install dependencies and run the isolated end-to-end and stream parsing tests. Run `bun setup.js` to register the working directory as a local development plugin. The local and GitHub installations use the same page port, so enable one at a time on a given machine.
