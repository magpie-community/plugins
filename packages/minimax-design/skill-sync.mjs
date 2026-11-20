import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const marker = ".magpie-design-skill.json"

function skillMetadata(source, parseYaml) {
  const content = fs.readFileSync(path.join(source, "SKILL.md"), "utf8")
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  const fields = frontmatter ? parseYaml(frontmatter[1]) ?? {} : {}
  const file = path.join(source, "meta.yaml")
  const existing = fs.existsSync(file) ? parseYaml(fs.readFileSync(file, "utf8")) ?? {} : {}
  if ([fields, existing].some((value) => typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`Invalid Design skill metadata: ${source}`)
  }
  const description = typeof fields.description === "string" ? fields.description.trim() : ""
  const result = { ...fields }
  delete result.metadata
  if (!result["summary-en"] && !result.summary && description) result["summary-en"] = description
  if (!result.version && fields.metadata?.version !== undefined) result.version = String(fields.metadata.version)
  return JSON.stringify({ ...result, ...existing }, null, 2) + "\n"
}

function readOwnership(directory) {
  const record = JSON.parse(fs.readFileSync(path.join(directory, marker), "utf8"))
  if (record.owner !== "magpie-minimax-design") throw new Error(`Invalid Design skill ownership: ${directory}`)
  return record
}

function assertOwned(directory, record) {
  const entries = fs.readdirSync(directory).filter((name) => name !== marker).sort()
  if (JSON.stringify(entries) !== JSON.stringify(Object.keys(record.files).sort())) {
    throw new Error(`Design skill has local changes: ${directory}`)
  }
  for (const [name, value] of Object.entries(record.files)) {
    const file = path.join(directory, name)
    const entry = fs.lstatSync(file)
    const unchanged = name === "meta.yaml"
      ? entry.isFile() && fs.readFileSync(file, "utf8") === value
      : entry.isSymbolicLink() && fs.readlinkSync(file) === value
    if (!unchanged) throw new Error(`Design skill has local changes: ${file}`)
  }
}

export function syncSkills({ staging, target }, parseYaml = globalThis.Bun?.YAML?.parse) {
  if (!fs.existsSync(staging)) return
  if (typeof parseYaml !== "function") throw new Error("Design skill projection requires a YAML parser.")
  fs.mkdirSync(target, { recursive: true })
  const selected = new Map()
  for (const name of fs.readdirSync(staging)) {
    const entry = path.join(staging, name)
    if (!fs.existsSync(path.join(entry, "SKILL.md"))) continue
    selected.set(name, fs.realpathSync(entry))
  }
  for (const name of fs.readdirSync(target)) {
    const directory = path.join(target, name)
    if (!fs.lstatSync(directory).isDirectory()) continue
    const ownership = path.join(directory, marker)
    if (!fs.existsSync(ownership)) continue
    const record = readOwnership(directory)
    if (selected.has(name)) continue
    assertOwned(directory, record)
    fs.rmSync(directory, { recursive: true })
  }
  for (const [name, source] of selected) {
    const directory = path.join(target, name)
    const files = { "meta.yaml": skillMetadata(source, parseYaml) }
    for (const child of fs.readdirSync(source)) {
      if (child === "meta.yaml" || child === marker || child === ".magpie-library") continue
      files[child] = path.join(source, child)
    }
    const existing = fs.lstatSync(directory, { throwIfNoEntry: false })
    if (existing) {
      if (existing.isSymbolicLink()) {
        if (fs.realpathSync(directory) !== source) throw new Error(`Design skill name is already in use: ${directory}`)
      } else {
        const ownership = path.join(directory, marker)
        if (!existing.isDirectory() || !fs.existsSync(ownership)) throw new Error(`Design skill name is already in use: ${directory}`)
        const record = readOwnership(directory)
        assertOwned(directory, record)
        if (JSON.stringify(record.files) === JSON.stringify(files)) continue
      }
    }
    const temporary = path.join(target, `.${name}.${randomUUID()}.__tmp_extract__`)
    const previous = `${temporary}.previous`
    fs.mkdirSync(temporary)
    try {
      for (const [child, value] of Object.entries(files)) {
        const file = path.join(temporary, child)
        if (child === "meta.yaml") fs.writeFileSync(file, value)
        else fs.symlinkSync(value, file, fs.statSync(value).isDirectory() ? "junction" : "file")
      }
      fs.writeFileSync(path.join(temporary, marker), JSON.stringify({
        owner: "magpie-minimax-design", source, files,
      }, null, 2) + "\n")
      if (existing) fs.renameSync(directory, previous)
      try {
        fs.renameSync(temporary, directory)
      } catch (error) {
        if (existing) fs.renameSync(previous, directory)
        throw error
      }
      if (existing) fs.rmSync(previous, { recursive: !existing.isSymbolicLink() })
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }
}
