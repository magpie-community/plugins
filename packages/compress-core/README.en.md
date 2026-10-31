# compress-core

Gateway middleware for magpie: it rewrites `messages` before the request leaves the machine, folding the repeated, the noisy and the purely formatting parts out of the history, and hands the upstream the same body otherwise. The engines make no network calls and spawn no processes.

This is a port of OmniRoute's compression strategies: the ids, names, priorities and lossy flags match that project. This package carries three of them — `lite`, `headroom` and `session-dedup`. The rest of the ports (`ccr`, `rtk`, `codex-responses`, `caveman`, `relevance`, `read-lifecycle`, `aggressive`, `ultra`, `ionizer`, `llm`), the gateway hooks and the page land in later pull requests.

## Install

```bash
magpie plugin add @magpie-community/middleware-compress-core  # from the registry
magpie plugin add <this directory>                           # a local folder
magpie plugin add github:magpie-community/plugins             # from the repo (packages/compress-core)
```

`magpie plugin list` should show this plugin declaring `middleware`.

## Strategies

They run in ascending `stackPriority`. Each one can be switched and tuned on its own.

| id | name | priority | lossy | what it does |
| --- | --- | --- | --- | --- |
| `session-dedup` | Session Dedup | 3 | no | Text already sent earlier in the session becomes `[dedup:ref sha=…]`, restorable from the session's mapping. |
| `lite` | Lite Cleanup | 5 | no | Whitespace, repeated lines and formatting only; never touches wording. The fastest, always-safe one. |
| `headroom` | Headroom (GCF) | 15 | no | Tabular JSON becomes columnar, long runs fold to `[N rows]`, restored from the GCF data in the fence. |

All three are lossless: what they fold can be read back as it was, without extra tools.

## Presets

| preset | meaning |
| --- | --- |
| off | everything off |
| safe | every lossless strategy on — the three above |
| custom | whatever you switched on yourself; touching any toggle lands you here |
| all | every available strategy on; identical to safe in this package, and they part company as more engines arrive |

`custom` is a result, not a button, so it is greyed out.

## Caching and prefixes

A provider keys its prompt cache by **request prefix**: one changed byte early on makes everything after it a miss.

`lite` rewrites the whole history by default — strictly prefix-stable. Every message goes through the same deterministic transform from the first turn on (folding whitespace is idempotent), so once a message has been sent it is byte-identical for the rest of the session and the prefix never moves. The price is that the turn being sent is folded too: what the user just typed is compressed the same way.

`preserveCurrentTurn: true` restores the conservative mode: everything after the last assistant message (the whole body when there is none) goes out untouched, and is only rewritten in the turn where it stops being "current" and becomes history — one prefix miss there, stable afterwards.

`session-dedup` reads the same switch and defaults the same way: it processes the turn being sent unless you ask it not to. Protecting only that turn means the message is rewritten once in the next request, which moves the prefix with it.

`test/prefix-stability.test.mjs` is the acceptance test for this: the transcript grows turn by turn and the prefix sent each round must be byte-identical to the previous round's, for the default preset, the safe preset and each lossless engine on its own.

`preserve.lastTurns` defaults to `0` — no extra turn is protected. A positive N keeps the newest N turns out of every rewrite; that turn is still rewritten once when it leaves the window, which is the window's doing and not lite's.

`preserve.system` defaults to `false`. Switching it on stows the system prompt behind a placeholder and puts it back at the end, which also disables the step that depends on system content (for example "a system prompt written twice keeps one copy"). That step was a dead setting while this defaulted to `true`; someone who wants the system prompt untouched writes `true`.

## Options

`budgetMs` defaults to `0`: no strategy is skipped on a clock. A positive value makes the pipeline stop the remaining strategies after that many milliseconds — but then the same request can compress differently under load, and a body that changed is a body the provider's prompt cache can never reuse. The engines carry no deadline of their own (`session-dedup`'s `timeBudgetMs` is `0` too).

`maxBytes` defaults to `8000000`: **a body larger than this runs no engine at all and goes out as it came**. The hook has 250 ms, and on a 20 MB body `JSON.stringify` alone costs around 70 ms before any engine has looked at it — a body that size cannot be compressed inside the budget on any machine. Skipping on size rather than on a clock is what keeps it stable: the same body gets the same answer on every request, so the prefix it contributes to the prompt cache never moves. The decision does not count exact bytes: it sums text length first (O(n), no allocation, always a floor under the real byte count), concludes immediately when that floor is already over, lets the body through when it is far below, and pays for one exact count only in the narrow band between.

Measured here (this package's `lite` + `headroom`, median of 5): 2 MB 16 ms, 4 MB 25 ms, 8 MB 43 ms, 12 MB 55 ms, 20 MB 94 ms, 40 MB 122 ms — the last three are over the limit and only get the decision.

## Licence and provenance

MIT (`LICENSE`, which keeps OmniRoute's copyright line). Every engine is a port of OmniRoute's `open-sse/services/compression`; the repository each one came from, the file it reaches, and a sha256 of the ported copy are in `PROVENANCE.json`.

The Apache-2.0 upstreams reached through OmniRoute: `headroom` (github.com/headroomlabs-ai/headroom, including the GCF columnar codec under `engines/gcf/`) and `gcf-typescript` (github.com/blackwell-systems/gcf-typescript, the project the codec itself comes from — headroom reached it through its own copy). Their licence text is in `LICENSES/Apache-2.0.txt`, and the attribution lines §4(d) asks for are carried in `NOTICE`.

## Development

```bash
node test/run.mjs                 # every suite (7 of them)
node test/run.mjs lite            # one suite
bun test                          # what CI runs
```

`catalog.js` is the single source of truth for strategy metadata — id, name, priority, lossy flag, option schema — and `engines/index.js` merges it with the implementations in `engines/*.js` into `REGISTRY`.

`test/lite-spec.md` and `test/session-dedup-spec.md` are the behaviour contracts for those two engines; read them before changing either.

`cases.json` is the outward contract: 21 of its 23 cases are copied verbatim from history-trim (#423), merged in magpie-community/plugins, and two more pin this package's own default behaviour (the turn being sent is folded too; a tabular tool result becomes a `gcf-generic` block). It answers one question — does the same input produce the same body this middleware's ancestor produced — and a difference is a semantic fork: fix it here, or argue it there. The 21 say `preserveCurrentTurn: true` out loud, because that package's semantics keep the turn being sent as it arrived while this one folds it by default; every one of them that looks at truncation also says `compressToolResults: true`, because that behaviour is no longer the default here (below) and the case still has to reproduce #423 exactly. The repo runs them with `bun scripts/check.mjs`; the equivalent entry point here is `node test/run.mjs gateway`.

**By default it cuts nothing and strips nothing.** `lite` leaves tool results at their length (`compressToolResults` defaults to `false`) and leaves images in place (`supportsVision` is treated as "the model can see"). Both used to be on by default, which meant a long tool result arrived cut in half and the screenshot a user attached never reached the model at all. For the old behaviour, say `compressToolResults: true`, or `supportsVision: false`.

## Uninstall

```bash
magpie plugin rm compress-core
```