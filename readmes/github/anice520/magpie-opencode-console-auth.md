# OpenCode Console & Go

Sign in to OpenCode Console in a browser and choose the workspace to use in Magpie. This community plugin provides two separate sign-ins:

| Provider | Models |
| --- | --- |
| `opencode-go-account` | OpenCode Go subscription models |
| `opencode-console-account` | OpenCode Console pay-as-you-go models |

The existing Zen Free plugin uses the public free endpoint. This plugin uses your Console account and its workspace's Go allowance or paid credits. Choose the provider that matches how you want the request billed.

## Install and sign in

In Magpie, add the plugin from **Plugins**, then choose browser sign-in for the provider you want. Verify the device code and select the intended workspace. No API key entry is needed.

```sh
magpie plugin add github:anice520/magpie-opencode-console-auth
magpie plugin login opencode-go-account
magpie quota
```

Use `magpie plugin login opencode-console-account` for pay-as-you-go. Model names start with the provider ID, for example `opencode-go-account/deepseek-v4.1-flash`.

## Usage

Magpie's Usage page shows the selected workspace, the Go 5-hour, weekly and monthly windows with their reset times, and any readable Console budgets in USD. Console budgets apply to paid usage, including Go Extra Usage paid from credits. They are displayed for Go without blocking requests that are still covered by the subscription.

The Go quota windows do not apply to promotional models that the Go catalog reports as free. When available, the plugin also shows whether Go Extra Usage is enabled as an informational row.

Budget remaining is the amount left under a spending limit. When available, the plugin also displays the workspace prepaid balance and the Go paid period end and confirmed renewal state. The monthly quota reset is independent of the plan renewal date. These optional details use undocumented Console UI endpoints and may be absent if unavailable or unrecognized; quota and budget reads continue independently. For full plan and billing details, visit [Console billing](https://opencode.ai/docs/console/billing/).

## Credentials and requests

Magpie stores the access and refresh tokens in `plugin-auth.json` and renews them for the selected account through `auth.refresh`. The plugin sends credentials only to `https://opencode.ai`, rejects redirects, and does not read browser cookies.

The package also ships OpenCode 1.x and 2.x entry points. Standalone OpenCode users sign in again after expiry. Sign in again when upgrading an older OpenCode 1.x installation that did not retain the workspace ID. Existing Magpie credentials need no migration.

The plugin uses OpenCode's device authorization with the public `opencode-cli` client ID and sends its own User-Agent. Model discovery reads the public catalog and applies the selected workspace's model settings. An empty settings object makes no changes; explicitly disabled models stay hidden. An invalid catalog leaves Magpie's previous list in place. Inference uses the protocol declared by the model and preserves conversation IDs; a standalone model test gets its own ID.

## Development

```sh
bun test
```

The tests mock OpenCode responses and use synthetic accounts. For upstream changes, see OpenCode's [device authorization](https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/packages/core/src/plugin/provider/opencode.ts), [usage and budget responses](https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/packages/core/src/usage-limits.ts), and [workspace configuration](https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/packages/core/src/config/plugin/provider.ts). The bundled catalog snapshots come from OpenCode's public model endpoints. The OpenCode icon's MIT notice is in `assets/LICENSE-opencode.txt`.

## 中文

在 Magpie 的「插件」中添加后，从服务商页面选择浏览器登录，核对设备码并选定工作区。使用 Go 订阅选 `opencode-go-account`，使用 Console 充值余额按量付费选 `opencode-console-account`。

「用量」页显示 Go 的 5 小时、每周和每月额度及重置时间，以及可读的 Console 预算。预算剩余是还能支出的预算上限。可读取时也显示工作区预付余额、Go 付费周期结束时间、已确认的续费状态和 Extra Usage 开关；月度额度重置时间与续费日期彼此独立。这些可选信息来自未公开文档的 Console 界面接口，不可用或格式不符合预期时会省略，不影响额度和预算读取。
