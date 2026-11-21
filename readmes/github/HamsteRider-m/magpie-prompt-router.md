# magpie-prompt-router

**English** | [简体中文](README.zh-CN.md)

`magpie-prompt-router` (**Prompt Router** / **提示词路由**) is a zero-dependency Magpie gateway plugin for conditional system prompt routing across `chat`, `responses`, `anthropic`, and `gemini` wire protocols.

It ships with **no bundled redteam or jailbreak payloads**—only a neutral, local deterministic routing engine and a single minimal `builtin-example` persona so you can compose, swap, or clean system prompts cleanly across Alma, Pi, Claude Code, Codex, and OpenCode.

## Highlights

- **Deterministic local routing (no JEV / no LLM classifier)**: Runs synchronously inside Magpie's `onRequest` hook using pure JavaScript glob, keyword, and regex evaluation—zero extra model calls, zero network latency, and zero external router dependencies.
- **Ordered conditional routing rules**: Match workspace glob, model glob, agent glob, protocol, and user keywords top-to-bottom; first match selects the persona and mode.
- **In-chat `/route` & `@route` directives**: Switch personas or modes sticky across a thread or for a single turn, with automatic wire stripping so directives never leak upstream.
- **Auxiliary-call protection**: Automatically skips excluded models, memory extraction, title generation, JSON selectors, and background requests even when sticky routing is enabled.
- **Host-context cleaning**: Scrubs Alma/Pi/generic host persona, emotion, fatigue, and selfie sections while preserving operational blocks (`WORKING DIRECTORY`, `SYSTEM INFO`, `READ-ONLY AUTHORITY`, `<available_skills>`).
- **Local Markdown hot-reload**: Point any persona at a local `.md` file; YAML frontmatter is stripped and changes reload automatically on `mtime`/`size` updates.
- **Zero-build settings & live simulator**: Built-in Magpie settings page with Liquid Glass theme support and an interactive route simulator.

## How routing works

Prompt routing in `magpie-prompt-router` does **not** use JEV or any LLM-based router model. Every outbound request passes through a synchronous two-module pipeline (`src/hooks.js` → `src/engine.js`):

1. **Envelope extraction**: Normalizes `chat`, `responses`, `anthropic`, and `gemini` payloads into `{ protocol, model, agent, cwd, systemText, userText, userTurns }`.
2. **Directive reduction**: Scans all user turns in order (operating only on the human slice outside Alma's `[Context: ...][Message sent-at: ...]` wrapper and `## Response Guidelines` footer) to resolve sticky `/route on|off` state and current-turn `/route once` / `@route` overrides.
3. **Auxiliary-call guard**: Checks `excludedModelGlobs` (default `*nmem*`, `*embedding*`, `*rerank*`, `*jev*`) and JSON-only selector/memory/title/classification heuristics before rewriting.
4. **Ordered rule matching**: Evaluates enabled `options.rules` top-to-bottom. A rule matches only when all of its configured fields match (`workspaceGlob`, `modelGlob`, `agentGlob`, exact `protocol`, and all `userKeywords`).
5. **Precedence chain**: Current-turn `/route` or `@route` override > first matching rule > sticky `/route on` thread state > global `defaultMode` & `defaultPersonaId`.
6. **Wire rewrite & safety check**: Rewrites system prompts (and scrubs Alma user context in `replace`/`strict` modes), verifies all seven immutable wire keys plus `body.config.tools` and `body.config.toolConfig`, and fails open if validation fails.

## Configuration prerequisites

Before routing takes effect, make sure the following prerequisites are met:

- **Magpie gateway & runtime**:
  - Install into a Magpie gateway that supports middleware plugins and plugin settings pages (Magpie 2.4+ recommended for Liquid Glass theme variables).
  - For local development, testing, or CI verification: Node.js `>= 20` or Bun `>= 1.3.0` (zero runtime dependencies; no `npm install` needed).
- **Traffic path**:
  - Your client (Alma, Pi, Claude Code, Codex, or OpenCode) must send outbound requests through the Magpie gateway instance where this plugin is installed and enabled (`chat`, `responses`, `anthropic`, or `gemini` protocol).
- **Safe defaults & activation**:
  - The plugin ships with `enabled: true` and `defaultMode: "off"`, so it never modifies traffic until you either configure a non-`off` `defaultMode`, add at least one enabled rule in `options.rules`, or send an in-chat `/route` / `@route` directive.
  - To use `fallback` mode or custom prompts, define at least one custom persona in `options.personas` (inline `template` or readable local `filePath`); `fallback` skips when the bound persona is still `builtin-example` or empty.
- **Field-level rule prerequisites**:
  - `workspaceGlob`: Requires `cwd` on the request (`body.cwd` / `ctx.cwd`) or a recognizable working directory marker in the system prompt (`WORKING DIRECTORY`, `<environment> Working directory:`, `Current working directory:`, `Working directory:`, or `<cwd>...</cwd>`).
  - `agentGlob`: Requires Magpie to identify or forward `ctx.agent` / `body.agent`.
  - `modelGlob`: Matches `body.model` / `ctx.model` case-insensitively with `*` and `?`.
  - `filePath` (local Markdown personas): Must point to a `.md` file readable by the Magpie gateway process (absolute path or relative to the process working directory). YAML frontmatter is stripped automatically and changes reload when `mtime` or `size` changes.
- **Auxiliary-call protection**:
  - `bypassAuxiliary` defaults to `true` with `excludedModelGlobs: ["*nmem*", "*embedding*", "*rerank*", "*jev*"]`. Add any extra background/memory model globs you use so they are never rewritten. Keep `allowExcludedModelsOnOnce: false` unless you explicitly want `/route once` or `@route` to override excluded models.
- **CI/CD & release (maintainers)**:
  - GitHub Actions runs tests and package verification on every push to `main` and every pull request.
  - Automated npm publishing on `v*` tag pushes requires `NPM_TOKEN` in repository secrets (or npm Trusted Publishing) and a tag matching `package.json`'s `version` (e.g. `v0.1.0`).

## Install & terminal CLI

Install from npm:

```sh
magpie plugin add magpie-prompt-router
magpie plugin on magpie-prompt-router
```

Install from GitHub or a local checkout:

```sh
magpie plugin add github:HamsteRider-m/magpie-prompt-router
magpie plugin add /path/to/magpie-prompt-router
```

Configure personas and rules in Magpie's **Prompt Router** settings page, or manage everything from the terminal with the bundled `mpr` (`magpie-prompt-router`) CLI:

```sh
# Zero-config project routing: creates ./.prompt-router.md (auto-discovered by cwd)
npx magpie-prompt-router init-project --mode replace

# Or manage global Magpie personas & rules in ~/.config/magpie/plugins.json
npx magpie-prompt-router status
npx magpie-prompt-router persona add architect --file ~/prompts/architect.md --name "Architect"
npx magpie-prompt-router bind-cwd architect --mode replace
npx magpie-prompt-router test --model claude-sonnet-4 --agent claude-code --user "Review this diff"
```

A companion Agent Skill is bundled at `skills/magpie-prompt-router/SKILL.md` so Claude Code, Codex, Alma, Pi, or T3 Code can inspect and manage routing rules via natural language.

## Project-level `.prompt-router.md`

When `autoDiscoverProjectFile` is enabled (default `true`) and no explicit `/route` directive or `options.rules` entry matches, the hook checks `<cwd>/.prompt-router.md` (hot-reloaded on `mtime`/`size` changes):

```markdown
---
mode: replace
keepCwd: true
enabled: true
---
You are working in {{cwd}}. Answer concisely and follow repository conventions.
```

Explicit `/route off`, `/route once`, `@route`, `options.rules`, and auxiliary-call guards (including `*jev*`) always take higher precedence.

## Use it in chat

Enable sticky routing for the current and subsequent turns:

```text
/route on persona replace
```

Route a single turn without changing sticky thread state:

```text
/route once strict Review this code
@route append Summarize the change
```

Disable sticky routing:

```text
/route off
```

A bare `/route on` or `/route off` becomes a short acknowledgement request (`[magpie-prompt-router: state -> enabled|disabled. ...]`) so providers never receive an empty user turn. Alma context wrappers and `## Response Guidelines` blocks remain intact.

## Route by request data

Rules match workspace, model, agent, protocol, and user keywords. They run from top to bottom, and the first matching rule selects the persona and mode. Alma workspace routing extracts the path from the `WORKING DIRECTORY` section. Model globs such as `claude-*` and `*nmem*` use case-insensitive `*` and `?` matching.

Auxiliary calls stay off by default. The plugin protects excluded models, memory calls, title generation, JSON selectors, and similar background requests even when `/route on` appears earlier in the conversation. A current-turn `/route once` or `@route` can bypass the generic auxiliary check. Excluded model globs still win unless you set `allowExcludedModelsOnOnce`.

## Modes

| Mode | Behavior |
| --- | --- |
| `strict` | Replace all host system prompt entries with the selected persona (inherits Anthropic `cache_control` if present). |
| `replace` | Scrub host persona material and prepend the selected persona before the remaining host text. |
| `fallback` | Act like `replace` when a custom persona is bound. Skip when the bound persona is still `builtin-example` or empty. |
| `append` | Prepend the selected persona before the existing host prompt. |
| `suffix` | **Cache-preserving tail append**: append the selected persona after the host system prompt, keeping the entire host durable prefix and Anthropic `cache_control` breakpoints intact. |
| `off` | Leave the host prompt and user context unchanged. |

The `{{cwd}}` placeholder expands to the request working directory when `keepCwd` is enabled. Strict mode appends the current working directory when the persona template has no placeholder and a working directory is available. The hook keeps `cwd` on the wire in every mode.

## Host boundary

The hook clones request containers and preserves these seven immutable wire keys, verifying their JSON values before and after rewriting:

`tools`, `tool_choice`, `function_call`, `functions`, `toolConfig`, `model`, `stream`

It also preserves `body.config.tools` and `body.config.toolConfig`, preserves multimodal user content when stripping directives, and keeps Anthropic system array block fields and `cache_control` object identity intact.

The hook restores the original body before exact account-fallback re-entry. It reports only Magpie's valid statuses and fails open if input validation or the immutable-key check fails.

## Development & CI/CD

Run the test suite and package verification locally:

```sh
npm test
bun test
npm run verify
```

GitHub Actions workflows live under `.github/workflows/`:

- `ci.yml`: Runs `npm test` (Node 20 & 22), `bun test`, and `npm run verify` (manifest checks, `npm pack --dry-run`, and clean-repo checks) on every push to `main` and every pull request.
- `release.yml`: Triggers on `v*` tags (or manual dispatch with optional `dry_run`), verifies tests and tag-version parity, publishes to npm when `NPM_TOKEN` is configured, and creates a GitHub Release with the packed tarball.

## Changelog

### 2026-11-20

- **Cache-preserving architecture**: Added `suffix` tail-append mode to preserve host durable prefixes byte-for-byte, inherited Anthropic `cache_control` breakpoints in `strict` mode, restricted single-turn `/route once` & `@route` Alma context scrubbing to the current turn so historical turns stay append-only, and added segmented `prefixHash` / `prefixBreakSegment` (`cold` / `none` / `model` / `tools` / `system` / `history`) telemetry.
- **UX, observability & multi-gateway sync**: Smart single-turn activation (`replace`) when naming a persona under `defaultMode: "off"`, bounded 20-entry `getRecentDecisions()` ring buffer + opt-in `traceLog` (`mpr status --recent`), and `mpr export` / `mpr import` for syncing configs across Magpie instances.
- **Repositioning, CLI, project auto-discovery & CI/CD**: Repositioned to `magpie-prompt-router` (`/route` & `@route`), added zero-dependency `mpr` CLI, `<cwd>/.prompt-router.md` hot-reload discovery, companion `SKILL.md`, `*jev*` default auxiliary exclusion, GitHub Actions CI/CD, and PM evaluation report (`docs/evaluation.md`).

### 2026-11-18

- **Formal invariant & bilingual docs**: Passed 407-case cross-protocol formal invariant verification and added English/Chinese README language switchers.

### 2026-11-17

- **Initial release**: Two-module deterministic routing engine + Magpie hooks across `chat`, `responses`, `anthropic`, and `gemini`, 7 immutable wire key guard, Alma/Pi/generic host scrubbing, account-fallback retry restoration, and zero-build settings page with live simulator.

Licensed under the MIT License.
