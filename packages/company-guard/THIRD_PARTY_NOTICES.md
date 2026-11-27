# Third-party sources

- Word Guard, `@magpie-community/middleware-word-guard` 0.1.1, MIT. The protocol layout and hook contract were used as a reference. Its existing `cases.json` and `scripts/middleware.mjs` were reused for verification. Source: https://github.com/magpie-community/plugins/tree/main/packages/word-guard . License: `vendor/LICENSE.word-guard`.
- `@noble/hashes` 2.4.0, MIT. Only HMAC and SHA-256 are bundled in `vendor/hashes.js` and the generated middleware. Source: https://github.com/paulmillr/noble-hashes . License: `vendor/LICENSE.noble-hashes`.
- esbuild 0.25.12, MIT, used only to create the local JavaScript bundle. It is not required in the installed plugin and is not a global installation. Source: https://github.com/evanw/esbuild .

Magpie is the unmodified host application. The official page bridge is bundled unchanged in `vendor/magpie-pagebridge.js` for the plugin-hosted receipt page. Its MIT license is retained in `vendor/LICENSE.magpie`. Reference revision: `c42522e2414dfb6bf48c0a33a0b7de088d050f26`, official application version 0.1.3113.
