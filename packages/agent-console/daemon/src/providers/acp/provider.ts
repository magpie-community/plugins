import type { Provider, DetectResult, ModelInfo, Capabilities, Mode, LaunchCommand } from "../types.js";
import { killTree, spawnBin, type ResolveResult } from "../../util/bin.js";
import { resolveFirstBin } from "../../util/bin.js";
import { resolveLaunch } from "../launch.js";
import { PLACEHOLDER_MODEL_NAME } from "../types.js";
import { AcpSession } from "./session.js";
import { knownPromptCaps } from "./promptCaps.js";

export type AcpProviderConfig = {
  id: string;
  name: string;
  binName: string;
  /** Takes precedence over binName: detect / listModels / session resolve these in order */
  binCandidates?: string[];
  acpArgs: string[];
  /** Arguments for one session's ACP process from its model (dsh starts on the conversation's route); default acpArgs */
  argsFor?: (model: string | null) => Promise<string[]>;
  /** The Agent decides at initialize whether it takes images, for the model it started on (dsh): a model picked later sends images by path */
  imagesFollowStartModel?: boolean;
  installHint: string;
  appVersion?: string;
  flavor?: "cursor" | "generic";
  capabilities?: Capabilities;
  fetchModels?: (r: ResolveResult & { ok: true }, launchArgs?: string[]) => Promise<ModelInfo[]>;
  /** Our permission modes → this Agent's mode names over ACP; when given, only modes in the table are shown */
  modeMap?: Partial<Record<Mode, string>>;
  /** Mode names shown in the UI (the Agent's own naming) */
  modeLabels?: Partial<Record<Mode, string>>;
};

export const acpCapabilities: Capabilities = {
  resume: true,
  interrupt: true,
  steer: false,
  images: false,
  plan: true,
  questions: false,
  cost: false,
  effort: [],
  modes: ["plan", "default", "acceptEdits", "bypassPermissions"],
  deltasOnly: true,
};

export const cursorAcpCapabilities: Capabilities = {
  ...acpCapabilities,
  questions: true,
  modes: ["default", "plan", "ask"],
};

function runVersion(r: ResolveResult & { ok: true }, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let out = "";
    const p = spawnBin(r, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    const t = setTimeout(() => {
      try {
        void killTree(p, { graceMs: 500 }); // On Windows a .cmd wrapper must be killed together with its child processes
      } catch {}
      reject(new Error("timeout"));
    }, timeoutMs);
    p.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    p.stderr?.on("data", (c: Buffer) => (out += c.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0 || out.trim()) resolvePromise(out.trim());
      else reject(new Error("exit " + code));
    });
  });
}

async function resolveProviderBin(cfg: AcpProviderConfig) {
  const names = cfg.binCandidates?.length ? cfg.binCandidates : [cfg.binName];
  return resolveFirstBin(names);
}

export function createAcpProvider(cfg: AcpProviderConfig): Provider {
  const base = cfg.capabilities ?? acpCapabilities;
  // With a mode table, expose only the modes the Agent really has (in our fixed order)
  const ORDER: Mode[] = ["plan", "default", "acceptEdits", "bypassPermissions"];
  const caps: Capabilities = cfg.modeMap
    ? { ...base, modes: ORDER.filter((m) => cfg.modeMap![m] !== undefined), modeLabels: cfg.modeLabels }
    : base;
  return {
    id: cfg.id,
    name: cfg.name,
    // images is what the Agent's own initialize says (probe at warm-up / providers.list, or any session); until then unknown
    get capabilities(): Capabilities {
      const learned = knownPromptCaps(cfg.id);
      return learned ? { ...caps, images: learned.image, imagesKnown: true } : { ...caps, images: false, imagesKnown: false };
    },
    async detect(launch?: LaunchCommand): Promise<DetectResult> {
      const r = launch ? await resolveLaunch(launch) : await resolveProviderBin(cfg);
      if (!r.ok) {
        return { available: false, reason: r.reason, installHint: cfg.installHint };
      }
      let version: string | undefined;
      const versionArgs = cfg.id === "devin" ? ["version"] : ["cursor", "opencode"].includes(cfg.id) ? ["--version"] : null;
      try {
        if (versionArgs) {
          // Only the internal prefix: the user's extra args are meant for the ACP command, not for --version
          version = (await runVersion(r, [...(launch?.prefixArgs ?? []), ...versionArgs])).split(/\r?\n/)[0]?.trim();
        }
      } catch {
        /* Having the binary is enough */
      }
      return { available: true, bin: r.display, version };
    },
    async listModels(launch?: LaunchCommand): Promise<ModelInfo[]> {
      const resolved = launch ? await resolveLaunch(launch) : await resolveProviderBin(cfg);
      if (!resolved.ok) return [{ id: "default", name: PLACEHOLDER_MODEL_NAME, isDefault: true }];
      // The internal prefix rides on the resolution (fetchModels puts its own ACP args after it), the user's args go last
      const r = launch?.prefixArgs?.length && resolved.via !== "cmd-shim"
        ? { ...resolved, prefixArgs: [...resolved.prefixArgs, ...launch.prefixArgs] }
        : resolved;
      if (cfg.fetchModels) return cfg.fetchModels(r, launch?.args ?? []);
      return [{ id: "default", name: PLACEHOLDER_MODEL_NAME, isDefault: true }];
    },
    async createSession(o) {
      return new AcpSession({
        threadId: o.threadId,
        providerId: cfg.id,
        providerName: cfg.name,
        cwd: o.cwd,
        model: o.model,
        mode: o.mode,
        effort: o.effort,
        resumeId: o.resumeId,
        binName: cfg.binName,
        binCandidates: cfg.binCandidates ?? [cfg.binName],
        acpArgs: cfg.argsFor ? await cfg.argsFor(o.model) : cfg.acpArgs,
        imagesFollowStartModel: cfg.imagesFollowStartModel,
        appVersion: cfg.appVersion ?? "0.0.1",
        flavor: cfg.flavor ?? "generic",
        modeMap: cfg.modeMap,
        cursorFast: o.cursorFast,
        cursorAutoReview: o.cursorAutoReview,
        launch: o.launch,
      });
    },
  };
}
