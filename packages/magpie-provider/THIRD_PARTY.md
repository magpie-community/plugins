# Source and reproducibility

Adapted from [yee94/opencode-magpie-plugin 0.5.1](https://github.com/yee94/opencode-magpie-plugin/tree/2aa62282e3da728748956e770faca6c67714521d),
commit `2aa62282e3da728748956e770faca6c67714521d`, MIT. The original license
and icon are included unchanged. `src/` contains the complete runtime source,
including pricing data; no implementation is downloaded from the original npm
package. The catalog regression tests are adapted from the same source.

Community changes: configurable `agentID` on discovery, chat and image calls
(both the attribution header and direct-client User-Agent);
community package metadata; credential-boundary and lifecycle tests. Existing
`magpie.providers` plugin identity and default `opencode` attribution remain
compatible. The original package and this package must not be loaded together.

Build from this folder with Bun 1.3.14 (no dependencies or install scripts):

```sh
bun run build
bun test tests
```

`dist/index.mjs` is the unminified bundle committed for dependency-free loading.
The standard repository `publish.yml` packs and publishes this package. Its
first npm publication requires a community npm owner; OpenCode's npm resolver
does not use Magpie's community-dist fallback.
