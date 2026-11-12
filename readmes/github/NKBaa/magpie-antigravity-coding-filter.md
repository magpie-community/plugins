# magpie-antigravity-coding-filter

Another coding agent's name in the system prompt is rewritten or cloaked, as [magpie](https://usemagpie.ai) gateway middleware — on the request an Antigravity account is sent, and on no other.

A port of [jellyfish-p/cpa-plugin-antigravity-coding-filter](https://github.com/jellyfish-p/cpa-plugin-antigravity-coding-filter) (a CLIProxyAPI v7 dynamic plugin, MIT) to magpie's gateway middleware API. The keyword preset, the protected technical references and the rewrite semantics come from that plugin; the hook and the default action are magpie's.

This checkout also carries [additions the upstream port does not have](#additions-in-this-fork): whole-word matching, code protection, optional model-name keywords, a dry run that reports what it would have hit — and [a page](#the-page) in magpie's window where the options are a form and a system prompt can be tried before an agent sends it.

## Why

Antigravity answers a request whose system prompt reads as another coding agent's with `429 Resource has been exhausted`, however much quota is left — magpie shows it as a 400 that says so. The upstream plugin's issue [#4](https://github.com/jellyfish-p/cpa-plugin-antigravity-coding-filter/issues/4) has the controlled test: the same account, model, User-Agent and proxy, and only the identity phrase changed, turns a 429 into a 200.

magpie calls `onProvider` once a request is routed and once per try, so this middleware can act on the try an Antigravity account gets and leave a Claude subscription's — or a key's — request exactly as the agent wrote it, even inside a routing group that tries Antigravity first.

## Install

magpie installs a plugin from npm, GitHub or a folder. Add this repository — it carries the `magpie-plugin` topic, so **Plugins › Discover** finds it — or point magpie at a checkout's folder (**Plugins › Installed › Install from folder**).

Set its options under **Plugins › Installed › Options**, or with `magpie plugin options antigravity-coding-filter '<json>'` — or on [the page](#the-page), which does both and shows the effect.

## Options

```json
{ "mode": "cloak",
  "useDefaultKeywords": true,
  "useModelKeywords": false,
  "useAmbiguousKeywords": false,
  "customMappings": {},
  "accounts": ["antigravity"],
  "boundaries": true,
  "protectCode": true,
  "strictCase": false,
  "dryRun": false,
  "report": false,
  "off": false }
```

- **`mode`.** `cloak` (the default), `rewrite`, or anything else, which is treated as `cloak`.
- **`useDefaultKeywords`.** `true` (the default) turns the built-in preset on. `false` leaves only `customMappings`.
- **`useModelKeywords`.** `false` (the default) leaves model names alone. `true` adds a short list — `Claude Sonnet`, `Claude Opus`, `Claude Haiku`, `Claude`, `GPT-5`, `GPT-4o`, `GPT-4.1`, `GPT-4`, `GPT-3.5`, `Gemini 3`, `Gemini 2.5`, `Gemini 2.0` — for the prompts whose 429 comes from the model name rather than the agent's.
- **`useAmbiguousKeywords`.** `false` (the default) keeps the eleven names the Go plugin ships that are also ordinary words out of the list — see [the preset](#the-preset). `true` puts them back in one step.
- **`customMappings`.** More names: an object (`{"Cursor": "Antigravity"}`), a comma- or newline-delimited string (`"Cursor: Antigravity, Windsurf: Antigravity"`), or an array of such strings. A key overrides a preset name of the same spelling, ignoring case. A `null` value takes the name out of the list — `{"Windsurf": null}` is how a preset entry you never send gets removed — and a blank value is skipped. A string with a line break in it is one entry per line, so a value may contain a comma: `"Cursor: My IDE, Inc.\nWindsurf: My IDE, Inc."`.
- **`accounts`.** The subscription kinds it acts on, compared ignoring case. `antigravity` is the default; a try on a key has no account and is never touched.
- **`boundaries`.** `true` (the default) matches a name only as a whole word, so `Traefik`, `decline`, `Kirov` and `raider` are not treated as `Trae`, `Cline`, `Kiro` and `Aider`. `false` is the Go plugin's behaviour: the name matches anywhere, including inside a longer word.
- **`protectCode`.** `true` (the default) leaves names inside ` ``` ` fences and `inline code` alone, so a string literal in a code sample is not rewritten. `false` rewrites them as it does prose.
- **`strictCase`.** `false` (the default) matches ignoring case, so a lowercase identity line — `you are cursor` — is still cloaked, which is the point of the middleware. `true` matches the eleven ambiguous names, when they are in the list at all, only in their own spelling, so `move the cursor to the end`, `goose bumps` and `the tabby cat` are left alone — at the cost of a lowercase identity line slipping through.
- **`dryRun`.** `true` works out what would match, leaves the request exactly as it came, and still fills `report`.
- **`report`.** `true` leaves the outcome on `ctx.state["antigravity-coding-filter"]` — `{ account, mode, dryRun, changed, matches: [{ name, count }] }` — so a gateway log can show what was hit without replaying the request. The request is not touched.
- **`off`.** Leave every request as it came. `true`, `"true"`, `"1"`, `"yes"` and `"on"` all switch it off; `"false"` does not.

The upstream plugin spells two of these `use_default_keywords` and `custom_mappings`; both spellings are read, as are `use_model_keywords`, `protect_code` and `dry_run`, so its configuration can be copied across.

## Modes

| Mode | What it does | Why |
|---|---|---|
| `cloak` (default) | A zero-width space (U+200B) after the first and after the second letter of each matched name, e.g. `C\u200bu\u200brsor`. The model reads the word as before. | It keeps the sentence readable. `rewrite` turns "You are a Claude agent" into "You are a Antigravity". This is also what magpie's own `antigravity-cloak` middleware does. |
| `rewrite` | The matched name becomes its mapping's value, usually `Antigravity`. | The upstream plugin's `rewrite` mode, ported as it is. |

The upstream plugin's third mode, `block` — turn the request away with a 403 naming what matched — has no equivalent here, and setting `mode: "block"` gets `cloak`. magpie calls `onProvider` after the request has been routed, and an `onProvider` cannot turn a request away (`ctx.reject` there does nothing; the agent would still get its reply). To turn a request away before routing, install [@magpie-community/middleware-block-patterns](https://github.com/magpie-community/plugins/tree/main/packages/block-patterns) as well — it runs on `onRequest`, before any provider is chosen, so it cannot tell Antigravity from a Claude subscription.

## What it reads

Only the system prompt, in whichever shape the API it came in keeps it. Nothing else in the request is touched: not the user's or the assistant's turns, not tool definitions or tool results, not metadata, not images.

| API | Read |
|---|---|
| Anthropic | the top-level `system`, as a string or as text blocks, and any `system` / `developer` message |
| Chat Completions | any `system` / `developer` message, with `content` as a string, a single text object, or text blocks |
| Responses | `instructions`, `input` as a string, and any `system` / `developer` input item, including `input_text` blocks |
| Gemini | `systemInstruction` and `system_instruction`, as a string or as a `{ parts }` object, and any `contents` entry whose role is `system` or `developer` |

A request wrapped in a `request` object is unwrapped and read the same way, as the upstream plugin does.

Inside a system prompt, a name that is part of a technical reference is left alone: URLs, `mcp__…` identifiers, Windows and POSIX paths, `./` and `../`, `.codex`, and `*.md` file names. So `C:\work\Cursor\src\main.ts`, `https://cursor.com/docs`, `cursor.md` and `.codex/Cursor/rules.md` keep their `Cursor`, which is a path, not an identity. With `protectCode`, code fences and inline code are protected the same way. The upstream plugin protects the first list with the same regular expressions.

## The preset

47 names: Claude Agent, Claude Code, OpenAI Codex / Codex CLI, OpenCode, GitHub Copilot / CLI, Gemini Code Assist / Gemini CLI, Windsurf, Codeium, Roo Code, Kilo Code, Continue.dev, Amazon Q Developer / CodeWhisperer, JetBrains AI Assistant / Junie, Qoder / CLI, Qwen Code, Tabnine, Sourcegraph Cody, Augment Code, Replit Agent / Ghostwriter, OpenHands, SWE-agent, Zed AI, Void Editor, PearAI, Refact.ai, GitLab Duo, Visual Studio IntelliCode, CodeBuddy, Blackbox AI, Pieces for Developers, CodiumAI, Rovo Dev CLI, Factory Droid, OpenClaw / Clawdbot / Moltbot, Hermes Agent, WorkBuddy, Chatbox / Chatbox AI.

Longest name first, ignoring case, so `GitHub Copilot CLI` is replaced once rather than as `GitHub Copilot` plus a leftover ` CLI`.

Eleven names the Go plugin ships are **not** in it, because each is also an ordinary English word or given name: **Aider, Cline, Codex, Cursor, Devin, Goose, Hermes, Kiro, Qodo, Tabby, Trae**. `move the cursor to the end`, `goose bumps`, `the tabby cat` and `Kirov` came out rewritten with them in the list. A prompt that names one of them adds it:

```json
{ "customMappings": { "Cursor": "Antigravity", "Codex": "Antigravity" } }
```

or takes all eleven back with `"useAmbiguousKeywords": true`, and `"strictCase": true` then keeps `move the cursor` out of it. `ambiguousNames` is exported for the list, and a `null` replacement removes a name for good: `{"Goose": null}`.

Known gaps, kept from the upstream list rather than guessed at:

- Model names are not in it. A prompt that says `You are Claude` or `based on GPT-5` passes unless `useModelKeywords` is on. Issue #4 found that the model name alone can bring the 429 back, so if you hit that, turn `useModelKeywords` on or add the line you actually send: `"customMappings": {"Claude Sonnet": "Antigravity", "GPT-5": "Antigravity"}`.
- `Amp`, `Manus`, `v0`, `Lovable`, and `claude` on its own are not in it either.
- The eleven ambiguous names are the trade the other way: out of the box, a prompt that says `You are Cursor` is **not** filtered until you add it. That is deliberate — a filter that rewrites `move the cursor` is worse than one that misses a name you can add in a line — but it does mean the first thing to check when the 429 comes back from an agent that calls itself one of them is `customMappings`.

## Additions in this fork

| Option | Default | What it fixes |
|---|---|---|
| `boundaries` | `true` | Without it, `Traefik` became `Tr\u200bae\u200bfik`, `decline` became `dec\u200bl\u200bine`, `Kirov` became `K\u200bi\u200brov`, `raider` became `ra\u200bi\u200bder` — a prompt that mentions the ingress controller or says "we decline" came out corrupted. With it, a name matches only where it is not glued to another letter, digit or underscore. `boundaries: false` restores the Go plugin's matching exactly. |
| `protectCode` | `true` | A name inside a code fence or inline code was rewritten, so `const who = "Cursor"` became `const who = "C\u200bu\u200brsor"` — a changed string literal in an example the model is meant to copy. |
| `useAmbiguousKeywords` | `false` | The eleven names the Go plugin ships that are also ordinary words are out of the preset (see [the preset](#the-preset)); this is the one-step way to put them back, for an agent that calls itself Cursor, Codex or Goose. |
| `strictCase` | `false` | For those eleven, when they are in the list. `boundaries` stops `goosebumps`, but not `move the cursor to the end` or `the tabby cat`; `strictCase` requires the spelling they were written with, and leaves the rest matching ignoring case. Off by default because a lowercase identity line is worth more than clean prose. |
| `useModelKeywords` | `false` | Adds the model names the preset leaves out, which issue #4 shows can bring the 429 back on their own. |
| `dryRun` / `report` | `false` | The README's own advice for a 429 that comes back is to bisect the system prompt by hand. `dryRun` plus `report` names what matched without sending anything: run it, read `ctx.state["antigravity-coding-filter"].matches`, then add a `customMappings` entry. |

Two changes are invisible but real:

- **The hook got faster.** `protectedSpans` now merges overlapping spans and `transform` walks them with one moving index instead of scanning the whole list per match. On a 272 KB prompt with 5,000 URLs and 5,000 matches the hook took 316 ms — over the 250 ms budget, where a timeout drops the middleware — and now takes about 9 ms. The 80 KB / 0.6 ms figure from the port still holds.
- **Options are read defensively.** `accounts` is compared ignoring case (`["Antigravity"]` used to match nothing, silently), `off: "false"` no longer switches the middleware off, and the four APIs' remaining prompt shapes — a `system` block without a `type`, a message `content` that is one text object, `input` as a string, a Gemini `contents` entry with role `system` — are read rather than skipped.

Smaller ones, from reading the code rather than from a report: a mapping that maps a name to itself no longer counts as a change (the hook returned a body it had not modified); the matcher cache holds the last eight option sets instead of one, so a gateway serving two of them stops rebuilding it per request; `customMappings` can remove an entry (`null`) and can carry a comma in a value (one entry per line).

## The page

The package also puts a page in magpie's window, under **Plugins** in the sidebar: **Antigravity coding filter**.

![The page: options on the left, the preview on the right](docs/screenshot.png)

It follows magpie's theme, light and dark ([dark](docs/screenshot-dark.png)), and reflows to one column when the window is narrow.

The page calls Magpie's official `ui.button`, `ui.toggle`, and `ui.row` components. Community page bridges do not expose the host kernel's `magpie.ui`, so the plugin bundles an unchanged component subset from [Magpie's kernel](https://github.com/yetone/magpie/blob/f38ef9821b17cd08af1bca60081d03b00d6970dc/internal/gui/assets/kernel.js), plus the corresponding official style rules. The source revision, method checksums and MIT license are included under `page/vendor/`. `page/ui.js` supplies the host element helper and adapts form state and `--magpie-*` tokens to the sandbox; it does not modify or reach into the parent window. A host-exposed `magpie.ui` is preferred if available.

Settings rows, all switches, and action buttons are constructed by these component factories. `page/style.css` retains page layout and token aliases. The bridge still supplies the page's base typography and theme. Browser tests assert that the final page contains official switch buttons and settings rows, with no remaining checkbox inputs; `test/magpie-ui.test.mjs` guards the pinned component methods and loading order.

- **Common settings first.** Enable filtering, choose “Keep wording” or “Replace names”, and optionally include model names. Advanced matching switches, account types and JSON stay folded away.
- **One rule manager.** Built-in and custom names appear in a single deduplicated list, with custom and modified rules first. Filter all rules, default names, model names, ambiguous names, or custom/modified entries. Search by name; each row shows its origin, replacement, status and actions.
- **Add and edit from the list.** Choose Add rule or Edit — the editor opens as a compact bar above the list — change the matching name/replacement or exclusion, then Apply to list. Cancel leaves the rule unchanged. Edit a built-in name to store an override; Restore default removes it. Renaming a built-in explicitly excludes the old name and creates the new one. Custom-only rules can be renamed or deleted. Duplicate names are rejected ignoring case.
- **Save the draft.** Apply updates the list and preview; Save changes persists it. Ctrl/Cmd+S also validates and applies an open editor before saving. [Editor screenshot](docs/screenshot-editor.png).
- **Readable at window size.** The header with Save stays at the top while the rule list scrolls with the page (no nested scrollbar, no clipped rows), and the selected processing mode is a solid accent rather than a hover tint.
- **A truthful preview.** Paste a system prompt or load the Chatbox example. The outgoing text and match counts update immediately; off and check-only modes preserve the original text. The preview uses the current draft, while gateway requests use the saved settings.
- **Explicit saves.** Save is enabled only after a valid change. The page reports failed reads and writes, preserves unrelated options, and converts legacy mapping formats into rows without dropping names. `Ctrl/Cmd+S` also saves and does nothing when unchanged. Saves merge independent edits from other windows; conflicting changes to the same setting or name keep the draft unsaved with an explanation.
- **Sandbox-compatible copying.** If clipboard access is unavailable, Copy JSON expands the configuration and selects its contents for Ctrl/Cmd+C.

The page reads and writes the middleware's own options through the magpie bridge. As a plain file it saves only in browser storage, clearly labelled on the page; it does not change the gateway.

`test/page.test.mjs` compares the preview matcher with the middleware under ten option sets. Form tests check legacy configurations, exclusions, duplicates, and off/check-only previews. Run `node test/browser-ui.mjs` for real Chrome interaction tests covering editing, saving, reloads, failures and narrow layouts (`CHROME_BIN` selects Chrome on other machines). The browser test uses the official base stylesheet and a controlled bridge stand-in; it does not claim a live magpie end-to-end test.

## Chatbox

[Chatbox](https://chatboxai.app) is a desktop client for OpenAI, Claude, Gemini and local models. Its provider settings take a custom, OpenAI-compatible API host, so its requests can go through magpie's gateway and reach an Antigravity account like an agent's — and its own name goes into the system prompt it sends, which on that route is enough to bring the 429 back. `Chatbox` and `Chatbox AI` are in the preset for that reason.

To point it at magpie: add a custom OpenAI-compatible provider in Chatbox, set its API host to magpie's gateway address and its key to a magpie gateway key, and pick a model magpie serves. Nothing else changes: the filter acts only on the request an Antigravity account is sent, so Chatbox on a Claude subscription gets the prompt it wrote.

## When the 429 comes back anyway

A `429 Resource has been exhausted` while magpie shows quota left, and while other requests on the same model and account go through, means something else in that system prompt is being matched — often text that isn't the agent's own: a custom prompt, or another plugin's injection.

To find it, turn `report` on (and `dryRun` on, if you want the request to go out untouched) and read the matches; or paste the prompt into the page's preview and read the names it lists there; or replay the failing request with a short user message and take parts of the system prompt out, half at a time, until the 429 stops. Then add a distinctive phrase from the part that brought it back to `customMappings`. This middleware only touches the names it is given; it does not hide an arbitrary prompt.

## Differences from the Go plugin

| | CLIProxyAPI plugin | This |
|---|---|---|
| Hook | `request.intercept_after`, when `ToFormat == "antigravity"` | `onProvider`, when `ctx.provider.account` is in `accounts` |
| Default mode | `block` (403) | `cloak` (zero-width spaces) |
| `block` | 403 `blocked_by_antigravity_coding_filter` | not available; `mode: "block"` gets `cloak` |
| Rewrite | name → `Antigravity` | same, in `rewrite` mode |
| Matching | substring, ignoring case | whole word by default; `boundaries: false` for the original |
| Protected references | URLs, `mcp__`, paths, `.codex`, `*.md` | same list, same expressions, plus code when `protectCode` is on |
| Options | `mode`, `use_default_keywords`, `custom_mappings` | camelCase, with the snake_case spellings still read |
| Budget | 250 ms per hook | 250 ms per hook; about 0.6 ms on an 80 KB prompt, 9 ms on 272 KB with 5,000 protected spans |

## Before you turn it on

- This changes what Google is sent so that a request it means to refuse isn't refused. It may be against Antigravity's terms, and Google can ban the account for it. Use it on an account you can afford to lose.
- Google can change what it matches at any time. On 11-11 a single zero-width space after the first letter stopped working and a second one was needed; the next change can break `cloak` again, and then the 429 comes back. If it does, try `rewrite`, or the names in `customMappings` instead of a cloaked one.
- The model reads the words as before, so this does not change what an agent is told it is — only what the string looks like on the wire.

## Tests

```sh
bun test
```

`cases.json` runs the hooks the way magpie's gateway calls them, and the same cases run in magpie's own JavaScript engine (moejs). `test/middleware.mjs` is copied from [magpie-community/plugins](https://github.com/magpie-community/plugins) (MIT) so the cases run on their own. `test/features.test.mjs` covers what a case cannot express: `ctx.state`, `dryRun`, a second pass being a no-op, the preset's two halves and the hook's budget. `test/page.test.mjs` holds the page's copy of the matcher to the middleware's, `test/page-files.test.mjs` checks the page runs no inline script and looks up only ids that exist, and `test/page-smoke.test.mjs` checks form conversions and preview behavior. `node test/browser-ui.mjs` exercises the actual page in Chrome with a controlled bridge.

中文：把 CLIProxyAPI 的 antigravity-coding-filter 移植到 magpie 的 gateway middleware。只在发给 Antigravity 账号的那次尝试上、只改 system / developer 提示词：默认 `cloak`（在名字第一、第二个字母后各插一个零宽空格，模型照读，字面串变了），可选 `rewrite`（改成 `Antigravity`）；上游的 `block` 在 magpie 里做不到——`onProvider` 阶段请求已经路由，`ctx.reject` 无效，要拦截请配合 `middleware-block-patterns`。URL、路径、`mcp__`、`.codex`、`*.md` 里的名字不动。

内置词表现在是 47 条：Go 版的 56 条里，有 11 条本身是普通英文词或人名（Aider、Cline、Codex、Cursor、Devin、Goose、Hermes、Kiro、Qodo、Tabby、Trae），已经拿出去，免得 `move the cursor`、`goose bumps`、`the tabby cat` 被改坏；要用哪条就用 `customMappings` 加回来，或者一次全加 `useAmbiguousKeywords: true`，再加 `strictCase: true` 就只按原样大小写匹配。另外加了 Chatbox / Chatbox AI 两条（桌面客户端，自己名字会进 system 提示词）。

这个分支另外加了几项（都可关掉）：`boundaries`（默认开）只匹配整词，`Traefik`、`decline`、`Kirov`、`raider` 不再被当成 `Trae`、`Cline`、`Kiro`、`Aider` 改坏；`protectCode`（默认开）代码块和行内代码里的名字不动，免得把示例里的字符串字面量改了；`useModelKeywords`（默认关）额外匹配 `Claude Sonnet`、`GPT-5` 这类模型名；`dryRun` / `report` 只算不改，把命中的名字和次数写到 `ctx.state["antigravity-coding-filter"]`，方便排查“429 又回来了”。`customMappings` 里用 `null` 可以删掉某条内置词，多行字符串则允许映射值里带逗号。另外把保护区间合并、按游标遍历，272 KB / 5000 个保护区间的耗时从 316 ms 降到约 9 ms（钩子预算 250 ms）；`accounts` 改成忽略大小写比较，`off: "false"` 不再被当成关闭，映射成自己名字的条目不记为改动。

界面将默认词条和自定义词条合并为一个「规则管理」列表，同名覆盖只显示一行，自定义和已修改规则优先显示；支持按来源筛选和搜索。每行可修改、启用或排除；修改过的默认规则可「恢复默认」，纯自定义规则可删除。点击「新增规则」或「修改」后，可调整名称、替换值与排除状态，应用到列表或取消。默认规则改名会排除旧名称并创建新名称，界面会说明这一行为；重复名称会被拒绝。应用到列表后点击「保存更改」生效，也可直接 Ctrl/Cmd+S 应用并保存当前编辑。JSON、账号类型与调试选项仍在「高级设置」中。浏览器验证覆盖统一列表、默认规则覆盖与恢复、改名、新增、取消、重复校验、保存后刷新和失败重试，使用官方组件与 bridge 模拟器，尚未连接真实 magpie 做端到端测试。

这样做可能违反 Antigravity 的条款，账号有被封的风险。
