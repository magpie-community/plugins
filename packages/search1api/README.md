# Search1API for Magpie

Search1API web search, news, agentic search, page retrieval, sitemap discovery,
and trending tools in [Magpie](https://usemagpie.ai/), with browser OAuth and
API key sign-in. The source lives in this community repository and is published as
`@magpie-community/tools-search1api`. It uses native fetch with no runtime
dependencies; request bodies and defaults match the original integration.

## Install

In Magpie, open **Plugins → Add plugin** and enter:

```text
@magpie-community/tools-search1api
```

Or use the terminal:

```sh
magpie plugin add @magpie-community/tools-search1api
```

The package includes its TypeScript source and an `index.mjs` entry. Magpie's
Bun host loads it directly; installation and community packaging need no build.

## Sign in

### OAuth (recommended)

Choose **Search1API → Sign in to Search1API** in the plugin's sign-in controls,
or run:

```sh
magpie plugin login search1api oauth
```

Magpie opens your browser. Sign in with your Search1API account and approve
access, then return to Magpie. The plugin uses a dynamically registered public
OAuth client, authorization code flow with PKCE S256, and a temporary loopback
callback. No client secret or Search1API CLI is required.

The browser must run on the same computer as Magpie. For a remote or container
installation, use an API key instead. The callback expires after five minutes.

Magpie saves access and refresh tokens in `plugin-auth.json` under its config
directory (`~/.config/magpie`, or `$XDG_CONFIG_HOME/magpie`) with file mode
`0600`. The plugin reads only its own `search1api` entry and saves refreshed
tokens through Magpie's `client.auth.set`; it does not maintain a second token
store. Tool calls refresh expiring tokens and retry once after an OAuth `401`.
Refreshes are serialized across simultaneous calls and Magpie processes.

Search1API appears as a sign-in entry with **no chat models**. It authenticates
the tools, not a model provider. One Search1API account is active at a time;
signing in again replaces it.

To remove the saved sign-in:

```sh
magpie plugin logout search1api
```

This removes the local credentials. It does not revoke an authorization at the
authorization server or remove API keys configured separately below.

### API key

Choose **Search1API API key** in the same sign-in controls, or run:

```sh
magpie plugin login search1api api
```

Magpie prompts privately for the key and saves it in its credential store.
Get a key at [s1.dev](https://s1.dev/).

For automated deployments, the plugin also accepts an `apiKey` plugin option
in Magpie's options editor, or `SEARCH1API_API_KEY` in the environment of the
Magpie process. Precedence: plugin option → environment → Magpie sign-in.
An option or environment key overrides a saved OAuth account. `SEARCH1API_KEY`
and the CLI's `s1 login` session are not read.

`baseUrl` is an optional API base URL for a compatible deployment or local
testing. It defaults to `https://api.search1api.com`. HTTPS is required, except
for loopback test servers. OAuth discovery uses that API's protected-resource
metadata and validates the issuer and endpoints.

## Connect your agent

In **Settings → Plugins**, copy the plugin tools MCP address, then add it to
your agent's MCP configuration. The default address is:

```text
http://127.0.0.1:3425/mcp/magpie/tools
```

For Claude Code:

```sh
claude mcp add --transport http magpie-tools \
  http://127.0.0.1:3425/mcp/magpie/tools
```

Other agents use the same Streamable HTTP endpoint. Use the address Magpie
shows if the port or host differs. Remote calls require a Magpie gateway key;
this is separate from your Search1API credential.

Installing the plugin does not write your agent's MCP configuration or replace
its built-in search tool. Magpie exposes tools from all enabled tool plugins
on this endpoint.

## Tools

Magpie prefixes each tool with the plugin name. Use the names reported by
your Magpie tools endpoint.

- `search`: web search, engine selection, site filters, date range and native
  pagination. Page selection works on engines that support it.
- `news`: news search with optional article content.
- `ask`: describe what to find; Search1API chooses engines and a time window
  and returns ranked results. Each completed call costs **5 credits**. It
  returns search results rather than a generated answer.
- `crawl`: retrieve readable page content.
- `sitemap`: discover site links.
- `trending`: GitHub or Hacker News trends.

Tool parameters follow the existing OpenCode integration. Search and news
preserve optional `published_date` and per-result `metadata`; Ask preserves
`intent`, `source`, `relevance`, and `errors`. Attribute Grokipedia results as
“Powered by xAI”. Results are returned as JSON text.

Magpie gives tools a 55-second deadline. Cancellation is forwarded to fetch.
Automatic request retries are disabled to keep calls within that deadline; OAuth
authentication is retried once after refreshing. Other upstream errors return
to the calling agent.

## Development

From this folder, on Node 24 or later (or Bun for the tests):

```sh
npm install --workspaces=false --ignore-scripts --package-lock=false
npm run lint
npm run typecheck
npm run build
npm test
npm pack --dry-run --ignore-scripts
```

The TypeScript build is a local verification artifact in `dist/`; the published
package contains the reviewed source. `lint` checks the entry syntax and runs
the strict TypeScript checks (including unused code and switch fallthrough).

From the repository root, run the same checks as community CI with a temporary
home, as documented in `.github/workflows/pr.yml`:

```sh
bun test
bun scripts/check.mjs
```

The fetch-stub tests replace every fetch with synthetic responses, covering
all six wire bodies, defaults, validation, safe errors, OAuth discovery,
refresh/retry limits and cancellation. Local loopback fixtures additionally
exercise PKCE browser callbacks, key precedence, concurrent refreshes and
logout without real accounts or paid API calls.

An optional integration test uses Magpie's actual Bun plugin host and the same
local fixture. It is outside the default test filename pattern:

```sh
MAGPIE_HOST_PATH=/path/to/magpie/internal/plugin/host.js \
MAGPIE_BUN_PATH=/path/to/bun npm run test:magpie
```

The migrated integration was verified against Magpie host revision
`8ef9fc578ced531b7ca835a3133c37f608a70e6a`. Live-account OAuth consent still
requires manual verification on the machine running Magpie.

## Maintenance and license

Migrated from [Search1API for Magpie v0.1.0](https://github.com/superagents-lab/magpie-search1api/tree/v0.1.0),
commit `89b9cd5fd1c1c105d603768c14404873d697941f`, under MIT. The original
Search1API copyright and license are retained in `LICENSE`.

This replaces the external-package listing proposed in
[#340](https://github.com/magpie-community/plugins/pull/340). Source changes
are reviewed here and published by `@magpie-community` through this
repository's existing publishing workflow; see the root README. This package
does not publish from the original repository's release workflow.
