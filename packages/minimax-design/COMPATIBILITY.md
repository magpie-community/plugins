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
3. Library distributes and withdraws a user skill and HTTP MCP server.
4. Design's actual gateway lists the skill, enables it through its normal
   permission API, and stops listing it after Library withdraws it.
5. Bundled OpenCode merges and connects the MCP beside user/bundled servers.
6. The generated provider key routes inference through sandbox Magpie.
7. A bundled-agent turn calls the MCP tool and sends its result back through
   Magpie to the model.
8. Disconnect restores existing custom providers. Existing MCP entries and
   the desktop's encrypted `customMcpVault` remain intact.

No account credentials or paid inference are used. These checks exercise
the installed app's real gateway and agent executables; they do not claim
GUI interaction, image/video generation or live vendor inference.

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
- Design permits at most 50 models per provider. Larger catalogs are
  split into `user-custom-magpie`, `user-custom-magpie-2`, etc.
  Magpie restores obsolete entries when a catalog shrinks.
