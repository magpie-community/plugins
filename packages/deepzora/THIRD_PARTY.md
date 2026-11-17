# Source and licenses

The Agent descriptor and original bridge are from
[SivanCola/magpie-agent-deepzora at a547f57](https://github.com/SivanCola/magpie-agent-deepzora/tree/a547f57),
MIT, copyright (c) 2026 SivanCola. See `LICENSE`.

The host-exit restoration, reserved-credential protection, additional tests
and dependency bundling follow the existing MIT-licensed
[`reasonix-desktop` package at 907847b](https://github.com/magpie-community/plugins/tree/907847b/packages/reasonix-desktop).
The Deepzora provider fields, Agent ID and configuration paths remain
Deepzora-specific; it does not use the Reasonix adapter.

The embedded PNG is Deepzora's unmodified 128 × 128 application icon,
AGPL-3.0-only. See `ASSET_NOTICE.md` for its exact source and brand policy,
and `LICENSE-ICON` for its license. This asset is separately licensed from
the plugin code.

`vendor.mjs` bundles these exact parsers so this Agent needs no runtime
dependency installation or build scripts:

- `smol-toml` 1.9.1, BSD-3-Clause (`LICENSE-SMOL-TOML`).
- `dotenv` 18.0.9, BSD-2-Clause (`LICENSE-DOTENV`). Only `parse` is exported;
  the bridge never calls dotenv's environment-loading functions.

The bundle is byte-identical to the existing `reasonix-desktop/vendor.mjs`.
To regenerate in this package folder with Bun 1.4.4:

```sh
npm install --no-save --ignore-scripts --package-lock=false smol-toml@1.9.1 dotenv@18.0.9
bun build vendor-entry.mjs --target=node --format=esm --minify --outfile=vendor.mjs
```

## 中文

Agent 入口与原始桥接来自独立 Deepzora 插件，补充保护与测试沿用社区已有的
Reasonix 桥接模式，均保留 MIT 许可。图标采用单独的 AGPL-3.0-only 许可，
来源和品牌政策见 `ASSET_NOTICE.md`。TOML 和 dotenv 解析器以固定版本打包，
保留 BSD 许可；无需安装运行时依赖或执行构建脚本。
