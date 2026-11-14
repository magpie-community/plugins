import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const dir = new URL('./page/', import.meta.url)
const read = (file) => readFileSync(new URL(file, dir), 'utf8')

function bridgeCalls(source) {
  return [...source.matchAll(/\bmagpie\s*(?:\?\.|\.)\s*([\w$]+(?:\s*(?:\?\.|\.)\s*[\w$]+)*)/g)]
    .map(([, call]) => call.replace(/\s/g, '').replaceAll('?.', '.'))
}

function safePageScript(source, allowed) {
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/.test(source)) return false
  if (/\bmagpie\s*\[|\b(?:window|globalThis)\s*\[\s*["']magpie["']\s*\]/.test(source)) return false
  return bridgeCalls(source).every((call) => allowed.includes(call))
}

test('page and panel use only the released bridge and make no network calls', () => {
  const app = read('app.js')
  const panel = read('panel.js')
  const agents = read('agents.js')
  const policy = read('policy.js')
  const settings = read('settings.js')
  const page = read('index.html')
  const panelPage = read('agents-panel.html')
  const allowed = ['ready', 'options.get', 'options.set', 'onAction']

  expect(safePageScript(app, allowed)).toBe(true)
  expect(safePageScript(panel, allowed)).toBe(true)
  expect(safePageScript(agents, [])).toBe(true)
  expect(safePageScript(policy, [])).toBe(true)
  expect(safePageScript(settings, [])).toBe(true)
  for (const source of [app, panel]) {
    expect(safePageScript(`${source}\nfetch('https://evil.example/x')`, allowed)).toBe(false)
    expect(safePageScript(`${source}\nmagpie.read?.('secrets')`, allowed)).toBe(false)
    expect(safePageScript(`${source}\nmagpie['read']('secrets')`, allowed)).toBe(false)
  }

  for (const html of [page, panelPage]) {
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i)
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*(?:["']\s*)?(?:https?:)?\/\//i)
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i)
    const tags = [...html.matchAll(/<script\b([^>]*)>/gi)]
    const sources = tags.map(([, attrs]) => attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]).filter(Boolean)
    expect(sources).toContain('_magpie/bridge.js')
    expect(sources).toContain('agents.js')
    expect(sources).toContain('policy.js')
    if (html === page) expect(sources).toContain('settings.js')
    expect(sources).toContain(html === page ? 'app.js' : 'panel.js')
    expect(tags).toHaveLength(sources.length)
  }
})

test('a glob policy survives an options save and unrelated options are kept', () => {
  const sandbox = {}
  sandbox.globalThis = sandbox
  runInNewContext(read('agents.js'), sandbox)
  runInNewContext(read('policy.js'), sandbox)
  const A = sandbox.ShyPieAgents
  const P = sandbox.ShyPiePolicy
  expect(A.KNOWN.some((row) => row.id === 'claude-code')).toBe(false)
  expect(A.KNOWN.some((row) => row.id === 'aider')).toBe(false)
  const split = P.split(['claude*', 'codex', ' claude ', 'CLAUDE'])
  expect(split.exact).toEqual(['codex'])
  expect(split.patterns).toEqual(['claude*', ' claude ', 'CLAUDE'])
  expect(P.matches('claude*', 'claude')).toBe(true)
  expect(P.matches('claude*', 'claude-desktop')).toBe(true)
  expect(P.matches('Claude*', 'claude')).toBe(false)
  expect(P.matches('*', 'anything')).toBe(true)
  expect(P.patternFor(['claude*'], 'claude')).toBe('claude*')
  expect(P.mergeDisabled(split.patterns, ['codex'])).toEqual(['claude*', ' claude ', 'CLAUDE', 'codex'])
  const merged = P.mergeOptions(
    { binaryPolicy: 'guide', allowModels: ['safe/*'] },
    { patterns: split.patterns, exact: ['codex'], protectUnknown: false, extra: ['my-agent'] },
  )
  expect(merged.binaryPolicy).toBe('guide')
  expect(merged.allowModels).toEqual(['safe/*'])
  expect(merged.disabledAgents).toEqual(['claude*', ' claude ', 'CLAUDE', 'codex'])
  expect(merged.protectUnknownAgent).toBe(false)
  expect(merged.extraAgents).toEqual(['my-agent'])
  expect(P.sameAgentFields(
    { disabledAgents: ['claude*'], protectUnknownAgent: true, extraAgents: [] },
    { disabledAgents: ['claude*'], protectUnknownAgent: true, extraAgents: [] },
  )).toBe(true)
  expect(P.sameAgentFields(
    { disabledAgents: ['claude*'], protectUnknownAgent: true, extraAgents: [] },
    { disabledAgents: ['claude*', 'codex'], protectUnknownAgent: true, extraAgents: [] },
  )).toBe(false)
})

test('middleware settings are validated, merged and detect stale values', () => {
  const sandbox = {}
  sandbox.globalThis = sandbox
  runInNewContext(read('settings.js'), sandbox)
  const S = sandbox.ShyPieSettings
  const parsed = S.fromOptions({
    binaryPolicy: 'guide',
    allowModels: ['safe/*'],
    blobBase64Chars: 400,
    future: 'keep',
  })
  expect(Array.from(parsed.values.allowModels)).toEqual(['safe/*'])
  expect(parsed.invalid).toEqual([])
  expect(Array.from(S.parseList('a/*, b/*\nc/*'))).toEqual(['a/*', 'b/*', 'c/*'])
  expect(S.fromOptions({ allowModels: { bad: true } }).invalid).toEqual(['allowModels'])
  expect(S.fromOptions({ allowModels: [null] }).invalid).toEqual(['allowModels'])
  const clamped = S.fromOptions({ maxDepth: 500, scanChars: 500, maxNodes: 40000.5 })
  expect(clamped.values.maxDepth).toBe(200)
  expect(clamped.values.scanChars).toBe(1000)
  expect(clamped.values.maxNodes).toBe(40000)
  const savedClamped = S.apply(
    { maxDepth: 500, scanChars: 500, maxNodes: 40000.5, disabledAgents: ['codex'] },
    clamped.values,
  )
  expect(savedClamped.maxDepth).toBe(200)
  expect(savedClamped.scanChars).toBe(1000)
  expect(savedClamped.maxNodes).toBe(40000)
  expect(S.fromOptions({ binaryPolicy: 'Guide' }).invalid).toEqual(['binaryPolicy'])
  expect(S.validate({ ...parsed.values, maxDepth: 0 }).map((error) => error.key)).toEqual(['maxDepth'])
  const many = Array.from({ length: 201 }, (_, i) => `model/${i}`)
  expect(S.parseList(many)).toHaveLength(201)
  expect(S.validate({ ...parsed.values, allowModels: many }).map((error) => error.key)).toEqual(['allowModels'])
  const rawSnapshot = S.snapshot({ ...parsed.values })
  expect(S.same({ allowModels: null }, S.snapshot({ allowModels: [] }))).toBe(false)
  const merged = S.apply(
    { binaryPolicy: 'fail', future: 'keep' },
    { ...parsed.values, binaryPolicy: 'guide', localProviders: ['ollama'] },
  )
  expect(merged.binaryPolicy).toBe('guide')
  expect(Array.from(merged.localProviders)).toEqual(['ollama'])
  expect(merged.future).toBe('keep')
  expect(S.same({ ...parsed.values }, rawSnapshot)).toBe(true)
  expect(S.same({ ...parsed.values, blobBase64Chars: 500 }, rawSnapshot)).toBe(false)
})

test('the shared agent catalogue validates ids and keeps custom agents', () => {
  const sandbox = {}
  sandbox.globalThis = sandbox
  runInNewContext(read('agents.js'), sandbox)
  const A = sandbox.ShyPieAgents
  expect(A.normalizeId(' My-Agent ')).toBe('my-agent')
  expect(A.normalizeId('bad id')).toBe('')
  expect(A.normalizeList(['Claude', 'claude', 'my_agent'])).toEqual(['claude', 'my_agent'])
  expect(A.allRows(['my-agent']).some((row) => row.id === 'my-agent')).toBe(true)
  expect(A.KNOWN.some((row) => row.id === 'dsh')).toBe(true)
})

test('package declares the page, Agents panel and agent action', () => {
  const pkg = JSON.parse(read('../package.json'))
  expect(pkg.version).toBe('0.4.1')
  expect(pkg.files).toContain('page')
  expect(pkg.magpie.page.file).toBe('page/index.html')
  expect(pkg.magpie.page.icon).toBe('page/icon.svg')
  expect(pkg.magpie.panels).toEqual([
    expect.objectContaining({ slot: 'agents', file: 'page/agents-panel.html' }),
  ])
  expect(pkg.magpie.actions).toEqual([
    expect.objectContaining({ menu: 'agent', id: 'shypie-protection' }),
  ])
  expect(pkg.magpie.permissions).toEqual([])
  expect(pkg.magpie.options.disabledAgents).toEqual([])
  expect(pkg.magpie.options.protectUnknownAgent).toBe(true)
})
