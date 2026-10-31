// detect + placeholder only: marked available when the CLI exists locally; createSession says "not integrated yet".
import { resolveBin } from "../util/bin.js";
import type { Provider, DetectResult, ModelInfo, ProviderSession } from "./types.js";
import type { ProviderCatalogEntry } from "./catalog.js";
import type { Capabilities } from "./types.js";
import { tr } from "../util/i18n.js";

const stubCapabilities: Capabilities = {
  resume: false,
  interrupt: true,
  steer: false,
  images: false,
  plan: false,
  questions: false,
  cost: false,
  effort: [],
  modes: ["default"],
};

function notReadySession(): ProviderSession {
  const err = () => {
    throw new Error(tr("stub.planned"));
  };
  return {
    events: (async function* () {})(),
    send: err,
    interrupt: err,
    setModel: err,
    setMode: err,
    setEffort: err,
    respond: () => {},
    listCommands: async () => [],
    close: async () => {},
  };
}

export function createStubProvider(entry: ProviderCatalogEntry): Provider {
  return {
    id: entry.id,
    name: entry.name,
    capabilities: stubCapabilities,
    async detect(): Promise<DetectResult> {
      for (const bin of entry.bins) {
        const r = await resolveBin(bin);
        if (r.ok) {
          return {
            available: true,
            bin: r.display,
            reason: entry.status === "verified" ? undefined : tr("stub.unverified"),
          };
        }
      }
      return { available: false, reason: tr("stub.notFound", { bin: entry.bins[0] }), installHint: entry.installHint };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
    async createSession() {
      if (entry.status === "planned") throw new Error(tr("stub.planned"));
      return notReadySession();
    },
  };
}
