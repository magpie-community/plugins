// English source strings, localized from magpie.theme.lang.
// No page-local language preference or storage.
(function () {
  "use strict"

  var ZH = {
    "Output Strategy": "输出策略",
    "Inject selected writing rules into model requests. Combine freely; all off by default.": "把选中的写作规则注入模型请求。可自由组合，全部默认关闭。",
    "selected": "已选择",
    "Style combinations": "样式组合",
    "Reading catalog…": "正在读取目录…",
    "Choose output styles to inject": "选择要注入的输出样式",
    "Save changes": "保存更改",
    "Saving…": "正在保存…",
    "Reading settings…": "正在读取设置…",
    "Pick styles and save.": "选择样式后保存。",
    "Unsaved changes.": "有未保存的更改。",
    "Saved.": "已保存。",
    "Could not save. Nothing was written; try again.": "保存失败。更改尚未写入，请重试。",
    "Could not read settings; reopen the page.": "设置读取失败，请重新打开页面。",
    "Configuration bridge unavailable; view only.": "配置桥接不可用，当前只能查看。",
    "Catalog not loaded; style toggles unavailable.": "目录未载入，样式开关暂不可用。",
    "Catalog not loaded": "目录未载入",
    "Catalog not loaded; styles cannot be changed.": "目录未载入，无法更改样式。",
    "{n} styles; injected in catalog order.": "{n} 种样式，按目录顺序注入。",
    "JavaScript is required to change styles.": "需要启用 JavaScript 才能更改样式。",
    "Terse prose": "精简散文",
    "Less code": "更少代码",
    "Ponytail (lazy senior dev)": "马尾辫（懒惰资深开发）",
    "I have ADHD (action-first)": "我有 ADHD（行动优先）",
    "Terse CJK (文言)": "文言精简",
    "Antislop UI filter": "反模板 UI",
    "Antislop copy and human filter": "反 AI 腔文案",
    "Drop filler/articles/hedging; keep technical substance exact.": "删客套、填充词、含糊表达；技术内容一字不动。",
    "YAGNI ladder: smallest working change, no unrequested abstractions.": "YAGNI 阶梯：最小可用改动，不做没人要的抽象。",
    "Lazy senior-dev discipline: climb the YAGNI ladder, fix root cause, smallest working diff.": "懒惰资深开发纪律：走 YAGNI 阶梯，修根因，最小完整 diff。",
    "Action-first output: next action leads, steps numbered, one concrete next step, no preamble.": "行动优先：下一步动作打头，步骤编号，单一明确的后续动作，无开场白。",
    "Classical-Chinese ultra-terse style.": "文言文级精简，技术标识照原样保留。",
    "Purpose-tested visuals: no generic gradients, template layouts or dead controls.": "视觉必须过目的测试：不要通用渐变、模板布局、死控件。",
    "Honest copy plus people rules: no AI tells, WCAG AA contrast, keyboard, states, mobile reflow.": "诚实文案加真人规则：无 AI 腔，WCAG AA 对比度，键盘可达，状态完整，移动端重排。",
  }

  function normalize(value) {
    var lower = String(value || "").toLowerCase()
    return lower === "zh" || lower === "zh-cn" || lower === "zh-hans" ? "zh" : "en"
  }

  function languageTag(value) {
    var lower = String(value || "").toLowerCase()
    if (lower === "zh-tw" || lower === "zh-hant") return "zh-TW"
    return lang === "zh" ? "zh-CN" : "en"
  }

  var lang = "en"
  var listeners = []
  var sourceText = typeof WeakMap === "undefined" ? null : new WeakMap()
  var translatedText = typeof WeakMap === "undefined" ? null : new WeakMap()

  function translate(root) {
    if (!root) return
    if (root.nodeType === 3) {
      if (sourceText && translatedText && root.nodeValue !== translatedText.get(root)) {
        sourceText.delete(root)
      }
      var text = sourceText ? sourceText.get(root) : root.nodeValue
      if (text === undefined) {
        text = root.nodeValue
        if (sourceText) sourceText.set(root, text)
      }
      var trimmed = text.trim()
      var next = lang === "zh" && ZH[trimmed] ? text.replace(trimmed, ZH[trimmed]) : text
      if (translatedText) translatedText.set(root, next)
      root.nodeValue = next
      return
    }
    if (root.nodeType !== 1 || root.tagName === "SCRIPT" || root.tagName === "STYLE") return
    var child = root.firstChild
    while (child) {
      translate(child)
      child = child.nextSibling
    }
  }

  function applyTheme(theme) {
    lang = normalize(theme && theme.lang)
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = languageTag(theme.lang)
      document.title = lang === "zh" ? "输出策略" : "Output Strategy"
      translate(document.body)
    }
    listeners.forEach(function (listener) { listener(lang) })
  }

  globalThis.OutputStrategyI18n = {
    get lang() { return lang },
    t: function (text) { return lang === "zh" ? ZH[text] || text : text },
    onChange: function (listener) {
      if (typeof listener === "function") listeners.push(listener)
    },
  }

  var host = globalThis.magpie
  if (host) {
    if (host.theme) applyTheme(host.theme)
    if (host.ready && typeof host.ready.then === "function") host.ready.then(applyTheme).catch(function () {})
    if (typeof host.onTheme === "function") host.onTheme(applyTheme)
  }
})()
