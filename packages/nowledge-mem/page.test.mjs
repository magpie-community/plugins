import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { onRequest, reset } from "./nowledge-mem.hooks.mjs"

test("the shared validator remains available after its module is cached", async () => {
 const validator=globalThis.__nowledgeMemValidateOptions
 await import("./page/validate.js")
 expect(typeof validator).toBe("function")
 expect(globalThis.__nowledgeMemValidateOptions).toBe(validator)
})

// The sandboxed page must not acquire network or additional host privileges.
// These checks are a regression guard, not a JavaScript security parser.
function pageCalls(source) {
 return [...source.matchAll(/\bmagpie\s*(?:\?\.|\.)\s*([\w$]+(?:\s*(?:\?\.|\.)\s*[\w$]+)*)/g)]
   .map(([,call]) => call.replace(/\s/g, "").replaceAll("?.", "."))
}
function pageScriptAllowed(source, allowedCalls) {
 if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/.test(source)) return false
 if (/\bmagpie\s*\[|\b(?:window|globalThis)\s*\[\s*["']magpie["']\s*\]/.test(source)) return false
 return pageCalls(source).every((call) => allowedCalls.includes(call))
}

test("page scripts use only the released bridge and do not perform network calls", async () => {
 const read=(file)=>Bun.file(new URL(`./page/${file}`,import.meta.url)).text()
 const [settings,validator,dictionary,html]=await Promise.all([read("settings.js"),read("validate.js"),read("i18n.js"),read("settings.html")])
 const allowed=["service","options.get","options.set","theme.lang","ready.then","onTheme"]
 expect(pageScriptAllowed(settings,allowed)).toBe(true)
 expect([...new Set(pageCalls(settings))].sort()).toEqual([...allowed].sort())
 expect(pageScriptAllowed(validator,[])).toBe(true)
 expect(pageScriptAllowed(dictionary,[])).toBe(true)
 const tags=[...html.matchAll(/<script\b([^>]*)>/gi)]
 expect(tags).toHaveLength(4)
 const sources=tags.map(([,attrs])=>attrs.match(/(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)?.slice(1).find((s)=>s !== undefined))
 expect(sources.sort())
   .toEqual(["_magpie/bridge.js","i18n.js","settings.js","validate.js"])
 expect(html).not.toMatch(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i)
 expect(html).not.toMatch(/\b(?:src|href)\s*=\s*(?:["']\s*)?(?:https?:)?\/\//i)
 // Prove that each checked source rejects both classes of regression.
 for (const [source,calls] of [[settings,allowed],[validator,[]]]) {
  expect(pageScriptAllowed(`${source}\nfetch("https://evil.example/x")`,calls)).toBe(false)
  expect(pageScriptAllowed(`${source}\nmagpie.read?.("secrets")`,calls)).toBe(false)
  expect(pageScriptAllowed(`${source}\nwindow.magpie?.read("secrets")`,calls)).toBe(false)
  expect(pageScriptAllowed(`${source}\nmagpie["read"]("secrets")`,calls)).toBe(false)
 }
})

async function pageFixture(initial) {
  const read = (file) => Bun.file(new URL(`./page/${file}`, import.meta.url)).text()
  const [dictionary, validator, source, html] = await Promise.all([read("i18n.js"), read("validate.js"), read("settings.js"), read("settings.html")])
  const make = () => ({
    dataset: {}, value: "", type: "text", checked: false, children: [], hidden: false,
    listeners: {},
    setAttribute(name, value) { this[name] = value }, focus() {}, showModal() { this.open = true }, close() { this.open = false; this.onclose?.() },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
    dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event) },
    append(...xs) { this.children.push(...xs); for (const x of xs) x.parent = this },
    replaceChildren(...xs) { this.children = xs }, remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this) },
  })
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, make()]))
  const labels = Object.fromEntries([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map(([, id]) => [id, make()]))
  for (const [id, label] of Object.entries(labels)) if (elements[id]) elements[id].closest = (selector) => selector === 'label' ? label : null
  const translated = [...html.matchAll(/data-t="([^"]+)"/g)].map(([, key]) => ({dataset:{t:key}}))
  const document = {documentElement:{},getElementById:(id)=>elements[id],createElement:make,
    querySelectorAll:(selector)=>selector === "[data-t]" ? translated : Object.values(elements).filter((el)=>el.dataset.message)}
  let options = structuredClone(initial), version = 0, repaint, writes = 0
  const magpie = {theme:{lang:"en"},ready:Promise.resolve(),onTheme:(fn)=>{repaint=fn},options:{get:async()=>structuredClone(options),set:async(next)=>{options=structuredClone(next);version++;writes++}}}
  const location = {href:"http://127.0.0.1:3425/_magpie/plugin/t/page/settings.html",assign(url){this.assigned=url}}
  const window = {name:""}
  const i18n = runInNewContext(`${dictionary}\n${validator}\n${source}\nnowledgeMemI18n`, {document,magpie,window,location,navigator:{language:"en"},URL})
  await new Promise(setImmediate)
  return {elements,labels,magpie,i18n,translated,document,location,repaint:()=>repaint(),get:()=>options,writes:()=>writes,
    external:(next)=>{options=structuredClone(next);version++},save:()=>elements.save.onclick({preventDefault(){}})}
}

test("default buttons execute their real handlers and clear explicit values", async () => {
 const f=await pageFixture({recall:false,requestTimeoutMs:900,skipAgents:["Mozilla"],apiKey:"saved",future:{v:1}}),e=f.elements
 await e.configure.onclick()
 for (const id of ["recall","request-timeout","skip-agents"]) {
  const reset=f.labels[id].children.find((child)=>child.className === "secondary option-reset")
  expect(typeof reset?.onclick).toBe("function")
  reset.onclick()
 }
 expect(e.recall.checked).toBe(true)
 expect(e["request-timeout"].value).toBe("")
 expect(e["skip-agents"].value).toBe("")
 await f.save()
 expect(f.get()).toEqual({apiKey:"saved",future:{v:1}})
 // Typing after a reset cancels inheritance and saves an explicit value.
 const reset=f.labels.recall.children.find((child)=>child.className === "secondary option-reset")
 reset.onclick();e.recall.checked=false;e.recall.dispatchEvent({type:"change"})
 await f.save();expect(f.get().recall).toBe(false)
})

test("skipAgents retains existing formats, edits names, and updates the summary", async () => {
 for (const original of [["Mozilla", "Claude Code"], "Mozilla，Claude Code"]) {
  const f=await pageFixture({skipAgents:original,apiKey:"saved"}),e=f.elements
  expect(e["summary-skip"].textContent).toBe("Mozilla, Claude Code")
  await e.configure.onclick()
  expect(e["skip-agents"].value).toBe("Mozilla, Claude Code")
  e.space.value="space-a";await f.save()
  expect(f.get().skipAgents).toEqual(original)
  e["skip-agents"].value="Mozilla,, Codex，";await f.save()
  expect(f.get().skipAgents).toEqual(["Mozilla","Codex"])
  expect(e["summary-skip"].textContent).toBe("Mozilla, Codex")
  e["skip-agents"].value=" , ";await f.save()
  expect(f.get().skipAgents).toBeUndefined()
  expect(e["summary-skip"].textContent).toBe("None")
 }
})

test("released hosts save only edited fields using a fresh read and retain secrets", async () => {
 const f=await pageFixture({serverUrl:"http://127.0.0.1:14242",apiKey:"saved_secret",custom:{a:1}}), e=f.elements
 expect(e.configure.disabled).toBe(false)
 expect(e.configured.dataset.message).toBe("loaded")
 await e.configure.onclick()
 expect(e.save.disabled).toBe(false)
 e.space.value="space-2"
 f.external({serverUrl:"http://127.0.0.1:14242",apiKey:"new_secret",custom:{a:2},future:true})
 await f.save()
 expect(f.get()).toEqual({serverUrl:"http://127.0.0.1:14242",apiKey:"new_secret",custom:{a:2},future:true,spaceId:"space-2"})
 expect(f.writes()).toBe(1)
})

test("connection status stays separate from the concurrency notice", async () => {
 const html=await Bun.file(new URL("./page/settings.html",import.meta.url)).text()
 const noticePos=html.indexOf('data-t="concurrencyHelp"')
 expect(noticePos).toBeGreaterThan(html.indexOf('class="dialog-body"'))
 expect(noticePos).toBeLessThan(html.indexOf('</div><footer>'))
 for (const [options,status] of [[{},"notConfigured"],[{serverUrl:"https://mem.example"},"loaded"]]) {
  const f=await pageFixture(options), e=f.elements
  expect(e.configured.dataset.message).toBe(status)
  await e.configure.onclick()
  expect(e.configured.dataset.message).toBe(status)
  const notice=f.translated.find((el)=>el.dataset.t === "concurrencyHelp")
  expect(notice.textContent).toBe(f.i18n.messages.en.concurrencyHelp)
  expect(notice.textContent).toMatch(/another editor saving at the same moment can still overwrite/)
 }
})

test("secret controls keep, replace and clear the saved value", async () => {
 const f=await pageFixture({apiKey:"saved_secret",apiKeyEnv:"NMEM_API_KEY",future:{x:1}}),e=f.elements
 await e.configure.onclick()
 expect(e.key.value).toBe("")
 e.space.value="space-7";await f.save()
 expect(f.get().apiKey).toBe("saved_secret")
 e["key-action"].value="replace";e.key.value="Bearer new_secret";await f.save()
 expect(f.get().apiKey).toBe("new_secret")
 e["key-action"].value="clear";await f.save()
 expect(f.get().apiKey).toBeUndefined()
 expect(f.get().apiKeyEnv).toBe("NMEM_API_KEY")
 expect(f.get().future).toEqual({x:1})
})

test("key visibility resets on close while its draft remains", async () => {
 const f=await pageFixture({}),e=f.elements
 const html=await Bun.file(new URL("./page/settings.html",import.meta.url)).text()
 expect(html).toMatch(/<svg class="eye-show"/)
 expect(html).toMatch(/<svg class="eye-hide"/)
 expect(html).toContain('aria-describedby="key-storage key-help"')
 expect(html).toContain('data-t="keyHelp"')
 await e.configure.onclick();e["key-action"].value="replace";e["key-action"].onchange();e.key.value="synthetic_secret"
 e["show-key"].onclick()
 expect(e.key.type).toBe("text")
 expect(e["show-key"]["aria-pressed"]).toBe("true")
 e.close.onclick()
 expect(e.key.type).toBe("password")
 expect(e["show-key"]["aria-pressed"]).toBe("false")
 await e.configure.onclick()
 expect(e.key.type).toBe("password")
 expect(e.key.value).toBe("synthetic_secret")
})

test("test connection opens the saved local service and language", async () => {
 const f=await pageFixture({}),e=f.elements
 e["test-saved"].onclick()
 expect(f.location.assigned).toBe("http://127.0.0.1:3479/test?lang=en")
})

test("invalid connection values do not write and closing keeps an unsaved draft", async () => {
 const f=await pageFixture({},true),e=f.elements
 await e.configure.onclick();e.url.value="http://remote.example"
 await f.save();expect(e.result.dataset.message).toBe("invalidUrl");expect(f.writes()).toBe(0)
 e.close.onclick();await e.configure.onclick()
 expect(e.url.value).toBe("http://remote.example")
 e.url.value="https://mem.example";e["key-action"].value="replace";e.key.value="bad key"
 await f.save();expect(e.result.dataset.message).toBe("invalidKey");expect(f.writes()).toBe(0)
})

test("settings saved through the released bridge reach the hook", async () => {
 const f=await pageFixture({}),e=f.elements
 await e.configure.onclick()
 e.url.value="https://mem.example";e.space.value="space-7"
 e["key-action"].value="replace";e.key.value="synthetic_key"
 await f.save()
 const originalFetch=globalThis.fetch, calls=[]
 globalThis.fetch=async (url,init)=>{calls.push({url:String(url),init});return Response.json([])}
 try {
  reset()
  await onRequest({messages:[{role:"user",content:"hello"}]},{protocol:"chat",origin:"local",query:"hello",session:"session",options:f.get(),state:{},signal:new AbortController().signal})
  expect(calls[0].url).toBe("https://mem.example/memories/search")
  expect(calls[0].init.headers.Authorization).toBe("Bearer synthetic_key")
  expect(JSON.parse(calls[0].init.body).space_id).toBe("space-7")
 } finally { globalThis.fetch=originalFetch;reset() }
})

test("released hosts keep the draft when a changed field was edited elsewhere", async () => {
 const f=await pageFixture({spaceId:"original"}),e=f.elements
 await e.configure.onclick();e.space.value="draft"
 f.external({spaceId:"other"});await f.save()
 expect(e.result.dataset.message).toBe("conflict")
 expect(e.space.value).toBe("draft")
 expect(f.get().spaceId).toBe("other")
 expect(f.writes()).toBe(0)
})

test("summary capture switch saves on released hosts", async () => {
 {
  const f=await pageFixture({capture:false,custom:{keep:true}}),e=f.elements
  expect(e["summary-capture"].disabled).toBe(false)
  f.external({capture:false,custom:{keep:"updated"}})
  e["summary-capture"].checked=true;await e["summary-capture"].onchange()
  expect(f.get()).toEqual({capture:true,custom:{keep:"updated"}})
  expect(e["capture-feedback"].dataset.message).toBe("captureEnabled")
  expect(e["summary-capture"].disabled).toBe(false)
 }
})

test("configuration page follows host language without losing edits", async () => {
 const f=await pageFixture({serverUrl:"http://127.0.0.1:14242"}),e=f.elements
 await e.configure.onclick();e.url.value="unsaved address"
 await f.save();expect(e.result.dataset.message).toBe("invalidUrl")
 const {messages,languageFor,languageTags}=f.i18n
 for (const language of ["en","zh","zh-TW","ja","de"]) {
  expect(Object.keys(messages[language]).sort()).toEqual(Object.keys(messages.en).sort())
  f.magpie.theme.lang=language;f.repaint()
  expect(f.document.documentElement.lang).toBe(languageTags[language])
  expect(e.url.value).toBe("unsaved address")
  expect(e.result.textContent).toBe(messages[language].invalidUrl)
  for (const el of f.translated) expect(el.textContent).toBe(messages[language][el.dataset.t])
 }
 expect(languageFor("zh-Hant-TW")).toBe("zh-TW")
})
