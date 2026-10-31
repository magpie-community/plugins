import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SlashCommand } from "../slash.js";
import { parseSlashInput, sortSlashCommands } from "../slash.js";

export type CodexSlashEntry = SlashCommand & { body: string };

function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: raw };
  const fm = raw.slice(4, end);
  const meta: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (m) meta[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(end + 5) };
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t.replace(/^#+\s*/, "").slice(0, 120);
  }
  return "";
}

async function readPromptFiles(dir: string): Promise<CodexSlashEntry[]> {
  const out: CodexSlashEntry[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      const raw = await readFile(path, "utf8");
      const { meta, body } = parseFrontMatter(raw);
      const name = basename(f, ".md");
      out.push({
        name,
        description: meta.description || firstLine(body) || name,
        argumentHint: meta.argumentHint || meta["argument-hint"],
        kind: "command",
        body,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

async function readSkillDirs(root: string): Promise<CodexSlashEntry[]> {
  const out: CodexSlashEntry[] = [];
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const skillPath = join(root, d, "SKILL.md");
    try {
      const st = await stat(skillPath);
      if (!st.isFile()) continue;
      const raw = await readFile(skillPath, "utf8");
      const { meta, body } = parseFrontMatter(raw);
      const name = meta.name || d;
      out.push({
        name,
        description: meta.description || firstLine(body) || name,
        argumentHint: meta.argumentHint,
        kind: "skill",
        body,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function loadCodexSlashEntries(cwd: string, opts?: { skipHome?: boolean }): Promise<CodexSlashEntry[]> {
  const home = homedir();
  const parts = await Promise.all([
    opts?.skipHome ? Promise.resolve([]) : readPromptFiles(join(home, ".codex", "prompts")),
    readPromptFiles(join(cwd, ".codex", "prompts")),
    opts?.skipHome ? Promise.resolve([]) : readSkillDirs(join(home, ".codex", "skills")),
    readSkillDirs(join(cwd, ".codex", "skills")),
  ]);
  const byName = new Map<string, CodexSlashEntry>();
  for (const list of parts) {
    for (const e of list) {
      if (!byName.has(e.name)) byName.set(e.name, e);
    }
  }
  return sortSlashCommands([...byName.values()]) as CodexSlashEntry[];
}

export function expandCodexSlash(text: string, entries: CodexSlashEntry[]): string {
  const parsed = parseSlashInput(text);
  if (!parsed) return text;
  const hit = entries.find((e) => e.name === parsed.name);
  if (!hit) return text;
  return hit.body.replace(/\$ARGUMENTS/g, parsed.args);
}

export function codexSlashCommandsFromEntries(entries: CodexSlashEntry[]): SlashCommand[] {
  return entries.map(({ body: _b, ...rest }) => rest);
}
