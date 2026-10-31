export type SlashCommandKind = "command" | "skill";

export type SlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: SlashCommandKind;
};

const CLAUDE_BUILTIN_COMMANDS = new Set(["clear", "compact", "context", "usage", "init", "debug"]);

export function classifyClaudeSlashCommand(name: string): SlashCommandKind {
  return CLAUDE_BUILTIN_COMMANDS.has(name) ? "command" : "skill";
}

/** Parse "/name args" (must start with /) */
export function parseSlashInput(text: string): { name: string; args: string; raw: string } | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const body = t.slice(1).trim();
  if (!body) return null;
  const sp = body.indexOf(" ");
  if (sp === -1) return { name: body, args: "", raw: t };
  return { name: body.slice(0, sp), args: body.slice(sp + 1).trim(), raw: t };
}

export function mapAcpAvailableCommands(
  cmds: { name: string; description: string; input?: { hint?: string } | null }[],
): SlashCommand[] {
  return cmds.map((c) => ({
    name: c.name,
    description: c.description,
    argumentHint: c.input?.hint,
    kind: "skill" as const,
  }));
}

export function sortSlashCommands(list: SlashCommand[]): SlashCommand[] {
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "command" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
