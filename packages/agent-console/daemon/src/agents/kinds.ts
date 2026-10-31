// Tool name → kind / title / detail mapping (ported from lib/agents/kinds.mjs).
// Adapters call callInfo(name, input, cwd) to get {kind, title, detail}; the frontend renders by kind.
import type { ToolKind } from "../timeline/types.js";

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
      return f("read", `读取 ${relPath(file, cwd)}`, { path: file, offset: input.offset, limit: input.limit });
    case "Edit":
      return f("edit", `编辑 ${relPath(file, cwd)}`, { path: file, old: input.old_string, new: input.new_string });
    case "MultiEdit":
      return f("edit", `编辑 ${relPath(file, cwd)}（${((input.edits as unknown[]) || []).length} 处）`, { path: file, edits: input.edits ?? [] });
    case "Write":
      return f("write", `${input._exists ? "覆盖" : "新建"} ${relPath(file, cwd)}`, { path: file, content: input.content });
    case "NotebookEdit":
      return f("edit", `编辑笔记本 ${relPath(String(input.notebook_path || file), cwd)}`, { path: input.notebook_path ?? file });
    case "Bash":
      return f("bash", `运行 ${trunc(String(input.command ?? ""))}`, { command: input.command, description: input.description });
    case "BashOutput":
      return f("bash", `查看输出 ${String(input.bash_id ?? "")}`, { bashId: input.bash_id });
    case "KillShell":
      return f("bash", `结束进程 ${String(input.shell_id ?? "")}`, { shellId: input.shell_id });
    case "Grep":
      return f("search", `搜索 "${trunc(String(input.pattern ?? ""), 40)}"`, { pattern: input.pattern, path: input.path, glob: input.glob });
    case "Glob":
    case "LS":
      return f("glob", `查找 ${trunc(String(input.pattern ?? input.path ?? ""), 40)}`, { pattern: input.pattern, path: input.path });
    case "WebFetch":
      return f("web", `打开 ${hostOf(String(input.url ?? ""))}`, { url: input.url });
    case "WebSearch":
      return f("web", `搜索网页 "${trunc(String(input.query ?? ""), 40)}"`, { query: input.query });
    case "TodoWrite": {
      const items = todoItems((input.todos as { content?: string; text?: string; status?: string }[]) ?? []);
      const done = items.filter((x) => x.status === "done").length;
      return f("todo", `更新待办（${done}/${items.length}）`, { items });
    }
    case "Task":
    case "Agent":
      return f("task", `子任务：${trunc(String(input.description ?? input.prompt ?? ""), 40)}`, { description: input.description });
    default:
      break;
  }
  const m = /^mcp__([^_]+)__(.+)$/.exec(t);
  if (m) return f("mcp", `${m[1]} · ${m[2]}`, { server: m[1], tool: m[2] });
  return f("other", t || "工具", {});
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
