# @magpie-community/hooks-mail-watch

Email alerts from [magpie](https://usemagpie.ai)'s gateway: a provider error the user should know about, a subscription quota close to or past its line — sent as plain mail through your own SMTP account, with your own words in it.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/hooks-mail-watch`. It has no page and no tab; it watches from beside the gateway.

## What it watches

Two signals, both from files magpie already keeps, read after an exchange finishes:

- **Provider errors** — a model call that ended in a 4xx/5xx (`usage.jsonl`'s own row for the call: status, the vendor's error type and words, provider, model, agent). A try the gateway handed on to another provider is skipped: the request was answered on a later try, so it was no failure of the request.
- **Quota windows** — a subscription account's allowance windows (`quotas.json`), each one a percentage used: exhausted at 100%, or over the low line you set.

## Options

Set them in magpie's plugin options for this package. All of it is yours: the mailbox, the words, and what to watch.

```jsonc
{
  "smtp": {
    "preset": "gmail",             // or host/port/secure by hand; a preset fills all three
    "host": "smtp.example.com",   // a hand-set host wins over the preset
    "port": 465,                  // default: 465 with TLS, 587 without
    "secure": true,               // default true: TLS from the first byte; false = plain relay
    "user": "me@example.com",     // omit on a plain relay that wants no sign-in
    "pass": "the app password",
    "from": "magpie@example.com"  // default: user
  },
  "to": ["me@example.com"],       // recipients; a comma string works too
  "watch": {
    "errors": true,               // provider call failures
    "quotaExhausted": true,       // a window at 100%
    "quotaLow": false,            // a window over quotaLowPct (but under 100)
    "quotaLowPct": 90,
    "providers": []               // empty: every provider; else only these
  },
  "cooldownMinutes": { "error": 10, "quota": 240 },  // one mail per key per window
  "maxMailsPerHour": 20,          // the whole hour's budget, on top of the per-key cooldowns
  "report": { "hours": 6 },       // opt-in only: a periodic usage digest; unset means none
  "template": {
    "subject": "[magpie] {{kind}} · {{provider}}{{window}}",
    "body": "What: {{kind}}\nProvider: {{provider}}{{account}}\n{{modelLine}}{{windowLine}}When: {{time}}\n\n{{detail}}"
  }
}
```

A note on `secure`: it defaults to `true` — TLS from the first byte, the usual submission port (465), which every major mailhost offers. A plain relay must say so explicitly (`"secure": false`): a localhost or LAN mailhost that wants no sign-in. A user/password on a plain wire is refused, because AUTH PLAIN is the password in base64 and a plaintext port would broadcast it. STARTTLS (an upgrade offered on a plain port, port 587's habit) is not supported: the runtime's TLS upgrade dies mid-session on some platforms, so rather than a send that breaks at random, use your mailhost's 465 port instead. TLS is verified against your system's certificate store; `smtp.insecure: true` turns that off for a mailhost with a self-signed certificate you know.

Presets name the mailhosts people actually forward mail through, so the options can just name one and add an address plus an app password: `qq` (smtp.qq.com), `163` (smtp.163.com), `126` (smtp.126.com), `gmail` (smtp.gmail.com), `zoho` (smtp.zoho.com), `yahoo` (smtp.mail.yahoo.com) — all TLS on 465. QQ/163/126 call the password an 授权码， Gmail an app password. A hand-set host or port wins over the preset; an unknown preset is ignored.

The cooldown keys are `provider` + error type (or status), and `provider` + account + window: one mail per key per window of minutes, so a vendor's bad hour is one mail, not four hundred. The cooldown marks the send before it is attempted — a broken SMTP server collects no backlog; the next matching event tries again after the window. On top of that, `maxMailsPerHour` (default 20) caps the whole hour: a bad hour across many keys still stops at N mails. Sent-marks older than the longest cooldown in force are pruned, so the state file doesn't grow without bound.

## Usage digest (opt-in)

Set `report.hours` and the plugin mails a periodic summary of the window since the last digest: calls (ok/failed), credits, tokens in/out, sessions (first 8 characters of the id), agents, providers, models — the shape of your own usage, in English by default (`template.reportSubject` / `template.reportBody` / `template.reportHtml` override the words). It is off unless you set it: filling in SMTP alone never starts a digest. An empty window sends nothing. The digest honours the same `watch.providers` list as the alerts — allow-listed providers only, not the whole gateway — and its timer is armed once per window, so it fires on schedule even while exchanges keep coming (the schedule only moves when you change the hours, or turn the report off).

Quota windows are read as magpie wrote them: the key is `provider/account` (the account lowercased), and a window whose reset time already passed is a stale last reading, not a window still full, so it is skipped rather than re-alerted every cooldown.

## Template variables

| Variable | Fills with |
| --- | --- |
| `{{kind}}` | `error`, `quota exhausted`, `quota low` |
| `{{provider}}`, `{{account}}` | where the call went / whose subscription |
| `{{model}}`, `{{agent}}` | the model asked, the agent that asked |
| `{{status}}`, `{{errType}}`, `{{endpoint}}` | HTTP status, the vendor's error type, the path called |
| `{{window}}`, `{{used}}`, `{{resetsAt}}` | the quota window's name, % used, when it resets |
| `{{time}}` | ISO time the alert was made |
| `{{modelLine}}`, `{{windowLine}}` | ready-made lines, empty when they'd say nothing |
| `{{detail}}` | the whole story: status + error, or window + % + reset |

A `{{name}}` the event doesn't carry becomes empty; braces that aren't a variable (`{{not a var}}`) are left alone. The subject is UTF-8 encoded for the header (RFC 2047), so any language works.

## How it runs

The package is one of magpie's asynchronous gateway hooks (`magpie.hooks`): magpie's Bun host calls `onResponse` once an exchange with a model is over — successfully or not. The hook waits a moment (1.5 s, so a burst of parallel calls is one scan), reads magpie's own log and quota files, and mails what is new through a queue that sends one mail at a time. It never awaits any of this — the bounded hook returns at once, and a broken send must not touch the request or magpie's log. Nothing is imported from npm; the SMTP client is hand-rolled over Bun's own socket API (implicit TLS or a plain relay, full reply-code validation).

State (how far the log was read, what was sent when) sits in `mail-watch-state.json` beside magpie's own config files, written atomically — one file shared with the digest's cursor, so neither walker disturbs the other's place. Its first run starts from the log as it is — a fresh install does not replay every past failure.

Where the files are is decided in one place: a plugin installed from the registry lives under magpie's config dir, so the plugin walks up from its own folder to the folder holding magpie's files — which also finds a portable install's data folder — and otherwise reads `$XDG_CONFIG_HOME/magpie`, else `~/.config/magpie`, the same rule magpie itself follows.

## Privacy

What a call's error said stays between you and your own mailbox: the mail carries the provider, model, agent, status and the vendor's own error words, cut to 400 characters, and nothing else — no conversation content, no prompt text. The hook reads only magpie's own files and your SMTP server; it sends to no third party. The digest, when you turn it on, carries only counts — sessions as id prefixes, agents, providers, models, tokens and credits — and only for the providers on your list, if you set one.

## Test

```sh
bun test packages/mail-watch
```
