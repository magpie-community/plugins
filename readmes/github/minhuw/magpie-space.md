# magpie-space

Use ChatGPT Space from any agent that can call a Magpie MCP server. The plugin discovers the current account's `chatgpt_space.*` tools through the signed-in Codex CLI and forwards calls without starting a Codex model turn.

Pages, presentations, workbooks, whiteboards, comments, templates and Space administration use the same adapter. Other Codex connectors, such as GitHub and Google Drive, are not exposed.

## Requirements

- Magpie with community tool and service-page support.
- Codex CLI, tested with `0.171.0`, installed on the machine running Magpie.
- A ChatGPT account signed in with `codex login` and eligible for ChatGPT Space tools.
- Bun for the offline test suite. The plugin itself has no npm dependencies or build step.

Magpie's model-provider login is not a substitute for the Codex CLI login. The plugin runs with the permissions of the Magpie host machine's current Codex account.

## Install

From a local checkout:

```sh
magpie plugin add /absolute/path/to/magpie-space
```

From GitHub:

```sh
magpie plugin add github:minhuw/magpie-space
```

Enable Magpie's built-in **Plugin tools** plugin. The plugin exposes its tools through `/mcp/magpie/tools`; Magpie prefixes them with the installed plugin's short name, for example `magpie-space_list_spaces` and `magpie-space_status`.

## Select a Space

Open **ChatGPT Space** in Magpie's Plugins pages, then:

1. Refresh the list of Drive-backed Spaces available to the current Codex account.
2. Choose a default Space and an access level.
3. Test the connection and save.

The selection is a default destination for **new** Pages and presentations. When a tool accepts `space_id` and the caller leaves it blank or omitted, the plugin supplies the selected ID. An explicit `space_id` is never overwritten. With no selection, creation remains private when the upstream tool supports that behavior.

This is not a security boundary for existing documents. Existing Pages and native artifacts are still addressed by their exact `page_id`; the plugin does not claim to verify that every one belongs to the selected Space.

If the account has no Drive-backed Spaces, the list is empty. Create one deliberately through ChatGPT or an explicitly enabled write tool before using the selector.

## Access levels

- **Read** (default): search, list, read and inspect operations.
- **Write**: ordinary creation, editing, comments and uploads, in addition to reads.
- **Sensitive**: code execution, sharing changes, automation, moves and deletion, in addition to writes.

Every audited tool is described to the agent, and the policy is enforced again on every call. Changes made in the UI take effect immediately. Unknown future upstream tools are never exposed merely because they appeared in the catalog.

Artifact inspection and execution are serialized per `page_id`; different Pages can proceed concurrently. Idempotency keys are preserved, and failed or uncertain writes are never automatically retried.

Magpie tool calls have a 55-second host timeout. Prefer upstream asynchronous operations and execution-status tools for long work. A lost wait does not prove that the cloud edit was cancelled or committed.

### Native Artifact availability

`inspect_artifact` and `execute_artifact_code` additionally depend on the hosted Artifact preparation service. If that service returns `artifact_preparation_failed`, the plugin surfaces the failure without retrying or changing the callback. Do not interpret it as a successful edit or as evidence that ordinary Page writes are unavailable. Verify native Artifact reads on a disposable document before enabling sensitive operations for unattended work.

## Privacy and remote use

The plugin does not read or copy Codex tokens. It starts `codex app-server --listen stdio://`, creates an ephemeral thread and uses the official `mcpServer/tool/call` route to the first-party `codex_apps` connection.

The UI service binds only to `127.0.0.1`; API calls require a random per-service page token and pass loopback Host/Origin checks.

The saved settings contain only `selectedSpaceId` and `access`, with mode `0600`:

```text
${XDG_CONFIG_HOME:-~/.config}/magpie/magpie-space.json
```

Set `MAGPIE_SPACE_CONFIG` to use another settings file. The UI service port defaults to `3489` and can be changed through the plugin's options.

Remote MCP callers share the gateway host's Codex account and saved default Space. Do not offer this plugin to untrusted remote users as if it were multi-tenant isolation. Account/profile switching is not implemented.

## Development

```sh
bun test
node --check index.mjs
```

The suite uses fake App Server and UI backends. It covers discovery, schema forwarding, policy, per-Page ordering, errors, settings, UI API validation and local-write protections without contacting OpenAI.

For an explicit live read-only smoke test using the current Codex login:

```sh
node scripts/smoke-read.mjs
```

This reads tool and Space metadata, not document contents. Live tool availability depends on the account. Large media results, long-running imports and write/sensitive operations should be validated against a private test Space before broad use.

## Publishing

Publish the package to npm, then submit an external entry to `magpie-community/plugins` in its root `registry.json` with `package`, `name`, `kind: "tools"`, and English and Chinese `summary` fields. Independent packages can also be discovered from GitHub with the `magpie-plugin` repository topic; that route is unreviewed.

## License

MIT
