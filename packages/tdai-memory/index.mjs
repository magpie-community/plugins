// The plugin's tools: magpie offers them to every agent through its plugin
// tools MCP server, so an agent whose model isn't served by magpie (Gemini
// CLI, Cursor, Copilot…) still reads and adds to the same memory.
//
// Unlike the requests the gateway hook sees, a tool call carries no origin,
// and magpie serves plugin tools to other computers that hold a gateway key
// as well. So there are no tools until the options turn them on.

import { KernelError, call, capture, config, cut, scope } from "./lib.mjs"

// options are what the plugin's Options (or `magpie plugin options`) set,
// the same the gateway hook is handed as ctx.options (input.magpie.options is
// a provider's sign-in switches, not these); a change reloads the plugin.
export default async function tdaiMemory(input, options) {
  const o = config(options)
  if (!o.tools) return {}
  const fail = (e) => (e instanceof KernelError ? `memory-core ${e.kind} (${e.status})` : `memory-core error: ${e?.message ?? e}`)
  const list = (v) => (Array.isArray(v) ? v : [])
  return {
    tool: {
      search: {
        description: "Search the long-term memory every agent on this computer shares (TDAI memory-core): extracted memories (L1) and, optionally, raw past conversations (L0). Use it before starting work that someone may have done before, or when the user refers to earlier decisions.",
        args: {
          type: "object",
          properties: {
            query: { type: "string", description: "keywords or a question" },
            limit: { type: "integer", description: "results per layer, 1-20 (default 5)" },
            conversations: { type: "boolean", description: "also search raw past conversations (default false)" },
          },
          required: ["query"],
        },
        async execute(args, ctx) {
          const q = String(args?.query ?? "").trim().slice(0, 2048)
          if (!q) return "query is empty"
          // magpie hands the arguments on as they came: a number or a switch may be text
          const n = Number(args?.limit)
          const limit = Number.isInteger(n) && n > 0 ? Math.min(20, n) : 5
          const conversations = args?.conversations === true || args?.conversations === "true"
          const sc = scope(o, ctx?.agent)
          try {
            const [l1, l0] = await Promise.all([
              call(o, "atomic/search", { ...sc, query: q, limit }, ctx?.abort),
              conversations ? call(o, "conversation/search", { ...sc, query: q, limit }, ctx?.abort) : null,
            ])
            const out = []
            for (const m of list(l1?.items)) out.push(`- [${m?.type}] ${m?.content}${m?.updated_at ? ` (${String(m.updated_at).slice(0, 10)})` : ""}`)
            for (const m of list(l0?.messages)) out.push(`- [conversation ${m?.role} ${String(m?.timestamp ?? "").slice(0, 10)} ${m?.session_id ?? ""}] ${cut(m?.content, 600)}`)
            return out.length ? out.join("\n") : "nothing found"
          } catch (e) {
            return fail(e)
          }
        },
      },
      read_scene: {
        description: "Read one scene file (L2) of the shared memory, by the path the recalled <scenes> list gives (the core's scene_blocks/… paths work too).",
        args: { type: "object", properties: { path: { type: "string", description: "a path from the <scenes> list, such as deploy.md" } }, required: ["path"] },
        async execute(args, ctx) {
          // the kernel's L3 core names scenes by their file under scene_blocks/;
          // scenario/read takes the name inside it, as scenario/ls lists it
          const path = String(args?.path ?? "").trim().replace(/^(?:.*\/)?scene_blocks\//, "")
          if (!path) return "path is empty"
          try {
            const d = await call(o, "scenario/read", { ...scope(o, ctx?.agent), path }, ctx?.abort)
            return typeof d?.content === "string" ? d.content : "no such scene"
          } catch (e) {
            return fail(e)
          }
        },
      },
      remember: {
        description: "Write something worth remembering into the shared memory: a decision, a fact about a project, a pitfall and its fix. The kernel's pipeline extracts it into memories other agents recall later (not at once).",
        args: {
          type: "object",
          properties: {
            content: { type: "string", description: "what to remember, self-contained" },
            project: { type: "string", description: "project or folder it is about (optional)" },
          },
          required: ["content"],
        },
        async execute(args, ctx) {
          const content = String(args?.content ?? "").trim()
          if (!content) return "content is empty"
          const agent = ctx?.agent || "agent"
          const project = String(args?.project ?? "").trim()
          const about = project ? ` about ${project}` : ""
          try {
            await capture(o, scope(o, ctx?.agent), `remember:${agent}`, `Remember this${about}: ${content}`, "Noted.", ctx?.abort)
            return "saved to L0; it becomes a recallable memory once the kernel's pipeline runs"
          } catch (e) {
            return fail(e)
          }
        },
      },
    },
  }
}
