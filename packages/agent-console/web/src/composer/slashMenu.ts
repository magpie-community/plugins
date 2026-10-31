export type SlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
};

export type SlashMenuState = { open: boolean; query: string };

/** Show the command menu while the input starts with "/" and no space-separated argument has been typed yet */
export function slashMenuState(text: string, suppressed = false): SlashMenuState {
  if (suppressed || !text.startsWith("/")) return { open: false, query: "" };
  const body = text.slice(1);
  if (body.includes("\n") || body.includes(" ")) return { open: false, query: "" };
  return { open: true, query: body };
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      (c.argumentHint ?? "").toLowerCase().includes(q),
  );
}

export type SlashMenuRow =
  | { type: "heading"; id: string; labelKey: "slashGroupCommand" | "slashGroupSkill" }
  | { type: "item"; id: string; command: SlashCommand };

export function slashMenuRows(commands: SlashCommand[]): SlashMenuRow[] {
  const cmds = commands.filter((c) => c.kind === "command");
  const skills = commands.filter((c) => c.kind === "skill");
  const out: SlashMenuRow[] = [];
  if (cmds.length) {
    out.push({ type: "heading", id: "h-cmd", labelKey: "slashGroupCommand" });
    for (const c of cmds) out.push({ type: "item", id: `c:${c.name}`, command: c });
  }
  if (skills.length) {
    out.push({ type: "heading", id: "h-skill", labelKey: "slashGroupSkill" });
    for (const c of skills) out.push({ type: "item", id: `s:${c.name}`, command: c });
  }
  return out;
}

export function selectableSlashRows(rows: SlashMenuRow[]): SlashCommand[] {
  return rows.filter((r): r is Extract<SlashMenuRow, { type: "item" }> => r.type === "item").map((r) => r.command);
}

export function applySlashPick(name: string): string {
  return `/${name} `;
}

/** The input is already a complete "/command": Enter sends it instead of completing to the same command again. */
export function slashEnterSends(text: string, pickName: string | undefined): boolean {
  return !!pickName && text.trim() === `/${pickName}`;
}

export function clampSlashIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return count - 1;
  if (index >= count) return 0;
  return index;
}
