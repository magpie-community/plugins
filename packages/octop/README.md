# @magpie-community/agent-octop

Connect Octop to Magpie: Octop appears
on Magpie's Agents page. Pick a model and Magpie registers itself as an
Octop provider named **magpie**, switching Octop's active model to your
choice. Disconnecting restores the original model and provider.

Octop is a local, self-hosted coding agent. Its LLM providers live in
`~/.octop/octop.db` (SQLite) and its HTTP API listens on the host/port
from `~/.octop/config.json` (default `127.0.0.1:8088`).

## How it works

1. The adapter reads the HMAC secret in `octop.db` and self-mints an admin
   JWT (Octop's API tokens are HS256 JWTs, so no password is needed).
2. Through Octop's HTTP API it creates or updates a provider named
   `magpie` with the gateway URL, key and model list from Magpie.
3. It sets Octop's `active_model` to the model chosen in Magpie.

On disconnect or when the shared plugin host exits, the adapter reverts:
restores the previous active model and removes or reverts the `magpie`
provider. If Octop is unreachable at exit, it falls back to direct SQLite
writes.

## Install

```sh
magpie plugin add @magpie-community/agent-octop
```

Then choose a model for Octop in Magpie's Agents page, or via CLI:

```sh
magpie models octop
magpie octop workbuddy/deepseek-v4.1-flash
```

## Requirements

- Octop installed and running (the plugin writes through Octop's local
  HTTP API).
- `~/.octop/octop.db` and `~/.octop/config.json` readable.
