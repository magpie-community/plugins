# Magpie Agent for Trae CN

[中文](README.md)

Use Magpie models and routing groups from Trae CN's own model picker. This is an unofficial **Agent adapter**, separate from the community Trae subscription provider.

## Compatibility and installation

Tested with Windows, Magpie 0.1.3078 and a specific Trae CN 3.4.18 build. Internal model APIs and native credential encoding are build dependent. Version and SHA-256 guards reject unknown client builds. Other operating systems and Trae international are not supported yet.

Install and sign in to Trae CN, configure working models in Magpie, then run:

```sh
magpie plugin add @magpie-community/agent-trae-desktop
```

Enable Trae on Magpie's Agents page. Expand the remaining agents if the row is collapsed. Restart Trae once after the first installation of the refresh component, then choose a model ending in `· Magpie`. Keep Magpie running and Trae signed in. Install only one of the standalone and community packages.

## Behavior

- Synchronizes catalog additions, capability changes and removals. Model selection stays in Trae.
- Preserves streaming, images, tool calls and reasoning parameters through a loopback bridge.
- Deletes unmodified entries it created when removed or disconnected; restores entries it adopted. Manual changes are preserved and reported.
- Journals writes and verifies the native catalog before confirming success, including recovery after lost responses.
- Uses Magpie's Library contract for selected MCP servers, skills and rules.

The bridge listens only on `127.0.0.1:3498`, forwards to the local Magpie gateway, and rejects browser origins. Upstream account, quota and model capability limits still apply.

Trae stores custom models in its account service. The adapter reads the current local Trae sign-in and calls the client's internal model APIs; it does not modify SQLite or sign in to other accounts. Native encoding parameters are read from hash-verified installed files. Client binaries, native codec secrets and user credentials are not distributed.

TraeWork session orchestration still runs in Trae's cloud. Model requests reach the loopback bridge through Trae's reverse tunnel, then Magpie calls the selected upstream. A local model URL does not make the entire TraeWork session local.

## Client refresh and rollback

For open-window updates, the adapter backs up Trae's `out/main.js`, appends a loader and installs `out/magpie-model-refresh.cjs`. The component watches a credential-free catalog revision and emits Trae's existing model-management notification. It does not select models, focus windows, edit prompts or open a debugger port. Unknown builds are left unchanged.

Disconnect the Agent and wait for `disconnected` before uninstalling. Keep the recovery journal until restoration completes. User-edited entries are left intact with `model_edited_in_trae`.

After uninstalling, restore the separate refresh component from the source checkout with `node cli.mjs restore-client`, then restart Trae. Journals and backups are under `%USERPROFILE%\.config\magpie-trae`. Never upload that directory: some files contain credentials.

From a source checkout, `node cli.mjs status` reports synchronization and `node cli.mjs models` lists the bridge catalog.

## Validation

No npm dependencies are required. Run `npm test` on Node.js 20 or newer. `npm run acceptance` requires the installed Magpie executable and its Bun host; it uses a temporary home and local fixture servers, without calling real model accounts.

Version 0.3.3 passed 54 unit tests, nine isolated Magpie integration checks and live TraeWork catalog add, replace and disconnect checks. Menu refresh took about 1.1–1.6 seconds after synchronization completed. Real DeepSeek chat was verified separately; other upstream models require their own validation.

The source also includes an optional, hash-guarded cancellation race patch in `scripts/trae-cancel-patch.mjs`, with `--check`, `--apply` and `--restore`. It is not automatically applied or included in the runtime package. `npm run test:cancel` checks the installed source against six regression cases. Full manual cancellation acceptance is still pending. Restart Trae after applying or restoring it, retain its backup, and revalidate after client upgrades.

## License

[MIT](LICENSE). See [THIRD_PARTY.md](THIRD_PARTY.md) for the reused community login-state decoder and [ASSET_NOTICE.md](ASSET_NOTICE.md) for the Trae icon. No Trae client binaries are included.
