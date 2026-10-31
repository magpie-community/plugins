---
name: agent-office
description: Open a live office view of every coding agent on this machine — Claude Code, Codex, Copilot CLI, Kimi Code, DeepSeek Harness, Gemini CLI, Qwen Code, Pi, omp, Qoder, WorkBuddy and CodeBuddy — and show who is thinking, running a tool, waiting for you, done or stuck. Use when the user types /agent-office, asks what their agents are doing, or wants a machine-readable snapshot.
---

# agent-office

The normal install is the magpie plugin. This skill runs the same page without
magpie, using Bun 1.2+.

Start the office in the background so it keeps running:

```bash
bun "<base directory>/bin/agent-office.mjs" --no-open
```

Then open the URL it prints. Running it again while it is up reuses the server.

For a one-off answer in chat, print a snapshot instead of opening a page:

```bash
bun "<base directory>/bin/agent-office.mjs" --json --hours 2
```

Summarize by status and project; do not paste prompts or replies unless the
user asks for them. Use `--private` for screen sharing or when the user wants
status only.

Options:

- `--hours 6` — sessions active in the last 6 hours
- `--private` — hide prompts, replies and titles; status and tool names only
- `--json` — one snapshot, then exit
- `--port 5000` — a different local port
- `--no-open` — don't open a browser

It reads the agents' own local session files, binds to `127.0.0.1` only, and
writes nothing back. Requires Bun; Node alone cannot run the compressed DSH
reader.
