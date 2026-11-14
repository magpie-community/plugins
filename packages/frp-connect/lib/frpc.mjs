// frpc: the one version this package pins, from frp's own release
// addresses, checked against the SHA256 kept here before it is run.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "./run.mjs";

// VERSION is the only frp release this package runs. SUMS are that
// release's archives' SHA256, as frp publishes them in
// frp_sha256_checksums.txt: an archive whose bytes don't match
// the line here is never unpacked, and nothing is fetched to decide it.
export const VERSION = "0.71.1";
export const SUMS = {
  "frp_0.71.1_android_arm64.tar.gz": "9dce8c10e66bdf1a0cff19bf2cd1a3f4f7389fccee8ca0cda57a7a7c0d87af3a",
  "frp_0.71.1_darwin_amd64.tar.gz": "8acb59b6fb998cc8d209d1373d90bf70fa5ec3efeb4dfbc7bda6ce3abd78cb45",
  "frp_0.71.1_darwin_arm64.tar.gz": "d15d0324b99e14619c9aa46e37f6db588c06a09be4bc6f7948890b6b61077842",
  "frp_0.71.1_linux_amd64.tar.gz": "1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803",
  "frp_0.71.1_linux_arm.tar.gz": "8eb6fe66a3b36db24ca0de44fb01e6742d0ff60e30f462c9662f41813bbf4376",
  "frp_0.71.1_linux_arm64.tar.gz": "8edf590b0c396fa42f9c147121a76af83cfc2002b08f5aef0ea1008c43482019",
  "frp_0.71.1_linux_arm_hf.tar.gz": "a40116f15f2a05b7001f985f1f1ccb2570e2aa41329b06de76a82e71495786db",
  "frp_0.71.1_linux_mips64le.tar.gz": "5cbdcc65fab851ab8f340df7b4539c2b2dbe74a365e41af2cb380712f07bea94",
  "frp_0.71.1_linux_loong64.tar.gz": "1e2fb9e17112dbc3c3d9b7ca36a23c1a97e277d6934c7a2d06faf14788e3f40a",
  "frp_0.71.1_linux_riscv64.tar.gz": "b3ade396d55d11bc1c3ceb27b22bfb6e80f3ffb5932cef29393a3d3273bab070",
  "frp_0.71.1_windows_amd64.zip": "b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821",
  "frp_0.71.1_windows_arm64.zip": "6c25afb4058f7708937db7064836fec593e941de0e6c2c255982335a9b16d370",
};

// BASE is where the release's files are: frp's own GitHub releases.
export const BASE = "https://github.com/fatedier/frp/releases/download";

// asset is the release file for a platform, or null for one frp doesn't
// build: node's arch, then whatever a Linux reports as its machine (uname
// -m), whose i686 and aarch64 aren't node's ia32 and arm64 on a build of
// magpie that doesn't run node itself.
export function asset(platform = process.platform, arch = process.arch) {
  const a = ARCHES[arch] ?? null;
  if (!a) return null;
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  if (!os || (os !== "linux" && a.onlyLinux)) return null;
  return {
    name: `frp_${VERSION}_${os}_${a.frp}.${os === "windows" ? "zip" : "tar.gz"}`,
    os,
    arch: a.frp,
    bin: os === "windows" ? "frpc.exe" : "frpc",
  };
}

// ARCHES is frp's own names for the machines this package runs on, and
// which of them only a Linux can be.
const ARCHES = {
  x64: { frp: "amd64" },
  arm64: { frp: "arm64" },
  ia32: { frp: "arm", onlyLinux: true }, // uname -m i686 (or i386)
  arm: { frp: "arm", onlyLinux: true },
  armv7l: { frp: "arm", onlyLinux: true },
  armv8l: { frp: "arm", onlyLinux: true },
  aarch64: { frp: "arm64", onlyLinux: true },
  arm64_hf: { frp: "arm_hf", onlyLinux: true },
  x32: { frp: "amd64", onlyLinux: true }, // x86-64 with 32-bit pointers
  x32_64: { frp: "amd64", onlyLinux: true },
  loong64: { frp: "loong64", onlyLinux: true },
  riscv64: { frp: "riscv64", onlyLinux: true },
  mips64el: { frp: "mips64le", onlyLinux: true },
};

// pinned is the SHA256 this package keeps for an archive.
export function pinned(name) {
  return SUMS[name] ?? null;
}

// sha256 is a file's digest.
export function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// sumsOf reads frp's checksums file: "<sha256>  <name>" a line.
export function sumsOf(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

// verify answers whether a file's SHA256 is want.
export function verify(file, want) {
  const got = sha256(file);
  if (!want || got !== want.toLowerCase()) return { ok: false, got, want: want || null };
  return { ok: true, got };
}

// installDir is where the checked frpc of this version is kept.
export function installDir(base) {
  return path.join(base, `frpc-${VERSION}`);
}

// ready is the checked frpc already at dir, if it is.
export function ready(dir, a = asset()) {
  if (!a) return null;
  const p = path.join(dir, a.bin);
  return fs.existsSync(p) ? p : null;
}

// fetchArchive asks for the release's archive, and for frp's checksums
// file beside it (null when that one can't be read), so an install says
// what the release publishes when the two disagree. Nothing is unpacked
// here.
export async function fetchArchive(base = BASE, a = asset()) {
  if (!a) throw new Error(`frp builds no frpc for ${process.platform}/${process.arch}`);
  const root = `${base.replace(/\/+$/, "")}/v${VERSION}`;
  const res = await fetch(`${root}/${a.name}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`frp's release answered HTTP ${res.status}: ${root}/${a.name}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  let published = null;
  try {
    const sums = await fetch(`${root}/frp_sha256_checksums.txt`, { redirect: "follow" });
    if (sums.ok) published = sumsOf(await sums.text())[a.name] ?? null;
  } catch {
    // no checksums file: the pinned SHA256 decides alone
  }
  return { bytes, pinned: pinned(a.name), published };
}

// install downloads the release's frpc, holds it to the SHA256 pinned
// here, and unpacks it into dir. A mismatch unpacks nothing.
export async function install(dir, { base = BASE, a = asset(), say = () => {} } = {}) {
  if (!a) throw new Error(`frp builds no frpc for ${process.platform}/${process.arch}; set a local frpc instead.`);
  const want = pinned(a.name);
  if (!want) throw new Error(`${a.name} isn't pinned in this package; refusing to download it.`);
  fs.mkdirSync(dir, { recursive: true });
  say(`downloading ${a.name}`);
  const { bytes, published } = await fetchArchive(base, a);
  if (published && published !== want.toLowerCase()) {
    throw new Error(`frp publishes ${published} for ${a.name}, this package pins ${want}; not unpacked.`);
  }
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  if (got !== want.toLowerCase()) {
    throw new Error(`${a.name} is ${got}, not the pinned ${want}; nothing was unpacked.`);
  }
  const archive = path.join(dir, a.name);
  fs.writeFileSync(archive, bytes);
  const into = path.join(dir, "unpacked");
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  const tar = await run("tar", ["-xf", archive, "-C", into], 120000);
  fs.rmSync(archive, { force: true });
  if (!tar.ok) throw new Error(`unpacking ${a.name} failed: ${tar.stderr || tar.error || "tar"}`);
  const found = find(into, a.bin);
  if (!found) throw new Error(`${a.name} held no ${a.bin}`);
  const dest = path.join(dir, a.bin);
  fs.copyFileSync(found, dest);
  if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
  fs.rmSync(into, { recursive: true, force: true });
  say(`frpc ${VERSION} at ${dest}`);
  return dest;
}

function find(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = find(p, name);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return p;
    }
  }
  return null;
}

// said is what `frpc -v` answers.
export async function said(frpcPath) {
  const r = await run(frpcPath, ["-v"], 5000);
  return r.ok ? r.stdout.trim() || r.stderr.trim() || null : null;
}
