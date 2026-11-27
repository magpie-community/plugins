import { homedir } from "node:os";
import { join } from "node:path";
import { threadName } from "../vendor/cam/adapters/codex/thread-names.ts";

export type SessionTitle = { title: string | null; titleSource: "index" | "query" | null };

function concise(value: unknown, max = 60): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
}

export function sessionTitle(platform: string, named: string, query?: unknown, env: NodeJS.ProcessEnv = process.env): SessionTitle {
  if (platform === "codex") {
    const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    const original = threadName(join(home, "sessions"), named);
    if (original) return { title: original, titleSource: "index" };
  }
  return { title: concise(query), titleSource: query ? "query" : null };
}
