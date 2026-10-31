// Codex history import (§7.6): ~/.codex/sessions/**/rollout-*.jsonl
// Layout: session_meta (with cwd) → event_msg → response_item (message/function_call/...)
// Import only user messages (minus environment_context and similar wrappers) + the assistant's final reply text; tool steps become notices. Read-only throughout.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { samePath } from "../util/paths.js";

const CODEX_ROOT = join(homedir(), ".codex", "sessions");

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Environment wrappers in user messages: anything whose first line starts with <environment_context> or <user_instructions> isn't user input
const WRAPPERS = /^\s*<(environment_context|user_instructions|skills_instructions|permissions instructions)>/i;

function textOf(content: unknown, kind: string): string {
  if (!Array.isArray(content)) return "";
  return (content as Rec[])
    .filter((p) => p.type === kind || p.type === "input_text" || p.type === "output_text")
    .map((p) => str(p.text) ?? "")
    .join("\n")
    .trim();
}

// Find rollout-*.jsonl recursively
async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 6) return;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, name);
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) yield* walk(p, depth + 1);
    else if (/^rollout-.*\.jsonl$/.test(name)) yield p;
  }
}

export type CodexHistItem = { sessionId: string; title: string; updatedAt: number; messageCount: number };

export async function listCodexHistory(cwd: string): Promise<CodexHistItem[]> {
  const out: CodexHistItem[] = [];
  for await (const path of walk(CODEX_ROOT)) {
    const m = /rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(path);
    const sessionId = m?.[1];
    if (!sessionId) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    let match = false;
    let title = "";
    let count = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r: Rec;
      try {
        r = rec(JSON.parse(line));
      } catch {
        continue;
      }
      // session_meta records payload.cwd
      if (r.type === "session_meta") {
        const cwdInFile = str(rec(r.payload).cwd);
        if (cwdInFile && samePath(cwdInFile, cwd)) match = true;
        else break; // Not this project: stop reading
        continue;
      }
      if (!match) continue;
      if (r.type === "response_item") {
        const p = rec(r.payload);
        if (p.type === "message" && p.role === "user") {
          const t = textOf(p.content, "input_text");
          if (t && !WRAPPERS.test(t)) {
            count++;
            if (!title) title = t.slice(0, 40);
          }
        }
      }
    }
    if (!match) continue;
    const s = await stat(path).catch(() => null);
    out.push({ sessionId, title: title || "（无标题）", updatedAt: s ? Math.round(s.mtimeMs) : 0, messageCount: count });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// Read one rollout → simplified events (user_message / assistant_message / notice for tool steps / turn_ended)
type CodexEv = {
  type: string; text?: string; message?: string; itemId?: string; level?: string;
  turnId?: string; status?: string;
};
export async function readCodexHistory(sessionId: string, cwd: string): Promise<CodexEv[]> {
  const out: CodexEv[] = [];
  let file: string | null = null;
  for await (const p of walk(CODEX_ROOT)) {
    if (p.endsWith(`${sessionId}.jsonl`)) { file = p; break; }
  }
  if (!file) return out;
  const text = await readFile(file, "utf8").catch(() => "");
  let matched = false;
  let aid = 0;
  // response_item.message and event_msg.item_completed duplicate each other → dedupe by text
  const seenText = new Set<string>();
  const pushText = (type: "user_message" | "assistant_message", t: string) => {
    const key = type + ":" + t;
    if (!t || seenText.has(key)) return;
    seenText.add(key);
    out.push(type === "user_message" ? { type, text: t } : { type, itemId: `imp_a${aid++}`, text: t });
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: Rec;
    try {
      r = rec(JSON.parse(line));
    } catch {
      continue;
    }
    if (r.type === "session_meta") {
      const c = str(rec(r.payload).cwd);
      if (c && samePath(c, cwd)) matched = true;
      continue;
    }
    if (!matched) continue;
    // response_item message
    if (r.type === "response_item") {
      const p = rec(r.payload);
      if (p.type === "message") {
        const role = str(p.role);
        const phase = str(p.phase);
        if (role === "user") {
          const t = textOf(p.content, "input_text");
          if (t && !WRAPPERS.test(t)) pushText("user_message", t);
        } else if (role === "assistant" && phase !== "commentary") {
          const t = textOf(p.content, "output_text");
          if (t) pushText("assistant_message", t);
        }
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        const name = str(p.name) ?? "tool";
        out.push({ type: "notice", level: "info", message: `（历史）调用 ${name}` });
      }
      continue;
    }
    // event_msg.item_completed: AgentMessage (Text content blocks) and task_complete.last_agent_message
    if (r.type === "event_msg") {
      const p = rec(r.payload);
      if (p.type === "item_completed") {
        const it = rec(p.item);
        if (it.type === "AgentMessage" && it.phase !== "commentary") {
          const t = textOf(it.content, "Text");
          if (t) pushText("assistant_message", t);
        } else if (it.type === "UserMessage") {
          const t = textOf(it.content, "text");
          if (t && !WRAPPERS.test(t)) pushText("user_message", t);
        }
      } else if (p.type === "task_complete") {
        const last = str(p.last_agent_message);
        if (last) pushText("assistant_message", last);
      }
      continue;
    }
    const p2 = rec(r.payload);
    if (p2.type === "function_call" || p2.type === "custom_tool_call") {
      // Tool steps collapse into a one-line notice (§7.6, Codex part)
      const name = str(p2.name) ?? "tool";
      out.push({ type: "notice", level: "info", message: `（历史）调用 ${name}` });
    }
  }
  out.push({ type: "turn_ended", turnId: "import", status: "completed" });
  return out;
}
