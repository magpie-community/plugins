/**
 * PKCE：一次登录会话的码对与 state。
 *
 * 标准 PKCE（与平台授权端点的参数一致）：
 *   verifier  = base64url(48 随机字节)   → 64 字符，在 43–128 限制内
 *   challenge = base64url(SHA256(verifier))
 *   state     = base64url(16 随机字节)   → 22 字符
 * Go 用 base64.RawURLEncoding，等价于这里的 "base64url"（无填充、URL 安全表）。
 */

import { createHash, randomBytes } from "node:crypto";

/** base64url 无填充随机串（与 Go 的 base64.RawURLEncoding 一致）。 */
export function randomString(bytes) {
  return randomBytes(bytes).toString("base64url");
}

/** 一次登录会话的 PKCE 码对与 state。 */
export function createPkce() {
  const verifier = randomString(48);
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge, state: randomString(16) };
}
