import type { ProviderCatalogEntry } from "../catalog.js";
import type { AcpProviderConfig } from "./provider.js";
import { cursorAcpCapabilities } from "./provider.js";
import { acpProbeModels, cursorProbeModels, dshProbeModels } from "./probe.js";
import { DSH_ACP_ARGS, dshAcpArgs } from "./dsh.js";

const ACP_IDS = new Set(["cursor", "devin", "opencode", "dsh", "pi", "copilot"]);

export function isAcpCatalogId(id: string): boolean {
  return ACP_IDS.has(id);
}

// Model lists and thinking levels always come from what the Agent reports over ACP (acpProbeModels), no longer from parsing each CLI's text output.
// modeMap: our permission modes → the Agent's real mode names (from what session/new actually reports); "" means keep the entry but send nothing.
export function acpConfigForEntry(entry: ProviderCatalogEntry, appVersion: string): AcpProviderConfig | null {
  if (!ACP_IDS.has(entry.id)) return null;
  const base: Omit<AcpProviderConfig, "acpArgs" | "fetchModels" | "flavor" | "capabilities"> = {
    id: entry.id,
    name: entry.name,
    binName: entry.bins[0] ?? entry.id,
    binCandidates: entry.bins,
    installHint: entry.installHint,
    appVersion,
  };

  switch (entry.id) {
    case "cursor":
      // Modes: agent / plan / ask (see cursorAcpCapabilities)
      return {
        ...base,
        acpArgs: ["acp"],
        flavor: "cursor",
        capabilities: cursorAcpCapabilities,
        // Each model's own thinking levels come from cursor/list_available_models (as Paseo does)
        fetchModels: cursorProbeModels(["acp"], entry.id),
      };
    case "devin":
      // Modes: Code(accept-edits) / Smart / Ask / Plan / Bypass Permissions
      return {
        ...base,
        acpArgs: ["acp"],
        fetchModels: acpProbeModels(["acp"], entry.id),
        modeMap: { plan: "plan", default: "ask", acceptEdits: "accept-edits", bypassPermissions: "bypass" },
        modeLabels: { plan: "Plan", default: "Ask", acceptEdits: "Code", bypassPermissions: "Bypass Permissions" },
      };
    case "opencode":
      // Modes: build / plan; thinking level effort (low…ultra, including fast variants)
      return {
        ...base,
        acpArgs: ["acp"],
        fetchModels: acpProbeModels(["acp"], entry.id),
        modeMap: { plan: "plan", default: "build" },
        modeLabels: { plan: "Plan", default: "Build" },
      };
    case "copilot":
      // As Paseo: Agent / Plan / Allow All. Allow All = agent mode + allow_all config on (autopilot is not used)
      return {
        ...base,
        acpArgs: ["--acp"],
        fetchModels: acpProbeModels(["--acp"], entry.id),
        modeMap: { plan: "plan", default: "agent", bypassPermissions: "allow-all" },
        modeLabels: { plan: "Plan", default: "Agent", bypassPermissions: "Allow All" },
      };
    case "pi":
      // pi-acp has no mode options; thinking level thought_level (low…max)
      return { ...base, acpArgs: [], fetchModels: acpProbeModels([], entry.id), modeMap: { default: "" } };
    case "dsh":
      // Started on the conversation's route (--patch), so its initialize advertises image input for that model (see dsh.ts)
      return {
        ...base,
        acpArgs: DSH_ACP_ARGS,
        argsFor: (model) => dshAcpArgs(model),
        imagesFollowStartModel: true,
        fetchModels: dshProbeModels(entry.id),
      };
    default:
      return null;
  }
}
