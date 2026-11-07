import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { renderPageCatalog } from "../scripts/gen-page-catalog.mjs"

const appSource = readFileSync(new URL("../page/app.js", import.meta.url), "utf8")
const i18nSource = readFileSync(new URL("../page/i18n.js", import.meta.url), "utf8")
const ids = ["terse-prose", "less-code", "ponytail", "i-have-adhd", "terse-cjk", "antislop-ui", "antislop-copy"]
const sampleCatalog = ids.map(id => ({ id, label: `Label ${id}`, description: `Description ${id}` }))

class FakeElement {
  constructor(tagName, id = "") {
    this.tagName = tagName.toUpperCase()
    this.nodeType = 1
    this.id = id
    this.children = []
    this.parentNode = null
    this.attributes = {}
    this.listeners = {}
    this.className = ""
    this.disabled = false
    this.checked = false
    this.type = ""
    this.name = ""
    this._textContent = ""
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this
      this.children.push(node)
    }
  }
  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index !== -1) this.children.splice(index, 1)
    node.parentNode = null
    return node
  }
  get firstChild() { return this.children[0] || null }
  get nextSibling() {
    const siblings = this.parentNode ? this.parentNode.children : []
    return siblings[siblings.indexOf(this) + 1] || null
  }
  set textContent(value) {
    this._textContent = String(value)
    this.children = []
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join("") }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(listener)
  }
  dispatch(type) {
    const event = { preventDefault() { this.defaultPrevented = true }, defaultPrevented: false }
    for (const listener of this.listeners[type] || []) listener(event)
    return event
  }
}

class FakeDocument {
  constructor() {
    this.nodes = {}
    this.documentElement = {}
    for (const id of ["stylesForm", "stylesFieldset", "stylesList", "saveButton", "formMessage", "selectedCount", "catalogState"]) {
      this.nodes[id] = new FakeElement("div", id)
    }
  }
  getElementById(id) { return this.nodes[id] || null }
  createElement(tagName) { return new FakeElement(tagName) }
}

function descendants(root) { return [root, ...root.children.flatMap(descendants)] }
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function boot({ catalog = sampleCatalog, current, lang = "en", failGet = false } = {}) {
  const document = new FakeDocument()
  const writes = []
  let onTheme
  const sandbox = {
    console,
    document,
    magpie: {
      theme: { lang },
      ready: Promise.resolve({ lang }),
      onTheme(callback) { onTheme = callback },
      options: {
        get() { return failGet ? Promise.reject(new Error("read failed")) : Promise.resolve(current) },
        set(value) { writes.push(value); return Promise.resolve(value) },
      },
    },
  }
  if (catalog !== undefined) sandbox.OUTPUT_STRATEGY_CATALOG = catalog
  vm.createContext(sandbox)
  vm.runInContext(i18nSource, sandbox, { filename: "page/i18n.js" })
  vm.runInContext(appSource, sandbox, { filename: "page/app.js" })
  await settle()
  return { document, writes, setLang(value) { onTheme({ lang: value }) } }
}

describe("generated page catalog", () => {
  test("is current and exposes only style metadata", () => {
    const source = readFileSync(new URL("../page/catalog.js", import.meta.url), "utf8")
    expect(source).toBe(renderPageCatalog())
    const sandbox = {}
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    expect(sandbox.OUTPUT_STRATEGY_CATALOG).toHaveLength(7)
    for (const style of sandbox.OUTPUT_STRATEGY_CATALOG) {
      expect(Object.keys(style).sort()).toEqual(["description", "id", "label"])
      expect(style.prompt).toBeUndefined()
    }
  })
})

describe("page save flow", () => {
  test("loads and saves complete options without inventing telemetry", async () => {
    const current = { untouched: { nested: "keep" }, styles: { "terse-prose": true, "future-style": true } }
    const { document, writes } = await boot({ current })
    const inputs = descendants(document.nodes.stylesList).filter(node => node.tagName === "INPUT")
    expect(inputs).toHaveLength(7)
    expect(inputs[0].checked).toBe(true)
    expect(inputs[1].checked).toBe(false)
    inputs[1].checked = true
    inputs[1].dispatch("change")
    const submit = document.nodes.stylesForm.dispatch("submit")
    await settle()
    expect(submit.defaultPrevented).toBe(true)
    expect(writes).toEqual([{
      ...current,
      styles: {
        "terse-prose": true, "future-style": true, "less-code": true,
        ponytail: false, "i-have-adhd": false, "terse-cjk": false,
        "antislop-ui": false, "antislop-copy": false,
      },
    }])
    expect(document.nodes.formMessage.textContent).toBe("Saved.")
    expect(document.nodes.saveButton.disabled).toBe(true)
  })

  test("renders without catalog and fails closed for editing", async () => {
    const { document, writes } = await boot({ catalog: null, current: { styles: {} }, failGet: true })
    expect(document.nodes.catalogState.textContent).toBe("Catalog not loaded")
    expect(document.nodes.formMessage.textContent).toBe("Could not read settings; reopen the page.")
    expect(document.nodes.stylesFieldset.disabled).toBe(true)
    expect(document.nodes.saveButton.disabled).toBe(true)
    expect(writes).toHaveLength(0)
  })
})

describe("host language", () => {
  test("uses magpie.theme.lang and follows changes without a toggle", async () => {
    const { document, setLang } = await boot({ current: { styles: {} }, lang: "zh-CN" })
    expect(document.documentElement.lang).toBe("zh-CN")
    expect(document.nodes.saveButton.textContent).toBe("保存更改")
    expect(document.nodes.formMessage.textContent).toBe("选择样式后保存。")
    setLang("en")
    expect(document.documentElement.lang).toBe("en")
    expect(document.nodes.saveButton.textContent).toBe("Save changes")
    expect(document.nodes.formMessage.textContent).toBe("Pick styles and save.")
    setLang("zh-TW")
    expect(document.documentElement.lang).toBe("zh-TW")
    expect(document.nodes.saveButton.textContent).toBe("Save changes")
  })

  test("preserves unsaved choices when host language changes", async () => {
    const { document, setLang } = await boot({ current: { styles: {} }, lang: "en" })
    const before = descendants(document.nodes.stylesList).filter(node => node.tagName === "INPUT")
    before[0].checked = true
    before[0].dispatch("change")
    setLang("zh-CN")
    setLang("en")
    const after = descendants(document.nodes.stylesList).filter(node => node.tagName === "INPUT")
    expect(after[0].checked).toBe(true)
    expect(document.nodes.saveButton.disabled).toBe(false)
    expect(document.nodes.formMessage.textContent).toBe("Unsaved changes.")
  })

  test("translates static English text to Chinese and back to its original text", () => {
    const body = new FakeElement("body")
    const text = { nodeType: 3, nodeValue: "Output Strategy", parentNode: body }
    body.append(text)
    const document = { documentElement: {}, body }
    let repaint
    const sandbox = { document, magpie: { theme: { lang: "zh" }, onTheme(callback) { repaint = callback } } }
    vm.createContext(sandbox)
    vm.runInContext(i18nSource, sandbox)
    expect(text.nodeValue).toBe("输出策略")
    repaint({ lang: "en" })
    expect(text.nodeValue).toBe("Output Strategy")
  })

  test("ships English HTML and no private stats or local language switch", () => {
    const html = readFileSync(new URL("../page/index.html", import.meta.url), "utf8")
    expect(html).toContain('<html lang="en">')
    expect(html).not.toContain("stats.js")
    expect(html).not.toContain("lang-toggle")
    expect(appSource).not.toContain("__OUTPUT_STRATEGY_STATS__")
    expect(i18nSource).not.toContain("localStorage")
    expect(i18nSource).not.toContain("data-lang-toggle")
  })
})
