# Bundled native tools

The plugin's own source is MIT. The following separately executed, unmodified
Windows x64 tools retain their upstream licenses. They are not relabeled MIT.
SHA-256 hashes and download URLs are in `bin/manifest.json`. There are no runtime
downloads or install scripts. Other platforms do not execute these binaries.

| Files | Version | License files | Source |
|---|---|---|---|
| oxipng.exe | 10.2.1 | LICENSES/oxipng.txt (MIT) | https://github.com/oxipng/oxipng/tree/v10.2.1 |
| jpegtran.exe, jpeg62.dll | libjpeg-turbo 3.2.1 | LICENSES/libjpeg-turbo.md, LICENSES/libjpeg-ijg.txt | https://github.com/libjpeg-turbo/libjpeg-turbo/tree/3.2.1 |
| cwebp.exe | libwebp 1.6.0 | LICENSES/libwebp-COPYING, LICENSES/libwebp-PATENTS, LICENSES/libwebp-AUTHORS | https://github.com/webmproject/libwebp/tree/v1.6.0 |
| gifsicle.exe, gifdiff.exe | 1.97 | LICENSES/gifsicle.txt (GPL-2.0-or-later) | vendor-sources/gifsicle-1.97.tar.gz |

The bundled GIF source archive accompanies the executables in every published
package; it includes the corresponding source and upstream build instructions.
Its distributor is https://eternallybored.org/misc/gifsicle/ (the matching
`src/gifsicle-1.97.tar.gz` release). Do not omit the archive or license when
redistributing these executables.
