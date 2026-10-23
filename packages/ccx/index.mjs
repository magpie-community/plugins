// Claude Code and Codex for every agent magpie connects, through the local
// ccx command: how much of each app's 5-hour and weekly window is used, and
// their sessions, to list and to read, so another agent can pick up a task
// where Claude Code or Codex left it. Read only. Arguments are JSON Schema,
// so the package needs no dependency.
import { app, folder, NAME, readArgs, run, sessionId, sessionsArgs } from "./ccx.mjs"

const appArg = { type: "string", enum: ["claude", "codex"], description: "claude for Claude Code, codex for Codex" }

export const CcxTools = async () => ({
  tool: {
    usage: {
      description:
        "How much of Claude Code's and Codex's usage window is used on this computer, and when it resets: " +
        "each app's level (ok, near at 90%+, limit, unknown), percent used, reset time and whether it is the weekly window. " +
        "Use it before handing work to Claude Code or Codex, or to tell the user which one has room left.",
      args: { type: "object", properties: {} },
      async execute(_args, ctx) {
        const u = JSON.parse(await run(["usage", "--json"], { signal: ctx?.abort }))
        const out = { available: !!u.available }
        for (const a of ["claude", "codex"]) {
          const w = u[a]
          if (w) out[a] = { level: w.level, used_percent: w.used_percentage, resets_at: w.resets_at_epoch ? new Date(w.resets_at_epoch * 1000).toISOString() : null,
            window: w.window === "weekly" ? "weekly" : "5-hour", from: w.source }
        }
        return out
      },
    },
    sessions: {
      description:
        "Lists Claude Code sessions or Codex threads on this computer, newest first, with their title, last update and id: " +
        "the ones in the project folder cwd, or with query, those whose title matches in every project. " +
        "Pass an id to ccx_read to read one. Use it when the user wants to continue, check or review something they did in Claude Code or Codex.",
      args: {
        type: "object",
        properties: {
          app: appArg,
          cwd: { type: "string", description: "absolute path of the project folder (your working directory)" },
          query: { type: "string", description: "words of the session's title; searches every project" },
        },
        required: ["app", "cwd"],
      },
      async execute(args, ctx) {
        const q = typeof args.query === "string" ? args.query.trim().slice(0, 200) : ""
        return (await run(sessionsArgs(app(args.app), folder(args.cwd), q), { signal: ctx?.abort })).trim()
      },
    },
    read: {
      description:
        "Reads a Claude Code session's or Codex thread's history in pages of about 6000 characters, condensed: " +
        "the user's and assistant's messages, the task list and short tool results. Start at offset 0 and call again with next_offset until it is null. " +
        "It only reads; the session is left as it is.",
      args: {
        type: "object",
        properties: {
          app: appArg,
          session_id: { type: "string", description: "the session's id, from ccx_sessions" },
          offset: { type: "number", description: "where to start (default 0); the next_offset of the page before" },
        },
        required: ["app", "session_id"],
      },
      async execute(args, ctx) {
        const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0
        const page = JSON.parse(await run(readArgs(app(args.app), sessionId(args.session_id), offset), { signal: ctx?.abort }))
        return { app: NAME[args.app], ...page }
      },
    },
  },
})
