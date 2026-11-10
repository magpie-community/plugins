# Route an Amp model through Magpie

Select a model on Magpie's Amp Agent row, then run `magpie-amp sync` to apply that selection to one personal Amp route. Selection alone does not change cloud routing. Amp still owns its modes, tools, accounts, and threads.

This package has a Magpie descriptor and an explicit CLI. It has no server, watcher, provider entry, runtime dependencies, or Library integration.

## Prepare the endpoint and account

Use Node 20 or later and an installed Amp CLI with model-provider routing commands. Sign in with Amp's own account commands before setup.

Provide an existing public HTTPS Magpie base ending in `/v1`, reachable from Amp's servers. Localhost and private literal addresses are not usable. Do not pass a `/responses` or `/chat/completions` endpoint. Setup validates the URL's syntax, not DNS, TLS, reachability, or authentication. This package does not expose your gateway or create a tunnel.

Choose one exact canonical `provider/model` ID from Amp's catalog or Mode Dial. Choose a compatible target in Magpie. This package does not create canonical models, change their limits, or redirect every Amp mode.

Store a separately provisioned remote-access Magpie gateway key in an owned regular file with mode `0600` or `0400`. Do not use the placeholder `magpie` or `magpie-amp` attribution key. The CLI reads the key only when needed and passes it to Amp through stdin. It never includes the key in arguments or output.

## Install and save local setup

Install the package's CLI and add the same package to Magpie.

```sh
npm install -g @magpie-community/agent-amp
magpie plugin add @magpie-community/agent-amp
magpie-amp setup --base-url "$PUBLIC_HTTPS_V1" \
	--amp-model "$AMP_CANONICAL_MODEL" \
	--gateway-key-file "$REMOTE_GATEWAY_KEY_FILE"
```

Set the variables to your existing endpoint, canonical model ID, and key file path. Setup reads `amp account list --json` and binds the active saved account's `accounts[].userID`. It writes only local CLI settings and state. It does not create a remote connection or require a Magpie selection yet.

From a repository checkout, install the local package with `npm install -g ./packages/amp` and `magpie plugin add ./packages/amp`.

`AMP_URL` identifies the Amp service, not Magpie. Setup binds its current value, defaulting to `https://ampcode.com`. Later commands reject a different service or active saved account. They reject `AMP_API_KEY` overrides. The CLI never copies credentials, signs in, or switches accounts. To use a different binding, use a separate state directory after disconnecting the original installation.

## Apply a selected model

Select a target in Magpie's Amp Agent row. Then inspect and apply it.

```sh
magpie-amp sync --dry-run
magpie-amp sync
magpie-amp status
```

The CLI generates one exact mapping, `canonical/model -> magpie-target/model`. It preserves the selected Magpie ID, including a `group/` prefix. It rejects wildcard, comma, newline, arrow, and malformed identifiers.

The first sync reserves a random installation name locally before submitting `add-router custom-url --personal --no-active`. It reads back the exact inactive route, binds its ID, and activates it only when precedence and warnings allow. Later syncs edit only differing owned fields of that same ID. An unchanged sync performs no cloud writes and does not upload the key again. A changed key file triggers a credential replacement through stdin.

Personal routes use the native CLI's `list --json` readback. The CLI does not delete, adopt, reorder, or edit unrelated connections. An earlier active matching connection produces `routing: "shadowed"`. An unknown default mapping produces `routing: "potentially-shadowed"`. Both block activation of an inactive route and cause applying sync to exit with code 2. Amp warnings also block activation. If readback after activation finds shadowing, potential shadowing, or warnings, sync deactivates only the route it just activated and confirms it is inactive. An already active owned route remains active. Resolve precedence or warnings with native Amp commands if you intend to do so.

Status includes the owned ID, mapping, exact base URL, and active state. `configured-unverified` means the selected configuration matches readback and the route is active. It does not mean inference has succeeded. Read the `routing` field as well. No command performs paid inference, verifies which connection served a request, or proves backend tool and context compatibility.

## Disconnect before removal

```sh
magpie-amp disconnect
```

Disconnect deactivates only the bound route and retains it remotely. Repeating it is a no-op. It ignores Magpie control, so later sync can reactivate the route if a selection remains.

Alternatively, disable the Agent in Magpie and run `magpie-amp sync`. Missing or fully empty control means disconnect. Partial or malformed control blocks sync without deactivation.

Disconnect before uninstalling or removing local state. Removing or disabling the package alone cannot clean up a remote route.

## Resolve pending state and conflicts

`not-configured` means setup has not saved a binding. `prepared/pending` means work remains or a create or edit outcome is uncertain. `disconnected` means no bound route is active. `conflict` means the CLI cannot safely proceed.

An interrupted create keeps its pending marker. A later sync binds only one inactive route with the reserved random name and the full expected nonsecret shape in the bound account. If no such route is visible, the CLI does not submit another create. Inspect that account with native Amp commands and resolve the uncertain outcome before manually changing pending state. A timeout is not evidence that creation failed.

Before an edit, sync saves `pendingEdit` with the bound connection ID and the intended `after` receipt. `lastApplied` is its `before` receipt. Recovery accepts only these two recorded shapes on that same ID, never an arbitrary current selection. Sync converges to the current selection without creating another connection and can resend the current private key through stdin because remote key state is not observable. If the selection changes again, sync preserves the observed known shape as the new `before` before saving a replacement intent. Disconnect can deactivate that owned ID without clearing an uncertain edit. Status and dry-run leave the receipt unchanged and never report a pending edit as configured.

Outside changes to the owned route's nonsecret configuration cause a conflict. Missing bound IDs do not trigger replacement. Restore the expected configuration or resolve the local receipt deliberately. Remote key changes are not observable in nonsecret readback. To replace a remotely changed credential, provide a changed key file and sync.

A `cli.lock` file identifies its process and host. The CLI never guesses that a lock is stale. Confirm that its owner has stopped before manually removing it. The lock coordinates this installation's CLI processes, not native Amp commands or account switching. Account checks surround mutations, but Amp has no proven per-command account pinning. Do not switch accounts or edit the owned route concurrently with these finite commands.

## Keep state owners separate

The default private directory is `~/.config/magpie-amp`, with mode `0700`.

- Magpie owns `control.json` with `{version,model}`. The descriptor supplies only `version: 1` and does not save a gateway key.
- The CLI owns private `settings.json` with `{version,installationId,accountUserId,ampURL,baseURL,ampModel,keyFile}`.
- The CLI owns private `state.json` with `{version,connectionId?,pendingCreate?,pendingEdit?,lastApplied?}`. `pendingEdit` contains `{connectionId,after}`, where `after` is a receipt. Receipts hold nonsecret configuration and a private key digest, not the key itself.

CLI writes use atomic replacement under one mutation lock. Status and dry-run do not write files. Subprocesses use argument arrays, private stdin, no shell, and a 30-second timeout per command. Failures withhold raw Amp output because it might contain credentials.

All commands accept `--state-dir PATH` for isolated state and `--amp-bin PATH` for a known executable or fixture. Magpie's descriptor still uses the default control path. An alternate directory must contain its own control for sync. `magpie-amp help` lists the commands.
