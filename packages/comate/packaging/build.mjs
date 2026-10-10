import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const packagingDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(packagingDir, "..")
const payloadNames = ["LICENSE", "README.md", "discovery.mjs", "index.mjs", "package.json", "protocol.mjs"]
const installers = [
  { platform: "macos", name: "install.command", mode: 0o100755 },
  { platform: "windows", name: "install.ps1", mode: 0o100644 },
]
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
function usage() {
  return `Usage: node packaging/build.mjs --out-dir DIR [--dry-run]\n\nBuilds reproducible Windows and macOS ZIPs without network access or extra packages.\nThe output directory is required so generated archives never appear in the source tree by default.`
}

function parseArgs(args) {
  let outDir = ""
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h") {
      console.log(usage())
      process.exit(0)
    }
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--out-dir") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--out-dir needs a directory")
      outDir = resolve(args[++i])
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (!outDir) throw new Error("--out-dir is required (it may be outside the repository)")
  return { outDir, dryRun }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function safeArchiveName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._/-]+$/.test(name)) throw new Error(`Unsafe archive path: ${name}`)
  if (name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe archive path: ${name}`)
  }
  return name
}

function archiveManifest(entries) {
  return Buffer.from([...entries]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(({ name, data }) => `${sha256(data)}  ${safeArchiveName(name)}\n`)
    .join(""), "utf8")
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

// ZIP32 stored entries use fixed timestamps, permissions, ordering, and no
// host compression tool, so the same input bytes produce the same archive.
function zip(entries) {
  if (entries.length > 0xffff) throw new Error("Too many ZIP entries")
  const ordered = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const localParts = []
  const centralParts = []
  let localOffset = 0
  for (const entry of ordered) {
    const name = Buffer.from(safeArchiveName(entry.name), "utf8")
    const data = Buffer.from(entry.data)
    if (name.length > 0xffff || data.length > 0xffffffff) throw new Error(`ZIP32 limit exceeded by ${entry.name}`)
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored, without compression
    local.writeUInt16LE(0, 10) // fixed DOS time: midnight
    local.writeUInt16LE(0x0021, 12) // fixed DOS date: 1980-01-01
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4) // Unix creator, ZIP 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x0021, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((entry.mode ?? 0o100644) * 0x10000) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  if (localOffset > 0xffffffff || centralSize > 0xffffffff) throw new Error("ZIP32 archive size limit exceeded")
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(ordered.length, 8)
  end.writeUInt16LE(ordered.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}

async function readRegularFile(root, name) {
  safeArchiveName(name)
  const path = resolve(root, name)
  const rel = relative(root, path)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Source path escaped package: ${name}`)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular non-symlink file: ${name}`)
  return readFile(path)
}

async function validateSourcePaths() {
  const realPackageDir = await realpath(packageDir)
  const realRepoRoot = await realpath(resolve(packageDir, "../.."))
  const expectedPackageDir = resolve(realRepoRoot, "packages", "comate")
  const realPackagingDir = await realpath(packagingDir)
  if (realPackageDir !== expectedPackageDir || realPackagingDir !== resolve(realPackageDir, "packaging")) {
    throw new Error("Packaging sources must be regular files inside the maintained packages/comate checkout")
  }
}

async function writeAtomically(path, data) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temp, data, { flag: "wx", mode: 0o600 })
    try {
      await rename(temp, path)
    } catch (error) {
      // Node's rename replaces an existing file on POSIX. Some Windows file
      // systems require the old output to be removed first.
      if (!new Set(["EEXIST", "EPERM", "ENOTEMPTY"]).has(error?.code)) throw error
      await rm(path, { force: true })
      await rename(temp, path)
    }
  } finally {
    await rm(temp, { force: true })
  }
}

async function ensureOutputDirectory(path) {
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Output is not a real directory: ${path}`)
}

async function main() {
  if (basename(packageDir) !== "comate" || basename(dirname(packageDir)) !== "packages") {
    throw new Error("Run this builder from the maintained packages/comate checkout, not a temporary npm directory")
  }
  await validateSourcePaths()
  const { outDir, dryRun } = parseArgs(process.argv.slice(2))
  const payload = await Promise.all(payloadNames.map(async (name) => ({
    name: `payload/${name}`,
    data: await readRegularFile(packageDir, name),
    mode: 0o100644,
  })))
  const packageJson = JSON.parse(payload.find((entry) => entry.name === "payload/package.json").data.toString("utf8"))
  if (packageJson.name !== "@magpie-community/opencode-comate-auth" || packageJson.main !== "./index.mjs") {
    throw new Error("package.json does not identify the Comate OpenCode plugin")
  }
  if (typeof packageJson.version !== "string" || !semverPattern.test(packageJson.version)) {
    throw new Error("package.json version must be a strict semantic version before it can be used in archive names")
  }
  const runtimeFiles = ["index.mjs", "protocol.mjs", "discovery.mjs"]
  if (runtimeFiles.some((name) => !packageJson.files?.includes(name))) {
    throw new Error("package.json `files` must include every relative runtime import")
  }

  const installDoc = await readRegularFile(packageDir, "PACKAGING.md")
  const artifacts = []
  const summaries = []
  for (const installer of installers) {
    const scriptData = await readRegularFile(packagingDir, installer.name)
    const entries = [
      { name: "INSTALL.md", data: installDoc, mode: 0o100644 },
      ...payload,
      { name: installer.name, data: scriptData, mode: installer.mode },
    ]
    const manifest = archiveManifest(entries)
    const archive = zip([
      ...entries,
      { name: "SHA256SUMS.txt", data: manifest, mode: 0o100644 },
    ])
    const outputName = `comate-${packageJson.version}-${installer.platform}.zip`
    artifacts.push({ name: outputName, bytes: archive })
    summaries.push({
      archive: outputName,
      size: archive.length,
      sha256: sha256(archive),
      payload: payload.map(({ name, data }) => ({ path: name, size: data.length, sha256: sha256(data) })),
    })
  }
  const outerManifest = Buffer.from([...artifacts]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(({ name, bytes }) => `${sha256(bytes)}  ${name}\n`)
    .join(""), "utf8")

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, version: packageJson.version, outDir, artifacts: summaries, manifest: "SHA256SUMS.txt" }, null, 2))
    return
  }

  await ensureOutputDirectory(outDir)
  for (const artifact of artifacts) await writeAtomically(resolve(outDir, artifact.name), artifact.bytes)
  await writeAtomically(resolve(outDir, "SHA256SUMS.txt"), outerManifest)
  console.log(JSON.stringify({ dryRun: false, version: packageJson.version, outDir, artifacts: summaries, manifest: "SHA256SUMS.txt" }, null, 2))
}

main().catch((error) => {
  console.error(`Comate package build failed: ${error.message}`)
  process.exitCode = 1
})
