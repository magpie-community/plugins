import { spawn } from "node:child_process";

export function runMagpie(args, { input, timeoutMs = 20_000 } = {}) {
  // 每次调用时才读 MAGPIE_BIN：同一个进程里（例如 bun test 依次加载多个测试文件）
  // 环境变量可能在 import 之后才被设置。
  const bin = process.env.MAGPIE_BIN || "magpie";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`magpie ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input != null) child.stdin.end(String(input));
    else child.stdin.end();
  });
}

export async function magpieOk(args, opts) {
  const r = await runMagpie(args, opts);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || "").trim() || `magpie exited ${r.code}`;
    const err = new Error(msg.replace(/^magpie:\s*/i, ""));
    err.code = r.code;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  return r;
}
