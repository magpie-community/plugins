// Tool name → kind / title / detail mapping (ported from lib/agents/kinds.mjs).
// Adapters call callInfo(name, input, cwd) to get {kind, title, detail}; the frontend renders by kind.
import type { ToolKind } from "../timeline/types.js";
import { tr } from "../util/i18n.js";

const MAX_CMD = 80;
const trunc = (s: string, n = MAX_CMD): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function relPath(p: string, cwd: string): string {
  if (!p) return "";
  const s = String(p);
  if (!cwd) return s;
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(s);
  const b = norm(cwd);
  if (a.toLowerCase().startsWith(b.toLowerCase() + "/")) return a.slice(b.length + 1);
  if (a.toLowerCase() === b.toLowerCase()) return ".";
  return s;
}

export type CallInfo = { kind: ToolKind; title: string; detail: Record<string, unknown> };

type ToolInput = Record<string, unknown> & { _exists?: boolean };

export function callInfo(name: string, input: ToolInput = {}, cwd = ""): CallInfo {
  const t = String(name || "");
  const f = (kind: ToolKind, title: string, detail: Record<string, unknown>): CallInfo => ({ kind, title, detail });
  const file = String(input.file_path ?? input.path ?? input.notebook_path ?? "");

  switch (t) {
    case "Read":
      return f("read", tr("tool.read", { x: relPath(file, cwd) }), { path: file, offset: input.offset, limit: input.limit });
    case "Edit":
      return f("edit", tr("tool.edit", { x: relPath(file, cwd) }), { path: file, old: input.old_string, new: input.new_string });
    case "MultiEdit":
      return f("edit", tr("tool.multiEdit", { x: relPath(file, cwd), n: ((input.edits as unknown[]) || []).length }), { path: file, edits: input.edits ?? [] });
    case "Write":
      return f("write", tr(input._exists ? "tool.overwrite" : "tool.create", { x: relPath(file, cwd) }), { path: file, content: input.content });
    case "NotebookEdit":
      return f("edit", tr("tool.notebook", { x: relPath(String(input.notebook_path || file), cwd) }), { path: input.notebook_path ?? file });
    case "Bash":
      return f("bash", tr("tool.run", { x: trunc(String(input.command ?? "")) }), { command: input.command, description: input.description });
    case "BashOutput":
      return f("bash", tr("tool.output", { x: String(input.bash_id ?? "") }), { bashId: input.bash_id });
    case "KillShell":
      return f("bash", tr("tool.kill", { x: String(input.shell_id ?? "") }), { shellId: input.shell_id });
    case "Grep":
      return f("search", tr("tool.grep", { x: trunc(String(input.pattern ?? ""), 40) }), { pattern: input.pattern, path: input.path, glob: input.glob });
    case "Glob":
    case "LS":
      return f("glob", tr("tool.glob", { x: trunc(String(input.pattern ?? input.path ?? ""), 40) }), { pattern: input.pattern, path: input.path });
    case "WebFetch":
      return f("web", tr("tool.fetch", { x: hostOf(String(input.url ?? "")) }), { url: input.url });
    case "WebSearch":
      return f("web", tr("tool.webSearch", { x: trunc(String(input.query ?? ""), 40) }), { query: input.query });
    case "TodoWrite": {
      const items = todoItems((input.todos as { content?: string; text?: string; status?: string }[]) ?? []);
      const done = items.filter((x) => x.status === "done").length;
      return f("todo", tr("tool.todo", { done, n: items.length }), { items });
    }
    case "Task":
    case "Agent":
      return f("task", tr("tool.task", { x: trunc(String(input.description ?? input.prompt ?? ""), 40) }), { description: input.description });
    default:
      break;
  }
  const m = /^mcp__([^_]+)__(.+)$/.exec(t);
  if (m) return f("mcp", `${m[1]} · ${m[2]}`, { server: m[1], tool: m[2] });
  return f("other", t || tr("tool.generic"), {});
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "").slice(0, 40);
  }
}

export function todoItems(todos: { content?: string; text?: string; status?: string }[] = []): { text: string; status: string }[] {
  return todos.map((x) => ({
    text: x.content || x.text || "",
    status: x.status === "completed" ? "done" : x.status === "in_progress" ? "in_progress" : "pending",
  }));
}
