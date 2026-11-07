# Magpie provider for OpenCode V2

Yuri original website: **https://useyuri.top**.

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
provider, not the caller UI; it does not independently determine Magpie Usage
attribution. Session requests additionally send `X-Magpie-Session`.
The provider does **not** replace OpenCode's User-Agent or claim to be Yuri.
Magpie's real Agent connection supplies `gateway.key` to `connect({ gateway })`;
the bridge passes that assigned key unchanged as `options.remote.token`. On a
local gateway, Magpie identifies that Agent from its assigned key before looking
at the User-Agent. `X-Magpie-Agent` is a configured advisory label, not proof of
which UI submitted a request; it alone does not relabel a direct OpenCode client.
An existing key assigned to another agent is never rewritten to match `agentID`.

Yuri's cloned source uses the normal OpenCode session/prompt API. The shared
OpenCode service owns the outbound model request and sets its real User-Agent.
No model-client provenance is inferred from a window title, a URL, session text,
or a static `agentID`. If a CLI uses the same provider/key it has the same
connection attribution; this integration cannot claim per-UI isolation.

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
