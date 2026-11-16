// Claude Code and Codex conversations as tools magpie offers every agent (its
// MCP server /mcp/magpie/tools). An agent on any model can list them and read
// one to pick up the task where it stopped. Nothing here writes to a
// conversation or opens an app.
//
// Claude Code's transcripts are read from the JSONL the app writes; Codex's
// are read through Codex's own app-server API. Nothing is read until the
// user allows that project or conversation — see consent.mjs.
import { allowConversation, allowProject, getState, isAllowed, notAllowed } from "./consent.mjs"
import * as claude from "./claude.mjs"
import * as codex from "./codex.mjs"

const APP = {
  type: "string",
  enum: ["claude", "codex"],
  description: "whose conversations: claude (Claude Code) or codex (Codex)",
}

const source = (app) => (app === "codex" ? codex : claude)

const listText = (app, sessions) => {
  if (!sessions.length) return `No ${app} conversations found.`
  const head = `${app === "codex" ? "Codex" : "Claude"} sessions, newest first:`
  return [head, ...sessions.map((s, i) => `${i + 1}. “${s.title}” · ${s.cwd || "(no folder)"} · id=${s.id}`)].join("\n")
}

export const CcxTools = async () => ({
  tool: {
    sessions: {
      description:
        "Lists the Claude Code or Codex conversations on this Mac, newest first, with each one's id, title and folder. " +
        "Use it to find the conversation where a task was being worked on, then ccx_read it to continue. `query` searches titles; " +
        "`cwd` narrows to one folder. " +
        "These tools return the conversation's contents, which are then sent to the model that asks for them: " +
        "nothing is listed until you have allowed that folder or conversation (ccx_allow does that).",
      args: {
        type: "object",
        properties: {
          app: APP,
          query: { type: "string", description: "words from the title, searched in every project" },
          cwd: { type: "string", description: "the project folder, so its conversations are marked" },
        },
        required: ["app"],
      },
      async execute(args, ctx) {
        const app = args?.app
        if (app !== "claude" && app !== "codex") throw new Error('app is "claude" or "codex"')
        const sessions = await source(app).listSessions({ query: args?.query, cwd: args?.cwd })
        const allowed = sessions.filter((s) => isAllowed({ cwd: s.cwd, id: s.id }))
        if (!allowed.length) {
          const denied = sessions.filter((s) => !isAllowed({ cwd: s.cwd, id: s.id }))
          if (!denied.length) return listText(app, [])
          throw new Error(notAllowed(denied))
        }
        return listText(app, allowed)
      },
    },
    read: {
      description:
        "Reads a Claude Code or Codex conversation as condensed text: the messages, each tool call and its result in short, and the plan, so you can carry on the task " +
        "without the user explaining it again. It comes in pages of about 6000 characters: when next_offset is below total_chars, call again with offset = next_offset. " +
        "Take session_id from ccx_sessions. The text is sent to the model that asks for it, so the user must have allowed that conversation first.",
      args: {
        type: "object",
        properties: {
          app: APP,
          session_id: { type: "string", description: "the conversation's id, from ccx_sessions" },
          offset: { type: "number", description: "where to start, the next_offset of the last read (default 0)" },
        },
        required: ["app", "session_id"],
      },
      async execute(args, ctx) {
        const app = args?.app
        if (app !== "claude" && app !== "codex") throw new Error('app is "claude" or "codex"')
        const id = typeof args?.session_id === "string" ? args.session_id.trim() : ""
        if (!id) throw new Error("session_id is a string, from ccx_sessions")
        const found = await source(app).findSession(id)
        if (!found) throw new Error(`${app === "codex" ? "Codex" : "Claude"} session ${id} not found`)
        if (!isAllowed({ cwd: found.cwd, id: found.id })) {
          throw new Error(
            notAllowed([{ cwd: found.cwd, title: found.title, id: found.id }]) +
              `\n  This conversation's id is ${found.id}.`,
          )
        }
        const offset = args?.offset === undefined ? 0 : Number(args.offset)
        if (!Number.isInteger(offset) || offset < 0) throw new Error("offset is a whole number, the next_offset of the last read")
        return source(app).readSession(id, { offset })
      },
    },
    allow: {
      description:
        "Allows these tools to read one project folder or one conversation, after the user asked for it. " +
        "The choice is kept in the package's own state file and lasts until it is removed. " +
        "The user can also allow it themselves with `magpie plugin allow-ccx project <folder>`.",
      args: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["project", "conversation"],
            description: "what to allow: a project folder, or a single conversation",
          },
          target: {
            type: "string",
            description: "the folder (project) or the conversation id (conversation)",
          },
        },
        required: ["scope", "target"],
      },
      async execute(args) {
        const target = typeof args?.target === "string" ? args.target.trim() : ""
        if (!target) throw new Error("target is a folder or a conversation id")
        if (args?.scope === "project") {
          allowProject(target)
          return `Allowed the project ${target}.`
        }
        if (args?.scope === "conversation") {
          allowConversation(target)
          return `Allowed the conversation ${target}.`
        }
        throw new Error('scope is "project" or "conversation"')
      },
    },
    state: {
      description:
        "What these tools are allowed to read right now: the projects and conversations the user has allowed, and where that is kept.",
      args: { type: "object", properties: {} },
      async execute() {
        const state = getState()
        return {
          projects: state.projects,
          conversations: state.conversations,
          note: "Conversations in these folders (or with these ids) may be read. Anything else is refused until it is allowed.",
        }
      },
    },
  },
})
