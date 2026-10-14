# @magpie-community/opencode-amp-auth

The models of [Amp](https://ampcode.com) (Kimi, GLM, Gemini, Qwen,
MiniMax, DeepSeek, GPT, Claude …), billed to the Amp account's credits,
through Amp's own plugin API and the sign-in of the amp CLI. Provider id:
`amp`.

It needs the amp CLI installed ([Amp's manual](https://ampcode.com/manual)
says how) and signed in:

```sh
amp login
```

## How it reaches Amp

Amp has no model API for other programs. Its agent runs on Amp's servers,
and the routes older Amp clients called (`/api/provider/…`) now answer
"This version of Amp is no longer supported". What Amp offers is
[plugins](https://ampcode.com/manual#plugins), and a plugin can call
`amp.ai.generate`: one of Amp's models answers, billed to the account. So:

1. The package keeps a folder of its own, `$XDG_DATA_HOME/magpie-amp`
   (else `~/.local/share/magpie-amp`; `MAGPIE_AMP_DIR` changes it), and
   puts its Amp plugin, [`bridge.ts`](bridge.ts), in that folder's
   `.amp/plugins`. Only Amp sessions in that folder load it: your own Amp
   sessions don't.
2. On the first request, it starts `amp --no-tui` in that folder. The
   bridge listens on a free port of `127.0.0.1` and answers only requests
   with the key in the folder's `key` (a random one, mode 0600).
3. Each chat completion is one `amp.ai.generate` (two at times, see
   [Tool calls](#tool-calls)), billed through one private thread the bridge
   makes once and keeps in `thread` (and makes again if you delete it in
   Amp).
4. When no request has come for 30 minutes (`MAGPIE_AMP_IDLE_MINUTES`),
   the bridge stops the runner. The next request starts it again, in
   about 2 seconds.

The amp CLI signs in and keeps its own key. The package never reads it.

The runner is an Amp runner like any `amp --no-tui`: while it runs, it is
in your account's runner list (`amp runner list`), as `magpie-<random>`.

## Sign in

- **Use the amp CLI's sign-in** runs `amp usage` and takes the account
  the CLI is signed in to. There is nothing to approve. The account is
  the CLI's: `amp logout` signs magpie out too.

## Models

The account's list is `amp plugins show-agent-options`. Each model is
offered by its own name (`amp/kimi-k3` for `moonshotai/kimi-k3`), or by
Amp's full id when two providers' models share a name. Kimi K3, GLM-5.3
and Gemini 3.8 Flash come first, because magpie offers the first 24 when
you have picked none (`magpie provider models amp +<model>` picks one).

What a model costs, and whether it answers, is Amp's to say:

- GPT models go through the ChatGPT subscription linked in Amp, when one
  is.
- Claude models follow Amp's Claude setting: with "Subscription only"
  they are refused.
- A model Amp lists but doesn't serve is a 404, which magpie can fall
  back from (`deepseek-v4-pro` was one).

### Reasoning effort

Each model takes only some efforts, and Amp's default (none) is refused
by most. A request without an effort asks for `low`. When a model
refuses an effort, Amp's error lists the ones it takes ("Available
efforts: low, high, max"): the request is asked again at the nearest
(the higher of two as near), and the list is kept in `models.json` for
the next requests. Every model is offered with `low`, `medium`, `high`,
`xhigh` and `max` until its list is known.

### Tool calls

`generate` takes one system text and one prompt, and has no native tool
calls. So the conversation is written as a transcript: the tools and how
to call them go in the system text, and the model calls a tool by
writing an `<amp_call name="…">{…}</amp_call>` block.

Some models at times write a call in their own native format instead,
which their serving stack takes out of the text: Kimi K3 and GLM 5.3
answered nothing, and Kimi K3 once only the sentence before the call
("Fixing them:"). Such an answer, empty or ending in a colon with no call,
is asked again as an object, `{content, tool_calls}`, which holds the
model to JSON. Object inference in turn refuses a model that answers in
text, as Kimi K3 did in four turns of five: that one is asked again for
text. An object whose calls are written in its `content` instead of
`tool_calls` is read for them: `<amp_call>` blocks, GLM's own format, or a
JSON list of `{name, arguments}`, as GLM-5.3 wrote. Only calls of the
request's own tools count.

Each model is asked first the way that has failed it least, counted per
model in `models.json`, so most turns are one `generate`. Only turns that
show how the model calls tools are counted: a final answer in text, which
object inference refuses too, is neither way's failure. GPT and GLM models
start with the object: asked for text, GPT-6 Luna said it couldn't run
commands and called no tool. The others start with text.

## Usage

`amp usage`: the account's credits left, on magpie's Usage page.

## What it doesn't do

- **Streaming.** `generate` answers once the whole turn is in, so a
  streamed request gets the turn in one piece.
- **Token counts.** Amp tells a plugin none, so the replies carry no
  `usage`. `amp threads usage <thread>` gives what the bridge's thread
  has cost.
- **Images.** A picture in a message is written as `[image omitted]`.

## Settings

| Variable | |
|---|---|
| `MAGPIE_AMP_DIR` | the bridge's folder |
| `MAGPIE_AMP_IDLE_MINUTES` | minutes without a request before the runner is stopped (30) |
| `AMP_BIN` | the amp CLI, when it isn't on `PATH`, `~/.local/bin` or `~/.amp/bin` |
| `MAGPIE_AMP_LOG` | `1`: each request's model, effort, way, time and call counts in the folder's `calls.jsonl`, with no content |

## Tests

```sh
HOME=$(mktemp -d) bun test packages/amp
```

They use a fake amp CLI and a fake bridge: nothing is started or billed.
