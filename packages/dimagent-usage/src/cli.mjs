import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

function searchDirs() {
  const home = homedir();
  return [...new Set([
    ...(process.env.PATH ?? "").split(delimiter),
    join(home, ".local/share/mise/shims"), join(home, ".npm-global/bin"),
    join(home, ".local/bin"), join(home, ".bun/bin"),
    join(home, ".dimcode/bin"), join(home, ".dimcode/dimcode/bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
  ].filter(isAbsolute))];
}

export async function findDim(given = "") {
  const path = given.trim();
  if (path && !isAbsolute(path)) throw new Error("请填写 dim 的绝对路径，或留空自动查找。");
  const paths = path ? [path] : searchDirs().map((dir) => join(dir, "dim"));
  for (const candidate of paths) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  throw new Error("找不到可执行的 dim。请安装 DimAgent CLI，或连接时填写 command -v dim 给出的绝对路径。");
}

function exitError(stderr) {
  if (/not (logged|signed) in|dim auth login|unauthorized|token expired/i.test(stderr)) {
    return new Error("DimAgent 尚未登录或登录已失效，请在终端运行 dim auth login 后重试。");
  }
  if (/429|rate limit/i.test(stderr)) return new Error("DimAgent 额度查询被限流，请稍后重试。");
  return new Error("dim usage --json 查询失败。请在终端运行该命令查看原因。");
}

export function readDim(path, { timeoutMs = 15000, maxBytes = 512 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const group = process.platform !== "win32";
    const child = spawn(path, ["usage", "--json"], {
      cwd: tmpdir(), detached: group, stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: [dirname(path), ...searchDirs()].join(delimiter),
        DIMCODE_DISABLE_AUTOUPDATE: "1",
      },
    });
    let stdout = "", stderr = "", bytes = 0, failure;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (e) {
        if (e.code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => stop(new Error("DimAgent 额度查询超时，请稍后重试。")), timeoutMs);
    const collect = (chunk, errorStream) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return stop(new Error("DimAgent 用量输出超过大小限制。"));
      if (failure) return;
      if (errorStream) stderr += chunk;
      else stdout += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s) => collect(s, false));
    child.stderr.on("data", (s) => collect(s, true));
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("无法启动 dim，请重新连接并检查 CLI 路径。"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(exitError(stderr));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("dim usage --json 没有返回有效 JSON。")); }
    });
  });
}
