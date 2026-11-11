# RTK for DSH

A Magpie gateway middleware that routes **DeepSeek Harness (DSH)** `pwsh` tool
calls through [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk), so shell
output is compressed before it reaches the model.

It works at the Magpie gateway layer, not inside DSH. DSH does not need a DSH
plugin; it only needs to send its model requests to Magpie.

## What it does

```text
DSH model returns a pwsh tool call
  command: "git status"
        -> Magpie middleware wraps it
  command: "& "$env:USERPROFILE\.local\bin\rtk-wrap.ps1" -Command 'git status'"
        -> DSH executes the wrapper
        -> wrapper installs RTK shims for git/npm/... and runs the command
        -> RTK-compressed output goes back to DSH
```

The wrapper passes every argument through unchanged, so quotes, pipes,
redirection and compound commands keep working.

The middleware also restores the original command in the conversation history,
so the model sees `git status`, not the wrapper command.

## Requirements

- Windows
- PowerShell 5.1 or newer (DSH uses `powershell.exe` when `pwsh.exe` is absent)
- [RTK](https://github.com/rtk-ai/rtk) installed and on `PATH` (`rtk --version`)
- Magpie v0.1.1875 or newer
- DSH with the `pwsh` tool (the default on Windows)

## Install

```powershell
# from GitHub
magpie plugin add github:z20503740/magpie-rtk-dsh

# from npm (after publishing)
magpie plugin add magpie-rtk-dsh
```

Then install the wrapper once:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.local\bin" | Out-Null
Copy-Item "$env:USERPROFILE\.config\magpie\plugins\node_modules\magpie-rtk-dsh\bin\rtk-wrap.ps1" `
          "$env:USERPROFILE\.local\bin\rtk-wrap.ps1" -Force
```

If you install from a local folder, copy `bin\rtk-wrap.ps1` from that folder.

Open Magpie:

**Extensions -> Plugins -> RTK for DSH**

The page shows the current state and a switch. It writes this plugin's
`options.enabled` value; the middleware reads it on the next request.

The wrapper path is configurable through the page; the default is:

```text
$env:USERPROFILE\.local\bin\rtk-wrap.ps1
```

## Verify

1. In the page, turn RTK on.
2. In DSH, ask the agent to run `git status`.
3. Compare the output with a normal `git status`: RTK prints a compact form.
4. Check the RTK counters:

```powershell
rtk gain
```

## How the wrapper works

`rtk-wrap.ps1` installs PowerShell function shims only for tools that exist on
the machine:

```text
git, gh, glab, aws, psql, dotnet, docker, kubectl, oc,
grep, rg, curl, wget, npm, pnpm, npx, bun, bunx,
cargo, tsc, vitest, jest, ctest, prisma, playwright, prettier, ng
```

`cat <single file>` goes through `rtk read`; other `cat` forms use
`Get-Content`.

`ls` is deliberately not shimmed: `rtk ls` fails on Windows in this setup.

## Limitations

- The approval layer sees the wrapper command, with the original command visible
  inside `-Command '...'`.
- DSH's `read-only` / `workspace-write` sandbox may block RTK's child-process
  pipes. The default `danger-full-access` preset works.
- If Magpie runs on another machine, install the wrapper on the agent machine,
  because the shell executes the rewritten command there.
- v0.2 covers OpenAI Chat Completions (DSH's default `llm-pi-ai` provider).
  Anthropic Messages / Responses need an extra middleware branch.

## License

MIT