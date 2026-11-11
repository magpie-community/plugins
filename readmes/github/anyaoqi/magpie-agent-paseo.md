<p align="center">
  <img src="icon.svg" width="72" height="72" alt="Paseo Logo" />
</p>

<h1 align="center">Magpie for Paseo</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/magpie-agent-paseo"><img src="https://img.shields.io/npm/v/magpie-agent-paseo.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/anyaoqi/magpie-agent-paseo/blob/main/LICENSE"><img src="https://img.shields.io/github/license/anyaoqi/magpie-agent-paseo.svg?style=flat-square" alt="license" /></a>
</p>

A Magpie Agent plugin that adds **Magpie** provider support to Paseo, allowing Paseo to seamlessly access all LLMs served through the local Magpie gateway.

## Features

- **Automatic Model Sync**: Publishes Magpie's active models and routing groups directly into Paseo's model picker.
- **Reasoning Effort Mapping**: Automatically maps thinking options so Paseo only offers native reasoning levels supported by each model.
- **Safe & Non-Destructive**: Turning the agent off restores your original Paseo configuration untouched.
- **Isolated Credentials**: Generates a dedicated gateway key for Paseo, making tracking in Magpie's usage panel effortless.

---

## Requirements

- Local [Magpie](https://usemagpie.ai) installed and running
- [Paseo](https://paseo.sh) installed and configured on the machine
- Paseo daemon and Magpie running under the same user account
- `paseo` CLI command available on `PATH`

---

## Install into Magpie

### 1. Install Plugin

```sh
magpie plugin add magpie-agent-paseo
```

### 2. Enable in Magpie

Turn on **Paseo** on Magpie's **Agents** page.

### 3. Reload and Use in Paseo

Apply the provider configuration in Paseo:

```sh
paseo reload
```

Then select **Magpie** as the provider when starting a session in Paseo to choose from any of your Magpie models.

---

## How It Works

- **Configuration Management**: The plugin automatically updates provider settings in `~/.paseo/config.json`. If `PASEO_HOME` is set in the environment, Magpie expands it accordingly.
- **Gateway Routing**: All model inference requests travel from Paseo to the local Magpie gateway (`127.0.0.1:3425` by default), which routes them to the upstream AI providers.
