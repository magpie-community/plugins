# Compatibility record

## macOS — verified on November 13, 2026

MiniMax Design 4.0.10, domestic production build, Apple Silicon macOS.
Requires the companion Magpie change exposing `magpie.platform` to agent
modules. Stock Magpie 0.1.4040 does not expose it.

| Purpose | Observed path |
| --- | --- |
| Desktop configuration and detection | `~/Library/Application Support/@hilo/desktop/hub-config.json` |
| User skills | `~/Movies/Hub/skills/<name>/SKILL.md` |
| Isolated agent's global MCP configuration | `~/Library/Application Support/@hilo/desktop/ai-runtime/config-home/opencode/opencode.json` |

The bundle and running process confirmed the desktop data path. Design's
packaged gateway and skill loader confirmed the user-skill directory.
Its bundled OpenCode 1.18.18 merges its isolated global configuration with
the desktop's generated configuration.

`acceptance.mjs` uses disposable homes, the actual packaged gateway and
OpenCode executable, and local model/MCP fixtures. It verifies:

1. Magpie discovers and connects Design, preserving existing providers/settings.
2. Design 4.0.10's own model validator accepts the generated provider.
   Its packaged provider converter builds the actual OpenCode configuration,
   retaining the desktop's provider IDs and tool support.
3. Library distributes and withdraws a user skill and HTTP MCP server.
4. Design's actual gateway lists the skill, enables it through its normal
   permission API, and stops listing it after Library withdraws it.
5. Bundled OpenCode merges and connects the MCP beside user/bundled servers.
6. The generated provider key routes inference through sandbox Magpie.
7. A bundled-agent turn calls the MCP tool and sends its result back through
   Magpie to the model.
8. Disconnect restores existing custom providers. Existing MCP entries and
   the desktop's encrypted `customMcpVault` remain intact.
9. A 101-model catalog passes the desktop validator and bundled OpenCode
   loader across three providers, then shrinks to one without stale groups.
   An existing `user-custom-magpie` entry is restored on disconnect.

No account credentials or paid inference are used. These checks exercise
the installed app's real gateway and agent executables; they do not claim
GUI interaction, image/video generation or live vendor inference.

## Native media bridge — 0.3.0

`media-native.mjs` validates the generated media store and adapter using
Design 4.0.10's installed gateway code and Electron Node runtime, in a
disposable home. It loads the packaged module with automatic gateway
startup suppressed and invokes its actual media store, sandbox and executor.
HTTP responses are fixture responses, not live vendor generation.

Passed: image/video model loading, image output resolution, reference-image
editing, video submission/polling and authenticated content fetch. The video
fixture checks byte transport, not playback or a usable generated clip.
This test does not prove canvas insertion or desktop GUI selection.

Version 0.3.1 parses generated enum/default/reference limits with Design's
actual parser and runs generated per-model adapters. It verifies multi-image
editing, a legal Hailuo preset, and an invalid 1080P/10-second request rejected
before the HTTP fixture is called. See MEDIA-PARAMETERS.md for model-specific
controls and sources. Custom specs do not expose dynamic cross-field rules;
combined presets and submission validation enforce those restrictions.
Video/audio references and native Windows media execution remain untested.

Version 0.3.2 restricts OpenRouter resolution presets to the verified
Seedream Images API route. Chat image routes retain ratio controls, because
the tested gateway does not pass their resolution override. Video reference
metadata cannot expand beyond the adapter's verified frame/subject modes.
Both regressions have generated-adapter tests.

The live desktop model-access settings displayed all 29 synchronized media
entries and the generated Hailuo options. This verifies settings discovery;
canvas generation selection, live inference and output insertion remain
unaccepted. See MANAGEMENT.md for the wider management audit.

## Windows

The existing `%APPDATA%\@hilo\desktop\hub-config.json` model path is retained.
Release 0.1.0 recorded real Windows 11 / Design 3.0.17 model inference.
This change tests the Windows descriptor and model conversion, but does not
claim a new native Windows run or Library support on Design 3.x. Library
paths follow the observed Design 4.x layout.

## Boundaries

- Linux is refused explicitly; Windows paths are not expanded there.
- The tested desktop is the domestic production edition. Global, staging,
  test and development profiles have separate storage and are not targeted.
- New user skills may initially be disabled by Design. Library manages
  placement/removal; Design retains its own permission toggle.
- MCPs in the isolated OpenCode file are available to the agent, but are
  not entries in Design's encrypted connector vault or connector UI.
- Global instructions are not advertised: Design disables ordinary
  project/Claude config discovery and has its own optional memory system.
- Models without positive integer context/output limits are omitted.
  Empty eligible catalogs fail explicitly; no guessed limits are written.
- Model IDs must satisfy Design's validator: nonempty strings without
  whitespace/control characters or its reserved reasoning prefix. Duplicate
  IDs keep the first eligible model before providers are split.
- Design permits at most 50 models per provider. Larger catalogs are
  split into `user-custom-magpie`, `user-custom-magpie-2`, etc.
  Magpie restores obsolete entries when a catalog shrinks.
