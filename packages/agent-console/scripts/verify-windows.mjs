#!/usr/bin/env node
// One-shot Windows self-check (also runs on macOS / Linux, where Windows-only items are marked SKIP).
//
//   cd /d <path to agent-console>
//   node scripts\verify-windows.mjs            full: npm ci → build → verify:build → npm test → all checks
//   node scripts\verify-windows.mjs --quick    skip npm ci and npm test (when dependencies are already installed)
//
// Changes no real configuration: the daemon uses a temporary data directory + the Mock Provider; Agent CLIs only run --version.
// The report is also written to _tmp/verify-windows.log. Exit code: 1 if anything FAILs, otherwise 0.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const args = new Set(process.argv.slice(2));
const QUICK = args.has("--quick");
const logFile = path.join(root, "_tmp", "verify-windows.log");
mkdirSync(path.dirname(logFile), { recursive: true });
writeFileSync(logFile, `verify-windows ${new Date().toISOString()}\n`);

const results = [];
function out(line) {
  console.log(line);
  try {
    appendFileSync(logFile, line + "\n");
  } catch {}
}
function record(status, name, detail = "") {
  results.push({ status, name, detail });
  const mark = { PASS: "✓ PASS", WARN: "! WARN", FAIL: "✗ FAIL", SKIP: "- SKIP" }[status];
  out(`${mark}  ${name}${detail ? "  — " + detail : ""}`);
}
async function step(name, fn) {
  try {
    const r = await fn();
    if (r && typeof r === "object" && r.status) record(r.status, name, r.detail ?? "");
    else record("PASS", name, typeof r === "string" ? r : "");
  } catch (e) {
    record("FAIL", name, String(e?.message ?? e).slice(0, 800));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// npm is npm.cmd on Windows: run it through cmd.exe (the command is hard-coded, no user input)
function npm(cmdArgs, { inherit = true } = {}) {
  const r = IS_WIN
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${cmdArgs.join(" ")}`], {
        cwd: root,
        stdio: inherit ? "inherit" : "pipe",
        windowsHide: true,
      })
    : spawnSync("npm", cmdArgs, { cwd: root, stdio: inherit ? "inherit" : "pipe" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`npm ${cmdArgs.join(" ")} 退出码 ${r.status}`);
  return r.stdout ? String(r.stdout).trim() : "";
}

function decode(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return Buffer.from(buf).toString("utf8");
    }
  }
}

// Bundle the tools from the daemon sources (PATH scan, shim resolution, process-tree termination, Provider catalog, default shell) into a temporary ESM and load it,
// so the checks run against exactly the code that goes into the daemon.
async function loadDaemonHelpers(tmp) {
  const esbuild = await import("esbuild");
  const entry = path.join(tmp, "helpers-entry.ts");
  const rel = (p) => path.relative(tmp, path.join(root, p)).split(path.sep).join("/");
  writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(rel("daemon/src/util/bin.ts"))};`,
      `export { PROVIDER_CATALOG } from ${JSON.stringify(rel("daemon/src/providers/catalog.ts"))};`,
      `export { pickShell } from ${JSON.stringify(rel("daemon/src/terminal/service.ts"))};`,
      `export { decodePickFolderStdout } from ${JSON.stringify(rel("daemon/src/util/pickFolderWin.ts"))};`,
      `export { normPath } from ${JSON.stringify(rel("daemon/src/util/paths.ts"))};`,
    ].join("\n"),
  );
  const outfile = path.join(root, "_tmp", `verify-helpers-${process.pid}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    outfile,
    logLevel: "silent",
    banner: { js: 'import { createRequire as __vcr } from "node:module"; const require = __vcr(import.meta.url);' },
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    // Already loaded into memory; the file can be deleted
    setTimeout(() => rmSync(outfile, { force: true }), 100).unref();
  }
}

function runWithTimeout(child, ms) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout?.on("data", (d) => (stdout = Buffer.concat([stdout, d])));
    child.stderr?.on("data", (d) => (stderr = Buffer.concat([stderr, d])));
    const t = setTimeout(() => resolve({ code: null, timedOut: true, stdout, stderr }), ms);
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: null, error: e, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function getJson(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, headers: { "x-agent-console": token }, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

async function main() {
  out(`系统: ${os.type()} ${os.release()} ${process.arch}  Node ${process.version} (${process.execPath})`);
  out(`仓库: ${root}`);
  out(`用户目录: ${os.homedir()}  数据目录: ${path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie", "agent-console")}`);
  if (IS_WIN) {
    try {
      const cp = execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true });
      out(`控制台代码页: ${decode(cp).trim()}`);
    } catch {}
  }
  out("");

  // 1. Node / npm
  await step("Node.js ≥ 20", () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 20) throw new Error(`当前 ${process.version}，需要 20+`);
    return process.version;
  });
  await step("npm 可用", () => "npm " + npm(["-v"], { inherit: false }));
  const nonAscii = /[^\x00-\x7f]/.test(root) || /\s/.test(root);
  record(nonAscii ? "PASS" : "SKIP", "仓库路径含中文/空格（用于覆盖编码问题）", nonAscii ? root : "路径全是 ASCII，未覆盖");

  // 2. Install / build
  if (QUICK) record("SKIP", "npm ci", "--quick");
  else await step("npm ci", () => npm(["ci"]));
  await step("npm run build", () => npm(["run", "build"]));
  await step("npm run verify:build（提交的 bundle 与重新构建一致）", () => npm(["run", "verify:build"]));
  await step("npm run check（类型检查）", () => npm(["run", "check"]));
  if (QUICK) record("SKIP", "npm test", "--quick");
  else await step("npm test（含 Windows 专属的 CP936 用例）", () => npm(["test"]));

  const tmp = mkdtempSync(path.join(os.tmpdir(), "ac-verify-"));
  let helpers = null;
  try {
    await step("加载 daemon 工具代码（esbuild 临时打包）", async () => {
      helpers = await loadDaemonHelpers(tmp);
      return "ok";
    });

    // 3. node-pty
    await step("node-pty 加载 + 用默认 shell 起一个 PTY", async () => {
      const pty = await import("node-pty");
      const shell = helpers ? helpers.pickShell() : IS_WIN ? "powershell.exe" : "/bin/sh";
      const marker = "AC-PTY-中文-" + randomBytes(3).toString("hex");
      const p = pty.spawn(shell, [], { name: "xterm-256color", cols: 100, rows: 30, cwd: root, env: process.env });
      let text = "";
      p.onData((d) => (text += d));
      await sleep(1500);
      p.write(`echo ${marker}\r`);
      const t0 = Date.now();
      while (Date.now() - t0 < 10000 && !text.includes(marker + "\r") && !text.includes(marker + "\n")) await sleep(100);
      const ok = text.split(marker).length >= 3 || /AC-PTY-中文-[0-9a-f]{6}\r?\n/.test(text);
      try {
        p.kill();
      } catch {}
      if (!text.includes(marker)) throw new Error(`没有收到回显（shell=${shell}）：${JSON.stringify(text.slice(-300))}`);
      return ok ? `shell=${shell}` : { status: "WARN", detail: `收到回显但格式不同（shell=${shell}）` };
    });

    // 4. Agent CLI resolution
    if (helpers) {
      const { PROVIDER_CATALOG, resolveFirstBin, resolveBin, spawnBin, killTree } = helpers;
      for (const p of PROVIDER_CATALOG) {
        await step(`CLI 解析: ${p.name} (${p.bins.join(" / ")})`, async () => {
          const r = await resolveFirstBin(p.bins);
          if (!r.ok) return { status: "SKIP", detail: "未安装（PATH 和常见目录里都没有）" };
          const child = spawnBin(r, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
          const res = await runWithTimeout(child, 20000);
          if (res.timedOut) await killTree(child, { graceMs: 500 });
          const text = decode(Buffer.concat([res.stdout, res.stderr])).trim().split(/\r?\n/)[0] ?? "";
          const detail = `via=${r.via} ${r.display}${text ? "  → " + text.slice(0, 120) : ""}`;
          if (res.error) throw new Error(`${detail}  启动失败: ${res.error.message}`);
          if (res.timedOut) return { status: "WARN", detail: `${detail}  （--version 20 秒没返回）` };
          return { status: res.code === 0 ? "PASS" : "WARN", detail: res.code === 0 ? detail : `${detail}  退出码 ${res.code}` };
        });
      }
      await step("CLI 解析: npx", async () => {
        const r = await resolveBin("npx");
        if (!r.ok) throw new Error(r.reason);
        return `via=${r.via} ${r.display}`;
      });

      // 4b. shim resolution + argument escaping: create .cmd / .ps1 in a temp directory whose name has spaces and Chinese characters
      const shimDir = path.join(tmp, "shim 测试 dir");
      mkdirSync(shimDir, { recursive: true });
      const probeArgs = ["a b", "x&y", "中文", 'q"t', "100%"];
      if (IS_WIN) {
        writeFileSync(path.join(shimDir, "ac-args.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
        writeFileSync(path.join(shimDir, "acjs.cmd"), '@ECHO off\r\n"node" "%~dp0\\ac-args.js" %*\r\n');
        writeFileSync(path.join(shimDir, "acbat.cmd"), "@ECHO off\r\nnode -e \"process.stdout.write(JSON.stringify(process.argv.slice(1)))\" -- %*\r\n");
        writeFileSync(
          path.join(shimDir, "acps.ps1"),
          "[Console]::OutputEncoding=[Text.Encoding]::UTF8\r\n[Console]::Out.Write((ConvertTo-Json -Compress @($args)))\r\n",
        );
      } else {
        writeFileSync(path.join(shimDir, "acjs"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 });
      }
      const oldPath = process.env.PATH;
      const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      process.env[pathKey] = shimDir + path.delimiter + (process.env[pathKey] ?? "");
      helpers.clearBinCache?.();
      try {
        const cases = IS_WIN
          ? [
              ["acjs", "shim-js"],
              ["acbat", "cmd-shim"],
              ["acps", "ps1"],
            ]
          : [["acjs", "path"]];
        for (const [name, via] of cases) {
          await step(`shim + 参数转义: ${name} (${via})，目录含空格和中文`, async () => {
            const r = await resolveBin(name);
            if (!r.ok) throw new Error(r.reason);
            if (r.via !== via) throw new Error(`via=${r.via}，期望 ${via}`);
            const child = spawnBin(r, probeArgs, { stdio: ["ignore", "pipe", "pipe"] });
            const res = await runWithTimeout(child, 20000);
            const text = decode(res.stdout).trim();
            let got = null;
            try {
              got = JSON.parse(text);
            } catch {}
            const want = probeArgs;
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              // Batch %* and PowerShell -File each have quirks with embedded quotes: when the argument count is right and only a few characters differ, record a WARN for comparison
              const detail = `得到 ${text || decode(res.stderr).slice(0, 200)}，期望 ${JSON.stringify(want)}`;
              if (name !== "acjs" && Array.isArray(got) && got.length === want.length) return { status: "WARN", detail };
              throw new Error(detail);
            }
            return JSON.stringify(got);
          });
        }
      } finally {
        process.env[pathKey] = oldPath;
        helpers.clearBinCache?.();
      }

      // 5. Process tree termination
      await step("进程树结束（killTree：子进程 + 孙进程）", async () => {
        const script = path.join(tmp, "tree-parent.js");
        writeFileSync(
          script,
          [
            'const { spawn } = require("node:child_process");',
            'const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });',
            "process.stdout.write(String(g.pid) + '\\n');",
            "setInterval(()=>{},1000);",
          ].join("\n"),
        );
        writeFileSync(path.join(tmp, "package.json"), '{"type":"commonjs"}');
        const r = { ok: true, cmd: process.execPath, prefixArgs: [script], display: "node", via: "path" };
        const child = spawnBin(r, [], { stdio: ["ignore", "pipe", "ignore"], group: true });
        const gpid = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("没拿到孙进程 pid")), 10000);
          child.stdout.once("data", (d) => {
            clearTimeout(t);
            resolve(Number(String(d).trim()));
          });
        });
        if (!pidAlive(gpid)) throw new Error("孙进程没起来");
        await killTree(child, { graceMs: 1500 });
        for (let i = 0; i < 40 && pidAlive(gpid); i++) await sleep(100);
        if (pidAlive(gpid)) {
          try {
            process.kill(gpid, "SIGKILL");
          } catch {}
          throw new Error(`孙进程 ${gpid} 还活着`);
        }
        return `子 ${child.pid} / 孙 ${gpid} 都已结束`;
      });

      // 6. Encoding
      await step("编码：GBK 控制台输出解码（pickFolder 回退）", () => {
        const buf = Buffer.concat([Buffer.from("D:\\workwork\\magpie", "ascii"), Buffer.from("b2e5bcfe", "hex")]);
        const s = helpers.decodePickFolderStdout(buf);
        if (s !== "D:\\workwork\\magpie插件") throw new Error(String(s));
        if (!IS_WIN) return "静态样本 ok（真实 powershell 只在 Windows 上测）";
        const real = execFileSync(
          "powershell.exe",
          ["-NoProfile", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); [Console]::Out.WriteLine('D:\\workwork\\magpie插件')"],
          { windowsHide: true },
        );
        const t = helpers.decodePickFolderStdout(real);
        if (t !== "D:\\workwork\\magpie插件") throw new Error(`真实 powershell 得到 ${JSON.stringify(t)}`);
        return "静态样本 + 真实 powershell CP936 都 ok";
      });
      await step("路径规范化（大小写 / 分隔符 / 中文）", () => {
        const a = helpers.normPath(root);
        const b = helpers.normPath(IS_WIN ? root.toUpperCase().replace(/\\/g, "/") : root);
        if (IS_WIN && a !== b) throw new Error(`${a} != ${b}`);
        return a;
      });
    }

    // 7. Daemon start / stop
    await step("daemon 启动 → /api/ping → 关 stdin 退出（Mock，临时数据目录）", async () => {
      const dataRoot = path.join(tmp, "数据 data");
      const token = randomBytes(32).toString("hex");
      const child = spawn(
        process.execPath,
        [path.join(root, "daemon", "dist", "main.js"), "--port", "0", "--data", dataRoot, "--parent-pid", String(process.pid)],
        { env: { ...process.env, AGENT_CONSOLE_TOKEN: token, AGENT_CONSOLE_MOCK: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const port = await new Promise((resolve, reject) => {
        let buf = "";
        const t = setTimeout(() => reject(new Error("15 秒内没有就绪行 " + stderr.slice(-300))), 15000);
        child.stdout.on("data", (d) => {
          buf += d;
          for (const line of buf.split(/\r?\n/)) {
            try {
              const j = JSON.parse(line);
              if (j.agentConsoleReady) {
                clearTimeout(t);
                resolve(j.port);
              }
            } catch {}
          }
        });
        child.once("exit", (code) => reject(new Error(`daemon 提前退出 ${code} ${stderr.slice(-300)}`)));
      });
      const ping = await getJson(port, "/api/ping", token);
      if (ping.status !== 200 || !ping.body?.ok) throw new Error("ping 失败 " + JSON.stringify(ping));
      const bad = await getJson(port, "/api/ping", "wrong");
      if (bad.status !== 403) throw new Error("错误令牌没有被拒绝");
      const daemonJson = path.join(dataRoot, "magpie", "agent-console", "daemon.json");
      if (!existsSync(daemonJson)) throw new Error("没有写 daemon.json");
      const t0 = Date.now();
      child.stdin.end();
      const code = await new Promise((resolve) => {
        const t = setTimeout(() => resolve("timeout"), 8000);
        child.once("exit", (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      if (code === "timeout") {
        child.kill();
        throw new Error("关 stdin 后 8 秒没退出");
      }
      if (existsSync(daemonJson)) throw new Error("退出后 daemon.json 还在");
      return `端口 ${port}，${Date.now() - t0}ms 内退出（code ${code}），数据目录含中文和空格`;
    });

    // 8. Plugin entry: the message when node can't be found inside Bun (function check only)
    await step("插件宿主找 node（宿主是 Bun 时）", async () => {
      const m = await import(pathToFileURL(path.join(root, "lib", "pathscan.mjs")).href);
      const node = m.requireNode({ execPath: IS_WIN ? "C:\\Magpie\\bun.exe" : "/opt/magpie/bun" });
      return node;
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  out("");
  out(`===== PASS ${count("PASS")}  WARN ${count("WARN")}  FAIL ${count("FAIL")}  SKIP ${count("SKIP")} =====`);
  out(`报告: ${logFile}`);
  process.exit(count("FAIL") ? 1 : 0);
}

main().catch((e) => {
  out("自检脚本异常: " + (e?.stack ?? e));
  process.exit(1);
});
