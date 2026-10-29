# GoAnyAPI for Magpie

GoAnyAPI's complete, publicly advertised **read-only MCP API catalog** as Magpie tools. No API selection list is maintained in this plugin. It supports OAuth login through GoAnyAPI's remote MCP server and API-key login through its REST API.

## Install

Use **Plugins → Discover → Tools for agents** or:

```sh
magpie plugin add @magpie-community/tools-goanyapi
```

Sign in with **GoAnyAPI → Sign in** (OAuth, recommended):

```sh
magpie plugin login goanyapi oauth
```

Alternatively choose **GoAnyAPI API key** or use `magpie plugin login goanyapi api`. Existing API keys can also be supplied with `GOANYAPI_API_KEY` in the Magpie gateway process or through the `apiKey` plugin option. OAuth credentials are kept in Magpie's sign-in storage, and requests use the remote `https://mcp.goanyapi.com/mcp` server; no privileged backend secret is distributed.

## Connecting to agents

Magpie exposes plugin tools at its local Streamable HTTP endpoint `http://127.0.0.1:3425/mcp/magpie/tools`. Add this endpoint to your agent's MCP configuration using the URL shown in Magpie's Plugins page. Installing the plugin alone does not modify an agent's configuration.

All current read-only API definitions come from the public `https://api.goanyapi.com/api/v1/mcp/catalog` JSON Schema directory, with GoAnyAPI's built-in catalog as a failover. New published APIs do **not** require a new PR or changes to this package. **Magpie captures the named tool set when its plugin host loads**; restart/reload the plugin to show newly added tools as individual names. The permanent `catalog` and `call_dynamic` tools read the live catalog at invocation time, allowing access to a newly published API without updating the plugin itself.

## Authentication and credits

- **OAuth**: browser consent and OAuth 2.1/PKCE through GoAnyAPI's authorization server. API calls are sent to the remote MCP server, which validates the user's token.
- **API key**: REST requests to GoAnyAPI API endpoints using the user's API key, no backend-only secrets.
- API calls may consume GoAnyAPI account credits. Tool discovery reads the public catalog and is free.
- Never put API keys, access tokens, refresh tokens, or server-only secrets into public source or issues.

## Development

```sh
node --check packages/goanyapi/index.mjs
bun scripts/check.mjs
bun test
```

Tests are in `packages/goanyapi/tests`. Authentication tests use stubs, not live user credentials.

Source of truth: [GoAnyAPI MCP](https://github.com/GoAnyAPI/goanyapi-mcp). Magpie community repository: [magpie-community/plugins](https://github.com/magpie-community/plugins).