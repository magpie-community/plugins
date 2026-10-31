// detect + placeholder only: marked available when the CLI exists locally; createSession says "not integrated yet".
import { resolveBin } from "../util/bin.js";
import type { Provider, DetectResult, ModelInfo, ProviderSession } from "./types.js";
import type { ProviderCatalogEntry } from "./catalog.js";
import type { Capabilities } from "./types.js";

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
    throw new Error("该 Agent 尚未在 Agent Console 接入，敬请期待");
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
            reason: entry.status === "verified" ? undefined : "已检测到 CLI，会话驱动尚未完全验证",
          };
        }
      }
      return { available: false, reason: `未找到 ${entry.bins[0]}`, installHint: entry.installHint };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
    async createSession() {
      if (entry.status === "planned") throw new Error("该 Agent 尚未在 Agent Console 接入，敬请期待");
      return notReadySession();
    },
  };
}
