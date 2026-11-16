# QianWen Token Plan usage

QianWen Token Plan (`qwen-tokenplan`) on Magpie: the official QianWen CLI's
local sign-in supplies the monthly credit allowance, used percentage, reset
time, and subscription expiry on the Usage card.

## Sign-in

1. Install the official CLI: `npm install -g @qianwenai/qianwen-cli`.
2. Run `qianwen auth login` in the same user environment as Magpie.
3. Add the Token Plan API key to the provider's normal API-key sign-in if
   model calls are configured. The plugin's quota read is independent of the
   API key and never sends it to the quota endpoints.

The CLI stores its credentials in its user configuration directory. This
plugin reads that file with the CLI's credential scheme; it does not start a
long-running bridge, print tokens, or write credentials. The monthly quota
window is read from the CLI's own `subscription`, `quota-config`, and `usage`
endpoints. A missing or expired sign-in is shown as an error, not zero quota.

This package supports the QianWen AI platform's individual Token Plan, not
Alibaba Cloud's separate AccessKey-based quota integrations. The monthly
allowance is the authoritative server response; no five-hour limit is
invented. The plugin does not change model routing or failover policy.

## Tests

```sh
bun test packages/qwen-tokenplan
bun scripts/check.mjs qwen-tokenplan
```

The tests use synthetic credentials and fixed quota responses; they never
read a real home directory or contact QianWen.
