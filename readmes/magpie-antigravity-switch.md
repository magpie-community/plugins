# Antigravity Switch

[简体中文](https://github.com/0xTotoroX/magpie-antigravity-switch/blob/HEAD/docs/README.zh-CN.md) · [Release notes](https://github.com/0xTotoroX/magpie-antigravity-switch/releases) · [MIT License](LICENSE)

View and switch local Antigravity desktop and CLI accounts from Magpie. The page follows Magpie's language and displays the accounts registered under its agy-cli provider.

## Install

Requires macOS, Magpie 0.1.2670 or later, and an existing Antigravity desktop or agy CLI sign-in. Open **Antigravity Switch** from the Magpie sidebar after installation.

From npm:

```sh
magpie plugin add npm:magpie-antigravity-switch@0.2.4
```

From GitHub:

```sh
magpie plugin add github:0xTotoroX/magpie-antigravity-switch#v0.2.4
```

## Accounts and quotas

You can refresh quotas or switch an existing account while another Magpie sign-in is waiting for its authorization code.

**Refresh** syncs the agy-cli provider list and checks enabled accounts' quotas. The current CLI account is checked first, and each row updates as its quota arrives. You can switch accounts while timed-out queries and temporary sign-in renewal failures retry in the background. Click a refresh warning for the affected accounts and their previous reading times.

The table shows the 5-hour and weekly quotas for Gemini on the left and GPT / Claude on the right. Narrow views use circular meters. Reset countdowns use formats such as `6h32min`, `32min`, and `6d4h`. Gemini 4 Carbon appears when a separate reading is available. Disabled accounts appear under **Unavailable accounts**. Missing readings show a dash and expired readings show **Needs refresh**. Common plans use short labels such as Pro and Starter. If agy-cli omits the plan, the plugin looks up the saved Antigravity sign-in for the same email.

The CLI toggle shows or hides both the CLI badge and the **CLI only** buttons. They start hidden and the plugin remembers your choice. On macOS with local agy 1.5 or later, **CLI only** updates the Keychain sign-in used by new CLI processes and shared with the desktop app. Reconnect an existing CodexHost session to use the new CLI sign-in. The checkmark shows which account is saved in Keychain. Click it for details.

Use **Paid only** next to the account count to show available paid accounts. The plugin remembers this choice.

Sign-ins and backups stay on this Mac. Existing Keychain access permissions are preserved. macOS may ask you to authorize access.

## Command line

The standalone CLI requires Node.js 24 or later.

```sh
npm install --global magpie-antigravity-switch@0.2.4
magpie-agy-switch status
magpie-agy-switch switch user@example.com --target=cli
```
