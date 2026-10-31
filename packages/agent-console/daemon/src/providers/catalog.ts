import { tr } from "../util/i18n.js";
/** Provider catalog (fixed, 8 entries).
 *  status: verified=accepted on a real machine | experimental=usable but not guaranteed | planned=integration not confirmed
 *  All 8 are currently verified; default toggle: verified ones are on by default (see enabled.ts). */
export type ProviderStatus = "verified" | "experimental" | "planned";

export type ProviderCatalogEntry = {
  id: string;
  name: string;
  bins: string[];
  installHint: string;
  status: ProviderStatus;
};

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: "claude", name: "Claude Code", bins: ["claude"], installHint: "npm i -g @anthropic-ai/claude-code", status: "verified" },
  { id: "codex", name: "Codex", bins: ["codex"], installHint: "npm i -g @openai/codex", status: "verified" },
  { id: "cursor", name: "Cursor", bins: ["cursor-agent", "cursor"], installHint: "curl https://cursor.com/install -fsS | bash", status: "verified" },
  { id: "copilot", name: "Copilot", bins: ["copilot"], installHint: "npm i -g @github/copilot", status: "verified" },
  { id: "opencode", name: "OpenCode", bins: ["opencode"], installHint: "npm i -g opencode-ai", status: "verified" },
  { id: "pi", name: "Pi", bins: ["pi-acp", "pi", "pi-coding-agent"], installHint: "npm i -g pi-acp", status: "verified" },
  { id: "devin", name: "Devin CLI", bins: ["devin"], installHint: "https://docs.devin.ai/cli", status: "verified" },
  { id: "dsh", name: "dsh", bins: ["dsh"], installHint: "npm i -g @deepseek-ai/dsh", status: "verified" },
];

export function catalogById(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

export function providerCreatable(status: ProviderStatus): boolean {
  return status !== "planned";
}
