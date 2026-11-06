import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { renderPageCatalog } from "../scripts/gen-page-catalog.mjs"

const appSource = readFileSync(new URL("../page/app.js", import.meta.url), "utf8")
const pageCatalogPath = new URL("../page/catalog.js", import.meta.url)
const ids = [
  "terse-prose",
  "less-code",
  "ponytail",
  "i-have-adhd",
  "terse-cjk",
  "antislop-ui",
  "antislop-copy",
]
const sampleCatalog = ids.map(id => ({
  id,
  label: `Label ${id}`,
  description: `Description ${id}`,
}))

class FakeElement {
  constructor(tagName, id = "") {
    this.tagName = tagName.toUpperCase()
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

  set textContent(value) {
    this._textContent = String(value)
    this.children = []
  }

  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join("")
  }

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
    for (const id of [
      "stylesForm", "stylesFieldset", "stylesList", "saveButton", "formMessage",
      "selectedCount", "catalogState", "statsState", "statRequests", "statApplied",
      "statSkipped", "statInjectedBytes", "styleStats",
    ]) this.nodes[id] = new FakeElement("div", id)
  }

  getElementById(id) { return this.nodes[id] || null }
  createElement(tagName) { return new FakeElement(tagName) }
  querySelector() { return null }
  get documentElement() { return this._root || (this._root = {}) }
}

const i18nSource = readFileSync(new URL("../page/i18n.js", import.meta.url), "utf8")

function fakeObserverClass() {
  return class FakeMutationObserver {
    constructor(callback) { this.callback = callback }
    observe() {}
    disconnect() {}
    takeRecords() { return [] }
  }
}

function descendants(root) {
  return [root, ...root.children.flatMap(descendants)]
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function boot({ catalog = sampleCatalog, stats, current, failGet = false } = {}) {
  const document = new FakeDocument()
  const writes = []
  const sandbox = {
    console,
    document,
    MutationObserver: fakeObserverClass(),
    magpie: {
      options: {
        get() {
          return failGet ? Promise.reject(new Error("read failed")) : Promise.resolve(current)
        },
        set(value) {
          writes.push(value)
          return Promise.resolve(value)
        },
      },
    },
  }
  if (catalog !== undefined) sandbox.OUTPUT_STRATEGY_CATALOG = catalog
  if (stats !== undefined) sandbox.__OUTPUT_STRATEGY_STATS__ = stats
  vm.createContext(sandbox)
  vm.runInContext(i18nSource, sandbox, { filename: "page/i18n.js" })
  vm.runInContext(appSource, sandbox, { filename: "page/app.js" })
  await settle()
  return { document, writes }
}

describe("generated page catalog", () => {
  test("is current and exposes only the agreed global metadata", () => {
    const source = readFileSync(pageCatalogPath, "utf8")
    expect(source).toBe(renderPageCatalog())
    expect(source.startsWith("globalThis.OUTPUT_STRATEGY_CATALOG = ")).toBe(true)
    expect(source).not.toContain("export ")

    const sandbox = {}
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    expect(Array.isArray(sandbox.OUTPUT_STRATEGY_CATALOG)).toBe(true)
    expect(sandbox.OUTPUT_STRATEGY_CATALOG).toHaveLength(7)
    for (const style of sandbox.OUTPUT_STRATEGY_CATALOG) {
      expect(Object.keys(style).sort()).toEqual(["description", "id", "label"])
      expect(style.prompt).toBeUndefined()
    }
  })
})

describe("page save flow", () => {
  test("loads options and saves the complete options and styles objects", async () => {
    const current = {
      autoClarity: false,
      telemetry: true,
      untouched: { nested: "keep" },
      styles: { "terse-prose": true, "future-style": true },
    }
    const stats = {
      requests: 12,
      applied: 8,
      skipped: 4,
      injectedBytes: 3456,
      styles: { "terse-prose": 5, ponytail: 2 },
    }
    const { document, writes } = await boot({ current, stats })
    const inputs = descendants(document.nodes.stylesList).filter(node => node.tagName === "INPUT")

    expect(inputs).toHaveLength(7)
    expect(inputs[0].checked).toBe(true)
    expect(inputs[1].checked).toBe(false)
    expect(document.nodes.statRequests.textContent).toBe("12")
    expect(document.nodes.statApplied.textContent).toBe("8")
    expect(document.nodes.statSkipped.textContent).toBe("4")
    expect(document.nodes.statInjectedBytes.textContent).toBe("3456")
    expect(document.nodes.styleStats.textContent).toContain("Label ponytail2")

    inputs[1].checked = true
    inputs[1].dispatch("change")
    expect(document.nodes.saveButton.disabled).toBe(false)
    const submit = document.nodes.stylesForm.dispatch("submit")
    await settle()

    expect(submit.defaultPrevented).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      ...current,
      styles: {
        "terse-prose": true,
        "future-style": true,
        "less-code": true,
        ponytail: false,
        "i-have-adhd": false,
        "terse-cjk": false,
        "antislop-ui": false,
        "antislop-copy": false,
      },
    })
    expect(writes[0]).not.toBe(current)
    expect(document.nodes.formMessage.textContent).toBe("已保存。")
    expect(document.nodes.saveButton.disabled).toBe(true)
  })

  test("renders without catalog or stats", async () => {
    const { document, writes } = await boot({ catalog: null, stats: undefined, current: { styles: {} } })
    expect(document.nodes.catalogState.textContent).toContain("目录未载入")
    expect(document.nodes.statsState.textContent).toContain("统计暂不可用")
    expect(document.nodes.stylesList.textContent).toContain("统计仍可使用")
    expect(document.nodes.statRequests.textContent).toBe("—")
    expect(writes).toHaveLength(0)
  })

  test("keeps controls disabled when options cannot be read", async () => {
    const { document, writes } = await boot({ current: {}, failGet: true })
    expect(document.nodes.formMessage.textContent).toContain("设置读取失败")
    expect(document.nodes.stylesFieldset.disabled).toBe(true)
    expect(document.nodes.saveButton.disabled).toBe(true)
    expect(writes).toHaveLength(0)
  })
})

describe("page i18n", () => {
  test("zh mode translates catalog English and leaves Chinese untouched", () => {
    const source = readFileSync(new URL("../page/i18n.js", import.meta.url), "utf8")
    const sandbox = { document: undefined, localStorage: undefined }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)
    const i18n = sandbox.OutputStrategyI18n
    expect(i18n).toBeTruthy()
    expect(i18n.lang).toBe("zh")

    const zh = ["输出策略", "样式组合", "{n} 种样式，按目录顺序注入。"]
    for (const text of zh) {
      expect(i18n.t(text)).toBe(text)
    }

    const labels = ["Terse prose", "Less code", "Ponytail (lazy senior dev)", "I have ADHD (action-first)", "Terse CJK (文言)", "Antislop UI filter", "Antislop copy and human filter"]
    for (const label of labels) {
      const zhLabel = i18n.t(label)
      expect(typeof zhLabel).toBe("string")
      expect(zhLabel.length).toBeGreaterThan(0)
      expect(zhLabel).not.toBe(label)
    }
  })

  test("observer callbacks do not re-trigger themselves", () => {
    const observers = []
    class FakeMutationObserver {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe() {}
      disconnect() {}
      takeRecords() { return [] }
    }

    function makeElement(tag, parent) {
      const node = {
        nodeType: 1,
        tagName: tag,
        attributes: {},
        childNodes: [],
        parentNode: parent || null,
        get firstChild() { return this.childNodes[0] || null },
        get nextSibling() {
          if (!this.parentNode) return null
          const siblings = this.parentNode.childNodes
          return siblings[siblings.indexOf(this) + 1] || null
        },
        getAttribute(name) { return name in this.attributes ? this.attributes[name] : null },
        setAttribute(name, value) { this.attributes[name] = String(value) },
        hasAttribute(name) { return name in this.attributes },
        append(node) { node.parentNode = this; this.childNodes.push(node); return node },
      }
      return node
    }

    const body = makeElement("BODY")
    const text = {
      nodeType: 3,
      nodeValue: "Terse prose",
      parentNode: body,
      get nextSibling() {
        const siblings = this.parentNode.childNodes
        return siblings[siblings.indexOf(this) + 1] || null
      },
    }
    const toggle = makeElement("BUTTON", body)
    toggle.setAttribute("aria-label", "Switch to English")
    toggle.setAttribute("title", "Switch to English")
    body.childNodes.push(text, toggle)

    const document = {
      body,
      documentElement: {},
      querySelector() { return null },
      createElement(tag) { return makeElement(tag.toUpperCase()) },
    }
    const sandbox = { document, MutationObserver: FakeMutationObserver }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    vm.runInContext(readFileSync(new URL("../page/i18n.js", import.meta.url), "utf8"), sandbox)
    const i18n = sandbox.OutputStrategyI18n

    expect(text.nodeValue).toBe("精简散文")
    expect(toggle.getAttribute("aria-label")).toBe("切换到英文")

    // The observer only runs in en mode (zh renders through t()), so switch
    // first and then prove its callbacks cannot re-trigger themselves.
    i18n.setLang("en")
    expect(text.nodeValue).toBe("Terse prose")
    expect(toggle.getAttribute("aria-label")).toBe("Switch to English")

    const observer = observers[0]
    expect(observer).toBeTruthy()
    for (let i = 0; i < 5; i++) {
      observer.callback([
        { type: "characterData", target: text },
        { type: "attributes", target: toggle },
      ])
    }
    expect(text.nodeValue).toBe("Terse prose")
    expect(toggle.getAttribute("aria-label")).toBe("Switch to English")

    i18n.setLang("zh")
    expect(text.nodeValue).toBe("精简散文")
    expect(toggle.getAttribute("aria-label")).toBe("切换到英文")
    expect(toggle.getAttribute("aria-label")).toBe("切换到英文")
  })
})
