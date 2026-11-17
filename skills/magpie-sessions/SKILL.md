---
name: magpie-sessions
description: Search what was said in every coding agent's sessions on this computer through magpie (usemagpie.ai) — Claude Code's, Codex's, OpenCode's, Gemini CLI's and the others' — and read the session a hit is in. Use when the user refers to an earlier conversation, decision, fix or command ("what did we decide about X", "the session where we fixed Y", "what did Codex say yesterday"), or when an earlier session would tell you something this one doesn't.
---

# magpie sessions

[magpie](https://usemagpie.ai) reads the session history of the coding
agents on this computer (once the user has allowed each one) and keeps an
index of what was said in them. Search it instead of reading the agents'
session files yourself.

## Search

```sh
magpie sessions search <words…>                  # every agent's sessions that said them, newest first
magpie sessions search rate limit --agent codex  # one agent's: claude, codex, gemini, opencode, …
magpie sessions search login --days 7 --limit 5  # only sessions used in the last 7 days (today, all)
magpie sessions search login --json
```

Every word must be said in the session; a word matches by its start.
Each hit is named `agent:id`, with its title, folder, when it was last
used, and the words round where it was said. Put words that start with
`-` after `--`.

`--json` gives `hits` (each with `session`: `agent`, `id`, `title`, `cwd`,
`last`, …, and `hit`: `role`, `before`, `match`, `after`), `indexed` and
`total` (sessions in the index, and to index), `cut` (there may be more
hits than `--limit`), and `listing` (still finding the sessions to index).

The first search on a long history builds the index, for up to a minute
(`--wait 3m` to give it longer); what was built is kept. When the answer
says "Still indexing", search again in a minute for the rest.

## Read a session

```sh
magpie sessions show codex:<id> --find "rate limit"   # from a few messages before the words
magpie sessions show codex:<id> --from 40             # from message 40
magpie sessions show codex:<id> --max-chars 50000     # more at once (20000 by default, 100000 at most)
magpie sessions show codex:<id> --json                # the parts, as magpie's Sessions page reads them
```

The text numbers each message (`[12] user:`), shortens tool calls and
their answers, and ends with the command that reads on when there is
more. An id alone is enough when only one agent has it.

## When it reads nothing

- "magpie reads no agent's session history until you allow it": the user
  hasn't chosen which agents' sessions magpie may read. Tell them; it is
  their decision (`magpie sessions read on all`, `magpie sessions read on
  claude codex`, or the Sessions page). Don't turn it on yourself.
- "not allowed to read this agent's sessions": that agent is turned off
  in `magpie sessions read`. Same: tell the user.
- If the `magpie` command isn't found, the user may have the app without
  its command on PATH: the Command line row in magpie's Settings puts it
  there.

## Don't

- Don't paste whole sessions back to the user: quote what answers their
  question and name the session (`agent:id`, title, date).
- Sessions can hold secrets the user typed or tools printed. Don't send
  what you read anywhere the user didn't ask for.
