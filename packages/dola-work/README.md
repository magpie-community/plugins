# Dola Work (Dola, formerly Cici)

**This is not a model API.** Dola has no model interface for other clients, so
this plugin drives its desktop app the way a person does: it starts Dola from a
profile of its own, opens a new work task, switches it from 本地电脑/Local
Computer to 云电脑/Cloud Computer, picks the model, writes the whole request
into the input as one message, and reads the reply as Dola renders it. The
client's tools are asked for as `<tool_call>` text and given back as
`tool_calls`. One request at a time, text only.

## How it differs from `packages/doubao-work`

Dola shares the Saman/Chromium shell with 豆包工作 — same window chrome, same
`brief_list` action-bar request, same work-task UI — but it is **another
service and another account**: `www.dola.com` (and `.cici.com`) instead of
`www.doubao.com`, Cici/Dola sign-in instead of a Doubao one. Both entries can
be installed side by side and signed in to their own accounts.

What that changes inside the plugin:

- `APPS`: the Dola app (`Cici.app`, bundle `com.bot.pc.cici`,
  `www.dola.com`) instead of `DoubaoWork.app` / `Doubao.app`.
- `dataDir`: `magpie-dola-work` instead of `magpie-doubao-work`, so the two
  plugins never share a profile, a port file or a model cache.
- `isChat`: the page reports `dola://dola-chat/chat/`; 豆包 reports
  `chrome://doubao-chat/chat`.
- `CLOUD`: the work-task mode menu says "Cloud Computer" in the English
  profile, taken as well as 云电脑, and pressed up to three times because the
  menu animates.
- `checkin`: Dola has none. `/alice/ug/campaign/landing/checkin` answers 404
  on www.dola.com, so the task reports `inactive` rather than failing daily.
- `usage`: `/alice/commerce/sale/subscription/quota/summary/` is 404 too, so
  an account is reported with no windows instead of a failed read.

Both apps are single-instance per bundle id on macOS: the plugin uses its own
window, and the app the user runs themselves has to be quit first (the plugin
says so instead of failing silently).

## Install and sign in

```sh
magpie plugin add @magpie-community/opencode-dola-work-auth
magpie plugin login dola-work
```

Signing in opens a separate Dola window from a profile of the plugin's own;
your everyday Dola is not touched, and you sign in once inside that window.
macOS and Windows; the app is found in `/Applications`, `~/Applications`,
Spotlight, a running copy, or one folder down in the usual places.

## Models

Read from Dola's own work-task menu (the `brief_list` request its page makes),
so the account gets the models its subscription shows: 自动/Auto, Dola 2.1
Lite, DeepSeek V4.1 Flash, GLM 5.3/5.4, Kimi K3.1 Pro, Qwen 4 Max, GPT 6 Sol
and so on — the id is the name, `dola-work/<model>`. A request may also name a
model by its own key or by its name. Each model's reasoning levels are offered
as variants and picked with `reasoning_effort`.

## What it does not have

No 签到 and no plan-allowance read, for the reason above: those two endpoints
are not served on www.dola.com. Everything else — model discovery, streaming
text, tool calls, reasoning — works the same as the 豆包工作 entry.

## License

MIT.