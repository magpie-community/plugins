// Running a program to its end, within a time.

import { spawn } from "node:child_process";

// run starts command with args, its output collected, and kills it after
// timeoutMs. It never rejects: a program that can't start, or that is
// killed, is answered with why.
export function run(command, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, exitCode: null, stdout: "", stderr: "", error: e.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok, exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, exitCode, stdout, stderr, error });
    };
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => finish(false, null, e.message));
    child.on("close", (code) => finish(code === 0, code));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // gone already
      }
      finish(false, null, "timed out");
    }, timeoutMs);
  });
}
