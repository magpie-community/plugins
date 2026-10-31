# Third-Party Notices

## Design references

The persistent-session architecture, event protocol and UI layout of this plugin were designed
with reference to the following open-source projects (only design ideas and protocol shapes were
referenced; no source code was copied):

- **Paseo** (https://github.com/getpaseo/paseo)
  — persistent daemon + WebSocket event push, and the provider session abstraction.
- **T3 Code** (https://github.com/pingdotgg/t3code, MIT)
  — timeline item shapes (tool groups, permission cards, plan cards) and the three-column workbench layout.

## npm dependencies and their licenses

Installed with the plugin (`dependencies`, and `node-pty` as an `optionalDependency`):

| Package | Version | License |
|---|---|---|
| @agentclientprotocol/sdk | 2.1.0 | Apache-2.0 |
| ignore | 7.0.14 | MIT |
| node-pty (optional) | 1.2.0-beta.15 | MIT |
| ws | 8.22.0 | MIT |
| zod | 4.6.7 | MIT |

Bundled into `app/app.js` (`devDependencies`: not installed for users, but their code ships inside the bundle):

| Package | Version | License |
|---|---|---|
| @tanstack/react-virtual | 3.14.24 | MIT |
| @xterm/addon-fit | 0.11.0 | MIT |
| @xterm/xterm | 6.0.0 | MIT |
| clsx | 2.1.1 | MIT |
| dompurify | 3.4.17 | MPL-2.0 OR Apache-2.0 |
| highlight.js | 11.12.0 | BSD-3-Clause |
| lucide-react | 1.64.0 | ISC |
| marked | 18.1.2 | MIT |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| zustand | 5.0.16 | MIT |

Build and test tools (`devDependencies`; nothing from them ships):
typescript (Apache-2.0), esbuild (MIT), vitest (MIT), playwright-core (Apache-2.0),
@types/* (MIT).

The Codex app-server JSON-RPC schema files (`daemon/src/providers/codex/schema/`) are generated
locally by `codex app-server generate-json-schema`. They describe the OpenAI Codex CLI interface
and are used under the Codex license; the plugin uses them only for protocol integration.
