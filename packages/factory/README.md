# @magpie-community/opencode-factory-auth

Signs in to a [Factory](https://factory.ai) (Droid) subscription and sends
model requests to Factory's API the way `droid` sends them. Provider id:
`factory`.

## Sign-in

- **Sign in with Factory (device code).** This is WorkOS's device flow
  under droid's own client. The browser opens Factory's page with the code
  filled in. Confirm it there, and the plugin picks up the tokens.
- **Factory API key.** A key (`fk-…`), as droid takes one from
  `FACTORY_API_KEY`. It is sent as the bearer token with droid's headers
  and never renewed. A key carries no organization header; `whoami`, asked
  once with the key, says whose it is and where its organization is served.
- **Organization.** A token that isn't in an organization yet is put in
  the first one your account belongs to.
- **Whoami.** The plugin asks `whoami` for your active organization, its
  region (EU orgs go to `api.eu.factory.ai`) and any host of the org's
  own. Every request then carries them, as droid's do.

## Where the sign-in is kept

The sign-in is kept wherever the host keeps provider sign-ins:

- OpenCode: `~/.local/share/opencode/auth.json`
- magpie: `plugin-auth.json`

It holds WorkOS's access and refresh tokens, with the organization,
region and host.

**Refreshing.**
- magpie renews the access token three minutes before it lapses, through
  the plugin's `auth.refresh`, once for the account and before its
  requests and usage need it; magpie saves the new tokens. OpenCode
  doesn't call that hook: there the token is renewed two minutes before it
  lapses, before a request, and the plugin saves it.
- WorkOS rotates the refresh token, so the plugin never runs two refreshes
  at once, and never spends one refresh token twice: a request that comes
  before magpie has saved a renewal goes on with the new tokens.
- The account counts as signed out only when WorkOS refuses the refresh
  token (a 4xx other than 429). Any other failure keeps the sign-in, and
  the current token is used while it lasts.

**Refusals.** If Factory refuses the organization a request names, the
plugin asks `whoami` again and resends the request once. If the refusal
stands, the error says what to check.

## Requests from other agents

Factory serves a subscription's model requests to Droid. Every request
droid sends opens its system prompt with "You are Droid, an AI software
engineering agent built by Factory.", so another agent's request to
Factory's OpenAI-shaped API (`/api/llm/o`: GPT and Grok on Responses, the
open models on chat completions) opens with that line too, the agent's own
prompt after it. On Anthropic's Messages (`/api/llm/a`), the plugin adapts
fixed client metadata while preserving the task instructions and history;
see [Claude Code through magpie](#claude-code-through-magpie) below.

## Models

Each model is served on the one API droid uses for it:

| API | Models |
|---|---|
| Anthropic Messages (`/api/llm/a`) | Fable 5.1, Fable 5, Opus 5.5, Opus 5, Opus 4.8, Sonnet 5.5, Sonnet 5, Sonnet 4.6, Haiku 4.5, MiniMax M2.7 |
| OpenAI Responses (`/api/llm/o/v1`) | GPT-6.1 Sol, GPT-6 Sol/Astra/Luna, GPT-5.6 Sol/Terra/Luna, GPT-5.5, GPT-5.4, GPT-5.3-Codex, Grok 4.7, Grok 4.6 |
| Chat completions (`/api/llm/o/v1`) | GLM-5.3, GLM-5.3-Flash, GLM-5.2, Kimi K3, DeepSeek V4.1 Flash, Qwen3.8 Max, MiniMax M3, Mistral Medium 3.5, Nemotron 3 Ultra |

Reasoning efforts are the variants droid offers for each model. DeepSeek V4.1
Flash, Kimi K3 and GLM-5.2 have `none`, droid's "off": they stop thinking.
Reasoning is mandatory on GLM-5.3 and GLM-5.3-Flash (Fireworks turns `none`
away), so `low` is their least.

The list is not included:

- Gemini, which Factory sends on a route of its own.
- auto, which droid picks on the client side.

## Use

```sh
magpie plugin add @magpie-community/opencode-factory-auth
magpie plugin login factory
```

## Claude Code through magpie

Factory's Anthropic route requires Droid's fixed client preamble and
refuses some of Claude Code's fixed environment, model and built-in skill
metadata. The plugin adapts that metadata while preserving the coding
instructions, environment values, tool definitions, images and reasoning
options. Ordinary Droid requests remain unchanged, and OpenAI routes keep
their existing request adapter. Quoted fixed metadata in tool results is
handled as described below.
The fixed Claude identity is recognized as a complete first line too when
magpie joins it with the following system instructions into one text block.

For the built-in `update-config` skill, the adapter changes only the known
self-reference "not Claude" to "not the assistant" inside a complete
generated skill-list reminder. Its configuration instructions, other
skill descriptions, tools and caller text are preserved.

Claude 5 can send runtime metadata in string-content `system` messages
instead of user-message reminders. The plugin adapts the known environment,
model and configuration-skill metadata in that shape too, preserving the
message role, environment values and session instructions.
Startup hooks (`SessionStart` or `SubagentStart`, including additional
context) and deferred-tool announcements may precede that environment
block. The adapter preserves the prefix verbatim and adapts the generated
runtime context after it, including when folded into user text.
After `/model` switches, Claude Code can send model-only system updates
without the initial environment paragraph. Updates beginning with the known
model paragraph and containing complete generated token metadata are
adapted too, including accumulated switches when resuming a conversation.
Token budgets, permission instructions and conversation history are preserved.
The same model-update adaptation covers updates that start with the complete
generated `# Environment update` block after a working-directory change.

Claude Code's generated compaction summaries also have a fixed opening
that Factory refuses. The adapter recognizes the two generated opening
sentences and rephrases only the first in user strings and text blocks,
including summaries without a `Summary:` label. The generated artifact
provenance marker and note stay verbatim. If the summary itself quotes any
of the refused client phrases handled in tool output, the context after the
two opening sentences is encoded as a JSON string with explicit decoding
instructions. Decoding restores the exact summary, transcript path and
continuation instructions; context without those phrases stays verbatim.
Complete generated reminders for restored Read calls and omitted files are
adapted too. Read arguments and file paths are preserved; quoted or incomplete
reminders are left alone.
Claude Code can also combine reminders into a token-prefixed `system` turn
without the reminder wrappers. The adapter handles the known metadata
paragraphs in that form, including skill-list updates, while retaining
numbered file contents, token markers and SessionStart hook output.
The same adaptation applies when a translating gateway folds that complete
token-prefixed block into a user message.
Standalone skill updates can instead start with the generated skill-list
header and end with a token marker, for example when leaving auto mode.
That complete form receives the same adaptation while retaining the skill
descriptions and mode-change instructions.
The skill list can also come alone as a `system` message, with only its
entries: no header, no reminder wrapper and no token marker, as text blocks
or a string. A `system` message that opens with an entry gets the same
change to the known `update-config` line; everything else in it stays.
When runtime notifications precede the skill update, the adapter recognizes
the complete skill-header and bullet-list paragraphs inside a token-terminated
bundle. It preserves MCP connection errors, other notifications, mode updates
and custom skill descriptions while adapting the known built-in description.
After `/compact`, Claude Code also sends the files it restores and the
runtime context as one turn that opens with an unwrapped restored-file note
or Read call, with no token marker first. When that turn also carries the
generated environment paragraph or a token marker before any hook output,
each fixed paragraph (file notes, Read calls and results, environment, model
line) is adapted as in a token-prefixed bundle; everything else stays
byte-for-byte. Quoted, incomplete and hook-owned forms are left alone.

Factory can also refuse fixed client phrases quoted in tool results, such as
the identity/environment definitions printed when inspecting this plugin's
source, or the compaction opening embedded in a historical session JSONL
record. Those text results are represented as JSON strings with explicit
decoding instructions and Unicode escapes for the fixed phrases. Decoding
the string recovers the exact original output, including quotes, backslashes
and Unicode; the plugin does not delete the output or replace its identities
with different ones. Tool ids, cache/error markers and non-text blocks stay
unchanged. Ordinary tool results are forwarded as before.
The same lossless encoding applies to restored or `@`-attached Read file text
after the exact `Result of calling the Read tool:` header, including complete
reminder wrappers and announced runtime bundles. The generated header and
wrapper stay intact. File text without a known refused phrase is unchanged.
Claude Code's complete changed-on-disk notifications receive the same handling:
only the numbered file snippet is encoded, retaining its TAB or colon line
separators, hunk separators and truncation notice. The path and instructions
about respecting the current file stay verbatim. This covers wrapped user
attachments and generated system bundles, including notifications before a
token marker. Changed-file text supplied by hooks, quoted or incomplete
notifications, and notices that omit the snippet are left alone. Model and
environment metadata after non-startup hooks retain their existing adaptation.

Use magpie's Claude Code integration to select the Factory provider.
magpie manages the provider-specific client settings, including capability
and permission configuration. Fields such as `safeguards` and
`context_management` are forwarded for Factory to validate; the request
adapter preserves them along with the other request options. One exception:
Factory's streaming route refuses `context_management` ("Extra inputs are
not permitted") while its non-streaming route takes it, so a streamed
request is sent without it. The server then clears nothing from the
context; Claude Code's own compaction still runs.

The same metadata adaptation applies to `/messages` and
`/messages/count_tokens`, so token counting sees the prompt used for
inference. Serving the counting endpoint still depends on the host and
upstream. Model and feature availability depend on the Factory account,
organization region and upstream API. Connectivity has been verified with
Sonnet 4.6, Sonnet 5.5 and Opus 5.5. Two-turn Read tool calls with Claude
Code's default tool set have been verified with Sonnet 4.6 and Sonnet 5.5,
including Sonnet 5.5 selected through a routing group.

## Tool schema compatibility

Factory's Anthropic route rejects tool schemas with root-level `anyOf`,
`oneOf` or `allOf`. The plugin nests those schemas under an internal
`arguments` property instead of removing their branch constraints. It
wraps examples and previous tool inputs too, then unwraps tool replies
before returning them to OpenCode or magpie. Ordinary object schemas and
OpenAI routes keep their existing behavior.

Local schema pointers are rebased to the nested schema; `$id` resources
and anchors retain their resolution scope, and literal data is unchanged.
Recursive schema resources
without `$id` fail explicitly because nesting would change their scope.
Affected streaming tool arguments are buffered until their content block
is complete. Other events, tool ids, usage and upstream errors pass through;
an incomplete or invalid argument envelope fails instead of being executed.
