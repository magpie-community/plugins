// GitService (§5.8): runs the local git via execFile (no shell), cwd = project path, 15 s timeout.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

export type GitFileEntry = {
  path: string;
  index: string;
  worktree: string;
  kind: "modified" | "added" | "deleted" | "untracked" | "renamed";
};
export type GitStatus = { isRepo: boolean; branch?: string; files?: GitFileEntry[]; error?: string };

const TIMEOUT = 15_000;
const DIFF_LIMIT = 1024 * 1024;

function runGit(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    // core.quotepath=false: non-ASCII paths (e.g. Chinese file names) are no longer turned into "\346\226\207" octal escapes in diff headers
    execFile("git", ["-c", "core.quotepath=false", ...args], { cwd, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (e, stdout, stderr) => {
      const code = e && typeof (e as { code?: number }).code === "number" ? (e as { code: number }).code! : e ? 1 : 0;
      const missing = (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
      res({ code, out: String(stdout ?? ""), err: missing ? "找不到 git（请先安装 git 并加入 PATH）" : String(stderr || (e?.message ?? "")) });
    });
  });
}

// The path must be inside the project (no .. escape); returns the project-relative path (posix form)
function insidePath(projectPath: string, p: string): string | null {
  const rel = normalize(p).replace(/\\/g, "/");
  const abs = normalize(join(projectPath, rel));
  const proj = normalize(projectPath);
  if (abs !== proj && !abs.startsWith(proj + sep)) return null;
  return rel.replace(/\\/g, "/");
}

// rename across drives/volumes (Windows project on D:, data dir on C:; different mount points on Linux) fails with EXDEV → copy then delete
export async function moveAcrossDevices(
  from: string,
  to: string,
  ops: { rename?: typeof rename; cp?: typeof cp; rm?: typeof rm } = {},
): Promise<void> {
  const ren = ops.rename ?? rename;
  try {
    await ren(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EXDEV") throw e;
    await (ops.cp ?? cp)(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await (ops.rm ?? rm)(from, { recursive: true, force: true });
  }
}

export class GitService {
  // projectPath is resolved from projectId by the caller (the service doesn't know about the store)
  async status(projectPath: string): Promise<GitStatus> {
    const inside = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.out.trim() !== "true") return { isRepo: false };
    const br = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const st = await runGit(projectPath, ["status", "--porcelain=v1", "-z", "-uall"]);
    if (st.code !== 0) return { isRepo: true, branch: br.out.trim() || undefined, error: st.err.trim() || "status 失败" };
    const files: GitFileEntry[] = [];
    const parts = st.out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (!rec || rec.length < 4) continue;
      const index = rec[0];
      const worktree = rec[1];
      let path = rec.slice(3);
      let kind: GitFileEntry["kind"] = "modified";
      if (index === "?" && worktree === "?") kind = "untracked";
      else if (index === "R" || worktree === "R") {
        kind = "renamed";
        // A renamed record looks like "R  new\0old": the next part is the old path, skip it
        i++;
      } else if (index === "A" || worktree === "A") kind = "added";
      else if (index === "D" || worktree === "D") kind = "deleted";
      files.push({ path, index, worktree, kind });
    }
    return { isRepo: true, branch: br.out.trim() || undefined, files };
  }

  // Unified diff text; {tooLarge:true} when the diff is > 1MB
  async diff(projectPath: string, p: string): Promise<{ diff?: string; tooLarge?: boolean; untracked?: boolean; error?: string }> {
    const rel = insidePath(projectPath, p);
    if (!rel) return { error: "路径不允许" };
    // Check untracked first (git diff prints nothing for untracked files)
    const ls = await runGit(projectPath, ["ls-files", "--error-unmatch", "--", rel]);
    if (ls.code !== 0) {
      // Untracked/not in the index: treat the whole file as added
      const full = join(projectPath, rel);
      if (!existsSync(full)) return { error: "文件不存在" };
      const s = await stat(full);
      if (!s.isFile()) return { error: "不是文件" };
      if (s.size > DIFF_LIMIT) return { tooLarge: true };
      const text = await readFile(full, "utf8").catch(() => null);
      if (text === null) return { error: "二进制或无法读取" };
      const lines = text.split("\n").map((l) => "+" + l).join("\n");
      return { untracked: true, diff: `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${text.split("\n").length} @@\n${lines}` };
    }
    let d = await runGit(projectPath, ["diff", "--no-color", "--", rel]);
    if (d.code !== 0) return { error: d.err.trim() || "diff 失败" };
    if (!d.out.trim()) {
      d = await runGit(projectPath, ["diff", "--cached", "--no-color", "--", rel]);
      if (d.code !== 0) return { error: d.err.trim() || "diff 失败" };
    }
    if (d.out.length > DIFF_LIMIT) return { tooLarge: true };
    return { diff: d.out };
  }

  // Tracked → git restore; untracked → move to trash/discarded/<ts>/<relpath>
  async discard(projectPath: string, p: string, dataDir: string): Promise<{ ok: boolean; trashedTo?: string; error?: string }> {
    const rel = insidePath(projectPath, p);
    if (!rel) return { ok: false, error: "路径不允许" };
    // Only discard a single file: an empty path / "." would make git restore act on the whole repository
    if (rel === "." || rel === "" || rel === "./") return { ok: false, error: "路径不允许" };
    const ls = await runGit(projectPath, ["ls-files", "--error-unmatch", "--", rel]);
    if (ls.code === 0) {
      let r = await runGit(projectPath, ["restore", "--staged", "--worktree", "--", rel]);
      if (r.code !== 0) r = await runGit(projectPath, ["checkout", "--", rel]);
      if (r.code !== 0) return { ok: false, error: r.err.trim() || "放弃失败" };
      return { ok: true };
    }
    const full = join(projectPath, rel);
    if (!existsSync(full)) return { ok: false, error: "文件不存在" };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = join(dataDir, "trash", "discarded", stamp, rel);
    await mkdir(join(dest, ".."), { recursive: true });
    try {
      await moveAcrossDevices(full, dest);
    } catch (e) {
      return { ok: false, error: "移动失败：" + String((e as Error)?.message ?? e) };
    }
    return { ok: true, trashedTo: dest };
  }
}
