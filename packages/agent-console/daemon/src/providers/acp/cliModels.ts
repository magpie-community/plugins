import type { ModelInfo } from "../types.js";
import { killTree, spawnBin, type ResolveResult } from "../../util/bin.js";

export function runCli(r: ResolveResult & { ok: true }, args: string[], timeoutMs = 25000): Promise<string> {
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

/** devin models list: indented lines are model ids followed by the display name */
export function parseDevinModelsList(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s{2,}([a-z0-9][a-z0-9-]*)\s{2,}(.+?)(?:\s+\[|$)/i);
    if (!m) continue;
    const id = m[1].trim();
    if (id === "aliases" || id.startsWith("aliases:")) continue;
    const name = m[2].trim();
    if (!id || id.length < 3) continue;
    models.push({ id, name });
  }
  if (!models.length) return [{ id: "default", name: "默认", isDefault: true }];
  const adaptive = models.find((x) => x.id === "adaptive");
  if (adaptive) adaptive.isDefault = true;
  else models[0]!.isDefault = true;
  return models;
}

/** opencode models: one provider/model-id per line */
export function parseOpencodeModels(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim();
    if (!id || /\s/.test(id) || id.startsWith("Usage:")) continue;
    if (!id.includes("/")) continue;
    const name = id.includes("/") ? id.split("/").slice(1).join("/") : id;
    models.push({ id, name: name.replace(/-/g, " ") });
  }
  if (!models.length) return [{ id: "default", name: "默认", isDefault: true }];
  models[0]!.isDefault = true;
  return models;
}

export async function devinListModels(r: ResolveResult & { ok: true }): Promise<ModelInfo[]> {
  const text = await runCli(r, ["models", "list"], 35000);
  return parseDevinModelsList(text);
}

export async function opencodeListModels(r: ResolveResult & { ok: true }): Promise<ModelInfo[]> {
  const text = await runCli(r, ["models"], 20000);
  return parseOpencodeModels(text);
}
