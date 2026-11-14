import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { syncSkills } from "./skill-sync.mjs"

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-skills-"))
  const source = path.join(root, "library/example")
  const staging = path.join(root, "staging")
  const target = path.join(root, "native")
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(staging)
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(source, "SKILL.md"), '---\n{"name":"example","description":"Read assets","metadata":{"version":"2.3.0"}}\n---\nOriginal instructions\n')
  fs.mkdirSync(path.join(source, "scripts"))
  fs.writeFileSync(path.join(source, "scripts/run.txt"), "original\n")
  fs.symlinkSync(source, path.join(staging, "example"), "junction")
  try { run({ source, staging, target }) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test("local metadata and linked resources leave Library files unchanged", () => fixture((paths) => {
  const original = fs.readFileSync(path.join(paths.source, "SKILL.md"), "utf8")
  syncSkills(paths, JSON.parse)
  const directory = path.join(paths.target, "example")
  const meta = JSON.parse(fs.readFileSync(path.join(directory, "meta.yaml")))
  assert.equal(meta["summary-en"], "Read assets")
  assert.equal(meta.version, "2.3.0")
  assert.equal(fs.existsSync(path.join(paths.source, "meta.yaml")), false)
  assert.equal(fs.readFileSync(path.join(paths.source, "SKILL.md"), "utf8"), original)
  assert.equal(fs.readFileSync(path.join(directory, "scripts/run.txt"), "utf8"), "original\n")
  syncSkills(paths, JSON.parse)
}))

test("source updates refresh display metadata and withdrawal removes only the projection", () => fixture((paths) => {
  syncSkills(paths, JSON.parse)
  const file = path.join(paths.source, "SKILL.md")
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Read assets", "Inspect assets"))
  syncSkills(paths, JSON.parse)
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.target, "example/meta.yaml")))["summary-en"], "Inspect assets")
  fs.unlinkSync(path.join(paths.staging, "example"))
  syncSkills(paths, JSON.parse)
  assert.equal(fs.existsSync(path.join(paths.target, "example")), false)
  assert.equal(fs.existsSync(file), true)
}))

test("preserves source metadata values and refuses to overwrite user-owned skills", () => fixture((paths) => {
  const original = '{"summary-cn":"原有说明","version":"9.1","creator":"User"}'
  fs.writeFileSync(path.join(paths.source, "meta.yaml"), original)
  syncSkills(paths, JSON.parse)
  const meta = JSON.parse(fs.readFileSync(path.join(paths.target, "example/meta.yaml")))
  assert.equal(meta["summary-cn"], "原有说明")
  assert.equal(meta.version, "9.1")
  assert.equal(meta.creator, "User")
  assert.equal(fs.readFileSync(path.join(paths.source, "meta.yaml"), "utf8"), original)
  fs.mkdirSync(path.join(paths.target, "mine"))
  fs.writeFileSync(path.join(paths.target, "notes.txt"), "user notes")
  fs.writeFileSync(path.join(paths.target, "mine/SKILL.md"), "mine")
  fs.symlinkSync(paths.source, path.join(paths.staging, "mine"), "junction")
  assert.throws(() => syncSkills(paths, JSON.parse), /already in use/)
  assert.equal(fs.readFileSync(path.join(paths.target, "mine/SKILL.md"), "utf8"), "mine")
  assert.equal(fs.readFileSync(path.join(paths.target, "notes.txt"), "utf8"), "user notes")
}))

test("preserves locally edited projections on update and withdrawal", () => fixture((paths) => {
  syncSkills(paths, JSON.parse)
  const file = path.join(paths.target, "example/meta.yaml")
  fs.writeFileSync(file, '{"summary-en":"Local edit"}')
  assert.throws(() => syncSkills(paths, JSON.parse), /local changes/)
  fs.unlinkSync(path.join(paths.staging, "example"))
  assert.throws(() => syncSkills(paths, JSON.parse), /local changes/)
  assert.equal(fs.readFileSync(file, "utf8"), '{"summary-en":"Local edit"}')
}))

test("migrates only an existing link to the selected Library source", () => fixture((paths) => {
  fs.symlinkSync(paths.source, path.join(paths.target, "example"), "junction")
  syncSkills(paths, JSON.parse)
  assert.equal(fs.lstatSync(path.join(paths.target, "example")).isDirectory(), true)
  assert.equal(fs.existsSync(path.join(paths.source, "meta.yaml")), false)
}))

test("a missing staging directory never withdraws existing projections", () => fixture((paths) => {
  syncSkills(paths, JSON.parse)
  syncSkills({ ...paths, staging: path.join(paths.staging, "missing") }, JSON.parse)
  assert.equal(fs.existsSync(path.join(paths.target, "example/SKILL.md")), true)
}))

test("native YAML reads folded descriptions and nested versions", {
  skip: typeof globalThis.Bun?.YAML?.parse !== "function",
}, () => fixture((paths) => {
  fs.writeFileSync(path.join(paths.source, "SKILL.md"), `---
name: example
description: >-
  Inspect project assets,
  keeping originals intact.
metadata:
  version: "3.4.0"
---
Original instructions
`)
  syncSkills(paths)
  const meta = JSON.parse(fs.readFileSync(path.join(paths.target, "example/meta.yaml")))
  assert.equal(meta["summary-en"], "Inspect project assets, keeping originals intact.")
  assert.equal(meta.version, "3.4.0")
}))
