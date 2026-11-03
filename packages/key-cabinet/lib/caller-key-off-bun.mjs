#!/usr/bin/env bun
/**
 * Magpie-compatible flock toggle for caller-keys.json.
 * Args: <id> <0|1> <keysPath>
 * Prints only {ok,id,off} / {ok:false,error} — never secrets.
 */
import { open } from "node:fs/promises";
import { mutateKeysFile } from "./caller-keys-core.mjs";
import { openLibc } from "./libc-flock.mjs";

const id = String(Bun.argv[2] || "").trim();
const off = Bun.argv[3] === "1";
const path = String(Bun.argv[4] || "").trim();
if (!id || !path) {
  console.log(JSON.stringify({ ok: false, error: "缺少参数" }));
  process.exit(1);
}

const lock = path + ".lock";
const libc = await openLibc();
const LOCK_EX = 2;
const LOCK_UN = 8;

let result = { ok: false, error: "未知错误" };
const lf = await open(lock, "a+");
try {
  if (libc.symbols.flock(lf.fd, LOCK_EX) !== 0) {
    result = { ok: false, error: "无法锁定 Magpie caller-keys.json（其它 magpie 正在写入）" };
  } else {
    try {
      const changed = await mutateKeysFile(path, id, off);
      result = { ok: true, ...changed };
    } catch (e) {
      result = { ok: false, error: e?.message || String(e) };
    } finally {
      libc.symbols.flock(lf.fd, LOCK_UN);
    }
  }
} finally {
  await lf.close();
}

console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 2;
