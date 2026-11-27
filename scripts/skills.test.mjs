import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..", "skills")

// A skill's frontmatter is read by strict YAML loaders too: pi refused
// magpie-api's plain description, whose "magpie: choosing" opened a mapping
// (#1621). Parse each one strictly, and check the two fields an agent reads.
test("every skill's frontmatter is valid YAML with a name and a description (#1621)", () => {
  const names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  expect(names.length).toBeGreaterThan(0)
  for (const name of names) {
    const text = readFileSync(join(root, name, "SKILL.md"), "utf8")
    const m = text.match(/^---\n([\s\S]*?)\n---\n/)
    expect(m, name).not.toBeNull()
    let front
    try {
      front = Bun.YAML.parse(m[1])
    } catch (e) {
      throw new Error(`skills/${name}/SKILL.md: ${e.message}`)
    }
    expect(front.name, name).toBe(name)
    expect(typeof front.description, name).toBe("string")
    expect(front.description.length, name).toBeGreaterThan(20)
  }
})
