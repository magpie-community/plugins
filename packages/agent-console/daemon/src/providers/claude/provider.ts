// Claude Provider (§7.2): detection + createSession(ClaudeSession).
import type { Provider, ProviderSession, DetectResult, ModelInfo, HistoryItem } from "../types.js";
import { resolveBin, killTree, spawnBin, type ResolveResult } from "../../util/bin.js";
import { ClaudeSession } from "./session.js";
import { listClaudeModels } from "./models.js";
import { listClaudeHistory, readClaudeHistory } from "../../history/import.js";
import { mapSdkMessage, newMapState } from "./map.js";
import type { ProviderEvent } from "../../timeline/types.js";

const INSTALL_HINT = "npm i -g @anthropic-ai/claude-code";

export const claudeCapabilities = {
  resume: true,
  interrupt: true,
  steer: false, // Claude doesn't support real steering — the manager queues instead (§7.2.2)
  images: true,
  plan: true,
  questions: true,
  cost: true,
  effort: ["low", "medium", "high", "xhigh", "max"],
  modes: ["plan", "default", "acceptEdits", "bypassPermissions"] as ("plan" | "default" | "acceptEdits" | "bypassPermissions")[],
};

function runVersion(r: ResolveResult & { ok: true }, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let out = "";
    const p = spawnBin(r, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
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
      if (code === 0) resolvePromise(out);
      else reject(new Error("exit " + code));
    });
  });
}

export function createClaudeProvider(): Provider {
  return {
    id: "claude",
    name: "Claude Code",
    capabilities: claudeCapabilities,
    async detect(): Promise<DetectResult> {
      const bin = await resolveBin("claude");
      if (!bin.ok) return { available: false, reason: bin.reason, installHint: INSTALL_HINT };
      try {
        const version = await runVersion(bin, ["--version"]);
        return { available: true, bin: bin.display, version: version.trim().split("\n")[0] || "" };
      } catch {
        return { available: true, bin: bin.display, version: "" };
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      return listClaudeModels();
    },
    async createSession(o): Promise<ProviderSession> {
      const bin = await resolveBin("claude");
      if (!bin.ok) throw new Error(`找不到 claude：${bin.reason}`);
      return new ClaudeSession({
        threadId: o.threadId,
        cwd: o.cwd,
        model: o.model,
        mode: o.mode,
        effort: o.effort,
        resumeId: o.resumeId,
        binCmd: bin.cmd,
        binPrefixArgs: bin.prefixArgs,
        binVia: bin.via,
      });
    },
    // §7.6: jsonl sessions under ~/.claude/projects matched by cwd
    async listHistory(cwd: string): Promise<HistoryItem[]> {
      const items = await listClaudeHistory(cwd);
      return items.map((i) => ({ provider: "claude", ...i, imported: false }));
    },
    async readHistory(sessionId: string, cwd: string): Promise<ProviderEvent[]> {
      const msgs = await readClaudeHistory(sessionId, cwd);
      const st = newMapState();
      const out: ProviderEvent[] = [];
      for (const m of msgs) {
        const r = m as { type?: string; message?: { content?: unknown } };
        // User text messages don't appear as events in the SDK stream (the manager writes user_message itself); emit them here
        if (r.type === "user") {
          const content = r.message?.content;
          const text = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? (content as { type?: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
              : "";
          if (text.trim()) out.push({ type: "user_message", text });
          else out.push(...mapSdkMessage(m as never, st, cwd)); // tool_result and the like still go through the mapping
          continue;
        }
        out.push(...mapSdkMessage(m as never, st, cwd));
      }
      // Finish: an imported session is closed
      out.push({ type: "turn_ended", turnId: "", status: "completed" });
      return out;
    },
  };
}
