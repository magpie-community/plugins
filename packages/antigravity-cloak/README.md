# @magpie-community/middleware-antigravity-cloak

Claude Code and Claude Desktop on an Antigravity account, as [magpie](https://usemagpie.ai) gateway middleware.

Antigravity answers a request whose system prompt reads as Claude Code's or the Claude Agent SDK's (which Claude Desktop's chats use) with `429 Resource has been exhausted`, however much quota is left. magpie shows it as a 400 that says so. Tried with a real account, Antigravity matches these pieces of the prompt:

- Claude Code's billing line, `x-anthropic-billing-header: …`;
- `You are a Claude agent, built on Anthropic's Claude Agent SDK`;
- Codex's own prompt for its GPT-5 models, `You are Codex, an agent based on GPT-5` or `You are Codex, a coding agent based on GPT-5`. A Codex chat begun on a GPT model keeps it after `/model` or a fork onto an Antigravity model, so that chat 429s while a new one works;
- Hermes Agent's earlier default persona, `Hermes Agent, an intelligent AI assistant created by Nous Research`, which a SOUL.md the user edited keeps (Hermes' current default goes through). Breaking it after `You` doesn't help; it is broken after the `H`.

The same prompt goes through when each has a zero-width space (U+200B) inside it. This middleware puts two (after the first and the second character of each word; one after the first letter only was turned away again on 11-11) in `x-anthropic-billing-header`, `Claude Agent SDK`, those two Codex lines and Hermes' line, in the system prompt only, and only in what an Antigravity account is sent. Every other provider, a Claude subscription above all, gets the prompt as the agent wrote it, even in a routing group that tries Antigravity first. The model reads the words as before.

It needs a magpie with the `onProvider` hook (v0.1.1283 or later): an older magpie loads it and never calls it, so requests go as they came.

magpie v0.1.1641 and later break these same lines on an Antigravity account by themselves (`magpie provider set antigravity prompt=as-written` turns that off), so there this middleware adds only `extraWords`.

Install it from magpie's **Plugins › Discover**, or with `magpie plugin add @magpie-community/middleware-antigravity-cloak`.

## Before you turn it on

- This changes what Google is sent so that a request it means to refuse isn't refused. It may be against Antigravity's terms, and Google can ban the account for it. Use it on an account you can afford to lose.
- Google can change what it matches at any time. Then the refusal comes back, and magpie may no longer recognise it as this refusal: it can read as a real quota running out and rest the account. If that happens, add the new words to `extraWords`, or turn the plugin off.

## When the 429 comes back anyway

A `429 Resource has been exhausted` while magpie still shows quota left, and while other requests on the same model and account go through (an agent's title request, say), is this refusal, not quota. Something else in that agent's system prompt is being matched. It is often text that isn't the agent's own: a custom prompt, or a plugin or extension that adds to the prompt (magpie-community/plugins#1031 was a DeepSeek Harness plugin's injected prompt).

To find it, replay the failing request with a short user message and take parts of the system prompt out, half at a time, until the 429 stops. Then add a distinctive phrase from the part that brought it back to `extraWords`, or change or remove that text where it comes from. This middleware breaks only the lines and words it is given; it doesn't hide arbitrary prompts.

## Options

```json
{ "extraWords": [], "accounts": ["antigravity"], "off": false }
```

- `extraWords`: more words to break the same way, matched whatever their case.
- `accounts`: the subscriptions it acts on, by kind. `antigravity` is the default.
- `off`: leave every request as it came.

中文：Antigravity 看到 Claude Code / Claude Agent SDK / Codex GPT-5 / Hermes Agent 旧版默认人设的系统提示词会回一个假的 429。这个中间件只在发给 Antigravity 账号的请求里，往 `x-anthropic-billing-header`、`Claude Agent SDK` 和 Codex 给 GPT-5 模型的身份行（在 GPT 模型上开始、再切到 Antigravity 模型的 Codex 对话会带着它），以及 Hermes Agent 旧版默认人设（SOUL.md）那句里插一个零宽空格，其他供应商（尤其是 Claude 订阅）收到的提示词不变。这样做可能违反 Antigravity 的条款，账号有被封的风险，请只用在可以承受损失的账号上。需要 magpie v0.1.1283 或更新版本。如果还剩额度、同一模型的其他请求也正常，却仍然收到 429，说明系统提示词里还有别的内容被匹配到（常见的是自定义提示词，或其他插件注入的内容）：把系统提示词逐段拿掉重放请求，找到触发的那段，再把其中有代表性的短语加进 `extraWords`。

After [hexiaolv/magpie-antigravity-cloak](https://github.com/hexiaolv/magpie-antigravity-cloak) (MIT), which breaks a longer list of words in every request, whatever provider it goes to.
