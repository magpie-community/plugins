import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { resolve as resolvePath } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { ResolveResult } from "../../util/bin.js";
import { killTree, spawnBin } from "../../util/bin.js";

export function spawnResolved(r: ResolveResult & { ok: true }, args: string[], o: { cwd?: string } = {}): ChildProcess {
  // group: on non-Windows it gets its own process group so killTree also ends the tool processes it started
  return spawnBin(r, args, {
    cwd: o.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    group: true,
  });
}

export function acpStreamFromChild(child: ChildProcess): acp.Stream {
  if (!child.stdin || !child.stdout) throw new Error("ACP 子进程缺少 stdio 管道");
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  return acp.ndJsonStream(output, input);
}

export function absCwd(cwd: string): string {
  return resolvePath(cwd);
}

export async function killAcpChild(child: ChildProcess | null): Promise<void> {
  await killTree(child);
}
