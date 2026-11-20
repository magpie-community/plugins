# D-message

**English** · [简体中文](README.zh-CN.md)

D-message is a local Magpie plugin for debugging LLM traffic. Use **Trace** to record and search requests, responses, and tool calls. Send a request to **Repeater** to edit individual messages, switch models, inspect the diff, and replay it through the same gateway. D-message supports Chat Completions, OpenAI Responses, and Anthropic Messages.

## Installation

To install the tagged release from GitHub:

```sh
magpie plugin add github:DeePunk42/D-mesage#v0.0.1
```

Open **D-message** in the Magpie sidebar. On first launch, the plugin creates a local credential and saves it through Magpie. Recording is off by default. Choose a client under **Trace → Capture scope**, turn recording on, and send a request from that client through its usual Magpie gateway. Tested with Magpie 0.1.4520.

The npm package is named `magpie-page-d-message`.

## Trace

- **Choose what to record.** Select one or more local agents, or all of them. The scope includes all models used by the selected agents. Magpie supplies the client ID, and clients can send `X-Magpie-Session` to distinguish sessions. Scope changes apply to the next request. Requests already in progress can still receive their responses after recording stops.
- **Find a client.** The picker finds clients in Magpie’s connected-agent model mappings and local gateway history. Opening the picker or requesting MCP status refreshes the list, with a one-minute cache after a successful refresh. To add a client that uses the key `magpie-xxx`, enter `xxx`. Use the trash icon and **Apply scope** to hide a name. Adding it again restores it. **All local agents** still includes every eligible local client.
- **Search the traffic.** Each row shows the agent and a preview of the last message with its role. Filter by preview, agent, session, or model, or narrow the list by record type and status. For a field-specific search, choose `request:`, `response:`, or `tool:` and press Space or Enter to add a condition. For example, `request:"blue sky" response:ok` requires both matches in the same record. Click a condition to edit it or its × to remove it. Click a result to highlight the matching field, then use `‹` and `›` to move between hits.
- **Inspect Codex activity.** Trace pairs tool results with their calls, shows shell exit codes, and labels progress and final answers. Expand **Raw item** to inspect encrypted reasoning or the original tool envelope. Search opens the most relevant matching action in the current request before earlier history.
- **Follow a session.** Requests that carry a session ID collapse into one row. Codex and Claude Code rows use the local session name when available and fall back to the first captured user message. Requests without a session ID stay as individual rows. Click a session to see the latest 40 requests in the middle pane. Older requests appear automatically as you scroll. The branch of the latest capture appears in the leftmost lane. The selected detail tab displays first, then the other tabs load in the background. Drag the divider between the tree and the details to resize them. D-message links each request to the earlier request whose messages it continues. Rows are marked **Side** for requests that the main path did not continue, **Retry** for repeated requests, **Possible compaction** when most earlier history was replaced, **Branch** when it was otherwise rewritten, **Separate** for unrelated conversations in the same session, and **Repeater** for replays. **Active branch only** shows that request and its ancestors. Selecting an older row or sending a replay keeps the highlight on the latest capture. **Request** shows the items added since the parent request, or the full input when there is no parent to compare. **History** opens at the newest messages in the selected request. Scroll up to load earlier messages in groups of 40.
- **Inspect a response.** **Reply** shows message text and tool calls. Use **{}** to switch to the complete recorded response. **Request → {}** opens the complete request JSON. Collapsed messages show tool names beside a wrench icon. Text blocks show decoded text with syntax highlighting and collapsible code blocks. Responses instructions and input/output items, and Anthropic system messages and tool blocks, retain their native fields in the original JSON view. Open **Details** for the protocol, gateway endpoint, session, and original request number. Drag the divider to resize the list or double-click it to reset.

To clear history, click **Clear** at the bottom of Trace and confirm with **Clear all history**. This removes captures, replays, and open and closed drafts, including records hidden by filters. Recording settings and capture scope are preserved.

## Repeater

1. **Open a draft.** Double-click a Trace record or choose **Send to Repeater**. Reopening the same source returns to its tab. Each tab keeps its own draft and replay history.
2. **Edit the request.** Expand a message to change its role or click its content to edit in place. The text editor decodes escapes and keeps indentation and highlighting while you edit. Use **{}** in the Request toolbar for the whole request, or beside a message or block for its JSON. Hover at the far left of a gap and click **+** to insert a message, or focus the gap with Tab and press Enter. The trash icon deletes a message or block. Press Esc to return to preview. Edits save automatically to local SQLite. A failed save provides a retry button. Undo and redo are in the draft menu and support Ctrl/⌘+Z and Ctrl/⌘+Shift+Z.
3. **Pick a model and review changes.** New tabs use the source request’s model, marked **Original**. Click the model name to search Magpie’s catalog by model or provider. Routing groups appear separately. The model selection is part of the draft and can be undone. **Request → Changes** shows a unified diff against the source snapshot, even before the first send. Sending again or selecting a different run keeps the same comparison baseline. Duplicated tabs share the original baseline.
4. **Send and inspect.** Click **Send to model** or press Ctrl/⌘+Enter to make one inference. Each send queues a separate request snapshot. You can keep editing and sending while earlier runs execute. Repeater tabs and MCP share eight execution slots and a FIFO queue of up to 128 waiting runs. Select a queued run to cancel it. After a restart, waiting runs resume and interrupted in-flight runs remain in history. Select a run on the right. **Reply** shows the response and tool calls, with **{}** for the original response. **Request snapshot** shows the request for that run. **Restore draft** loads the selected request into the editor. Drag the request/response divider, or focus it and use the arrow keys, to resize the panes. Double-click it for an even split. Replays use your gateway’s usual billing.
5. **Return later.** **⋯ → Duplicate tab** copies the current draft. **Rename tab** changes its name. Closing a tab with **×** saves it under **Recently closed**. Refreshing or restarting restores tab order, the active tab, the selected run, and unfinished JSON edits. **Delete draft** permanently removes the tab’s draft. Its sent requests remain under **Trace → All records → Repeater**, marked with the run number and original request number. Double-click a run to start from that exact snapshot. **Source agent** identifies the original client.

### Continue a completed run in an agent (macOS)

Use **Send to model** in the **Request** toolbar for a gateway replay. For Codex or DSH captures, **Send to Codex** and **Send to DSH** use the current request draft directly, including when the tab has no replay history. **Send to Claude Code** uses the selected completed replay. Its chevron opens the Magpie client list, marks the source as **Original**, and shows why an action is unavailable. **Run actions (⋯)** contains **View request snapshot** and **Restore draft**.

**Send to DSH** sends the user prompt from the selected run to a branch in the running DeepSeek Harness instance. In **Settings → Replay → DeepSeek Harness**, macOS detects the local desktop Host address. Paste that instance’s launch token, full authorized URL, or existing cookie. DSH Web prints its launch URL in its startup terminal. The token is the value of the `token` query parameter. With official Desktop 0.2.2-rc.5 on macOS, finish any active tasks, quit the app with ⌘Q, then run `"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"` in Terminal. Copy the URL after `dsh web:` and keep the app running. Click **Connect**. The green indicator confirms that the Host accepted the grant. D-message saves the verified cookie and its Host origin in a local owner-only file and restores them after restarting. Enter a replacement credential and click **Update** when the grant expires or DSH moves to a new port. **Forget credential** removes the saved grant. Expand **Host** to override automatic detection. Codex and Claude Code have separate executable settings under **Replay**.

For a DSH trace, edit one text message with role `user` in Repeater and click **Send to DSH**. This also works for user-role context supplied by DSH. D-message forks before the corresponding user input and submits the edited block as the new user prompt. DSH generates its own context and answer on the branch. An unchanged run resends the original user input for the turn.

**Send to Codex** forks the source thread at the edited turn, queues the user input, and opens the branch in Codex App. **Send to Claude Code** opens a native chat in Terminal with the selected run's saved request and answer using Anthropic Messages. Portable text can cross protocols. A supported pending Claude `Read` can continue after you review the file. D-message supplies the earlier history and supported generation parameters when the chat continues through Magpie. Keep D-message running while using this route. **Reopen last chat** restores the last eligible chat after its process exits. Clearing Trace history revokes the route.

## Capture and replay behavior

The request hook records the full JSON object it receives. Concurrent requests get separate IDs. JSON whitespace, HTTP headers, and the final upstream token sequence are outside the capture. If other plugins rewrite requests, their order determines which changes D-message sees. Request bodies may contain credentials or file contents and are stored with the local user’s permissions.

Model traffic continues through the existing Magpie gateway. The authenticated page service listens on loopback port `34891`. Repeater uses a separate client ID and session and sends the edited body using the recorded protocol:

| Protocol | Replay endpoint |
| --- | --- |
| Chat Completions | `/v1/chat/completions` |
| OpenAI Responses | `/v1/responses`, or `/backend-api/codex/responses` for captures from the Codex backend route |
| Anthropic Messages | `/v1/messages` with the standard `anthropic-version` header |

Replays support JSON and SSE responses. A replay sends one request. Client-side tool calls are available for inspection. Provider-hosted tools follow the provider’s behavior. Magpie’s hook does not expose the original authentication or beta headers, so requests that depend on a particular account, beta flag, or `previous_response_id` may require upstream context. Switching models preserves the request protocol. The selected model and gateway determine which fields and tools are supported.

**Missing response content.** Magpie delivers a consolidated reply through an asynchronous callback. In Magpie 0.1.4520, the Responses callback uses `response.completed.response`. When text or tool calls appear only in earlier `response.output_item.done` events, Trace may show a completed request with an empty `output` and a positive output token count. For local Codex captures, **Reply** can show output from the local session log when its response ID matches the capture. The **{}** view shows the original gateway response. The optional [Magpie 0.1.4520 gateway patch](patches/magpie-0.1.4520-responses-output.patch) restores finished items in order when the terminal event omits them. Applying this fix requires building the patched gateway.

**Failed and missing responses.** Trace saves protocol errors directly. When a failure callback lacks a reason, Trace checks Magpie’s local request ledger and shows the final provider error or cancellation. It also checks calls whose capture process exited or whose callback is overdue. If the ledger confirms success, the Reply pane shows **Response not captured**. If the lookup is ambiguous or unavailable, the pane explains that the outcome or the failure details could not be matched. Opening an older incomplete capture with no reply also triggers this check.

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
