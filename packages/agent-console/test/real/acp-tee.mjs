// Sits between Agent Console and a real ACP agent: passes stdio through and appends every session/prompt the
// console sends to $ACP_TEE_LOG (one JSON line each), so a test sees the exact payload the agent got.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [bin, ...args] = process.argv.slice(2);
const child = spawn(bin, args, { stdio: ["pipe", "inherit", "inherit"], env: process.env });
let buf = "";
process.stdin.on("data", (d) => {
  child.stdin.write(d);
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    try {
      const m = JSON.parse(line);
      if (m.method === "session/prompt" && process.env.ACP_TEE_LOG) appendFileSync(process.env.ACP_TEE_LOG, JSON.stringify(m.params.prompt) + "\n");
      if (/^session\/(new|load|resume)$/.test(m.method) && process.env.ACP_TEE_SESSION_LOG) {
        appendFileSync(process.env.ACP_TEE_SESSION_LOG, JSON.stringify({ method: m.method, sessionId: m.params?.sessionId ?? null }) + "\n");
      }
    } catch {}
  }
});
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (c, s) => process.exit(c ?? (s ? 1 : 0)));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
