# Comate offline ZIP packages

The build creates two self-contained ZIPs from the maintained `packages/comate`
source: `comate-<version>-macos.zip` and `comate-<version>-windows.zip`. The
version is read from `package.json` and must be a strict semantic version. The
archives contain the same plugin payload, a platform installer, this guide as
`INSTALL.md`, and `SHA256SUMS.txt` covering every installer and payload file.
The build also writes an outer `SHA256SUMS.txt` for the ZIP files.

## Build

Run the builder from the community plugin checkout with Node.js 18 or newer.
It uses only Node's built-in modules and makes no network requests or global
changes. Pass an explicit output directory; the builder does not put archives
in the source tree by default.

```sh
node packages/comate/packaging/build.mjs --out-dir /path/to/offline-artifacts
```

To validate the source and see the planned archive names and hashes without
creating the output directory or writing files:

```sh
node packages/comate/packaging/build.mjs --out-dir /path/to/offline-artifacts --dry-run
```

The builder accepts only the fixed Comate payload files and requires regular
non-symlink sources. It emits deterministic ZIP bytes for identical inputs.

## Install on macOS

1. Extract the whole ZIP to a folder you intend to keep. Magpie registers the
   absolute path to `payload`, so do not move or remove that folder afterward.
2. Open Terminal in the extracted folder and run:

   ```sh
   ./install.command
   ```

   If Magpie is not on `PATH`, provide its executable path. Quote the path if
   it contains spaces:

   ```sh
   ./install.command --magpie "/Applications/Magpie.app/Contents/MacOS/magpie"
   ```

3. The installer verifies the manifest, then runs `magpie plugin add` with the
   absolute extracted `payload` path. It does not start sign-in. To opt in to
   sign-in during installation, add `--login`.

Use `./install.command --dry-run` to verify the package and print the command
without writing files or invoking Magpie. Add `--magpie PATH` if Magpie is not
available on `PATH`.

## Install on Windows

1. Extract the whole ZIP to a folder you intend to keep. Magpie registers the
   absolute path to `payload`, so do not move or remove that folder afterward.
2. Open PowerShell in the extracted folder and run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   If Magpie is not on `PATH`, provide its executable path. Quote the path if
   it contains spaces:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -MagpiePath "C:\Program Files\Magpie\magpie.exe"
   ```

3. The installer verifies the manifest, then runs `magpie plugin add` with the
   absolute extracted `payload` path. It does not start sign-in. To opt in to
   sign-in during installation, add `-Login`.

Use `-DryRun` to verify the package and print the command without writing files
or invoking Magpie. Add `-MagpiePath PATH` if Magpie is not available on
`PATH`. Windows PowerShell 5.1 or newer is required.

## What the installers change

The installer verifies `SHA256SUMS.txt` before registering the plugin. It
does not move the payload or read or modify Comate settings, license files, or
service-discovery files. `magpie plugin add` updates Magpie's own plugin
registration. Sign-in is opt-in; after registration, it can be started later
with `magpie plugin login comate`.

The matching Magpie development branch used for this package's validation is
recorded in the delivery review. This ZIP does not include Magpie; verify that
any released Magpie build used with it includes the corresponding non-stream
error-aggregation fix. No minimum released Magpie version is claimed. The
Windows installer has not yet been tested on a native Windows machine.
