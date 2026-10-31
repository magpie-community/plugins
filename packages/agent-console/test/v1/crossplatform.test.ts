// Cross-platform logic (independent of the real OS): PATH scanning, .cmd/.ps1 shim resolution, cmd.exe escaping,
// default shell, path normalization, pid liveness, PATH completion, cross-drive moves, the gate's 503 text.
import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraBinDirs, findNode, findOnPath, isNodeExecutable, requireNode, searchDirs } from "../../lib/pathscan.mjs";
import { failureHtml } from "../../lib/gate.mjs";
import {
  argvFor,
  escapeCmdArgument,
  escapeCmdCommand,
  killTree,
  resolveBinWith,
  shimTarget,
  spawnBin,
} from "../../daemon/src/util/bin.js";
import { pickShell, simpleShellArgs } from "../../daemon/src/terminal/service.js";
import { normPath } from "../../daemon/src/util/paths.js";
import { augmentPath, pidAlive } from "../../daemon/src/util/proc.js";
import { moveAcrossDevices } from "../../daemon/src/git/service.js";
import { claudeArgs } from "../../daemon/src/providers/claude/cli.js";

const lower = (s: string) => s.toLowerCase();

describe("pathscan (simulated Windows)", () => {
  const env = { Path: "C:\\Users\\张三\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const files = new Set(
    [
      "C:\\Users\\张三\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\张三\\AppData\\Roaming\\npm\\claude.ps1",
      "C:\\Users\\张三\\AppData\\Roaming\\npm\\claude",
      "C:\\Users\\张三\\AppData\\Roaming\\npm\\onlyps.ps1",
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files\\nodejs\\claude.exe",
    ].map(lower),
  );
  const exists = (f: string) => files.has(lower(f));
  const opts = { platform: "win32" as const, env, home: "C:\\Users\\张三", exists };

  it("env var names are case-insensitive (Path), PATH order + PATHEXT order, extensionless shims are not returned", () => {
    const hits = findOnPath("claude", opts);
    expect(hits[0]).toBe("C:\\Users\\张三\\AppData\\Roaming\\npm\\claude.cmd");
    expect(hits).toContain("C:\\Users\\张三\\AppData\\Roaming\\npm\\claude.ps1");
    expect(hits).toContain("C:\\Program Files\\nodejs\\claude.exe");
    expect(hits).not.toContain("C:\\Users\\张三\\AppData\\Roaming\\npm\\claude");
  });

  it("a lone .ps1 is found too; names with an extension are looked up as-is", () => {
    expect(findOnPath("onlyps", opts)).toEqual(["C:\\Users\\张三\\AppData\\Roaming\\npm\\onlyps.ps1"]);
    expect(findOnPath("node.exe", opts)).toEqual(["C:\\Program Files\\nodejs\\node.exe"]);
  });

  it("findNode only accepts node.exe; requireNode searches PATH when the host is Bun and gives a userMessage when not found", () => {
    expect(findNode(opts)).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(requireNode({ execPath: "C:\\Magpie\\bun.exe", find: () => "C:\\n\\node.exe" })).toBe("C:\\n\\node.exe");
    expect(requireNode({ execPath: "/usr/bin/node", find: () => null })).toBe("/usr/bin/node");
    let err: (Error & { code?: string; userMessage?: string }) | null = null;
    try {
      requireNode({ execPath: "/opt/magpie/bun", find: () => null });
    } catch (e) {
      err = e as Error & { code?: string; userMessage?: string };
    }
    expect(err?.code).toBe("ENODE");
    expect(err?.userMessage).toMatch(/Node\.js/);
  });

  it("directory dedupe is case-insensitive and quotes in PATH are stripped", () => {
    const dirs = searchDirs({ ...opts, env: { PATH: '"C:\\A b";c:\\a B\\;C:\\X', APPDATA: "C:\\X" }, extra: true });
    expect(dirs.filter((d) => lower(d).replace(/\\$/, "") === "c:\\a b")).toHaveLength(1);
    expect(dirs.filter((d) => lower(d) === "c:\\x")).toHaveLength(1);
  });

  it("isNodeExecutable", () => {
    expect(isNodeExecutable("C:\\Program Files\\nodejs\\node.exe".replace(/\\/g, "/"))).toBe(true);
    expect(isNodeExecutable("/usr/local/bin/node")).toBe(true);
    expect(isNodeExecutable("/Applications/Magpie.app/Contents/MacOS/bun")).toBe(false);
  });
});

describe("pathscan (simulated macOS / Linux)", () => {
  it("adds Homebrew and ~/.local/bin when the macOS GUI PATH is minimal", () => {
    const dirs = extraBinDirs({ platform: "darwin", env: {}, home: "/Users/me" });
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/Users/me/.local/bin");
    const hit = findOnPath("codex", {
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      home: "/Users/me",
      exists: (f) => f === "/opt/homebrew/bin/codex",
    });
    expect(hit).toEqual(["/opt/homebrew/bin/codex"]);
  });

  it("Linux does not add Homebrew; PATH comes first", () => {
    expect(extraBinDirs({ platform: "linux", env: {}, home: "/home/me" })).not.toContain("/opt/homebrew/bin");
    const hit = findOnPath("x", {
      platform: "linux",
      env: { PATH: "/a:/b" },
      home: "/home/me",
      exists: (f) => f === "/b/x" || f === "/usr/local/bin/x",
    });
    expect(hit).toEqual(["/b/x", "/usr/local/bin/x"]);
  });
});

describe("resolveBin (simulated Windows)", () => {
  const npmShim = [
    "@ECHO off",
    "SETLOCAL",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    ")",
    '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join("\r\n");
  const base = "C:\\Program Files\\nodejs";

  it("npm .cmd shim → node + cli.js; node.exe in the same directory is not picked by mistake", async () => {
    const files = new Set([`${base}\\node.exe`, `${base}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`].map(lower));
    const r = await resolveBinWith("claude", {
      platform: "win32",
      find: () => [`${base}\\claude.cmd`],
      readText: async () => npmShim,
      exists: (f) => files.has(lower(f)),
      node: () => "C:\\node\\node.exe",
    });
    expect(r).toMatchObject({ ok: true, via: "shim-js", cmd: "C:\\node\\node.exe" });
    if (r.ok) expect(r.prefixArgs[0]).toBe(`${base}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`);
  });

  it("uses the exe when shimTarget only points at an .exe", () => {
    const t = shimTarget('"%~dp0\\bin\\tool.exe" %*', "C:\\t", { win: true, exists: (f) => lower(f) === "c:\\t\\bin\\tool.exe" });
    expect(t).toBe("C:\\t\\bin\\tool.exe");
  });

  it(".exe used directly; .ps1 via powershell -File; other .cmd via cmd-shim", async () => {
    const exe = await resolveBinWith("codex", { platform: "win32", find: () => ["C:\\x\\codex.exe"] });
    expect(exe).toMatchObject({ ok: true, via: "exe", cmd: "C:\\x\\codex.exe", prefixArgs: [] });
    const ps = await resolveBinWith("agent", { platform: "win32", find: () => ["C:\\x\\agent.ps1"] });
    expect(ps).toMatchObject({ ok: true, via: "ps1", cmd: "powershell.exe" });
    if (ps.ok) expect(ps.prefixArgs.slice(-2)).toEqual(["-File", "C:\\x\\agent.ps1"]);
    const cmd = await resolveBinWith("cursor-agent", {
      platform: "win32",
      find: () => ["C:\\Users\\A B\\AppData\\Local\\cursor-agent\\cursor-agent.cmd"],
      readText: async () => '@powershell -NoProfile -File "%~dp0cursor-agent.ps1" %*',
      exists: () => false,
      comspec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(cmd).toMatchObject({ ok: true, via: "cmd-shim", cmd: "C:\\Windows\\System32\\cmd.exe" });
  });

  it("npx special case: node.exe + npx-cli.js", async () => {
    const r = await resolveBinWith("npx", {
      platform: "win32",
      find: () => [`${base}\\npx.cmd`],
      exists: () => true,
    });
    expect(r).toMatchObject({ ok: true, via: "npx-shim", cmd: `${base}\\node.exe` });
  });

  it("gives a reason when not found; POSIX uses the PATH hit directly", async () => {
    expect(await resolveBinWith("nope", { platform: "win32", find: () => [] })).toMatchObject({ ok: false });
    expect(await resolveBinWith("claude", { platform: "darwin", find: () => ["/opt/homebrew/bin/claude"] })).toMatchObject({
      ok: true,
      cmd: "/opt/homebrew/bin/claude",
      via: "path",
    });
  });
});

describe("cmd.exe escaping (cmd-shim)", () => {
  it("spaces and metacharacters in paths are ^-escaped; arguments are quoted and escaped twice", () => {
    expect(escapeCmdCommand("C:\\Users\\A B\\x.cmd")).toBe("C:\\Users\\A^ B\\x.cmd");
    expect(escapeCmdArgument("a b", false)).toBe('^"a^ b^"');
    expect(escapeCmdArgument("a&b", true)).toBe('^^^"a^^^&b^^^"');
    expect(escapeCmdArgument('say "hi"\\', false)).toBe('^"say^ \\^"hi\\^"\\\\^"');
  });

  it("argvFor: cmd-shim uses /d /s /c + windowsVerbatimArguments; others just prepend prefixArgs", () => {
    const a = argvFor(
      { ok: true, cmd: "cmd.exe", prefixArgs: [], display: "", via: "cmd-shim", shim: "C:\\A B\\agent.cmd" },
      ["--print", "x y"],
    );
    expect(a.cmd).toBe("cmd.exe");
    expect(a.windowsVerbatimArguments).toBe(true);
    expect(a.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(a.args[3]).toBe('"C:\\A^ B\\agent.cmd ^^^"--print^^^" ^^^"x^^^ y^^^""');
    const b = argvFor({ ok: true, cmd: "node", prefixArgs: ["cli.js"], display: "", via: "shim-js" }, ["-v"]);
    expect(b).toEqual({ cmd: "node", args: ["cli.js", "-v"] });
  });
});

describe("claude CLI launch", () => {
  const base = { model: null, permissionMode: "default", effort: null, resume: null };
  it("stream-json both ways, permissions over stdio, model / effort / resume as flags", () => {
    const a = claudeArgs({ ...base, model: "claude-sonnet-4-5", effort: "high", resume: "0b9c3c3e-1111-2222-3333-444455556666" });
    expect(a.slice(0, 1)).toEqual(["-p"]);
    expect(a.join(" ")).toContain("--input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio");
    expect(a).toEqual(expect.arrayContaining(["--model", "claude-sonnet-4-5", "--effort", "high", "--resume", "0b9c3c3e-1111-2222-3333-444455556666", "--permission-mode", "default"]));
    expect(a).not.toContain("--allow-dangerously-skip-permissions");
    expect(claudeArgs({ ...base, permissionMode: "bypassPermissions" })).toContain("--allow-dangerously-skip-permissions");
  });
  it("refuses values that could become another flag or shell syntax", () => {
    for (const bad of ["--dangerously-skip-permissions", "a b", "x&calc", 'a"b', "m|n", "%PATH%"]) {
      expect(() => claudeArgs({ ...base, model: bad })).toThrow(/unexpected value/);
      expect(() => claudeArgs({ ...base, resume: bad })).toThrow(/unexpected value/);
    }
  });
  it("a Windows .cmd shim runs through cmd.exe with every argument escaped; a .ps1 through PowerShell -File; an npm shim as node + cli.js", () => {
    const args = claudeArgs({ ...base, model: "opus[1m]" });
    const cmd = argvFor({ ok: true, cmd: "C:\\Windows\\cmd.exe", prefixArgs: [], display: "", via: "cmd-shim", shim: "C:\\Users\\a b\\claude.cmd" }, args);
    expect(cmd.cmd).toBe("C:\\Windows\\cmd.exe");
    expect(cmd.windowsVerbatimArguments).toBe(true);
    expect(cmd.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(cmd.args[3]).toContain("C:\\Users\\a^ b\\claude.cmd");
    expect(cmd.args[3]).toContain('^^^"opus^^^[1m^^^]^^^"');
    const ps1 = argvFor({ ok: true, cmd: "powershell.exe", prefixArgs: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\x\\claude.ps1"], display: "", via: "ps1" }, args);
    expect(ps1.args.slice(0, 6)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\x\\claude.ps1"]);
    expect(ps1.args.slice(6)).toEqual(args);
    const js = argvFor({ ok: true, cmd: "C:\\n\\node.exe", prefixArgs: ["C:\\x\\cli.js"], display: "", via: "shim-js" }, args);
    expect(js).toEqual({ cmd: "C:\\n\\node.exe", args: ["C:\\x\\cli.js", ...args] });
  });
});

describe("default shell", () => {
  it("Windows: pwsh → powershell → system powershell → cmd", () => {
    expect(pickShell({ platform: "win32", env: {}, find: (n) => (n === "pwsh" ? "C:\\P\\pwsh.exe" : null) })).toBe("C:\\P\\pwsh.exe");
    expect(
      pickShell({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, find: () => null, isExec: () => false, }),
    ).toBe("cmd.exe");
    expect(
      pickShell({ platform: "win32", env: { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" }, find: () => null, isExec: () => false }),
    ).toBe("C:\\Windows\\system32\\cmd.exe");
  });
  it("macOS defaults to zsh; $SHELL is skipped when it does not exist; Linux bash → sh", () => {
    expect(pickShell({ platform: "darwin", env: {}, isExec: (f) => f === "/bin/zsh" || f === "/bin/bash" })).toBe("/bin/zsh");
    expect(pickShell({ platform: "darwin", env: { SHELL: "/opt/gone/fish" }, isExec: (f) => f === "/bin/zsh" })).toBe("/bin/zsh");
    expect(pickShell({ platform: "linux", env: { SHELL: "/usr/bin/fish" }, isExec: () => true })).toBe("/usr/bin/fish");
    expect(pickShell({ platform: "linux", env: {}, isExec: (f) => f === "/bin/sh" })).toBe("/bin/sh");
  });
  it("no-PTY arguments", () => {
    expect(simpleShellArgs("C:\\Windows\\system32\\cmd.exe", "win32")).toEqual(["/Q"]);
    expect(simpleShellArgs("pwsh.exe", "win32")).toEqual(["-NoLogo"]);
    expect(simpleShellArgs("/bin/zsh", "darwin")).toEqual(["-i"]);
  });
});

describe("path normalization", () => {
  it("case-insensitive on macOS / Windows, case-sensitive on Linux", () => {
    expect(normPath("/Users/Me/Proj/", "darwin")).toBe("/users/me/proj");
    expect(normPath("/home/Me/Proj", "linux")).toBe("/home/Me/Proj");
  });
  it("macOS normalizes NFD file names (Chinese / accented) to NFC", () => {
    expect(normPath("/tmp/cafe\u0301", "darwin")).toBe(normPath("/tmp/caf\u00e9", "darwin"));
  });
});

describe("process utilities", () => {
  it("pidAlive: EPERM counts as alive, ESRCH as dead", () => {
    const err = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(pidAlive(123, err("EPERM"))).toBe(true);
    expect(pidAlive(123, err("ESRCH"))).toBe(false);
    expect(pidAlive(123, () => true)).toBe(true);
    expect(pidAlive(0, () => true)).toBe(false);
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("augmentPath: appends at the end, dedupes (case-insensitive on Windows), keeps the existing order", () => {
    const win = augmentPath({ Path: "C:\\B;C:\\Program Files\\NodeJS" }, "C:\\Program Files\\nodejs", "win32", "C:\\Users\\me");
    const parts = win.split(";");
    expect(parts.slice(0, 2)).toEqual(["C:\\B", "C:\\Program Files\\NodeJS"]);
    expect(parts.filter((p) => lower(p) === "c:\\program files\\nodejs")).toHaveLength(1);
    const mac = augmentPath({ PATH: "/usr/bin:/bin" }, "/opt/homebrew/bin", "darwin", "/Users/me").split(":");
    expect(mac.slice(0, 3)).toEqual(["/usr/bin", "/bin", "/opt/homebrew/bin"]);
    expect(mac).toContain("/Users/me/.local/bin");
  });

  it.skipIf(process.platform === "win32")("killTree (POSIX): detached process group, grandchildren exit too", async () => {
    const r = { ok: true as const, cmd: "/bin/sh", prefixArgs: [], display: "sh", via: "path" };
    const child = spawnBin(r, ["-c", "sleep 30 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"], group: true });
    const grandchild = await new Promise<number>((res) => child.stdout!.once("data", (d) => res(Number(String(d).trim()))));
    expect(pidAlive(grandchild)).toBe(true);
    await killTree(child, { graceMs: 1000 });
    for (let i = 0; i < 20 && pidAlive(grandchild); i++) await new Promise((r) => setTimeout(r, 50));
    expect(pidAlive(grandchild)).toBe(false);
  });

  it("killTree returns immediately for a child that already exited", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => child.once("exit", r));
    const t0 = Date.now();
    await killTree(child, { graceMs: 3000 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("spawnBin really starts a process from the argvFor result", async () => {
    const r = { ok: true as const, cmd: process.execPath, prefixArgs: ["-e"], display: "node", via: "path" };
    const out = spawnSync(r.cmd, [...r.prefixArgs, "process.stdout.write('ok')"]).stdout.toString();
    expect(out).toBe("ok");
    const child = spawnBin(r, ["process.stdout.write('中文 ok')"], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    child.stdout!.on("data", (d) => (text += d));
    await new Promise((res) => child.once("close", res));
    expect(text).toBe("中文 ok");
  });
});

describe("cross-drive move (git discarding untracked files)", () => {
  it("copy then delete when rename fails with EXDEV; other errors are thrown as usual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-move-"));
    try {
      const from = join(dir, "a");
      mkdirSync(join(from, "sub"), { recursive: true });
      writeFileSync(join(from, "sub", "f.txt"), "内容");
      const to = join(dir, "trash", "a");
      mkdirSync(join(dir, "trash"));
      const exdev = async () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      };
      await moveAcrossDevices(from, to, { rename: exdev as never });
      expect(existsSync(from)).toBe(false);
      expect(readFileSync(join(to, "sub", "f.txt"), "utf8")).toBe("内容");
      const eacces = async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      };
      await expect(moveAcrossDevices(to, join(dir, "b"), { rename: eacces as never })).rejects.toThrow("denied");
      expect(existsSync(to)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gate 503 page", () => {
  it("shows only the userMessage, HTML-escaped; other error details are not exposed", () => {
    const html = failureHtml(Object.assign(new Error("secret /home/x"), { userMessage: "<b>装 Node</b>" }));
    expect(html).toContain("&lt;b&gt;装 Node&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(failureHtml(new Error("secret /home/x"))).not.toContain("secret");
  });
});

describe("folder picker (macOS / Linux)", async () => {
  const { appleScriptString, pickFolderCommand } = await import("../../daemon/src/util/pickFolder.js");
  it("AppleScript strings escape backslashes and quotes; no default location when the initial directory does not exist", () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
    const c = pickFolderCommand("darwin", "/definitely/not/here");
    expect(c?.cmd).toBe("/usr/bin/osascript");
    expect(c?.args[1]).not.toContain("default location");
    const d = pickFolderCommand("darwin", tmpdir());
    expect(d?.args[1]).toContain("default location (POSIX file ");
  });
  it("Linux: zenity / kdialog only with a graphical session", () => {
    const find = (n: string) => (n === "kdialog" ? "/usr/bin/kdialog" : null);
    expect(pickFolderCommand("linux", undefined, find, {})).toBeNull();
    expect(pickFolderCommand("linux", undefined, find, { DISPLAY: ":0", HOME: "/home/me" })).toEqual({
      cmd: "/usr/bin/kdialog",
      args: ["--getexistingdirectory", "/home/me"],
    });
    const z = pickFolderCommand("linux", tmpdir(), (n) => (n === "zenity" ? "/usr/bin/zenity" : null), { WAYLAND_DISPLAY: "wayland-0" });
    expect(z?.args).toContain("--directory");
    expect(z?.args.at(-1)).toMatch(/^--filename=.*\/$/);
    expect(pickFolderCommand("aix" as NodeJS.Platform, undefined, find, { DISPLAY: ":0" })).toBeNull();
  });
});
