import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { dataDir, atomicWrite } from "./config.js";
import { run } from "./process.js";
import type { Config } from "./types.js";
const service = "magpie-github-stats";
export async function resolveToken(config: Config, dir = dataDir()) {
  if (config.credentialSource === "github-cli") {
    try {
      return validateToken(
        await run("gh", ["auth", "token", "--hostname", "github.com"]),
      );
    } catch {
      throw new Error(
        "GitHub CLI 登录不可用，请运行 gh auth login 或改用系统凭据库。",
      );
    }
  }
  return getToken(dir);
}
function account(dir: string) {
  return createHash("sha256").update(dir).digest("hex").slice(0, 24);
}
export function validateToken(token: unknown): string {
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 300 ||
    !/^[A-Za-z0-9_]+$/.test(token)
  )
    throw new Error("请输入有效 GitHub Token。");
  return token;
}
export async function setToken(token: string, dir = dataDir()) {
  validateToken(token);
  const id = account(dir);
  if (process.platform === "darwin") {
    // Interactive stdin keeps the PAT out of process arguments and shell history.
    await run(
      "/usr/bin/security",
      ["-i"],
      `add-generic-password -U -a "${id}" -s "${service}" -w "${token}"\nquit\n`,
    );
    if ((await getToken(dir, false)) !== token)
      throw new Error("系统钥匙串未保存 Token。");
  } else if (process.platform === "linux")
    await run(
      "secret-tool",
      [
        "store",
        "--label=Magpie GitHub Stats",
        "service",
        service,
        "account",
        id,
      ],
      token,
    );
  else if (process.platform === "win32") {
    const encrypted = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s=[Console]::In.ReadToEnd(); ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString",
      ],
      token,
    );
    await atomicWrite(join(dir, "token.dpapi"), encrypted);
  } else
    throw new Error(
      "此系统不支持安全凭据存储；请使用 MAGPIE_GITHUB_TOKEN 环境变量。",
    );
}
export async function getToken(
  dir = dataDir(),
  allowEnv = true,
): Promise<string> {
  if (allowEnv && process.env.MAGPIE_GITHUB_TOKEN)
    return validateToken(process.env.MAGPIE_GITHUB_TOKEN);
  let token = "";
  const id = account(dir);
  try {
    if (process.platform === "darwin")
      token = await run("/usr/bin/security", [
        "find-generic-password",
        "-a",
        id,
        "-s",
        service,
        "-w",
      ]);
    else if (process.platform === "linux")
      token = await run("secret-tool", [
        "lookup",
        "service",
        service,
        "account",
        id,
      ]);
    else if (process.platform === "win32")
      token = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}",
        ],
        await readFile(join(dir, "token.dpapi"), "utf8"),
      );
  } catch {
    throw new Error(
      "无法读取 GitHub Token；请在设置页保存 Token 并解锁系统凭据库。",
    );
  }
  return validateToken(token);
}
