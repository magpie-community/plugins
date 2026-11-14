// The frpc this package runs: one pinned version, held to a SHA256 kept
// in the package. Nothing here downloads anything: a fake fetch answers.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as frpc from "../lib/frpc.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "frp-connect-test-"));

test("the pinned version isn't `latest`", () => {
  assert.match(frpc.VERSION, /^\d+\.\d+\.\d+$/);
  assert.notEqual(frpc.VERSION, "latest");
});

test("every machine magpie runs on has its own release file, pinned", () => {
  // the architectures magpie itself ships (Makefile's TARGETS) and frp
  // builds, plus the ones a Linux reports as its machine
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
    ["win32", "arm64"],
    ["linux", "ia32"],
    ["linux", "arm"],
    ["linux", "armv7l"],
    ["linux", "aarch64"],
    ["linux", "loong64"],
    ["linux", "riscv64"],
    ["linux", "mips64el"],
  ]) {
    const a = frpc.asset(platform, arch);
    assert.ok(a, `${platform}/${arch} has an asset`);
    assert.ok(/^[0-9a-f]{64}$/.test(frpc.pinned(a.name) ?? ""), `${a.name} is pinned`);
    assert.match(a.name, new RegExp(`^frp_${frpc.VERSION.replace(/\./g, "\\.")}_`));
  }
});

test("architectures built separately get separate files", () => {
  // one SHA256 for all of them would be one file's for all of them
  const names = new Set();
  const sums = new Set();
  for (const arch of ["x64", "arm64", "ia32", "loong64", "riscv64", "mips64el"]) {
    const a = frpc.asset("linux", arch);
    names.add(a.name);
    sums.add(frpc.pinned(a.name));
  }
  names.add(frpc.asset("darwin", "arm64").name);
  sums.add(frpc.pinned(frpc.asset("darwin", "arm64").name));
  names.add(frpc.asset("win32", "arm64").name);
  sums.add(frpc.pinned(frpc.asset("win32", "arm64").name));
  assert.equal(sums.size, names.size, `distinct files, distinct SHA256s: ${[...sums].length}`);
});

test("a platform frp doesn't build has no asset", () => {
  // darwin and windows are amd64/arm64 only, whatever node's arch says
  assert.equal(frpc.asset("darwin", "ia32"), null);
  assert.equal(frpc.asset("win32", "ia32"), null);
  assert.equal(frpc.asset("linux", "ppc64"), null);
  assert.equal(frpc.asset("aix", "x64"), null);
});

test("a checksums file reads as frp publishes it", () => {
  const want = "a".repeat(64);
  assert.deepEqual(frpc.sumsOf(`${want}  frp_0.71.1_linux_amd64.tar.gz\n\nbogus line\n`), {
    "frp_0.71.1_linux_amd64.tar.gz": want,
  });
});

test("a file is held to its SHA256, and one that isn't it is refused", () => {
  const dir = tmp();
  const file = path.join(dir, "archive");
  fs.writeFileSync(file, "hello");
  const good = crypto.createHash("sha256").update("hello").digest("hex");
  assert.deepEqual(frpc.verify(file, good), { ok: true, got: good });
  assert.equal(frpc.verify(file, "0".repeat(64)).ok, false);
  assert.equal(frpc.verify(file, null).ok, false);
});

test("an archive whose bytes don't match the pinned SHA256 unpacks nothing", async () => {
  const dir = tmp();
  const a = frpc.asset("linux", "x64");
  const real = globalThis.fetch;
  // a release file that is not the one this package pins
  globalThis.fetch = async () => new Response(Buffer.from("not frp"), { status: 200 });
  try {
    await assert.rejects(frpc.install(dir, { a }), /pinned|publishes/);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(fs.existsSync(path.join(dir, a.bin)), false);
});

test("an archive with no SHA256 in the package is never downloaded", async () => {
  const dir = tmp();
  const real = globalThis.fetch;
  let asked = false;
  globalThis.fetch = async () => {
    asked = true;
    return new Response("", { status: 200 });
  };
  try {
    await assert.rejects(frpc.install(dir, { a: { name: "frp_9.9.9_linux_amd64.tar.gz", bin: "frpc", os: "linux", arch: "amd64" } }), /isn't pinned/);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(asked, false, "nothing was fetched");
});

test("the checksums file's name is frp's, not this package's guess", async () => {
  // frp publishes one checksums file per release, named for frp: a wrong
  // name read as none, and the pinned SHA256 then decided alone
  const dir = tmp();
  const a = frpc.asset("linux", "x64");
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(Buffer.alloc(0), { status: url.endsWith(".txt") ? 200 : 200 });
  };
  try {
    await frpc.fetchArchive(frpc.BASE, a);
  } finally {
    globalThis.fetch = real;
  }
  const sums = asked.find((u) => u.endsWith(".txt"));
  assert.ok(sums, `a checksums file was asked for: ${asked.join(" ")}`);
  assert.ok(!/frp_0\.\d+\.\d+_sha256_checksums\.txt$/.test(sums), `asked for ${sums}`);
  assert.match(sums, /\/v\d+\.\d+\.\d+\/frp_sha256_checksums\.txt$/);
});
