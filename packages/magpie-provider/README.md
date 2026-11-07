# Magpie provider for OpenCode V2

This is the reviewable, community-published provider used by the Yuri Agent.
It connects **OpenCode to Magpie**, not Magpie to another subscription service.
It adds no sign-in, billing channel or registry provider listing. Install the
Yuri Agent in Magpie; do not install this server package in Magpie's plugin host.

```jsonc
{
  "plugins": [{
    "package": "@magpie-community/opencode-magpie-provider@0.1.0",
    "options": {
      "agentID": "yuri",
      "remote": { "baseURL": "http://127.0.0.1:3425/v1", "token": "YOUR_GATEWAY_KEY" }
    }
  }]
}
```

The Yuri bridge creates and owns this entry reversibly. Do not configure both
this package and `opencode-magpie-plugin`: both use plugin id `magpie.providers`.
Existing user-owned installations are detected and left untouched, including
their attribution; the bridge never silently upgrades or rewrites them.

## Attribution and network boundary

`options.agentID` defaults to `opencode`. It accepts a lowercase identifier of
1–64 characters (`a-z`, `0-9`, `.`, `_`, `-`, starting with a letter or digit).
The bridge passes `yuri`; the provider uses it for `X-Magpie-Agent` on model
discovery, model HTTP requests and image calls. The option labels the shared
provider, not the caller UI: a CLI using that same service and provider is also
counted as Yuri. Session requests additionally send `X-Magpie-Session`.
The provider also sets `User-Agent: <agentID>/opencode-magpie-provider`:
Magpie only trusts `X-Magpie-Agent` from another Magpie's User-Agent, so that
header alone cannot identify a direct OpenCode client. Agent-specific gateway
keys remain authoritative; an existing key explicitly named for another agent
must not be silently replaced by this package.

Gateway credentials go only to the configured HTTP(S) API base. Authenticated
discovery and image calls reject redirects. The HTTP hook matches both origin
and API path before adding attribution headers. An explicit `remote` connection
never starts a gateway process or reads the local fast-model settings.

The provider reads Magpie's live `/models` catalog, native protocol and price
extensions, routing groups, limits, modalities and reasoning variants. It
refreshes every 30 seconds and retains the last catalog on errors. It uses
`https://models.dev/api.json` as a supplemental public price catalog, cached in
`$XDG_CACHE_HOME/opencode-magpie-plugin/models.json` (else `~/.cache/...`), with
Magpie/OpenCode caches as read-only seeds. That download carries **no gateway
token**. Image generation can download a returned image URL without gateway
credentials. See `src/gateway.ts`, `src/catalog-cache.ts` and `src/image.ts` for
the complete behavior; this package has no runtime npm dependency.

Without `remote`, it can find/start a local Magpie gateway, as in upstream.
The Yuri bridge always supplies `remote`. This is V2-only; it deliberately has
no fake V1 auth hook. Source provenance and build instructions: `THIRD_PARTY.md`.

## Publication

The source and bundled runtime are published by this repository's standard
`publish.yml`. Before the first npm publication, use the local package directory
only for isolated testing. OpenCode cannot resolve the future npm pin from
Magpie's dist registry; a community npm owner must publish the provider before
users connect the Agent using that pin.
