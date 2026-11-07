# Sources and licenses

The Agent and bridge are contributed by
[yee94](https://github.com/yee94), also available in the standalone
[magpie-agent-yuri](https://github.com/yee94/magpie-agent-yuri) repository.
The bridge follows the ownership, journal and host-exit patterns of this
repository's Reasonix Desktop integration. See `LICENSE`.

`vendor.mjs` bundles **jsonc-parser 3.3.1**, MIT, copyright Microsoft. Only
`parse`, `parseTree`, `modify` and `applyEdits` are exported. This preserves
JSONC comments and avoids a runtime install or lifecycle build script. The
original license is included as `LICENSE-JSONC-PARSER`.

To regenerate from this package's folder with Bun 1.3.14:

```sh
npm install --no-save --ignore-scripts --package-lock=false --workspaces=false jsonc-parser@3.3.1
bun build vendor-entry.mjs --target=node --format=esm --minify --outfile=vendor.mjs
```

The embedded Yuri artwork is unchanged; its source and hash are recorded in
`ASSET_NOTICE.md`, with the source repository's license in `LICENSE-YURI`.
