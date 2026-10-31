import type { ModelInfo } from "../types.js";
import { killTree, spawnBin, type ResolveResult } from "../../util/bin.js";

function runCmd(r: ResolveResult & { ok: true }, args: string[], timeoutMs = 20000): Promise<string> {
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
    p.on("close", () => {
      clearTimeout(t);
      resolvePromise(out);
    });
  });
}

export function parseCursorListModels(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("Available") || t.startsWith("Tip:")) continue;
    const m = t.match(/^(\S+)\s+-\s+(.+)$/);
    if (!m) continue;
    const id = m[1];
    const rest = m[2];
    const isDefault = /\(default\)/i.test(rest);
    const isCurrent = /\(current\)/i.test(rest);
    const name = rest.replace(/\s*\((default|current)\)\s*/gi, "").trim();
    models.push({ id, name, isDefault: isDefault || id === "auto", ...(isCurrent ? {} : {}) });
  }
  if (!models.length) return [{ id: "auto", name: "Auto", isDefault: true }];
  if (!models.some((x) => x.isDefault)) {
    const auto = models.find((x) => x.id === "auto");
    if (auto) auto.isDefault = true;
  }
  return models;
}

/** Cursor CLI: Fast toggle → model parameter string (see --model 'id[fast=true]') */
// Model values come from the options Cursor reports over ACP, e.g. `claude-opus-5-5[context=300k,effort=medium,fast=false]`:
// without Fast, send them back unchanged (keeping context/effort and other parameters); with Fast, change only the fast parameter.
// When a thinking level is chosen, write it as that model's own level parameter (e.g. grok-4.6[effort=high], gpt-5.6-sol[reasoning=max]).
export function cursorWireModel(
  modelId: string | null,
  fast: boolean,
  thinking?: { param: string; value: string },
): string | null {
  if (!modelId) return null;
  const id = modelId.trim();
  if (!fast && !thinking) return id;
  const m = id.match(/^(.*?)\[(.*)\]$/u);
  if (!m && !thinking) return id.endsWith("-fast") ? id : `${id}[fast=true]`;
  const base = m ? m[1] : id;
  const params = (m ? m[2].split(",") : [])
    .map((s) => s.trim())
    .filter((s) => s && (!fast || !/^fast=/.test(s)) && (!thinking || !s.startsWith(`${thinking.param}=`)));
  if (thinking) params.push(`${thinking.param}=${thinking.value}`);
  if (fast) params.push("fast=true");
  return `${base}[${params.join(",")}]`;
}

export async function cursorListModels(r: ResolveResult & { ok: true }): Promise<ModelInfo[]> {
  const text = await runCmd(r, ["--list-models"]);
  return parseCursorListModels(text);
}
