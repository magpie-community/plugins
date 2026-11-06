// 1.3: Git Bash detection for the agents on Windows, with a mocked file system (no Windows here).
import { describe, it, expect, afterEach } from "vitest";
import {
  bashEnv, bashForGitDir, checkBashPath, driveBashCandidates, findGitBash, isWslBash, knownBashCandidates, bashPathDir,
} from "../../daemon/src/util/gitBash.js";
import { agentShellStatus, bashMissingFor, refreshAgentShell, withAgentShell } from "../../daemon/src/util/agentShell.js";

const lc = (s: string) => s.toLowerCase();
/** A fake Windows disk: the given files exist (case-insensitive), nothing else does */
function disk(files: string[]) {
  const set = new Set(files.map(lc));
  const isFile = (p: string) => set.has(lc(p));
  return { isFile, isFileAsync: async (p: string) => isFile(p) };
}
const WIN_ENV = {
  SystemRoot: "C:\\WINDOWS",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\nolan\\AppData\\Local",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
};
const WSL = "C:\\WINDOWS\\system32\\bash.exe";
const APPS = "C:\\Users\\nolan\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe";

describe("isWslBash", () => {
  it("System32 / SysWOW64 / Sysnative / WindowsApps bash are the WSL launcher", () => {
    expect(isWslBash(WSL, WIN_ENV)).toBe(true);
    expect(isWslBash("c:/windows/System32/bash.exe")).toBe(true);
    expect(isWslBash("C:\\Windows\\SysWOW64\\bash.exe")).toBe(true);
    expect(isWslBash("C:\\Windows\\Sysnative\\bash.exe")).toBe(true);
    expect(isWslBash(APPS)).toBe(true);
    expect(isWslBash("D:\\Win\\System32\\bash.exe", { SystemRoot: "D:\\Win" })).toBe(true);
    expect(isWslBash("E:\\Git\\bin\\bash.exe", WIN_ENV)).toBe(false);
    expect(isWslBash("C:\\Program Files\\Git\\usr\\bin\\bash.exe", WIN_ENV)).toBe(false);
  });
});

describe("checkBashPath (Settings → Bash path)", () => {
  const d = disk(["E:\\Git\\bin\\bash.exe", WSL, "E:\\Git\\bin\\git.exe"]);
  it("accepts an existing bash.exe, with quotes and spaces trimmed", () => {
    expect(checkBashPath('  "E:\\Git\\bin\\bash.exe" ', { ...d, env: WIN_ENV })).toEqual({ ok: true, path: "E:\\Git\\bin\\bash.exe" });
    expect(checkBashPath("e:/Git/bin/bash.exe", { ...d, env: WIN_ENV })).toEqual({ ok: true, path: "e:\\Git\\bin\\bash.exe" });
  });
  it("refuses empty, relative, non-bash, WSL and missing paths", () => {
    expect(checkBashPath("", { ...d, env: WIN_ENV })).toEqual({ ok: false, reason: "empty" });
    expect(checkBashPath("bash.exe", { ...d, env: WIN_ENV })).toEqual({ ok: false, reason: "relative" });
    // UNC paths are refused: the check is synchronous and a dead share could stall the daemon
    expect(checkBashPath("\\\\srv\\share\\Git\\bin\\bash.exe", { ...d, env: WIN_ENV })).toEqual({ ok: false, reason: "relative" });
    expect(checkBashPath("E:\\Git\\bin\\git.exe", { ...d, env: WIN_ENV })).toEqual({ ok: false, reason: "notBash" });
    expect(checkBashPath(WSL, { ...d, env: WIN_ENV })).toEqual({ ok: false, reason: "wsl" });
    expect(checkBashPath("F:\\Git\\bin\\bash.exe", { ...d, env: WIN_ENV })).toEqual({ ok: false, reason: "missing" });
  });
});

describe("candidates", () => {
  it("bash next to git.exe: cmd, bin, mingw64\\bin, usr\\bin", () => {
    expect(bashForGitDir("E:\\Git\\cmd")[0]).toBe("E:\\Git\\bin\\bash.exe");
    expect(bashForGitDir("E:\\Git\\bin")).toContain("E:\\Git\\bin\\bash.exe");
    expect(bashForGitDir("E:\\Git\\mingw64\\bin")[0]).toBe("E:\\Git\\bin\\bash.exe");
    expect(bashForGitDir("D:\\Tools\\Git\\usr\\bin")[0]).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });
  it("known install dirs in order, deduped", () => {
    const k = knownBashCandidates(WIN_ENV, "C:\\Users\\nolan");
    expect(k[0]).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(k).toContain("C:\\Program Files (x86)\\Git\\bin\\bash.exe");
    expect(k).toContain("C:\\Users\\nolan\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
    expect(k).toContain("C:\\Users\\nolan\\scoop\\apps\\git\\current\\bin\\bash.exe");
    expect(new Set(k.map(lc)).size).toBe(k.length);
  });
  it("other drives", () => {
    expect(driveBashCandidates(["e", "F:", "1"])).toEqual([
      "E:\\Git\\bin\\bash.exe", "E:\\Program Files\\Git\\bin\\bash.exe",
      "F:\\Git\\bin\\bash.exe", "F:\\Program Files\\Git\\bin\\bash.exe",
    ]);
  });
});

describe("findGitBash", () => {
  it("Nolan's machine: Git on E:\\Git with git on PATH, WSL bash in System32 first → E:\\Git\\bin\\bash.exe", async () => {
    const d = disk([WSL, APPS, "E:\\Git\\cmd\\git.exe", "E:\\Git\\bin\\bash.exe"]);
    const env = { ...WIN_ENV, Path: "C:\\WINDOWS\\system32;C:\\WINDOWS;E:\\Git\\cmd;C:\\Users\\nolan\\AppData\\Local\\Microsoft\\WindowsApps" };
    const r = await findGitBash("", { ...d, env, drives: [] });
    expect(r.found).toEqual({ path: "E:\\Git\\bin\\bash.exe", source: "git" });
  });
  it("git not on PATH: finds X:\\Git on another drive, and never System32 or WindowsApps", async () => {
    const d = disk([WSL, APPS, "E:\\Git\\bin\\bash.exe"]);
    const env = { ...WIN_ENV, Path: "C:\\WINDOWS\\system32;C:\\Users\\nolan\\AppData\\Local\\Microsoft\\WindowsApps" };
    const r = await findGitBash("", { ...d, env });
    expect(r.found).toEqual({ path: "E:\\Git\\bin\\bash.exe", source: "drive" });
  });
  it("Program Files before other drives; LocalAppData\\Programs for per-user installs", async () => {
    const env = { ...WIN_ENV, Path: "C:\\WINDOWS\\system32" };
    expect((await findGitBash("", { ...disk(["C:\\Program Files\\Git\\bin\\bash.exe", "E:\\Git\\bin\\bash.exe"]), env })).found)
      .toEqual({ path: "C:\\Program Files\\Git\\bin\\bash.exe", source: "known" });
    expect((await findGitBash("", { ...disk(["C:\\Users\\nolan\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"]), env, drives: [] })).found)
      .toEqual({ path: "C:\\Users\\nolan\\AppData\\Local\\Programs\\Git\\bin\\bash.exe", source: "known" });
  });
  it("only the WSL launcher → nothing found", async () => {
    const env = { ...WIN_ENV, Path: "C:\\WINDOWS\\system32;C:\\Users\\nolan\\AppData\\Local\\Microsoft\\WindowsApps" };
    expect((await findGitBash("", { ...disk([WSL, APPS]), env })).found).toBeNull();
  });
  it("a non-WSL bash.exe on PATH (MSYS2) is the last resort", async () => {
    const env = { ...WIN_ENV, Path: "C:\\WINDOWS\\system32;C:\\msys64\\usr\\bin" };
    expect((await findGitBash("", { ...disk([WSL, "C:\\msys64\\usr\\bin\\bash.exe"]), env, drives: [] })).found)
      .toEqual({ path: "C:\\msys64\\usr\\bin\\bash.exe", source: "path" });
  });
  it("the manual setting wins; an unusable one is reported and detection still runs", async () => {
    const d = disk(["D:\\PortableGit\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe", WSL]);
    const env = { ...WIN_ENV, Path: "C:\\WINDOWS\\system32" };
    expect((await findGitBash("D:\\PortableGit\\bin\\bash.exe", { ...d, env })).found).toEqual({ path: "D:\\PortableGit\\bin\\bash.exe", source: "manual" });
    const bad = await findGitBash(WSL, { ...d, env });
    expect(bad.manualError).toEqual({ ok: false, reason: "wsl" });
    expect(bad.found?.source).toBe("known");
  });
  it("a valid CLAUDE_CODE_GIT_BASH_PATH is kept; one pointing at WSL is ignored", async () => {
    const d = disk(["F:\\g\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe", WSL]);
    const env = { ...WIN_ENV, Path: "", CLAUDE_CODE_GIT_BASH_PATH: "F:\\g\\bin\\bash.exe" };
    expect((await findGitBash("", { ...d, env })).found).toEqual({ path: "F:\\g\\bin\\bash.exe", source: "env" });
    expect((await findGitBash("", { ...d, env: { ...env, CLAUDE_CODE_GIT_BASH_PATH: WSL } })).found?.source).toBe("known");
  });
  it("a drive probe that hangs (dead network drive) times out instead of blocking", async () => {
    const env = { ...WIN_ENV, Path: "" };
    const t0 = Date.now();
    const r = await findGitBash("", {
      isFile: () => false,
      isFileAsync: (p) => (p.startsWith("Z:") ? new Promise(() => {}) : Promise.resolve(p === "E:\\Git\\bin\\bash.exe")),
      env, probeTimeoutMs: 200,
    });
    expect(r.found?.path).toBe("E:\\Git\\bin\\bash.exe");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("bashEnv (per-spawn environment)", () => {
  const d = disk([WSL, "E:\\Git\\bin\\bash.exe", "E:\\Git\\cmd\\git.exe"]);
  it("sets both agent variables and puts Git\\bin before System32 so `where bash.exe` (Pi) and PATH lookups (dsh) find it", () => {
    const env = { Path: "C:\\WINDOWS\\system32;E:\\Git\\cmd", PATHEXT: ".EXE" };
    const out = bashEnv({ path: "E:\\Git\\bin\\bash.exe", source: "git" }, env, d.isFile);
    expect(out.CLAUDE_CODE_GIT_BASH_PATH).toBe("E:\\Git\\bin\\bash.exe");
    expect(out.OPENCODE_GIT_BASH_PATH).toBe("E:\\Git\\bin\\bash.exe");
    expect(out.Path).toBe("E:\\Git\\bin;C:\\WINDOWS\\system32;E:\\Git\\cmd");
    expect(out.PATH).toBeUndefined();
  });
  it("PATH is left alone when the first bash.exe on it is already the chosen one", () => {
    const env = { PATH: "E:\\Git\\bin;C:\\WINDOWS\\system32", PATHEXT: ".EXE" };
    const out = bashEnv({ path: "E:\\Git\\bin\\bash.exe", source: "git" }, env, d.isFile);
    expect(out.PATH).toBeUndefined();
  });
  it("usr\\bin picks the Git\\bin directory for PATH (only bash/sh/git there, no coreutils shadowing)", () => {
    const dd = disk(["E:\\Git\\bin\\bash.exe", "E:\\Git\\usr\\bin\\bash.exe"]);
    expect(bashPathDir("E:\\Git\\usr\\bin\\bash.exe", dd.isFile)).toBe("E:\\Git\\bin");
    expect(bashPathDir("C:\\msys64\\usr\\bin\\bash.exe", dd.isFile)).toBe("C:\\msys64\\usr\\bin");
  });
  it("nothing found → no changes", () => {
    expect(bashEnv(null, { PATH: "x" })).toEqual({});
  });
});

describe("agentShell state", () => {
  afterEach(async () => { await refreshAgentShell("", { platform: "linux" }); });
  it("is a no-op on macOS / Linux", async () => {
    await refreshAgentShell("C:\\x\\bash.exe", { platform: "darwin" });
    expect(agentShellStatus().needed).toBe(false);
    const env = { PATH: "/usr/bin" };
    expect(withAgentShell(env)).toBe(env);
    expect(bashMissingFor("claude")).toBe(false);
  });
  it("Windows: merges the variables into a spawn env; hint only for agents that need bash", async () => {
    const d = disk([WSL, "E:\\Git\\bin\\bash.exe"]);
    const env = { ...WIN_ENV, Path: "C:\\WINDOWS\\system32" };
    await refreshAgentShell("", { platform: "win32", deps: { ...d, env } });
    expect(agentShellStatus().found?.path).toBe("E:\\Git\\bin\\bash.exe");
    const out: Record<string, string | undefined> = withAgentShell({ Path: "C:\\WINDOWS\\system32", FOO: "1" });
    expect(out.CLAUDE_CODE_GIT_BASH_PATH).toBe("E:\\Git\\bin\\bash.exe");
    expect(out.Path).toBe("E:\\Git\\bin;C:\\WINDOWS\\system32");
    expect(out.FOO).toBe("1");
    expect(bashMissingFor("claude")).toBe(false);

    await refreshAgentShell("", { platform: "win32", deps: { ...disk([WSL]), env, drives: [] } });
    expect(agentShellStatus().found).toBeNull();
    expect(bashMissingFor("claude")).toBe(true);
    expect(bashMissingFor("pi")).toBe(true);
    expect(bashMissingFor("codex")).toBe(false);
    expect(withAgentShell({ Path: "x" })).toEqual({ Path: "x" });
  });
  it("an unusable manual path is reported in the status", async () => {
    const env = { ...WIN_ENV, Path: "" };
    await refreshAgentShell(WSL, { platform: "win32", deps: { ...disk([WSL]), env, drives: [] } });
    expect(agentShellStatus().manualError).toBe("wsl");
  });
});

describe("probeInChild (other drives, out of process)", () => {
  it("returns the first existing candidate in list order, null when none", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { probeInChild } = await import("../../daemon/src/util/gitBash.js");
    const dir = mkdtempSync(join(tmpdir(), "ac-probe-"));
    const a = join(dir, "a"), b = join(dir, "b");
    writeFileSync(a, ""); writeFileSync(b, "");
    expect(await probeInChild([join(dir, "nope"), b, a], 5000)).toBe(b);
    expect(await probeInChild([join(dir, "nope"), dir], 5000)).toBeNull(); // a directory is not a file
    expect(await probeInChild([], 5000)).toBeNull();
  });
});
