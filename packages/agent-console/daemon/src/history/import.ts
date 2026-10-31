// History import (§7.6): Claude sessions live in ~/.claude/projects/<encoded dir>/<sessionId>.jsonl.
// Don't guess the encoding rule: list every directory, read the first record with a cwd from each jsonl, match the project with samePath.
// Read-only throughout.
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { samePath } from "../util/paths.js";
import { tr } from "../util/i18n.js";

const CLAUDE_ROOT = join(homedir(), ".claude", "projects");

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// One jsonl line → {cwd?, title?, isUserText}
function parseLine(line: string): { cwd?: string; userText?: string } | null {
  let r: Rec;
  try {
    r = rec(JSON.parse(line));
  } catch {
    return null;
  }
  const cwd = str(r.cwd);
  let userText: string | undefined;
  if (r.type === "user") {
    const content = rec(r.message).content;
    if (typeof content === "string") userText = content;
    else if (Array.isArray(content)) {
      const t = content.map((p) => (rec(p).type === "text" ? str(rec(p).text) : undefined)).find(Boolean);
      userText = t;
    }
  }
  return { cwd, userText };
}

async function* linesOf(path: string): AsyncGenerator<string> {
  const text = await readFile(path, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (line.trim()) yield line;
  }
}

// Project cwd → that project's past sessions
export async function listClaudeHistory(cwd: string): Promise<{ sessionId: string; title: string; updatedAt: number; messageCount: number }[]> {
  const out: { sessionId: string; title: string; updatedAt: number; messageCount: number }[] = [];
  const dirs = await readdir(CLAUDE_ROOT).catch(() => [] as string[]);
  for (const d of dirs) {
    const dirPath = join(CLAUDE_ROOT, d);
    const files = (await readdir(dirPath).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const path = join(dirPath, f);
      let match = false;
      let title = "";
      let count = 0;
      for await (const line of linesOf(path)) {
        const p = parseLine(line);
        if (!p) continue;
        if (!match) {
          if (!p.cwd) continue;
          match = samePath(p.cwd, cwd);
          if (!match) break;
        }
        if (p.userText && !title) title = p.userText.slice(0, 40);
        if (p.userText) count++;
      }
      if (!match) continue;
      const s = await stat(path).catch(() => null);
      out.push({
        sessionId: f.replace(/\.jsonl$/, ""),
        title: title || tr("history.untitled"),
        updatedAt: s ? Math.round(s.mtimeMs) : 0,
        messageCount: count,
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// Read one session's jsonl → SDK message shape (so mapSdkMessage can be reused)
export async function readClaudeHistory(sessionId: string, cwd: string): Promise<Rec[]> {
  const dirs = await readdir(CLAUDE_ROOT).catch(() => [] as string[]);
  for (const d of dirs) {
    const path = join(CLAUDE_ROOT, d, `${sessionId}.jsonl`);
    if (!existsSync(path)) continue;
    // Confirm it belongs to this project (the first cwd record matches)
    const msgs: Rec[] = [];
    let matched = false;
    for await (const line of linesOf(path)) {
      const p = parseLine(line);
      if (!matched) {
        if (p?.cwd && samePath(p.cwd, cwd)) matched = true;
        else continue;
      }
      let r: Rec;
      try {
        r = rec(JSON.parse(line));
      } catch {
        continue;
      }
      // Keep only user/assistant/result — same shape as the SDK's streamed messages, so mapSdkMessage can digest them
      if (r.type === "user" || r.type === "assistant") msgs.push(r);
    }
    return msgs;
  }
  return [];
}
