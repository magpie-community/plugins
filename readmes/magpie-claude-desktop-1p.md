# Magpie Claude Desktop 1P

English | [简体中文](README.zh-CN.md)

Use the models you configured in [magpie](https://github.com/yetone/magpie) inside Claude Desktop, while keeping your native Claude sign-in.

![Magpie models in Claude Desktop's Code model menu](assets/model-menu.png)

## Install

1. On magpie's **Plugins** page, add the plugin: `github:chxsong/magpie-claude-desktop-1p`
2. Under **Agents → Claude Desktop 1P**, turn on the connection and choose the models to show.
3. On first connection, trust the local certificate, then press **⌘Q** to fully quit and reopen Claude Desktop.

macOS only for now. Requires magpie's local HTTP gateway.

## Uninstall

Disconnect **Claude Desktop 1P** in magpie and quit Claude Desktop, then remove the plugin on the **Plugins** page.

## Risks

The plugin runs a local proxy that decrypts part of Claude's HTTPS traffic to add model options and forward requests. Claude credentials are removed before requests are forwarded to magpie. It is designed to avoid violating Anthropic's terms as far as possible, but risks remain. Use at your own risk.

## Development

```sh
npm ci --ignore-scripts
npm run build
npm test
```

## License

MIT
