// A real Linux exited-but-unreaped child. Its parent explicitly reaps it on release (also on timeout).
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

export const hasZombieFixture = process.platform === "linux" && spawnSync("python3", ["--version"]).status === 0;

export async function zombieFixture() {
  const parent = spawn("python3", ["-u", "-c", `
import os, select, sys
pid = os.fork()
if pid == 0:
    with open("/proc/self/comm", "w") as f:
        f.write("ac ) zombie (")
    os._exit(0)
os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
print(pid, flush=True)
try:
    select.select([sys.stdin], [], [], 15)
finally:
    os.waitpid(pid, 0)
`], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(parent, "close");
  const pid = await new Promise<number>((resolve, reject) => {
    let output = "";
    parent.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("\n")) resolve(Number(output.trim()));
    });
    parent.once("error", reject);
    parent.once("exit", () => reject(new Error("zombie fixture exited before reporting pid")));
  });
  return { pid, release: async () => { parent.stdin.end(); await closed; } };
}
