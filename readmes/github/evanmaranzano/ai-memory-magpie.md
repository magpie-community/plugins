# magpie-ai-memory

A Magpie async gateway hook that recalls project-scoped context from [ai-memory](https://github.com/akitaonrails/ai-memory) and appends it to the matching user turn before the request reaches the model provider.

The hook uses `POST /api/v1/search`, not an admin route. It supports OpenAI chat and Responses, Anthropic, and Gemini request bodies. It has no runtime npm dependencies and no build step.

## Install

Pin the initial release:

```sh
magpie plugin add github:evanmaranzano/ai-memory-magpie#v0.1.0
```

Or follow the repository's default branch:

```sh
magpie plugin add evanmaranzano/ai-memory-magpie
```

ai-memory must serve the read-only API. `--enable-web` also enables it:

```sh
ai-memory serve --transport http --enable-api
```

## Scope resolution

Recall is scoped in this order:

1. `workspace` and `project` plugin options, when either is set (both are then required);
2. the nearest `.ai-memory.toml` with a top-level `project`;
3. the normalized `upstream` Git remote, then `origin`, using the repository path without its host (`github.com/acme/api` becomes `acme-api`);
4. the Git root folder name, or `cwd`'s folder name outside Git.

The default workspace is `default`. Missing or ambiguous scope fails closed. `allowUnscoped: true` explicitly permits cross-project search when no `cwd` is available; it is off by default.

Example with an explicit scope:

```sh
magpie plugin options magpie-ai-memory '{"workspace":"default","project":"acme-api"}'
```

Use `skipAgents` for clients that already receive ai-memory context through native hooks and MCP, for example:

```sh
magpie plugin options magpie-ai-memory '{"skipAgents":["claude-code","codex"]}'
```

## Authentication

Credentials are resolved without putting token values in plugin options:

1. the environment variable named by `authTokenEnv` (default `AI_MEMORY_AUTH_TOKEN`);
2. `tokenFile`, relative to `dataDir` when necessary;
3. otherwise `<dataDir>/auth-tokens/default`, which matches a fresh `ai-memory init`.

`dataDir` defaults to `AI_MEMORY_DATA_DIR` or ai-memory's platform data directory. `serverUrl` defaults to `AI_MEMORY_SERVER_URL`, then `http://127.0.0.1:49374`.

Plain HTTP to a non-loopback server is refused unless `allowInsecureRemote: true` is explicitly set. Use HTTPS for a remote memory server.

## Request behavior

- A non-empty `ctx.query` triggers one bounded search. Tool continuations do not search again; they only reattach earlier blocks.
- Sticky blocks follow a SHA-256 fingerprint of the conversation prefix, not a message array index. This preserves the provider prompt-cache prefix when the client resends history.
- The cache is partitioned by session, project, agent, and protocol, with LRU and TTL bounds. Without a session id, sticky reuse is disabled so anonymous conversations cannot share memory.
- Only `local` and `magpie-key` origins are recalled by default. `recallRemote: true` opts into other origins.
- Search snippets are treated as untrusted history, masked for common credential shapes, fence-escaped, and capped with `maxBytes` (default 4000 UTF-8 bytes).
- Errors, timeouts, empty results, and malformed responses leave the request usable. Previously cached blocks may still be reattached.
- `requestTimeoutMs`, `limit`, `ttlMs`, `maxSessions`, and `maxTurns` are configurable.

## Privacy boundary

The current prompt is sent to the configured ai-memory search API. Returned titles, paths, and snippets are then sent to the upstream LLM as part of that request. Secret masking reduces exposure but is not a guarantee. Do not enable recall for a provider or project unless that data flow is acceptable.

This plugin is read-only with respect to ai-memory: it does not capture conversations, write pages, or claim handoffs.

## Current limitations

- Search results are bounded snippets, not full wiki pages. The hook does not make follow-up `read-page` calls.
- Native ai-memory integrations remain preferable when the client already supports them; running both can add duplicate context.
- The design was prototyped with contract-level tests and an isolated ai-memory API harness. This package itself has **not yet been validated inside a real Magpie host or against a live upstream model**.

## License and acknowledgements

MIT. Scope normalization is adapted from ai-memory. The gateway-hook approach was informed by [deja-vu's Magpie extension](https://github.com/vshulcz/deja-vu/tree/main/extensions/magpie).
