// Provider registry: 8 in the catalog; claude/codex native, the rest over ACP (including copilot --acp).
import type { Provider } from "./types.js";
import { createMockProvider } from "./mock.js";
import { createClaudeProvider } from "./claude/provider.js";
import { createCodexProvider } from "./codex/provider.js";
import { PROVIDER_CATALOG } from "./catalog.js";
import { createAcpProvider } from "./acp/provider.js";
import { acpConfigForEntry } from "./acp/specs.js";

const providers = new Map<string, Provider>();

export function registerProvider(p: Provider): void {
  providers.set(p.id, p);
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

export function listProviders(): Provider[] {
  return [...providers.values()];
}

export function initProviders(version: string = ""): void {
  providers.clear();
  for (const entry of PROVIDER_CATALOG) {
    if (entry.id === "claude") registerProvider(createClaudeProvider());
    else if (entry.id === "codex") registerProvider(createCodexProvider(version));
    else {
      const acp = acpConfigForEntry(entry, version);
      if (acp) registerProvider(createAcpProvider(acp));
    }
  }
  if (process.env.AGENT_CONSOLE_MOCK === "1") {
    registerProvider(createMockProvider());
  }
}
