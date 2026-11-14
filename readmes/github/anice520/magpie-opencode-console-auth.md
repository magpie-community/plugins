# OpenCode Console & Go account

Independent community distribution · Unofficial

[GitHub repository](https://github.com/anice520/magpie-opencode-console-auth)

Sign in to your OpenCode Console account in the browser, choose a workspace, and use its Go subscription or pay-as-you-go models in magpie. No manually copied API key is required.

This is an unofficial adapter for OpenCode's public Console device sign-in protocol. It uses the public `opencode-cli` device client ID and identifies its inference requests independently as `magpie-opencode-console-account/0.1.3`.

## Install and sign in

```sh
magpie plugin add github:anice520/magpie-opencode-console-auth
magpie plugin login opencode-go-account
magpie quota
```

For a pay-as-you-go Console workspace, sign in to `opencode-console-account` instead. Each provider keeps its own account sign-in. In the app, install the package in Plugins and select the provider's browser sign-in method.

The browser opens OpenCode's authorization page. Check the displayed device code, sign in, and select the intended workspace. The plugin waits at the server's polling interval and handles pending approval, slow-down, denial, expiry and cancellation.

Models are named `opencode-go-account/<model-id>` or `opencode-console-account/<model-id>`, for example `opencode-go-account/deepseek-v4.1-flash`.

## Difference from Zen Free

The existing `@magpie-community/opencode-zen-free-auth` plugin serves the public free channel. This package signs in to your own **Console account** and serves **Go subscription and pay-as-you-go endpoints**, with workspace budgets and Go allowance windows. It does not serve Console's OpenCode-only free tier or impersonate an OpenCode inference client.

Go and pay-as-you-go requests still count against the workspace's applicable subscription, budget and balance. Installing both account providers does not create additional allowance. OpenCode's workspace permissions and subscription rules continue to apply on the server.

## Models and requests

The plugin discovers models from `/inference/go/v1/models` and `/inference/v1/models`. It preserves the native Chat Completions, Responses, Anthropic Messages or Gemini endpoint declared by each model. Bundled public catalog snapshots provide initial models before sign-in.

Authenticated discovery also reads `/console/api/v2/config`. Model entries there are configuration overlays: an empty `models: {}` does not hide the catalog. Explicit disabled models are hidden. An invalid or unexpectedly empty public catalog fails discovery so magpie keeps its last good list.

Every request reads the currently selected account through `getAuth()`, sends its bearer token and `x-opencode-org-id`, and preserves streaming and cancellation. Conversation IDs are passed through `x-opencode-session`; an independent request such as magpie's built-in model test gets its own session ID when none was supplied.

## Usage and refresh

magpie's `auth.usage` shows the account email and workspace, Go's rolling 5-hour, weekly and monthly windows, and member budgets when the workspace permits reading them. It reads:

- `GET /zen/go/v1/usage`, with `x-opencode-org-id`.
- `GET /console/api/policies/current-budgets`, with `x-org-id`.

Unknown usage is omitted rather than reported as 0%. A partial read preserves the available windows and reports the failure. Budget filters that magpie cannot faithfully represent are displayed without applying them to every model's routing.

magpie owns token renewal and persistence through `auth.refresh`. For OpenCode hosts that do not call that hook, requests and model discovery refresh due tokens through `client.auth.set`, with concurrent refreshes sharing one operation in that plugin instance.

Wallet balance, renewal status, precise Go/Go Plus/Go Teams identification, and per-model Go allowance mapping are not implemented. The plan label is the generic OpenCode Go product name.

## Credentials and data

magpie stores access and refresh tokens in its `plugin-auth.json`; the plugin stores no additional credential file and does not read browser cookies or another application's credential store. OpenCode hosts use their own authentication storage.

Model requests go only to `https://opencode.ai/inference/...`, using the endpoint for the selected Go or Console provider. Authentication, account metadata and usage are sent only to OpenCode's own endpoints. Requests and tokens are not logged. The plugin does not import remote instructions, skills, MCP servers or plugins from Console configuration.

## OpenCode entry points

The package includes magpie-community/plugins' shared OpenCode 2.x adapter and an OpenCode 1.x entry point. The end-to-end browser login, usage and inference checks below were performed in magpie; standalone OpenCode end-to-end behavior has not been verified.

## Validation

```sh
bun test
```

The tests mock all upstream requests and use synthetic credentials. They cover device polling and cancellation, rotated token persistence, workspace selection, native protocol mapping, empty/sparse configuration overlays, independent model tests, streaming and account isolation.

Manual validation on magpie 0.1.3893 and Bun 1.4.4: browser login, authenticated discovery of 30 Go models, all three Go usage windows, and DeepSeek V4.1 Flash through both CLI and application model testing. This does not claim that every listed model or live token rotation has been tested.

## Protocol and icon sources

The account protocol follows OpenCode source at `cbe71595e1f370ff91b3081872b96bbe56519c41`:

- [Console device authorization and refresh](https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/packages/core/src/plugin/provider/opencode.ts).
- [Go usage and member budgets](https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/packages/core/src/usage-limits.ts).
- [Workspace authentication headers](https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/packages/core/src/console-access.ts).
- [Model configuration overlays](https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/packages/core/src/config/plugin/provider.ts).

The embedded OpenCode icon is the unmodified [official favicon](https://github.com/anomalyco/opencode/blob/cbe71595e1f370ff91b3081872b96bbe56519c41/packages/ui/src/assets/favicon/favicon-v3.svg); its MIT notice is in `assets/LICENSE-opencode.txt`. The public catalog snapshots were read from OpenCode on 2026-11-14 and retain only fields used by the plugin.

## 中文

浏览器登录自己的 OpenCode Console 账号并选择工作区，分别通过 `opencode-go-account` 使用 Go 订阅，或通过 `opencode-console-account` 使用按量模型。支持模型发现、Magpie 内置模型测试，以及 Go 的 5 小时／每周／每月额度与成员预算。

与 Zen Free 使用 public 凭证的免费通道不同，本插件使用已授权的 Console 账号，调用 Go 和按量接口，不提供 OpenCode 专属的 Console 免费层。两个提供商不会增加同一个工作区的套餐额度或余额。

Token 由宿主保存和刷新，不读取浏览器 Cookie，也不额外写入凭据文件。充值余额、续费状态、具体套餐档位和按模型拆分的 Go 额度尚未实现。真实端到端验证目前仅覆盖 Magpie 和一个 DeepSeek 模型，未宣称所有模型都经过实测。

## Community discovery

This repository publishes the same provider implementation proposed in [magpie-community/plugins#1130](https://github.com/magpie-community/plugins/pull/1130), independently of that PR's review. It is an independent repository, with package.json and runnable entry points at the root, tagged `magpie-plugin` for Magpie's Discover → Unofficial section. Discovery is automatic and does not imply maintainer review.

GitHub topic indexing, Magpie's catalog rebuild and the app's cache can delay appearance. Installation from the GitHub URL works as soon as the committed files are available; npm publishing is not required.

The independent and proposed community packages use the same provider IDs and account allowance. Choose the package source you intend to keep; installing a second copy does not create additional quota.
