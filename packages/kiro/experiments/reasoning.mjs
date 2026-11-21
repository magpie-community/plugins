import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { hostname, platform, release } from 'node:os'
import { _internal as k } from '../index.mjs'

const [authFile, accountKey, outputDir, count = '20'] = process.argv.slice(2)
if (!authFile || !accountKey || !outputDir) throw Error('Usage: node experiments/reasoning.mjs AUTH_JSON ACCOUNT_KEY OUTPUT_DIR [PAIRS]')
mkdirSync(outputDir, { recursive: true, mode: 0o700 })
const model = process.env.KIRO_MODEL ?? 'claude-opus-5.5'
const machine = createHash('sha256').update('magpie:' + hostname()).digest('hex')
const app = `KiroIDE-1.4.121-${machine}-KAS/0.66.89 acp-client/kiro-ide`
function account() {
  const a = JSON.parse(readFileSync(authFile, 'utf8'))[accountKey]
  if (!a?.access || a.expires < Date.now() + 30000) throw Error('Access token missing or near expiry')
  return a
}
const initialAccount = account()
await k.listModels({ token: initialAccount.access, tokenType: initialAccount.method === 'idc' ? 'SSO_OIDC' : '', idc: initialAccount.method === 'idc', profile: initialAccount.profileArn, region: initialAccount.region })
function graph(seed) {
  let state = seed >>> 0
  const next = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n }
  const edges = []
  const n = 16
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < Math.min(n, i + 5); j++) edges.push([i, j, 1 + next(29)])
  const distance = Array(n).fill(Infinity), paths = Array(n)
  distance[0] = 0; paths[0] = [0]
  for (let i = 0; i < n; i++) for (const [from, to, cost] of edges) if (from === i && distance[from] + cost < distance[to]) { distance[to] = distance[from] + cost; paths[to] = [...paths[from], to] }
  return { edges, answer: { path: paths[n - 1], cost: distance[n - 1] } }
}
const tools = [{ name: 'confirm', description: 'Ask for approval to disclose the computed solution. No arguments.', input_schema: { type: 'object', properties: {}, additionalProperties: false } }]
async function call(body, label) {
  const a = account()
  const headers = { Authorization: `Bearer ${a.access}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', tokentype: a.method === 'idc' ? 'SSO_OIDC' : 'SOCIAL', 'x-amzn-kiro-agent-mode': 'vibe', 'x-amzn-kiro-client-attribution': 'kiro-ide', 'User-Agent': `aws-sdk-js/1.0.0 ua/2.1 os/${platform()}#${release()} lang/js md/nodejs#24.22.1 api/kiroruntime#1.0.0 m/N ${app}`, 'x-amz-user-agent': `aws-sdk-js/1.0.0 ${app}` }
  const start = performance.now()
  const res = await fetch(`https://runtime.${a.region}.kiro.dev/v1/responses`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) })
  const headersMs = performance.now() - start
  if (!res.ok) return { label, status: res.status, headersMs, error: await res.text() }
  let buf = '', firstEventMs, firstThinkingMs, firstTextMs, output = [], text = '', usage
  const reader = res.body.getReader(), dec = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    buf += done ? dec.decode() : dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = done ? '' : lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      let e
      try { e = JSON.parse(line.slice(5)) } catch { continue }
      const ms = performance.now() - start
      if (e.type?.endsWith('.delta')) firstEventMs ??= ms
      if (e.type === 'response.reasoning_text.delta' || e.type === 'response.reasoning.delta') firstThinkingMs ??= ms
      if (e.type === 'response.output_text.delta') { firstTextMs ??= ms; text += e.delta }
      if (e.type === 'response.output_item.done') output.push(e.item)
      if (e.type === 'response.completed' || e.type === 'response.incomplete') usage = e.response?.usage
      if (e.type === 'response.failed' || e.type === 'error') throw Error(JSON.stringify(e.error ?? e.response?.error))
    }
    if (done) break
  }
  const reasoning = body.input.filter(it => it.type === 'reasoning')
  return { label, endpoint: '/v1/responses', status: res.status, headersMs, firstEventMs, firstThinkingMs, firstTextMs, totalMs: performance.now() - start, reasoningItems: reasoning.length, reasoningBytes: reasoning.reduce((n, it) => n + (it.encrypted_content?.length ?? 0), 0), inputHashWithoutReasoning: createHash('sha256').update(JSON.stringify({ ...body, input: body.input.filter(it => it.type !== 'reasoning') })).digest('hex'), credits: usage?.['kiro:credits']?.value, usage, text, output }
}
function record(row) {
  const { output, ...summary } = row
  appendFileSync(`${outputDir}/results.jsonl`, JSON.stringify({ model, ...summary }) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ model, ...summary }))
}
for (let pair = 0; pair < Number(count); pair++) {
  const seed = 104729 + pair
  const { edges, answer } = graph(seed)
  const a = account()
  const session = randomUUID()
  const prompt = `Find the minimum cost directed path from vertex 0 to vertex 15. Vertices are 0..15. Edges (from,to,cost): ${JSON.stringify(edges)}. Finish solving before calling confirm with {}. Emit no ordinary text before the call, and put no solution in its arguments. After approval return only JSON {"path":[vertices],"cost":number}. Trial ${seed}.`
  const request = { model, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, tools, messages: [{ role: 'user', content: prompt }] }
  const gar = JSON.parse(k.buildKiro(request, model, a.profileArn, 30000, session))
  const body = k.responsesBody(gar)
  const initial = await call(body, `${pair}-initial`)
  record({ ...initial, pair, stage: 'initial', seed, answer })
  writeFileSync(`${outputDir}/${pair}-initial.json`, JSON.stringify({ body, ...initial }), { mode: 0o600 })
  if (initial.status !== 200) throw Error('Initial request failed')
  const reasoning = initial.output.filter(it => it.type === 'reasoning' && it.encrypted_content)
  const calls = initial.output.filter(it => it.type === 'function_call')
  if (!reasoning.length || calls.length !== 1 || calls[0].name !== 'confirm' || initial.text.trim() || Object.keys(JSON.parse(calls[0].arguments || '{}')).length) throw Error('Initial response does not meet the experiment protocol')
  const items = initial.output.filter(it => ['reasoning', 'function_call', 'message'].includes(it.type)).map(({ id, status, ...it }) => it)
  const continuation = { ...body, input: [...body.input, ...items, { type: 'function_call_output', call_id: calls[0].call_id, output: 'approved' }] }
  const order = pair % 2 ? ['drop', 'replay'] : ['replay', 'drop']
  for (const mode of order) {
    const input = mode === 'replay' ? continuation.input : continuation.input.filter(it => it.type !== 'reasoning')
    const row = await call({ ...continuation, input }, `${pair}-${mode}`)
    let got
    try { got = JSON.parse(row.text) } catch {}
    const cost = got?.path?.slice(1).reduce((sum, to, i) => sum + (edges.find(([from, end]) => from === got.path[i] && end === to)?.[2] ?? Infinity), 0)
    record({ ...row, pair, stage: 'continuation', mode, order: order.indexOf(mode), seed, answer, correct: got?.cost === answer.cost && cost === answer.cost && got?.path?.[0] === 0 && got?.path?.at(-1) === 15 })
    if (row.status !== 200) throw Error('Continuation failed')
  }
}
