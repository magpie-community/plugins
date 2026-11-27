# Factory Droid CLI

Use your local Factory Droid installation as a model provider in Magpie or OpenCode. The plugin starts `droid exec --output-format acp` and exchanges Agent Client Protocol (ACP) messages over standard input and output. The [`factory` provider](../factory) connects directly to Factory's API using a device login or API key. Both providers draw on the same quota when they use the same Factory account.

## Installation and sign-in

1. Install Droid on the machine that runs Magpie or OpenCode. Check that `droid exec --help` lists `acp` as an output format. The plugin has been tested on macOS with Droid 1.21.1. If the host cannot find `droid` on its `PATH`, set `FACTORY_DROID_BIN` to the absolute path to the executable.
2. To install from this repository, run `magpie plugin add ./packages/factory-droid` at the repository root.
3. In **Providers**, select **Factory Droid (local CLI)**. Choose **Use local Droid login** if you have already signed in to Droid as the same operating-system user. To use a key, choose **Factory API key** and enter it. You can also set `FACTORY_API_KEY` in the host environment and choose **Use local Droid login**.
4. Select `factory-droid/default` for Droid's default model, or `factory-droid/<model-id>` for a specific model. Droid supplies the model list for the signed-in account. For models with adjustable reasoning effort, the plugin lists the available levels and applies your selection to the ACP session.

## Using Factory models from Codex

After setup, select `factory-droid/deepseek-v4.1-flash-1017` in Codex if your Factory account has access to that model. You can use the same API key you use with the direct provider.

The `factory` provider builds HTTP requests for Factory's model endpoints from the client's messages, tool definitions and history. An adapter update can fix a known incompatibility. Factory evaluates each request, so a later turn or a change upstream can still cause a refusal on the same plugin version. With `factory-droid`, the installed Droid CLI builds the upstream model request. Factory's account permissions and usage policies apply to both providers. See [the report about version 0.1.58 of the direct provider](https://github.com/magpie-community/plugins/issues/1603).

## Model discovery

`magpie plugin list` shows how many models the plugin discovered. The gateway's `/v1/models` endpoint lists the models selected in Magpie for clients to use.

With an API key, the plugin caches model names, image support and reasoning levels by account and Droid executable. A new process can reuse a catalog less than a minute old. After that, a lookup starts a background refresh. If the refresh fails temporarily, the plugin can serve a catalog up to 24 hours old. If Droid rejects the credentials, the plugin clears that account's cache. The first lookup waits up to six seconds, then returns a provisional default entry while discovery continues.

With only a local Droid login, the catalog stays in memory. The plugin refreshes it when the local credential files change. If it cannot identify the current login from those files, it asks Droid for the catalog on every lookup and replays client history to continue tool calls.

## Messages and tools

The plugin accepts Anthropic Messages requests and returns JSON or server-sent events (SSE). It reads the top-level system instructions and the `system`, `developer`, `user` and `assistant` messages in order. It accepts inline base64 images, text documents, search results and tool references. It passes document URLs to the model as links. Setting `thinking.type` to `disabled` hides thinking blocks in the response. A final assistant message containing only text acts as a prefill for the model to continue.

The request's `tools` array defines the tools available to Droid. The plugin exposes them through a temporary stdio MCP server and returns a `tool_use` block for each call. Parallel calls can appear in one assistant response. Append that response to the conversation, execute the tools in the client and return a `tool_result` for every call ID in the batch. The results can span several user messages in the same request, arrive in any order and include accompanying instructions. Missing, duplicate or unknown IDs return HTTP 400. Correct the batch and retry.

When the history and configuration match, the plugin delivers each result to the waiting call. Droid can then use the result, request another tool or answer. If Droid accepts prompts while a turn is running, the plugin also delivers accompanying user instructions and subsequent system messages to that turn.

Droid controls sampling, the output token limit and stop sequences. The `/v1/messages/count_tokens` endpoint estimates input locally from the UTF-8 text size, tool definitions and image count.

## Session reuse and recovery

A stable `x-magpie-session` lets a follow-up send only new messages. The plugin checks the account, session, working directory, subagent, request configuration and conversation history. Reordering tools, changing cache markers or switching to another explicitly selected model can reuse a conversation. For reasoning effort, `x-magpie-effort` takes precedence over `output_config.effort`, followed by `reasoning_effort`. Switching back to the default model, clearing an explicit effort, changing tool definitions or editing the history causes the plugin to rebuild the context.

Each plugin process keeps up to eight sessions. An idle session stays available for two minutes. A session waiting for a client's tool results can stay open for up to ten minutes. The ACP prompt timeout pauses during that wait.

If the client disconnects after delivering a tool result, the plugin waits up to two minutes for the answer. Retrying the same request can retrieve that answer with its original message and call IDs. An identical request still running on its original connection, or conflicting results for the same call, returns HTTP 409. The retry cache holds up to 32 responses, each limited to 512,000 bytes.

When Droid advertises `session/resume`, the plugin saves a checkpoint for completed turns with a stable session ID and for steps waiting on tool results. A checkpoint matches the account, request configuration and history digest. It records the usage already reported and omits the message text. The plugin keeps up to 128 checkpoints, valid for 24 hours.

After a restart or eviction, the plugin tries to resume the Droid session in its original temporary directory and sends the new input. If the previous process exited while waiting for a tool, the new process sends the relevant call and its client-supplied result to the resumed session. If the directory is busy or Droid declines to resume, the plugin replays the client's history. Older exchanges have a default replay budget of 4 MiB, configurable with `FACTORY_DROID_REPLAY_BYTES`. The plugin preserves the current turn and system instructions and tells the model when earlier exchanges were omitted.

The plugin closes the child process and removes its temporary directory when the session ends, is cancelled or expires. Droid retains its own session records according to the Factory configuration.

## Tool permissions

In a chat session, the `PreToolUse` hook allows tool discovery and the session's MCP relay. Only client tools declared for that session can receive one-time ACP approval. The host must allow Droid to run the hook. Organization policy can disable user and project hooks. The temporary directory provides a working directory, and operating-system isolation depends on the host. See [Factory's hook documentation](https://docs.factory.com/harness/hooks).

## Usage and account quotas

At each tool call or final answer, the plugin reads the Droid session's cumulative `tokenUsage`. It reports the increase in input, output, cache-read and cache-write tokens in both JSON and SSE responses. The plugin waits up to 150 milliseconds for a delayed file update. If ACP has already supplied counts for the turn, it can report the increase immediately. A later file update counts only tokens still outstanding. Fields missing from both sources show zero. Retrieving an answer that the client has already received adds zero usage.

With a Factory API key, `magpie quota factory-droid` shows the account's Standard and Droid Core quota windows, plus its extra usage balance when positive. The direct provider shows the same account quota. With only a local Droid login, use `/status` in Droid to check the quota.

Magpie uses the verified model IDs to match each quota pool to its models. Unknown models, custom models and `default` are excluded from pool-based routing. When extra usage is enabled and has a positive balance, Magpie still displays the subscription windows and can route requests to the account after a window is exhausted.

## Web search and images

Run `magpie search add factory-droid` to enable Droid's native WebSearch in Magpie. Results include the page title, URL and snippet returned by the tool.

If the installed Droid exposes GenerateImage, the catalog includes `factory-droid/droid-image`. It uses the image model configured in Droid for the account and supports the OpenAI-compatible `/v1/images/generations` and `/v1/images/edits` endpoints. Both return `b64_json`.

For edits, submit one to four PNG or JPEG references as multipart files or JSON data URLs, up to 5 MiB per image. A request can produce one to four images. Droid passes `size` to the model as the requested dimensions, saves generated images in its local image directory and enforces the organization's image model restrictions. See [Factory's image generation documentation](https://docs.factory.com/droid-cli/image-generation).
