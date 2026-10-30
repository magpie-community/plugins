# @magpie-community/gateway-notify

A push to your phone or team chat when an agent's turn is done — Claude Code, Codex, Gemini CLI or any agent behind [magpie](https://usemagpie.ai) — so a long task can run while you're away from the screen.

```sh
magpie plugin add @magpie-community/gateway-notify
magpie plugin options notify '{"channels":[{"type":"ntfy","topic":"pick-a-long-random-topic"}]}'
```

Then subscribe to the same topic in the ntfy app (iOS, Android, or the web), and you'll hear about every turn that ran 3 minutes or more:

```
✅ Claude Code done · my-project
took 12 min
Model: anthropic/claude-opus-4-7
```

## When it sends

A *turn* starts when your own words reach the model, and ends when the model answers without asking for another tool. magpie sees both, whatever the agent: the hook marks the start in `onRequest` and reads the finished reply in `onResponse`.

- It sends when a turn ends and ran at least `minMinutes`.
- A request that fails (`errors`, on by default) ends the turn too, with ❌ instead of ✅.
- Requests that offer the model no tools — the titles, summaries and probes agents make on the side — are left out: they neither start nor end a turn.
- A new message from you while a turn runs starts it over.
- One push per conversation per `cooldownSeconds`.
- Only your own agents on this computer by default (magpie's local and sharing key). Requests through another gateway key are left out unless `allOrigins` is on.

The hook changes nothing in a request, and sending never holds one up: it returns at once and posts in the background, with a 10-second limit per channel.

## Options

```jsonc
{
  "channels": [                    // one or more; each sends the same push
    { "type": "ntfy", "topic": "…", "server": "https://ntfy.sh", "token": "…", "priority": 3 },
    { "type": "bark", "key": "…", "server": "https://api.day.app", "group": "magpie", "sound": "…" },
    { "type": "serverchan", "key": "SCT… or sctp…" },
    { "type": "feishu", "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/…", "secret": "…" },
    { "type": "dingtalk", "webhook": "https://oapi.dingtalk.com/robot/send?access_token=…", "secret": "SEC…" },
    { "type": "wecom", "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" },
    { "type": "telegram", "token": "123:abc", "chatId": 42 },
    { "type": "webhook", "url": "https://…", "headers": { "authorization": "…" } }
  ],
  "minMinutes": 3,                 // shorter turns send nothing; 0 sends every one
  "cooldownSeconds": 30,
  "errors": true,                  // push a turn that ends in a failed request
  "agents": [],                    // empty: every agent; else only these ids ("claude", "codex", …)
  "allOrigins": false,             // also requests through other gateway keys
  "includeText": false,            // add the start of the model's last answer
  "maxTextLength": 200,
  "lang": "en"                     // "en" or "zh"
}
```

Optional fields are shown with their defaults. A channel missing what it needs (a topic, a key, a webhook) is skipped; `"off": true` turns one off without deleting it. Feishu's and DingTalk's `secret` is the robot's signing secret (签名校验 / 加签), used when the robot asks for it. `webhook` posts `{title, body, event}` where `event` is `{kind, agent, model, project, seconds}`.

## Privacy

By default a push carries the agent, the project folder's name, the model and how long the turn took — no prompt, no reply, no file contents. `includeText` adds the first `maxTextLength` characters of the model's last answer; leave it off when a channel isn't yours alone. A push goes only to the channels you list. Pick an ntfy topic nobody can guess, or use your own ntfy server with a token: anyone who knows a topic on ntfy.sh can read it.

## How it runs

One of magpie's asynchronous gateway hooks (`magpie.hooks`, Magpie 0.1.1273 or newer), in magpie's Bun host. Open turns are kept in memory, by magpie's conversation id (else the agent and its folder); a magpie restart forgets them, so a turn running across one sends nothing. The reply is read in the agent's own API — Anthropic Messages, Responses, Chat completions or Gemini. Nothing is imported from npm.

## Test

```sh
bun test packages/notify
```

The tests run the hooks as the gateway calls them, with every channel faked: no network and no account.
