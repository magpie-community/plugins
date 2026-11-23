// 本文由AI自动生成
// 用 magpie 自己的 CLI 向厂商重读额度。
// 这是 magpie Usage 页刷新按钮背后的同一条通道：只查询额度，不发模型请求。

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BIN = process.platform === "win32" ? "magpie.exe" : "magpie";
const CONCURRENCY = 3;
const TIMEOUT_MS = 12_000;

async function executable(path) {
  if (!path) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 找 magpie 可执行文件。找不到返回 null —— 面板降级为只读，不报错。 */
export async function resolveMagpieBin() {
  const candidates = [];
  const binDir = process.env.MAGPIE_BIN_DIR;
  if (binDir) candidates.push(join(binDir, BIN));
  if (process.env.MAGPIE_BINARY) candidates.push(process.env.MAGPIE_BINARY);
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (dir) candidates.push(join(dir, BIN));
  }
  if (process.platform === "darwin") candidates.push("/Applications/magpie.app/Contents/MacOS/magpie");
  if (process.platform === "win32" && process.env.LOCALAPPDATA)
    candidates.push(join(process.env.LOCALAPPDATA, "Programs", "magpie", BIN));
  if (process.platform === "linux") candidates.push(join(homedir(), ".local", "bin", BIN));

  for (const path of candidates) {
    if (await executable(path)) return path;
  }
  return null;
}

function argsFor(account) {
  const provider = String(account?.provider || "").trim();
  if (!provider) return null;
  const user = String(account?.user || "").trim();
  return user
    ? ["quota", "refresh", provider, user, "--json"]
    : ["quota", "refresh", provider, "--json"];
}

/** 逐账号重读。单个账号失败只记进 results，不影响其余账号。 */
export async function runRefresh(accounts, bin) {
  const results = [];
  const seen = new Set();
  const jobs = [];
  for (const a of accounts || []) {
    const provider = String(a?.provider || "").trim();
    const user = String(a?.user || "").trim();
    const key = `${provider}|${user}`;
    if (!provider || seen.has(key)) continue;
    seen.add(key);
    const args = argsFor({ provider, user });
    if (!args) continue;
    jobs.push({ provider, user, args });
  }

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (job) => {
        try {
          await exec(bin, job.args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
          return { provider: job.provider, user: job.user, ok: true };
        } catch (err) {
          return {
            provider: job.provider,
            user: job.user,
            ok: false,
            error: String(err?.message || err).slice(0, 300),
          };
        }
      }),
    );
    results.push(...settled);
  }
  return results;
}
