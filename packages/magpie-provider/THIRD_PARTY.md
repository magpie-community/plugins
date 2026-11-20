# Source and reproducibility

Adapted from [yee94/opencode-magpie-plugin 0.5.1](https://github.com/yee94/opencode-magpie-plugin/tree/2aa62282e3da728748956e770faca6c67714521d),
commit `2aa62282e3da728748956e770faca6c67714521d`, MIT. The original license
and icon are included unchanged. `src/` contains the complete runtime source,
including pricing data; no implementation is downloaded from the original npm
package. The catalog regression tests are adapted from the same source.

This revision was refreshed from the user's upstream checkout, including its
not-yet-committed agentID/native-User-Agent changes. `UPSTREAM.json` records the
base commit and each of those nine source-file hashes; it does not pretend the
working-tree changes are already present in the published 0.5.1 tarball.

Community changes: configurable `agentID` as an advisory header on discovery,
chat and image calls, without overriding the real host's User-Agent;
runtime Magpie sidecar-key reading; models.dev networking disabled unless opted
in; descriptive image-tool documentation; community package metadata;
credential-boundary and lifecycle tests. Existing
`magpie.providers` plugin identity and default `opencode` advisory label remain
compatible. The original package and this package must not be loaded together.

Build from this folder with Bun 1.3.14 (no dependencies or install scripts):

```sh
bun run build
bun test tests
node mutation.mjs
```

`dist/index.mjs` is the unminified bundle committed for dependency-free loading.
The build script rejects other Bun versions; `.github/workflows/pr.yml` rebuilds
with 1.3.14 and checks the bytes against the commit. The public server entry
exports only the native V2 default; source-only setup helpers are not published
as fake legacy plugin entrypoints.
The standard repository `publish.yml` packs and publishes this package. Its
first npm publication requires a community npm owner; OpenCode's npm resolver
does not use Magpie's community-dist fallback.
