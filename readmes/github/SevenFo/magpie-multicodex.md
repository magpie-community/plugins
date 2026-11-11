# CXI for Magpie

Manage multiple Codex configurations from one page in Magpie. Give each instance a name and a `CODEX_HOME`, then choose its model independently.

[中文说明](README.zh-CN.md)

## Install

Requires Magpie, Codex CLI and Python 3.9+ on macOS or Linux. cxi is bundled with the plugin.

```sh
magpie plugin add github:SevenFo/magpie-multicodex
```

Open **CXI for Magpie** in Magpie's sidebar. Open a new terminal after installation. Add a directory such as `~/codex/work`, choose a model, then start it:

```sh
cxi work
```

Each instance keeps its own settings, login and sessions. Your default Codex keeps its existing configuration. Restart an instance to apply a new selection; running background daemons are not restarted automatically.

When an instance lives under your home directory, the adapter writes its `config` and `dir` as `~/` paths. Magpie runs disconnect previews in a temporary HOME, so absolute paths could make a preview modify the real instance. Previews never start the manager, and an old watcher exits after the package is replaced.

Regression checks: `python3 -m unittest discover -s tests -p test_controller.py -v`. With Magpie installed, `python3 tests/preview_regression.py` runs three disconnect previews in a temporary config without calling any model API.

The included [cxi](https://github.com/SevenFo/cxi) can also be installed on its own without Magpie. Removing an instance from this page keeps its files and sessions.
