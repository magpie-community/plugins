# AWS Bedrock SSO for Magpie

[![npm](https://img.shields.io/npm/v/magpie-aws-bedrock-sso)](https://www.npmjs.com/package/magpie-aws-bedrock-sso)
[![license](https://img.shields.io/npm/l/magpie-aws-bedrock-sso)](https://github.com/HaroldLeo/magpie-aws-bedrock-sso/blob/main/LICENSE)

Use Amazon Bedrock's Claude and GPT models in [Magpie](https://usemagpie.ai) with your AWS SSO / IAM Identity Center profile. No Bedrock API key needed.

[GitHub](https://github.com/HaroldLeo/magpie-aws-bedrock-sso) · [npm](https://www.npmjs.com/package/magpie-aws-bedrock-sso) · [Magpie plugin docs](https://usemagpie.ai/docs/plugins)

## Install

```sh
magpie plugin add magpie-aws-bedrock-sso
magpie plugin login bedrock-sso
magpie provider refresh bedrock-sso
```

Login asks for your AWS profile and Bedrock region. Then pick models:

```sh
magpie provider bedrock-sso                                      # list exposed and hidden models
magpie provider models bedrock-sso +us.anthropic.claude-opus-5-5    # expose an example model
```

Use a model ID from the list in place of the example above.

## Requirements

- Magpie with provider plugin support
- AWS CLI v2 and a profile allowed to list Bedrock inference profiles and invoke the selected models
- Your AWS policies decide which models you can invoke

## Models

After sign-in and refresh, the catalog lists active, system-defined Claude and supported GPT inference profiles visible to your account in the region's geography, plus global ones. Tokyo (`ap-northeast-1`) also includes `jp.*` profiles, and Sydney (`ap-southeast-2`) includes `au.*` profiles. Claude Instant, v2 and 3 profiles are excluded. Before sign-in, Magpie shows a small built-in seed list.

Model names look like `bedrock-sso/us.anthropic.claude-opus-5-5` and `bedrock-sso/us.openai.gpt-6.1-terra`. Claude goes through Bedrock's Anthropic Messages API, and GPT goes through Converse.

Limits and prices come from Magpie's local `amazon-bedrock` catalog for matching model IDs. A geography profile the catalog lacks (`us.openai.gpt-5.4`) uses its in-region entry (`openai.gpt-5.4`) instead of showing $0. Otherwise limits are estimates, and unknown prices may appear as zero. Cost estimates are not bills.

## Usage and budgets

The account's Bedrock spend shows in `magpie quota` and on the account's card. It counts every caller in the AWS account, not only Magpie.

- **This week** (on by default): CloudWatch's hourly `AWS/Bedrock` token counts (input, output, cache read and write, and the long-context share), priced from the catalog. Close to real time, refreshed at most every 15 minutes. A `+` means some model had no price. AWS charges about $0.01 per 1,000 metrics read; an account using a dozen models comes to roughly $1 a month.
- **Billed totals** (off by default): Cost Explorer's daily cost for every Bedrock service, Marketplace model editions included. It's what AWS actually charges, but a day or more behind. AWS charges $0.01 for each Cost Explorer call, so it's read at most every 6 hours, about $1.20 a month. Turn it on in the provider's editor (**Billed totals from Cost Explorer**).

Readings are saved in `~/.config/magpie/bedrock-sso-spend.json`, keyed by AWS account (found with STS `GetCallerIdentity`, which is free and needs no permission): only sums, times and hashed keys, no credentials, profile names or account ids. A restart, or `magpie quota` in a terminal, reuses them instead of asking AWS again, and when two processes need a new reading at once, one asks AWS and the other waits for its answer.

### Budgets (optional)

There's no budget by default: spend is shown, and nothing stops. If your company or your own plan caps Bedrock spend, give the plugin the cap:

1. **When you sign in**, answer *Weekly Bedrock budget in US$* (leave it blank for none), then the day and hour (UTC) the week starts. The budget is kept with that account, so two accounts can have different ones. To change it, sign in to the account again.
2. The card then shows the week as a share of the budget, like `Weekly 40% ($80 / $200)`.
3. To have Magpie **stop at the budget**, turn on **Stop at weekly budget** in the provider's editor. Once the estimate reaches the budget, Magpie moves requests to the fallbacks you set (`magpie provider fallback bedrock-sso <provider/model>…`) until the week resets. With the switch off, the budget is shown only.

Set the week to match your cap's own reset. For example, a cap that resets Sundays at 07:00 UTC is Sunday, hour 7.

#### Advanced options

For a monthly budget, more regions or other settings, use the plugin's Options: **Plugins › Installed › AWS Bedrock SSO › Options** in the app, or the terminal. A value here applies to every account and overrides what was given at sign-in; `null` leaves the sign-in's value. Billed totals and stopping at the budget are only ever the switches above, since one costs money and the other stops requests.

```sh
magpie plugin options magpie-aws-bedrock-sso '{"weeklyBudget": 200, "weekResetDay": "mon"}'
magpie plugin options magpie-aws-bedrock-sso off   # back to the defaults
```

| Option | Default | Meaning |
|---|---|---|
| `weeklyBudget` | the sign-in's, else none | US$ a week, against the CloudWatch estimate |
| `monthlyBudget` | none | US$ a calendar month (UTC), against Cost Explorer's bill, which lags a day. Shown only (it never stops requests); needs billed totals on |
| `weekResetDay`, `weekResetHour` | the sign-in's, else `sun`, `0` | When the week starts, in UTC |
| `metricRegions` | the sign-in region | Regions whose token metrics count, like `["us-west-2", "us-east-1"]` |
| `refreshMinutes` | `15` | How long a CloudWatch reading is kept (5 or more) |
| `estimate`, `usage` | `true` | `false` turns off the estimate, or all usage |

Amounts may be written `200` or `"$1,200"`. A setting that can't be read shows on the account's card as not used, and the rest still apply.

The profile needs `cloudwatch:ListMetrics` and `cloudwatch:GetMetricData` for the estimate, and `ce:GetCostAndUsage` for billed totals. A source it can't read is listed as not read; the other still shows.

## Sign-in

- Uses credentials resolved by `aws configure export-credentials`, including non-SSO profiles and roles without `bedrock:CallWithBearerToken`.
- During Magpie login, `aws sso login` runs only if the AWS CLI reports a missing, invalid or expired SSO session. Later you can sign in again in Magpie or run `aws sso login --profile <profile>`.
- Magpie saves the profile name, region and account label in `~/.config/magpie/plugin-auth.json` (or `$XDG_CONFIG_HOME/magpie/plugin-auth.json`). The sign-in record contains no AWS keys. The plugin keeps exported credentials in memory and refreshes them from the AWS CLI on demand, starting five minutes before expiry. The AWS CLI manages its own credential files and SSO caches.
- `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` are honored.
- If `aws` isn't on Magpie's PATH, set `MAGPIE_BEDROCK_AWS_CLI`. On macOS the plugin also checks Homebrew's usual locations.
- Model requests are SigV4-signed over HTTPS to `bedrock-runtime.<region>.amazonaws.com`. Untrusted hosts, ports, paths and redirects are refused.

## Details

<details>
<summary>GPT adapter support and limits</summary>

Supported: text, base64 image data URLs, function tools, tool results, streaming, and supported reasoning efforts.

Rejected: remote image URLs, image-detail controls, malformed tool arguments, named participants, audio, structured output, strict function schemas, web search, prediction, and disabling parallel tool calls. Unsupported controls it recognizes throw an error. System and developer instructions must come before the conversation, and tool history needs tool definitions. Storage-only fields (`store`, `metadata`, `user`) are not forwarded. Encrypted Bedrock reasoning may not replay. The event-stream decoder checks frame bounds and CRC32, with a 32 MiB client frame cap.

</details>

Magpie is the tested host. Direct OpenCode use is unverified. The `opencode` keyword follows Magpie's discovery convention. The provider ID is `bedrock-sso`.

## Development

```sh
npm test                                                   # offline, Node 20+
AWS_PROFILE=your-profile node test/live.mjs                 # billable Bedrock prompts
MAGPIE_TEST_URL=http://127.0.0.1:3499 node test/gateway-live.mjs
```

Replace `your-profile` with your AWS profile name. Both live scripts send billable Bedrock prompts. `gateway-live.mjs` needs an isolated Magpie with this plugin signed in and its test models exposed (defaults: `bedrock-sso/us.openai.gpt-6.1-terra` and `bedrock-sso/us.anthropic.claude-haiku-5-5`; override with `BEDROCK_GPT_MODEL` and `BEDROCK_CLAUDE_MODEL`).

To install from a local checkout, pass the folder path to `magpie plugin add` instead of the package name, and keep that directory.

See [RELEASING.md](https://github.com/HaroldLeo/magpie-aws-bedrock-sso/blob/main/RELEASING.md) for trusted npm publishing and PR auto-merge.

## License

MIT. The icon is from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
