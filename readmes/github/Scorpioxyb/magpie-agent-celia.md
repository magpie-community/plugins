# Celia × Magpie

Adds [Celia](https://github.com/Scorpioxyb/celia) to [Magpie](https://usemagpie.ai)'s Agents page, so Celia's assistant runs on a model you pick in Magpie.

把 Celia 加到 Magpie 的 Agents 页。打开后，Celia 的助手用 Magpie 里选的模型工作，费用记在 Magpie 连接的账号上。

## Install / 安装

```
magpie plugin add github:Scorpioxyb/magpie-agent-celia
```

Or in Magpie: Plugins → Add a plugin. / 或在 Magpie 里：插件 → 添加插件。

## Use / 使用

1. Magpie → Agents → Celia, pick a model (a DeepSeek flash route works well).
   Magpie → Agents → Celia，选一个模型（建议 DeepSeek flash 一类）。
2. In Celia, press 重新读取 in Settings, or restart Celia.
   在 Celia 设置里点“重新读取”，或重启 Celia。
3. Switch the Celia row off (or run `magpie celia default`) to go back to the model in Celia's own settings.
   关掉 Celia 这一行（或运行 `magpie celia default`），Celia 回到它设置里原来的模型。

## What it changes / 改了什么

Magpie writes `~/.celia/magpie.json` (model, local gateway address, gateway key) and restores it when switched off. Celia's `config.toml` and `auth.toml` are not touched. Celia only accepts a gateway on this computer (`http://127.0.0.1:<port>`) from this file.

Magpie 只写 `~/.celia/magpie.json`（模型、本机网关地址、网关密钥），关掉时恢复原样，不改 Celia 的 config.toml 和 auth.toml。Celia 只接受这个文件里的本机网关地址。

Requires a Celia version released after 2026-11-08; older versions ignore the file.
需要 2026-11-08 之后发布的 Celia 版本；旧版本会忽略这个文件。
