# Source and licenses

The Agent descriptor and bridge are adapted from
[SivanCola/magpie-agent-reasonix at 7f190e8](https://github.com/SivanCola/magpie-agent-reasonix/tree/7f190e801962e24cd791abaa70c8d2e7ac755a15),
MIT, copyright (c) 2026 SivanCola. See `LICENSE`.

The embedded PNG is Reasonix's unmodified 128 × 128 application icon from
[esengine/DeepSeek-Reasonix e81658d](https://github.com/esengine/DeepSeek-Reasonix/blob/e81658de81ab957d8f9f6277f6a7b48b8400261f/desktop/build/linux/icons/hicolor/128x128/apps/reasonix-desktop.png),
MIT, copyright (c) 2026 Reasonix Contributors. See `LICENSE-REASONIX`.

`vendor.mjs` bundles these exact parsing libraries so this Agent needs no
runtime dependency installation or build scripts:

- `smol-toml` 1.9.1, BSD-3-Clause (`LICENSE-SMOL-TOML`).
- `dotenv` 18.0.9, BSD-2-Clause (`LICENSE-DOTENV`). Only `parse` is exported;
  the bridge never calls dotenv's environment-loading functions.

To regenerate in this package folder with Bun 1.4.4:

```sh
npm install --no-save --ignore-scripts --package-lock=false smol-toml@1.9.1 dotenv@18.0.9
bun build vendor-entry.mjs --target=node --format=esm --minify --outfile=vendor.mjs
```

No original Reasonix or Magpie source changes are needed to use this package.

## 中文

桥接与 Agent 入口改编自上述独立插件，图标来自上述 Reasonix 原始提交，
均保留 MIT 许可。TOML 与 dotenv 解析器以固定版本打包，保留 BSD 许可；
无需安装运行时依赖或执行构建脚本。插件不改动 Reasonix 或 Magpie 程序。
