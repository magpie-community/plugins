// page/i18n.js — language toggle for the Output Strategy page.
// Default is Chinese; the toggle switches UI chrome and style labels between
// zh and en. Style descriptions come from catalog.js in English, so this file
// carries their Chinese equivalents. The iframe is sandboxed to allow-scripts
// (no allow-same-origin), so localStorage throws and the choice cannot be
// persisted; it resets to Chinese on reload, mirroring compress-core.
(function () {
  "use strict"

  var KEY = "output-strategy.lang"

  function normalize(value) {
    value = String(value || "").toLowerCase()
    return value.indexOf("zh") === 0 ? "zh" : "en"
  }

  function saved() {
    try {
      return localStorage.getItem(KEY)
    } catch (err) {
      return null
    }
  }

  var initial = saved()
  var lang = normalize(initial || "zh")

  // zh source is the static HTML and app.js strings; en source is the
  // catalog labels. Both directions are mapped so a node can be swapped
  // either way and restored on toggle back.
  var TEXT_EN = {
    "输出策略": "Output Strategy",
    "把选中的写作规则注入模型请求。可自由组合，全部默认关闭。": "Inject selected writing rules into model requests. Combine freely; all off by default.",
    "已选择": "selected",
    "样式组合": "Style combinations",
    "正在读取目录…": "Reading catalog…",
    "本地统计": "Local statistics",
    "只计数，不保存请求或回答内容。": "Counts only; request and answer bodies are never stored.",
    "各样式次数": "Style usage",
    "保存更改": "Save changes",
    "正在保存…": "Saving…",
    "正在读取设置…": "Reading settings…",
    "选择样式后保存。": "Pick styles and save.",
    "有未保存的更改。": "Unsaved changes.",
    "已保存。": "Saved.",
    "保存失败。更改尚未写入，请重试。": "Could not save. Nothing was written; try again.",
    "设置读取失败，请重新打开页面。": "Could not read settings; reopen the page.",
    "配置桥接不可用，当前只能查看。": "Configuration bridge unavailable; view only.",
    "目录未载入。样式开关暂不可用，统计仍可使用。": "Catalog not loaded; style toggles unavailable, statistics still work.",
    "目录未载入": "Catalog not loaded",
    "目录未载入，无法更改样式。": "Catalog not loaded; styles cannot be changed.",
    "正在读取目录": "Reading catalog",
    "目录未载入。样式开关暂不可用": "Catalog not loaded; style toggles unavailable",
    "统计仍可使用": "statistics still work",
    "种样式，按目录顺序注入。": " styles; injected in catalog order.",
    "还没有样式注入记录。": "No style injections recorded yet.",
    "暂无样式统计。": "No style statistics.",
    "统计暂不可用；样式设置仍可使用。": "Statistics unavailable; style settings still work.",
    "统计暂不可用": "Statistics unavailable",
    "样式设置仍可使用": "style settings still work",
    "数据仅保存在本机。": "Data stays on this machine.",
    "需要启用 JavaScript 才能更改样式。": "JavaScript is required to change styles.",
    "选择要注入的输出样式": "Choose output styles to inject",
    "{n} 种样式，按目录顺序注入。": "{n} styles; injected in catalog order.",
    // reverse of the style labels/descriptions so zh -> en restores them
    "精简散文": "Terse prose",
    "更少代码": "Less code",
    "马尾辫（懒惰资深开发）": "Ponytail (lazy senior dev)",
    "我有 ADHD（行动优先）": "I have ADHD (action-first)",
    "文言精简": "Terse CJK (文言)",
    "反模板 UI": "Antislop UI filter",
    "反 AI 腔文案": "Antislop copy and human filter",
    "删客套、填充词、含糊表达；技术内容一字不动。": "Drop filler/articles/hedging; keep technical substance exact.",
    "YAGNI 阶梯：最小可用改动，不做没人要的抽象。": "YAGNI ladder: smallest working change, no unrequested abstractions.",
    "懒惰资深开发纪律：走 YAGNI 阶梯，修根因，最小完整 diff。": "Lazy senior-dev discipline: climb the YAGNI ladder, fix root cause, smallest working diff.",
    "行动优先：下一步动作打头，步骤编号，单一明确的后续动作，无开场白。": "Action-first output: next action leads, steps numbered, one concrete next step, no preamble.",
    "文言文级精简，技术标识照原样保留。": "Classical-Chinese ultra-terse style.",
    "视觉必须过目的测试：不要通用渐变、模板布局、死控件。": "Purpose-tested visuals: no generic gradients, template layouts or dead controls.",
    "诚实文案加真人规则：无 AI 腔，WCAG AA 对比度，键盘可达，状态完整，移动端重排。": "Honest copy plus people rules: no AI tells, WCAG AA contrast, keyboard, states, mobile reflow.",
  }

  // Static-HTML zh strings that end in a number need special handling below
  // (see translateTextNode); the map above covers the rest.
  var TEXT_ZH = {
    "Output Strategy": "输出策略",
    "Inject selected writing rules into model requests. Combine freely; all off by default.": "把选中的写作规则注入模型请求。可自由组合，全部默认关闭。",
    "selected": "已选择",
    "Style combinations": "样式组合",
    "Reading catalog…": "正在读取目录…",
    "Local statistics": "本地统计",
    "Counts only; request and answer bodies are never stored.": "只计数，不保存请求或回答内容。",
    "Style usage": "各样式次数",
    "Save changes": "保存更改",
    "Saving…": "正在保存…",
    "Reading settings…": "正在读取设置…",
    "Pick styles and save.": "选择样式后保存。",
    "Unsaved changes.": "有未保存的更改。",
    "Saved.": "已保存。",
    "Could not save. Nothing was written; try again.": "保存失败。更改尚未写入，请重试。",
    "Could not read settings; reopen the page.": "设置读取失败，请重新打开页面。",
    "Configuration bridge unavailable; view only.": "配置桥接不可用，当前只能查看。",
    "Catalog not loaded; style toggles unavailable, statistics still work.": "目录未载入。样式开关暂不可用，统计仍可使用。",
    "Catalog not loaded": "目录未载入",
    "Catalog not loaded; styles cannot be changed.": "目录未载入，无法更改样式。",
    "Styles inject in catalog order.": "按目录顺序注入。",
    "No style injections recorded yet.": "还没有样式注入记录。",
    "No style statistics.": "暂无样式统计。",
    "Statistics unavailable; style settings still work.": "统计暂不可用；样式设置仍可使用。",
    "Data stays on this machine.": "数据仅保存在本机。",
    "JavaScript is required to change styles.": "需要启用 JavaScript 才能更改样式。",
    "Choose output styles to inject": "选择要注入的输出样式",
    "{n} styles; injected in catalog order.": "{n} 种样式，按目录顺序注入。",
    // style labels
    "Terse prose": "精简散文",
    "Less code": "更少代码",
    "Ponytail (lazy senior dev)": "马尾辫（懒惰资深开发）",
    "I have ADHD (action-first)": "我有 ADHD（行动优先）",
    "Terse CJK (文言)": "文言精简",
    "Antislop UI filter": "反模板 UI",
    "Antislop copy and human filter": "反 AI 腔文案",
    // style descriptions
    "Drop filler/articles/hedging; keep technical substance exact.": "删客套、填充词、含糊表达；技术内容一字不动。",
    "YAGNI ladder: smallest working change, no unrequested abstractions.": "YAGNI 阶梯：最小可用改动，不做没人要的抽象。",
    "Lazy senior-dev discipline: climb the YAGNI ladder, fix root cause, smallest working diff.": "懒惰资深开发纪律：走 YAGNI 阶梯，修根因，最小完整 diff。",
    "Action-first output: next action leads, steps numbered, one concrete next step, no preamble.": "行动优先：下一步动作打头，步骤编号，单一明确的后续动作，无开场白。",
    "Classical-Chinese ultra-terse style.": "文言文级精简，技术标识照原样保留。",
    "Purpose-tested visuals: no generic gradients, template layouts or dead controls.": "视觉必须过目的测试：不要通用渐变、模板布局、死控件。",
    "Honest copy plus people rules: no AI tells, WCAG AA contrast, keyboard, states, mobile reflow.": "诚实文案加真人规则：无 AI 腔，WCAG AA 对比度，键盘可达，状态完整，移动端重排。",
  }

  var ATTR_ZH = {
    "Switch to Chinese": "切换到中文",
    "Switch to English": "切换到英文",
  }

  var ATTR_EN = {
    "切换到中文": "Switch to Chinese",
    "切换到英文": "Switch to English",
  }

  var originals = new WeakMap()
  var lastRendered = new WeakMap()
  var attrOriginals = new WeakMap()
  var observer = null
  var listeners = []

  function excluded(node) {
    var el = node.nodeType === 1 ? node : node.parentNode
    while (el && el !== document.body) {
      if (el.hasAttribute && el.hasAttribute("data-no-i18n")) return true
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "TEXTAREA" || el.tagName === "PRE" || el.tagName === "CODE") return true
      el = el.parentNode
    }
    return false
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3 || excluded(node)) return

    // Keep the original text once, then always compute the target from it.
    // Never "restore then re-translate": that made the observer rewrite its
    // own writes and loop forever.
    var rendered = lastRendered.get(node)
    if (rendered !== undefined && node.nodeValue !== rendered) {
      originals.delete(node)
      lastRendered.delete(node)
    }
    if (!originals.has(node)) originals.set(node, node.nodeValue)
    var source = originals.get(node)
    var trimmed = source.trim()
    if (!trimmed) return

    var map = lang === "zh" ? TEXT_ZH : TEXT_EN
    var replacement = map[trimmed]
    if (replacement === undefined) replacement = trimmed
    var start = source.indexOf(trimmed)
    var next = source.slice(0, start) + replacement + source.slice(start + trimmed.length)
    lastRendered.set(node, next)
    if (node.nodeValue !== next) node.nodeValue = next
  }

  function translateAttrs(el) {
    if (!el || el.nodeType !== 1) return
    if (excluded(el)) return
    if (!attrOriginals.has(el)) attrOriginals.set(el, {})
    var savedAttrs = attrOriginals.get(el)
    ;["title", "placeholder", "aria-label"].forEach(function (name) {
      var value = el.getAttribute(name)
      if (value == null || !value.trim()) return
      var entry = savedAttrs[name]
      if (entry && value !== entry.last) {
        // Someone else wrote this attribute; treat the new value as source.
        delete savedAttrs[name]
        entry = undefined
      }
      if (!entry) entry = savedAttrs[name] = { source: value }
      var map = lang === "zh" ? ATTR_ZH : ATTR_EN
      var replacement = map[entry.source.trim()]
      if (replacement === undefined) replacement = entry.source
      entry.last = replacement
      if (value !== replacement) el.setAttribute(name, replacement)
    })
  }

  function walk(root) {
    if (!root || excluded(root)) return
    if (root.nodeType === 3) {
      translateTextNode(root)
      return
    }
    if (root.nodeType !== 1) return
    translateAttrs(root)
    var child = root.firstChild
    while (child) {
      walk(child)
      child = child.nextSibling
    }
  }

  function apply(root) {
    var target = root || document.body
    if (!target) return
    if (document.documentElement) document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"
    walk(target)
    var toggle = document.querySelector("[data-lang-toggle]")
    if (toggle) {
      toggle.textContent = lang === "zh" ? "EN" : "中文"
      toggle.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "Switch to Chinese")
      toggle.setAttribute("title", lang === "zh" ? "Switch to English" : "Switch to Chinese")
    }
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect()
      observer = null
    }
  }

  function startObserver() {
    if (observer || typeof MutationObserver === "undefined" || !document.body) return
    observer = new MutationObserver(function (records) {
      if (lang !== "en") return
      records.forEach(function (record) {
        if (record.type === "characterData") translateTextNode(record.target)
        else if (record.type === "attributes") translateAttrs(record.target)
        else if (record.type === "childList") {
          for (var i = 0; i < record.addedNodes.length; i++) walk(record.addedNodes[i])
        }
      })
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["title", "placeholder", "aria-label"],
    })
  }

  function setLang(next) {
    var value = normalize(next)
    if (value === lang) return
    lang = value
    try { localStorage.setItem(KEY, lang) } catch (err) { /* sandboxed iframe */ }
    stopObserver()
    apply(document.body)
    if (lang === "en") startObserver()
    listeners.forEach(function (fn) {
      try { fn(lang) } catch (err) { /* a listener must not break the toggle */ }
    })
  }

  function toggle() {
    setLang(lang === "zh" ? "en" : "zh")
  }

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("storage", function (event) {
      if (event && event.key === KEY && event.newValue) setLang(event.newValue)
    })
  }

  function makeToggle() {
    var host = document.querySelector(".lang-row")
    if (!host) return
    var btn = document.createElement("button")
    btn.type = "button"
    btn.className = "lang-toggle"
    btn.setAttribute("data-lang-toggle", "")
    btn.textContent = lang === "zh" ? "EN" : "中文"
    btn.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "Switch to Chinese")
    btn.setAttribute("title", lang === "zh" ? "Switch to English" : "Switch to Chinese")
    btn.addEventListener("click", toggle)
    host.append(btn)
  }

  globalThis.OutputStrategyI18n = {
    get lang() { return lang },
    isZh: function () { return lang === "zh" },
    normalize: normalize,
    setLang: setLang,
    toggle: toggle,
    apply: apply,
    onChange: function (fn) {
      if (typeof fn === "function") listeners.push(fn)
    },
    t: function (text) {
      var trimmed = String(text || "").trim()
      if (lang === "zh") return TEXT_ZH[trimmed] || text
      return TEXT_EN[trimmed] || text
    },
  }

  if (typeof document !== "undefined") {
    makeToggle()
    apply(document.body)
    if (lang === "en") startObserver()
  }
})()
