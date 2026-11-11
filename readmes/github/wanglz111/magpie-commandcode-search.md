# CommandCode Search for Magpie

[简体中文](README.zh-CN.md)

A search-only Magpie provider that runs DeepSeek through your CommandCode plan.
It returns an answer and source links through Magpie's existing `web_search`.
No HTTP bridge, daemon, Magpie source changes, or Python runtime is required.

This is an independent community project, not an official CommandCode integration.
This is a release candidate distributed from GitHub. It has not been published to
npm or reviewed by magpie-community.

## Requirements

- Linux with working bubblewrap (`/usr/bin/bwrap`). Other platforms are not supported.
- Node.js 22 or later.
- Magpie with provider plugin options and `searches: true` support.
- Official `command-code` CLI **1.84.0**, installed separately.
- A CommandCode plan API key with access to DeepSeek and the CLI's search service.

The CLI is not bundled or installed by a lifecycle script. Its license is
`UNLICENSED`; obtain it directly from its official npm distribution. Installing
this plugin does not grant service access or change your plan's limits or terms.
Use the dedicated npm installation below; pnpm's symlinked dependency layout is
not supported.

## Install

On Debian or Ubuntu, install bubblewrap if needed:

```sh
sudo apt-get install bubblewrap
```

First install the official CLI in a dedicated directory:

```sh
mkdir -p "$HOME/.local/share/commandcode-search-cli"
npm install --prefix "$HOME/.local/share/commandcode-search-cli" command-code@1.84.0
```

Install the plugin directly from GitHub, then configure the actual Node executable
and CLI entry point:

```sh
magpie plugin add github:wanglz111/magpie-commandcode-search
magpie plugin options github:wanglz111/magpie-commandcode-search "{\"node\":\"$(node -p 'process.execPath')\",\"cli\":\"$HOME/.local/share/commandcode-search-cli/node_modules/command-code/dist/index.mjs\"}"
magpie plugin login commandcode-search api
```

For local development, clone this repository, enter its directory, and use
`"$PWD"` in place of `github:wanglz111/magpie-commandcode-search` in both commands.
Keep the checkout in place: Magpie loads local folders directly. Linux must allow
bubblewrap user namespaces; if the sandbox fails, fix that prerequisite rather
than running the CLI without isolation.

Enter the CommandCode plan API key at Magpie's prompt. In **Settings -> Web
search**, select **CommandCode DeepSeek Search / DeepSeek V4.1 Flash Search**.
The full searcher id is:

```text
commandcode-search/deepseek/deepseek-v4.1-flash
```

The login has its own `commandcode-search` auth record, managed by Magpie.
It does not read the existing `commandcode-plan` plugin's credentials or change
its chat models. If your key changes, sign in to this provider again.

To remove it, first select another working searcher in Settings, then run:

```sh
magpie plugin rm github:wanglz111/magpie-commandcode-search
```

Use the local folder path instead if you registered a checkout.

## Options

| Option | Meaning |
| --- | --- |
| `node` | Required absolute path to a real Node executable, not a version-manager shim. |
| `cli` | Required absolute path ending in `node_modules/command-code/dist/index.mjs`. |
| `stateDir` | Optional absolute path for persistent search evidence. Omit for no retained queries or answers. |

With `stateDir`, each successful call writes one private JSON file containing the
query, answer, usage, source snippets and network provenance. You manage its
retention. No API keys or model reasoning are intentionally recorded. Temporary
files are removed on success, failure and request cancellation; a host crash or
forced plugin-host termination can still leave a temporary directory.

## How it works

```text
Magpie web_search
  -> provider loader.fetch
  -> isolated official CLI / fixed DeepSeek model
  -> CommandCode web-search service
  -> Anthropic Messages or SSE answer + sources
```

The provider declares `searches: true` and implements Anthropic Messages. This is
a provider adapter, not gateway middleware; no global request rewrite is needed.
It rejects ordinary chat calls and unsupported hosted-search options before
starting the CLI. It supports `web_search_20250305`, `max_uses` (capped at two),
`allowed_domains` and `blocked_domains`. Domain lists are sent to CommandCode's
search service. `tool_choice: none` and unsupported search options are rejected.

An invocation has 105 seconds, ten CLI turns and an 8 MiB output limit. The CLI's
model requests expose only `search_tools` and `web_search`; complete generation
responses are checked before any returned tool call reaches the CLI. The network
adapter enforces the model and search-count limit before sending those requests.
A successful response requires a completed search tool, an actual HTTP 200 search
response with structured results, a successful DeepSeek generation and a nonempty
final answer. URLs in generated prose alone are insufficient.

SSE is assembled after the complete result is verified, so it does not stream
tokens while the CLI is working. Answers use search snippets, not full webpage
downloads. Search relevance and factual accuracy still depend on the upstream.

## Isolation and maintenance

Bubblewrap starts with an empty filesystem root. It exposes system libraries,
DNS/TLS files, the selected Node executable, the dedicated CLI `node_modules`,
and one temporary run directory. It does not mount the user's home or projects.
The child receives an allowlisted environment and the key needed for this call.
It has a separate PID namespace; cancellation kills its process group and then
cleans the run directory.

This is containment for a trusted CLI, not a hostile-code sandbox. The process
can access the network and its own credential. The adapter observes the CLI's
`fetch`; it is not an OS-wide network firewall. See [security notes](docs/security.md).

The `/alpha/*` routes and CLI NDJSON format are implementation details, not a
documented stable public API. Keep CLI 1.84.0 pinned and revalidate before updating.
Failures surface as errors; the plugin never silently switches providers. This
uses the account represented by the entered plan key; it makes no per-query
price claim.

## Develop

```sh
npm test
npm pack --dry-run
```

There is no build step or runtime npm dependency. Tests use fake keys and local
fixtures; they make no paid model or search calls. On Linux with bubblewrap they
also check the real filesystem isolation and cleanup. On 2026-10-18 this refactor
also passed a separate isolated Magpie 0.1.1285 live test: HTTP 200, 505 answer
characters, one verified search, four source entries, 12.633 seconds. After the
final IO audit, a repeat passed with 231 characters, two source entries and
11.448 seconds. The active production installation was unchanged.
See [audit and scope](docs/security.md).

| File | Responsibility |
| --- | --- |
| `index.mjs` | Magpie provider declaration, login hook, request dispatch. |
| `src/protocol.mjs` | Request constraints, verified result, Anthropic JSON/SSE. |
| `src/body.mjs` | Bounded, cancellable request and upstream response reading. |
| `src/cli.mjs` | Child lifetime, byte limits, cancellation and evidence cleanup. |
| `src/sandbox.mjs` | Linux filesystem mounts and child environment. |
| `src/network-trace.mjs` | CLI fetch policy and structured search provenance. |

For GitHub discovery, npm publishing and community submission, see
[publishing](docs/publishing.md). MIT license; the separately installed official
CLI and remote services keep their own licenses and terms.
