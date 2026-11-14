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
  const page = read('index.html')
  const panelPage = read('agents-panel.html')
  const allowed = ['ready', 'options.get', 'options.set', 'onAction']

  expect(safePageScript(app, allowed)).toBe(true)
  expect(safePageScript(panel, allowed)).toBe(true)
  expect(safePageScript(agents, [])).toBe(true)
  expect(safePageScript(policy, [])).toBe(true)
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
  expect(pkg.version).toBe('0.4.0')
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
