# @magpie-community/gateway-notify

A push to your phone or team chat when an agent's turn is done — Claude Code, Codex, Gemini CLI or any agent behind [magpie](https://usemagpie.ai) — so a long task can run while you're away from the screen.

```sh
magpie plugin add @magpie-community/gateway-notify
TOPIC="magpie-$(openssl rand -hex 12)"; echo "$TOPIC"
magpie plugin options notify "{\"channels\":[{\"type\":\"ntfy\",\"topic\":\"$TOPIC\"}]}"
```

The topic is the only thing keeping your pushes private on ntfy.sh — anyone who knows it can read them — so use a random one like this, never a word or a name. The options the plugin ships with leave the topic empty, and nothing is sent until you fill it in.

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
- Subagents are left out. Claude Code's subagents share their parent's session, so a conversation is the session plus its first user message; one that first shows up while another conversation in the same session is mid-request or running a tool is a subagent, and its end sends nothing and doesn't touch the main turn. A conversation unseen for 15 minutes no longer counts, and agents magpie gives no session id are never treated as nested.
- Compaction doesn't end a turn. Claude Code's summary request (its instructions follow a "CRITICAL: Respond with TEXT ONLY" preamble, often in the same message as the last tool result) and Codex's compaction neither open nor close one. The conversation that goes on from the summary is matched to the conversation that asked for it, and keeps its turn and start time; a subagent that compacts stays a subagent. Codex's local compaction offers no tools, so it's otherwise left out like any side call.
- Claude Code's background agents belong to the turn that launched them. When the Agent tool answers "Async agent launched successfully", the main conversation may stop and say it's waiting: that sends nothing. When the agent finishes, Claude Code resumes the main conversation with a notification (`[SYSTEM NOTIFICATION - NOT USER INPUT]`); that isn't your words, so it doesn't start a new turn, and the push comes when the main conversation ends with no agent still out, timed from your message. Requests from an agent that starts after its parent stopped are still a subagent's (for up to 2 hours).
- A failure push waits `failureHoldSeconds` (60 by default) and is dropped if the conversation goes on, since agents retry 429s and 5xx on their own and Esc reaches magpie as a failure too.
- One push per conversation per `cooldownSeconds`.
- Only requests magpie marks as `local` by default: an agent on this computer that uses no gateway key. Requests with a named gateway key (`gateway-key`, which may be a friend's, and includes magpie's sharing key) and requests from another device (`remote`) are left out unless `allOrigins` is on.

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
  "failureHoldSeconds": 60,        // wait this long before a failure push; a retry cancels it
  "agents": [],                    // empty: every agent; else only these ids ("claude", "codex", …)
  "allOrigins": false,             // also gateway-key and remote requests
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

The tests run the hooks as the gateway calls them, with every channel faked: no network and no account. Compaction and background agents are tested on request bodies recorded from the real `claude` 2.1.316 (`fixtures/claude-2.1.316`, long system reminders and tool schemas cut short, block order and shape as sent): `claude -p` with a sandbox `HOME` / `CLAUDE_CONFIG_DIR` and `ANTHROPIC_BASE_URL` at a local recording endpoint, no API key needed.
