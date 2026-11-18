// 1.3.8 (issue #3): open the project in an IDE, reveal a file / folder in the file manager.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { IDES, type Launch } from "../../daemon/src/util/osOpen.js";

const launched: Launch[] = [];
let ideFound = true;
vi.mock("../../daemon/src/util/osOpen.js", async (orig) => {
  const real = await orig<typeof import("../../daemon/src/util/osOpen.js")>();
  return {
    ...real,
    detectIde: (dir: string) => (ideFound ? { ide: "Cursor", launch: { cmd: "/fake/cursor", args: [dir] } } : null),
    launchDetached: async (l: Launch) => {
      launched.push(l);
      return l.cmd === "/fake/broken" ? { ok: false, reason: "exit 1" } : { ok: true };
    },
  };
});

// detectIde / launchDetached are faked for the RPC tests below; the real ones are tested through importActual
const real = await vi.importActual<typeof import("../../daemon/src/util/osOpen.js")>("../../daemon/src/util/osOpen.js");

describe("IDE detection (osOpen.ts)", () => {
  const set = (files: string[]) => (p: string) => files.includes(p);

  it("tries Cursor, VS Code, Windsurf, Zed, IntelliJ IDEA, WebStorm, Sublime Text in that order", () => {
    expect(IDES.map((i) => i.name)).toEqual(["Cursor", "VS Code", "Windsurf", "Zed", "IntelliJ IDEA", "WebStorm", "Sublime Text"]);
    const onPath: Record<string, string> = { code: "/usr/bin/code", subl: "/usr/bin/subl" };
    const hit = real.detectIde("/p/my proj", { platform: "linux", env: {}, find: (n) => (onPath[n] ? [onPath[n]] : []), exists: () => false });
    expect(hit).toEqual({ ide: "VS Code", launch: { cmd: "/usr/bin/code", args: ["/p/my proj"] } });
  });

  it("nothing installed → null", () => {
    expect(real.detectIde("/p", { platform: "linux", env: {}, find: () => [], exists: () => false })).toBeNull();
    expect(real.detectIde("/p", { platform: "darwin", env: {}, home: "/Users/u", find: () => [], exists: () => false })).toBeNull();
  });

  it("macOS: no CLI on PATH → /Applications/<App>.app via open -a (path stays one argv entry)", () => {
    const hit = real.detectIde("/Users/u/a b;$(rm -rf ~)", {
      platform: "darwin", env: {}, home: "/Users/u", find: () => [],
      exists: set(["/Users/u/Applications/Visual Studio Code.app"]),
    });
    expect(hit).toEqual({ ide: "VS Code", launch: { cmd: "open", args: ["-a", "/Users/u/Applications/Visual Studio Code.app", "/Users/u/a b;$(rm -rf ~)"] } });
  });

  it("Windows: a .cmd launcher on PATH starts the GUI exe beside it, not cmd.exe", () => {
    const cursorCmd = "C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd";
    const l = real.ideLaunchFor(IDES[0], "D:\\work\\proj & calc", {
      platform: "win32", env: {}, find: (n) => (n === "cursor" ? [cursorCmd] : []),
      exists: set(["C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe"]),
    });
    expect(l).toEqual({ cmd: "C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe", args: ["D:\\work\\proj & calc"] });
  });

  it("Windows: a .cmd with no exe beside it goes through cmd.exe with quoted, ^-escaped arguments", () => {
    const l = real.ideLaunchFor(IDES[1], "D:\\a&b%PATH%", {
      platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" }, find: (n) => (n === "code" ? ["C:\\tools\\code.cmd"] : []),
      exists: () => false,
    })!;
    expect(l.cmd).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(l.windowsVerbatimArguments).toBe(true);
    expect(l.hide).toBe(true);
    expect(l.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // bin.ts argvFor (cross-spawn rules): quoted, every metacharacter ^-escaped twice (the .cmd parses it again),
    // so & and % can't start a second command or expand
    expect(l.args[3]).toBe('"C:\\tools\\code.cmd ^^^"D:\\a^^^&b^^^%PATH^^^%^^^""');
  });

  it("Windows: not on PATH → %LOCALAPPDATA% install folder; JetBrains versioned folders under Program Files", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files" };
    expect(real.detectIde("D:\\p", { platform: "win32", env, find: () => [], exists: set(["C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"]) }))
      .toEqual({ ide: "VS Code", launch: { cmd: "C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", args: ["D:\\p"] } });
    const hit = real.detectIde("D:\\p", {
      platform: "win32", env, find: () => [],
      list: (d) => (d === "C:\\Program Files\\JetBrains" ? ["IntelliJ IDEA 2025.2", "IntelliJ IDEA 2026.1", "WebStorm 2026.1"] : []),
      exists: set(["C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.1\\bin\\idea64.exe", "C:\\Program Files\\JetBrains\\WebStorm 2026.1\\bin\\webstorm64.exe"]),
    });
    expect(hit).toEqual({ ide: "IntelliJ IDEA", launch: { cmd: "C:\\Program Files\\JetBrains\\IntelliJ IDEA 2026.1\\bin\\idea64.exe", args: ["D:\\p"] } });
  });
});

describe("reveal commands (osOpen.ts)", () => {
  it("Windows selects a file with /select,\"…\" and opens a folder", () => {
    expect(real.revealLaunch("win32", "D:/proj/src/a b.ts", false)).toEqual({ cmd: "explorer.exe", args: ['/select,"D:\\proj\\src\\a b.ts"'], windowsVerbatimArguments: true });
    expect(real.revealLaunch("win32", "D:\\proj\\src", true)).toEqual({ cmd: "explorer.exe", args: ["D:\\proj\\src"] });
  });
  it("macOS open -R a file, open a folder; Linux xdg-open the folder", () => {
    expect(real.revealLaunch("darwin", "/p/a.ts", false)).toEqual({ cmd: "open", args: ["-R", "/p/a.ts"] });
    expect(real.revealLaunch("darwin", "/p/src", true)).toEqual({ cmd: "open", args: ["/p/src"] });
    expect(real.revealLaunch("linux", "/p/src/a.ts", false)).toEqual({ cmd: "xdg-open", args: ["/p/src"] });
    expect(real.revealLaunch("linux", "/p/src", true)).toEqual({ cmd: "xdg-open", args: ["/p/src"] });
  });
});

describe("launchDetached", () => {
  const fakeSpawn = (behave: (c: EventEmitter) => void) => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const fn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      const c = new EventEmitter() as EventEmitter & { unref(): void };
      c.unref = () => {};
      setTimeout(() => behave(c), 1);
      return c;
    };
    return { fn, calls };
  };

  it("no shell, detached; ok when still running after the grace period", async () => {
    const s = fakeSpawn((c) => c.emit("spawn"));
    const r = await real.launchDetached({ cmd: "/x/code", args: ["/p"] }, { spawn: s.fn as never, graceMs: 20 });
    expect(r).toEqual({ ok: true });
    expect(s.calls[0].opts).toMatchObject({ shell: false, detached: true, stdio: "ignore", windowsHide: false });
  });
  it("spawn error / quick non-zero exit → failure; explorer's exit 1 is ignored with ignoreExit", async () => {
    expect(await real.launchDetached({ cmd: "nope", args: [] }, { spawn: fakeSpawn((c) => c.emit("error", new Error("spawn nope ENOENT"))).fn as never }))
      .toEqual({ ok: false, reason: "spawn nope ENOENT" });
    expect(await real.launchDetached({ cmd: "x", args: [] }, { spawn: fakeSpawn((c) => { c.emit("spawn"); c.emit("exit", 2); }).fn as never, graceMs: 50 }))
      .toEqual({ ok: false, reason: "exit 2" });
    expect(await real.launchDetached({ cmd: "explorer.exe", args: [] }, { spawn: fakeSpawn((c) => { c.emit("spawn"); c.emit("exit", 1); }).fn as never, ignoreExit: true, graceMs: 50 }))
      .toEqual({ ok: true });
  });
});

// ---- the RPCs, through registerMethods (the gateway itself, hello auth included, is covered by ws.test.ts) ----
describe("projects.openInIde / files.reveal RPCs", () => {
  let dir = "";
  let proj = "";
  let outside = "";
  const handlers = new Map<string, (p: unknown, ctx: unknown) => unknown>();
  let projectId = "";
  let missingId = "";

  beforeAll(async () => {
    const { registerMethods } = await import("../../daemon/src/ws/methods.js");
    const { SettingsStore } = await import("../../daemon/src/store/settings.js");
    const { ProjectsStore } = await import("../../daemon/src/store/projects.js");
    const { ThreadsStore } = await import("../../daemon/src/store/threads.js");
    const { GitService } = await import("../../daemon/src/git/service.js");
    const { FileService } = await import("../../daemon/src/files/service.js");
    dir = mkdtempSync(join(tmpdir(), "ac-osopen-"));
    proj = join(dir, "proj");
    outside = join(dir, "outside");
    mkdirSync(join(proj, "src"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(proj, "src", "a.ts"), "x");
    writeFileSync(join(outside, "secret.txt"), "s");
    if (process.platform !== "win32") symlinkSync(outside, join(proj, "link-out"));
    const gw = { method: (n: string, fn: (p: unknown, ctx: unknown) => unknown) => handlers.set(n, fn), publish: () => {} };
    const projects = new ProjectsStore(dir);
    const cfg = { port: 0, dataDir: dir, token: "t", version: "9.9.9", idleExitMinutes: 60, buildStamp: "0" };
    registerMethods(gw as never, { cfg, settings: new SettingsStore(dir), gateway: gw as never, projects, threads: new ThreadsStore(dir), git: new GitService(), files: new FileService(), terminals: {} as never });
    projectId = (await projects.create(proj, "p")).id;
    const gone = join(dir, "gone");
    mkdirSync(gone);
    missingId = (await projects.create(gone, "gone")).id;
    rmSync(gone, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { launched.length = 0; ideFound = true; });

  const call = async (m: string, p: unknown) => {
    try { return { r: await handlers.get(m)!(p, {}) }; } catch (e) { return { code: (e as { code?: string }).code, message: (e as Error).message }; }
  };

  it("openInIde returns the IDE's name and launches it on the project's real folder", async () => {
    expect(await call("projects.openInIde", { id: projectId })).toEqual({ r: { ok: true, ide: "Cursor" } });
    expect(launched[0]).toEqual({ cmd: "/fake/cursor", args: [realpathSync(proj)] });
  });
  it("openInIde errors: no_ide, bad_path (folder gone), not_found", async () => {
    ideFound = false;
    expect((await call("projects.openInIde", { id: projectId })).code).toBe("no_ide");
    ideFound = true;
    expect((await call("projects.openInIde", { id: missingId })).code).toBe("bad_path");
    expect((await call("projects.openInIde", { id: "p_nope" })).code).toBe("not_found");
    expect(launched).toHaveLength(0);
  });

  it("files.reveal: a file is selected in its folder, a folder is opened", async () => {
    expect(await call("files.reveal", { projectId, path: "src/a.ts" })).toEqual({ r: { ok: true } });
    expect(await call("files.reveal", { projectId, path: "src" })).toEqual({ r: { ok: true } });
    expect(launched).toEqual([
      real.revealLaunch(process.platform, join(realpathSync(proj), "src", "a.ts"), false),
      real.revealLaunch(process.platform, join(realpathSync(proj), "src"), true),
    ]);
  });

  it("files.reveal refuses anything outside the project root, and missing targets", async () => {
    for (const path of ["../outside/secret.txt", "src/../../outside", join(outside, "secret.txt"), "", "C:\\Windows"]) {
      const r = await call("files.reveal", { projectId, path });
      expect(r.code, path).toBe("bad_path");
    }
    expect((await call("files.reveal", { projectId, path: "src/nope.ts" })).code).toBe("bad_path");
    expect(launched).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("files.reveal refuses a symlink that resolves outside the project", async () => {
    const r = await call("files.reveal", { projectId, path: "link-out/secret.txt" });
    expect(r.code).toBe("bad_path");
    expect(launched).toHaveLength(0);
  });
});

