# @magpie-community/middleware-antigravity-cloak

Claude Code and Claude Desktop on an Antigravity account, as [magpie](https://usemagpie.ai) gateway middleware.

Antigravity answers a request whose system prompt reads as Claude Code's or the Claude Agent SDK's (which Claude Desktop's chats use) with `429 Resource has been exhausted`, however much quota is left. magpie shows it as a 400 that says so. Tried with a real account, Antigravity matches these pieces of the prompt:

- Claude Code's billing line, `x-anthropic-billing-header: …`;
- `built on Anthropic's Claude Agent SDK`, the Agent SDK's identity line (Claude Desktop's Code tab and its subagents);
- Codex's own prompt for its GPT-5 models, `You are Codex, an agent based on GPT-5` or `You are Codex, a coding agent based on GPT-5`. A Codex chat begun on a GPT model keeps it after `/model` or a fork onto an Antigravity model, so that chat 429s while a new one works;
- Hermes Agent's earlier default persona, `Hermes Agent, an intelligent AI assistant created by Nous Research`, which a SOUL.md the user edited keeps (Hermes' current default goes through);
- oh-my-pi's first line, `RFC 2119 keywords: MUST, REQUIRED, …`.

Up to 0.1.6 this middleware put zero-width spaces (U+200B) inside them. Since 11-14 Google's check reads past invisible characters, and a broken-up line is turned away as the line itself. This middleware now leaves Claude Code's billing line out and rewords the others with the same meaning: `built on the Claude Agent SDK by Anthropic`, `built on GPT-5`, `built by Nous Research`, `RFC 2119 key words`. It does this in the system prompt only, and only in what an Antigravity account is sent. Every other provider, a Claude subscription above all, gets the prompt as the agent wrote it, even in a routing group that tries Antigravity first. A copy an older version broke up is reworded too.

It needs a magpie with the `onProvider` hook (v0.1.1283 or later): an older magpie loads it and never calls it, so requests go as they came.

magpie v0.1.1641 and later change these same lines on an Antigravity account by themselves (`magpie provider set antigravity prompt=as-written` turns that off), so there this middleware adds only `saidAs` and `extraWords`.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-antigravity-cloak`.

## Before you turn it on

- This changes what Google is sent so that a request it means to refuse isn't refused. It may be against Antigravity's terms, and Google can ban the account for it. Use it on an account you can afford to lose.
- Google can change what it matches at any time. Then the refusal comes back, and magpie may no longer recognise it as this refusal: it can read as a real quota running out and rest the account. If that happens, add the new words to `saidAs`, or turn the plugin off.

## When the 429 comes back anyway

A `429 Resource has been exhausted` while magpie still shows quota left, and while other requests on the same model and account go through (an agent's title request, say), is this refusal, not quota. Something else in that agent's system prompt is being matched. It is often text that isn't the agent's own: a custom prompt, or a plugin or extension that adds to the prompt (magpie-community/plugins#1031 was a DeepSeek Harness plugin's injected prompt).

To find it, replay the failing request with a short user message and take parts of the system prompt out, half at a time, until the 429 stops. Then add a distinctive phrase from the part that brought it back to `saidAs`, with a rewording that keeps its meaning, or change or remove that text where it comes from. This middleware changes only the lines and phrases it is given; it doesn't hide arbitrary prompts.

## Options

```json
{ "saidAs": {}, "extraWords": [], "accounts": ["antigravity"], "off": false }
```

- `saidAs`: more phrases, each with what goes instead, matched whatever their case and white space.
- `extraWords`: phrases broken up with zero-width spaces, as before 0.1.7. Google reads past that since 11-14; prefer `saidAs`.
- `accounts`: the subscriptions it acts on, by kind. `antigravity` is the default.
- `off`: leave every request as it came.

中文：Antigravity 看到 Claude Code / Claude Agent SDK / Codex GPT-5 / Hermes Agent 旧版默认人设 / oh-my-pi 的系统提示词会回一个假的 429。0.1.6 及以前往这几行里插零宽空格；11-14 起 Google 的检查会忽略零宽字符，这招不再有效。现在这个中间件只在发给 Antigravity 账号的请求里，去掉 Claude Code 的计费行，其余几行换成同义说法（built on the Claude Agent SDK by Anthropic、built on GPT-5、built by Nous Research、RFC 2119 key words），其他供应商（尤其是 Claude 订阅）收到的提示词不变。这样做可能违反 Antigravity 的条款，账号有被封的风险，请只用在可以承受损失的账号上。需要 magpie v0.1.1283 或更新版本。如果还剩额度、同一模型的其他请求也正常，却仍然收到 429，说明系统提示词里还有别的内容被匹配到（常见的是自定义提示词，或其他插件注入的内容）：把系统提示词逐段拿掉重放请求，找到触发的那段，再把其中有代表性的短语和同义说法加进 `saidAs`。

After [hexiaolv/magpie-antigravity-cloak](https://github.com/hexiaolv/magpie-antigravity-cloak) (MIT), which breaks a longer list of words in every request, whatever provider it goes to.
