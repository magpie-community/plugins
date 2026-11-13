# @magpie-community/agent-minimax-design

[MiniMax Design](https://design.minimax.io) (the local multimodal creation studio, electron app id `@hilo`) as a magpie agent. MiniMax Design supports custom text models over the OpenAI-compatible, OpenAI Responses and Anthropic protocols; magpie's gateway translates all three, so one switch points Design at magpie.

```sh
magpie plugin add @magpie-community/agent-minimax-design
```

**macOS and Windows, domestic production edition.** Requires the companion
Magpie change exposing `magpie.platform` to agent modules. Stock Magpie
0.1.4040 does not expose it. Linux is refused explicitly.

Quit MiniMax Design, switch the agent on in Magpie's Agents page, then
start Design and pick a model under **Magpie**. Disconnecting restores the
provider entries Magpie replaced and leaves other settings intact.

## Library

Design becomes a target for **Skills** and **MCP servers**, using the same
Library controls as other agents:

- Skills are linked/copied into `~/Movies/Hub/skills`, the desktop's user
  skill directory. New skills may need enabling in Design's skill UI;
  Library manages placement/removal and Design keeps its permissions.
- MCP servers use the OpenCode format in the desktop's isolated
  `ai-runtime/config-home/opencode/opencode.json`. Restart Design after
  changing servers. They are available to the agent beside bundled
  servers, but are not added to the desktop's connector UI.
- Removing an item removes only Library's entry or skill. The encrypted
  `customMcpVault` is never edited.
- Global instructions are not offered: no always-read instruction file
  has been established for this desktop.

## Native image and video models

With Design 4.0.10, connecting the Agent also synchronizes Magpie's image
and video catalogue into Design's native media model store. These are
native model choices, independent of MCP. A companion Bun plugin checks
connection changes every five seconds and refreshes the catalogue every
minute while Magpie is running.
Design's model-access settings have displayed the synchronized image/video
entries and Hailuo's generated parameter options. Restart Design after the
first synchronization if its canvas lists remain stale. Canvas generation
selection and output insertion remain acceptance items; the automated test
covers its native media loader and executor.

The bridge uses explicit image/video kinds from Magpie's authenticated model
list. It automatically builds model-specific dropdowns and reference budgets
from explicit parameter metadata, OpenRouter's public endpoint schemas, or
verified route profiles. `自动` retains the selected route's defaults.
MiniMax, Grok, Qwen and verified RightAPI routes have presets; unidentified
routes retain optional manual size/duration controls.

Video references automatically select a first frame, subject collection, or
ordered first/last frames according to the model and image count. Hailuo has
one resolution/duration dropdown containing only legal pairs. Other invalid
reference/parameter combinations are rejected before HTTP submission.
Design's custom specifications do not support dynamic cross-field rules;
see [MEDIA-PARAMETERS.md](MEDIA-PARAMETERS.md) for exact limits, sources and
gateway mappings. Unsupported video/audio references and ineffective
resolution controls are not advertised.

The bridge owns a provider and model entries under `media-models`, preserves
other providers/models and each managed model's enabled setting, and removes
its entries when the Agent disconnects. A failed catalogue request keeps
the previous list. Store version conflicts, ID collisions and Design's
200-model/50-provider limits stop synchronization with a logged error.
Do not edit the generated adapters/specifications by hand.

Image outputs and authenticated video downloads go through Design's media
executor. No separate generation service is installed. Changing the model
list does not submit generation jobs or incur inference charges.

On macOS the data directory is
`~/Library/Application Support/@hilo/desktop`; on Windows it is
`%APPDATA%\@hilo\desktop`. Detection uses the data directory so moving the
app between `/Applications` and `~/Applications` does not break it.
Start Design once before connecting.

## How it works

Design keeps custom models in `hub-config.json` under that data directory,
at `config.customModels.<id>`:

```json
{
  "protocol": "openai-compatible",
  "providerName": "Magpie",
  "baseUrl": "http://127.0.0.1:3425/v1",
  "apiKey": "magpie-minimax-design",
  "models": [{ "id": "...", "contextWindow": 1000000, "maxOutputTokens": 65536, "reasoningLevels": ["low", "high"] }]
}
```

The agent is a switch: Design picks its model in its own UI. Connecting
writes `config.customModels.user-custom-magpie` as one object, so
disconnect restores/removes the whole entry. Its Design-specific key
attributes requests to this agent in Usage.

Models map `id`, `context`, `output` and `efforts` to `id`, `contextWindow`,
`maxOutputTokens` and `reasoningLevels`. The reasoning array is always
present, filtered to `low`, `medium`, `high`, `xhigh`, `max`. Models without
positive integer context/output limits or valid model IDs are omitted.
IDs containing whitespace/control characters or Design's reserved reasoning
prefix are rejected; duplicate IDs keep the first eligible model. If none remain,
connecting fails. Set accurate limits in Magpie when a source lists none.

Design 4.0 permits 50 models per provider. Larger catalogs are split into
additional `user-custom-magpie-N` entries without dropping eligible models.
Magpie refreshes these on catalog changes, restores obsolete entries after
a shrink, and removes/restores all its entries on disconnect.

## Notes

- Quit Design before switching: a running Design writes its in-memory configuration back over the file. Restart Design after a change.
- Design accepts the non-UUID entry id `user-custom-magpie` (verified on 3.0.17).
- See [COMPATIBILITY.md](COMPATIBILITY.md) for verified versions and platforms.

How agent plugins work: [usemagpie.ai/docs/plugins#agents](https://usemagpie.ai/docs/plugins#agents).

See [MANAGEMENT.md](MANAGEMENT.md) for the verified management scope and the
remaining boundaries for rules, memory, speech and music.

## Verification

```sh
node --test packages/minimax-design/minimax-design.test.mjs
bun scripts/check.mjs minimax-design
MAGPIE_BIN=/path/to/patched/magpie \
  MINIMAX_APP="/Applications/MiniMax Design.app" \
  node packages/minimax-design/acceptance.mjs
```

Native acceptance uses isolated homes, the installed app's real gateway
and agent executables, and localhost model/MCP fixtures. It exercises
Library distribution/removal and an agent model → MCP → model round trip.
See [COMPATIBILITY.md](COMPATIBILITY.md) for versions and limits.
