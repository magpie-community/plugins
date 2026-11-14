# Sources and licenses

The Agent and bridge are contributed by
[yee94](https://github.com/yee94), also available in the standalone
[magpie-agent-yuri](https://github.com/yee94/magpie-agent-yuri) repository.
The bridge follows the ownership, journal and host-exit patterns of this
repository's Reasonix Desktop integration. See `LICENSE`.

`vendor/` contains the complete, readable ESM JavaScript sources of
**jsonc-parser 3.3.1**, MIT, copyright Microsoft, from its `lib/esm` directory.
The sole source adaptation adds `.js` to relative import specifiers for Node
ESM resolution. Original comments are retained; there is no minified vendor
blob, bundler or runtime dependency installation. The original license is
included as `LICENSE-JSONC-PARSER`.

To verify against an independently unpacked jsonc-parser 3.3.1 package:

```sh
node packages/yuri/verify-vendor.mjs /absolute/path/to/jsonc-parser/lib/esm
```

The embedded Yuri artwork is unchanged; its source and hash are recorded in
`ASSET_NOTICE.md`, with the source repository's license in `LICENSE-YURI`.
