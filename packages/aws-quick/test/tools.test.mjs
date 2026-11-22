import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTools, buildToolPreamble, createToolCallParser, slimSchema, mapQuickTool } from '../lib/tools.mjs'
import { byteLen } from '../lib/translate.mjs'

test('normalizeTools keeps only named function tools', () => {
  const tools = normalizeTools([
    { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'no_params' } },
    { type: 'bogus' },
    null,
  ])
  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, 'get_weather')
  assert.equal(tools[1].parameters.type, 'object') // defaulted
})

test('buildToolPreamble embeds specs and forced choice', () => {
  const tools = normalizeTools([{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }])
  const p = buildToolPreamble(tools, 'required')
  assert.ok(p.includes('<tool_call>{"name":"<tool_name>"'))
  assert.ok(p.includes('- f: d'))
  assert.ok(p.includes('reply with <tool_call> block(s) only'))
  assert.equal(buildToolPreamble([], 'auto'), '')
  const named = buildToolPreamble(tools, { type: 'function', function: { name: 'f' } })
  assert.ok(named.includes('requires the client tool "f"'))
})

test('slimSchema strips annotation keywords, keeps structure', () => {
  const slim = slimSchema({
    type: 'object',
    description: 'verbose docs',
    title: 'T',
    required: ['a'],
    properties: {
      a: { type: 'string', description: 'field doc', enum: ['x', 'y'] },
      b: { type: 'object', properties: { c: { type: 'number', examples: [1] } } },
    },
  })
  assert.equal(slim.description, undefined)
  assert.equal(slim.title, undefined)
  assert.deepEqual(slim.required, ['a'])
  assert.equal(slim.properties.a.description, undefined)
  assert.deepEqual(slim.properties.a.enum, ['x', 'y'])
  assert.equal(slim.properties.b.properties.c.examples, undefined)
})

test('preamble compacts schema annotations and caps giant schemas', () => {
  const bigProps = {}
  for (let i = 0; i < 200; i++) {
    bigProps[`field_${i}`] = { type: 'string', description: 'd'.repeat(80) }
  }
  const tools = normalizeTools([
    { type: 'function', function: { name: 'small', description: 's', parameters: { type: 'object', properties: { x: { type: 'string', description: 'doc' } } } } },
    { type: 'function', function: { name: 'huge', description: 'h', parameters: { type: 'object', properties: bigProps, required: ['field_0'] } } },
  ])
  const p = buildToolPreamble(tools, 'auto')
  // small tool keeps its (slimmed) schema incl. type info
  assert.ok(p.includes('"x":{"type":"string"}'))
  assert.ok(!p.includes('"doc"')) // property description stripped
  // huge tool degrades to bare object + required
  assert.ok(p.includes('"properties":{}'))
  assert.ok(p.includes('"required":["field_0"]'))
  assert.ok(!p.includes('field_1'))
})

test('preamble falls back to compact typed signatures when toolset is enormous', () => {
  const tools = normalizeTools(Array.from({ length: 60 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: `description ${i} `.repeat(30),
      parameters: {
        type: 'object',
        required: ['p0'],
        properties: Object.fromEntries(Array.from({ length: 15 }, (_, j) => [`p${j}`, { type: 'string', description: 'x'.repeat(60) }])),
      },
    },
  })))
  const p = buildToolPreamble(tools, 'auto')
  assert.ok(byteLen(p) < 36 * 1024)
  assert.ok(p.includes('compact signatures'))
  assert.ok(p.includes('- tool_0(p0!: string'))
  assert.ok(!p.includes('"properties"'))
})

test('parser extracts blocks split across deltas', () => {
  const p = createToolCallParser()
  let r = p.push('Hello <tool_call>{"name":"get_weather","arg')
  assert.equal(r.text, 'Hello ')
  assert.equal(r.calls.length, 0)
  r = p.push('uments":{"city":"Paris"}}</tool_call> done')
  assert.equal(r.text, ' done')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].name, 'get_weather')
  assert.deepEqual(r.calls[0].arguments, { city: 'Paris' })
  const end = p.end()
  assert.equal(end.text, '')
  assert.equal(end.dropped, undefined)
})

test('parser handles multiple blocks and surrounding text', () => {
  const p = createToolCallParser()
  const r = p.push('pre <tool_call>{"name":"a","arguments":{}}</tool_call> mid <tool_call>{"name":"b","arguments":{"x":1}}</tool_call> post')
  assert.equal(r.text, 'pre  mid  post')
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'b'])
})

test('parser holds back tag split mid-token across deltas', () => {
  // Live Quick streams "<" then "tool_call>{...}</tool_call>" as separate deltas.
  const p = createToolCallParser()
  let r = p.push('pre<')
  assert.equal(r.text, 'pre') // '<' held, not flushed
  assert.equal(r.calls.length, 0)
  r = p.push('tool_call>{"name":"f","arguments":{}}</tool_call>post')
  assert.equal(r.text, 'post')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].name, 'f')
})

test('parser holds back split close tag', () => {
  const p = createToolCallParser()
  p.push('<tool_call>{"name":"f","arguments":{}}</tool_')
  const r = p.push('call>tail')
  assert.equal(r.text, 'tail')
  assert.equal(r.calls.length, 1)
})

test('parser drops unterminated block without leaking it', () => {
  const p = createToolCallParser()
  p.push('text <tool_call>{"name":"x"')
  const end = p.end()
  assert.equal(end.text, '')
  assert.equal(end.dropped, true)
})

test('parser tolerates arguments as JSON string and missing args', () => {
  const p = createToolCallParser()
  const r = p.push('<tool_call>{"name":"f","arguments":"{\\"a\\":1}"}</tool_call><tool_call>{"name":"g"}</tool_call>')
  assert.equal(r.calls.length, 2)
  assert.deepEqual(r.calls[0].arguments, { a: 1 })
  assert.deepEqual(r.calls[1].arguments, {})
})

test('parser ignores malformed JSON blocks', () => {
  const p = createToolCallParser()
  const r = p.push('<tool_call>not json</tool_call>ok')
  assert.equal(r.calls.length, 0)
  assert.equal(r.text, 'ok')
  const end = p.end()
  assert.equal(end.dropped, true) // malformed block counts as dropped
})

test('parser supports OpenAI function.arguments shape and fenced JSON', () => {
  const p = createToolCallParser()
  const r = p.push(
    '<tool_call>{"function":{"name":"read","arguments":{"path":"a.txt"}}}</tool_call>' +
    '<tool_call>```json\n{"name":"write","arguments":{"path":"b.txt"}}\n```</tool_call>',
  )
  assert.equal(r.calls.length, 2)
  assert.deepEqual(r.calls[0], { name: 'read', arguments: { path: 'a.txt' } })
  assert.deepEqual(r.calls[1], { name: 'write', arguments: { path: 'b.txt' } })
})

test('normalizeTools deduplicates by tool name and minimal preamble lists names only', () => {
  const tools = normalizeTools([
    { type: 'function', function: { name: 'dup', description: 'first' } },
    { type: 'function', function: { name: 'dup', description: 'second' } },
    { type: 'function', function: { name: 'other', description: 'x'.repeat(200) } },
  ])
  assert.equal(tools.length, 2)
  assert.equal(tools[0].description, 'second')
  const min = buildToolPreamble(tools, 'auto', { minimal: true })
  assert.ok(min.includes('dup, other'))
  assert.ok(!min.includes('second'))
})

test('mapQuickTool preserves command even when optional properties also match', () => {
  const tools = normalizeTools([
    {
      type: 'function',
      function: {
        name: 'Shell',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' }, timeout: { type: 'number' } },
          required: ['cmd'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'Read',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
    },
  ])
  // Quick passes `command` + `timeout`; client schema expects `cmd` + `timeout`.
  const mapped = mapQuickTool('run_terminal_command', '{"command":"ls -la","timeout":5000}', tools)
  assert.deepEqual(mapped, { name: 'Shell', arguments: { cmd: 'ls -la', timeout: 5000 } })
  // Built-in file tools map to aliased client tools with parameter name aliasing.
  const mappedRead = mapQuickTool('read_file', { path: 'src/app.js' }, tools)
  assert.deepEqual(mappedRead, { name: 'Read', arguments: { file_path: 'src/app.js' } })
  assert.equal(mapQuickTool('web_search', { query: 'test' }, tools), null)
})

test('parser handles literal </tool_call> inside JSON string arguments and repairs minor JSON glitches', () => {
  const p = createToolCallParser()
  const r1 = p.push('ok <tool_call>{"name":"edit","arguments":{"code":"const tag = \\"</tool_call>\\";"}}</tool_call> after')
  assert.equal(r1.text, 'ok  after')
  assert.equal(r1.calls.length, 1)
  assert.equal(r1.calls[0].arguments.code, 'const tag = "</tool_call>";')

  // Unescaped raw newline inside JSON string + trailing comma
  const p2 = createToolCallParser()
  const r2 = p2.push('<tool_call>{"name":"write","arguments":{"content":"line1\nline2",},}</tool_call>')
  assert.equal(r2.calls.length, 1)
  assert.deepEqual(r2.calls[0], { name: 'write', arguments: { content: 'line1\nline2' } })
})
