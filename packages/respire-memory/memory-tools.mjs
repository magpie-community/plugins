// Reused from Respire Codex's restricted archival tools.
import { containsSecret, validId } from './runtime.mjs';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const READ = new Set(['recall', 'show', 'prompt', 'tree', 'taxonomy', 'agent-config', 'query-log', 'diary-search', 'diary-fragment'])
const WRITE = new Set(['remember', 'update'])
export const TOOL = {
  type: 'function', name: 'respire_memory',
  description: 'Run rsrs memory commands. args are CLI arguments without --client-only or --json. Read policy with prompt, recall titles and show candidates before writing. Use update for the same subject, or remember with --title and --parent for a new important fact. Diary reads are bounded historical references, not verified evidence. Use only for history or insufficient/conflicting main memories. Unsupported Runtime commands must not trigger whole-diary fallback. No force, merge, credential, runtime or configuration changes.',
  inputSchema: { type: 'object', properties: { command: { type: 'string', enum: [...READ, ...WRITE] }, args: { type: 'array', items: { type: 'string' } } }, required: ['command', 'args'], additionalProperties: false },
}

// 日记检索只开放固定预算的只读参数，不能由模型扩大成整库正文读取。
function boundedDiaryArgs(command, args) {
  const search = command === 'diary-search'
  const positional = search ? 1 : 2
  if (args.length < positional || args.slice(0, positional).some(arg => !arg.trim() || arg.startsWith('-'))) throw new Error('bounded-diary-arguments')
  if (search && [...args[0]].length > 500) throw new Error('bounded-diary-query')
  if (!search && !validId(args[0])) throw new Error('bounded-diary-source')
  const options = search
    ? new Map([['--limit','5'],['--max-chars','4000'],['--mode','hybrid']])
    : new Map([['--neighbors','0'],['--max-chars','4000']])
  const seen = new Set()
  for (let i = positional; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!options.has(key) || seen.has(key) || value === undefined) throw new Error('bounded-diary-option')
    if (key === '--mode' ? !['lexical','hybrid'].includes(value)
      : !/^\d+$/.test(value) || Number(value) > Number(key === '--neighbors' ? 1 : options.get(key)) || Number(value) < (key === '--neighbors' ? 0 : key === '--max-chars' ? 512 : 1)) throw new Error('bounded-diary-budget')
    options.set(key, value); seen.add(key)
  }
  return [...args.slice(0, positional), ...[...options].flat()]
}

export function memoryTools(call, { readOnly = false } = {}) {
  let recalled = false
  let policy = false
  let uncertain = false
  let diaryUnavailable = false
  const written = new Set()
  const shown = new Set()
  const verified = new Set()
  const commands = []
  const attempts = new Set()
  return {
    written, shown, commands,
    get uncertain() { return uncertain },
    async run(input) {
      if (!record(input) || ![...READ, ...WRITE].includes(input.command) || !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string') || JSON.stringify(input).length > 16000) throw new Error('invalid-memory-call')
      const { command } = input
      let args = input.args.filter(arg => arg !== '--json' && arg !== '--client-only')
      if (args.some(arg => /^(?:--(?:direct|force|merge-ids|go|ensure|set|addr|data-dir))(?:=|$)/.test(arg))) throw new Error('forbidden-memory-option')
      if (command === 'taxonomy' && (args.length !== 1 || args[0] !== '--list')) throw new Error('read-only-taxonomy')
      if (command === 'agent-config' && args.length) throw new Error('read-only-config')
      const diary = command === 'diary-search' || command === 'diary-fragment'
      if (diary && diaryUnavailable) throw new Error('diary-unsupported')
      if (diary) args = boundedDiaryArgs(command, args)
      const write = WRITE.has(command)
      if (write) {
        if (readOnly) throw new Error('read-only')
        if (uncertain || !recalled || !policy || !shown.size) throw new Error('read-before-write')
        if (containsSecret(JSON.stringify(input))) throw new Error('secret-content')
        const trivial = command === 'remember' && args.includes('--importance') && args[args.indexOf('--importance') + 1] === 'trivial'
        const title = args.indexOf('--title')
        if (!trivial && (title < 0 || !args[title + 1]?.trim())) throw new Error('title-required')
        if (command === 'remember' && !trivial) {
          const parent = args[args.indexOf('--parent') + 1]
          if (!args.includes('--parent') || !validId(parent) || !shown.has(parent)) throw new Error('shown-parent-required')
        }
        if (command === 'update' && (!validId(args[0]) || !shown.has(args[0]))) throw new Error('show-before-update')
        const key = JSON.stringify([command, args])
        if (attempts.has(key)) throw new Error('duplicate-write')
        attempts.add(key)
        uncertain = true
      }
      commands.push(command)
      let doc
      try { doc = await call([command, ...args]) }
      catch (error) {
        if (diary && error.message === 'diary-unsupported') diaryUnavailable = true
        throw error
      }
      if (diary && JSON.stringify(doc).length > 8000) throw new Error('diary-output-too-large')
      if (command === 'recall' && (doc.status === 'ok' || (doc.status === 'skip' && doc.summary?.count === 0))) recalled = true
      if (command === 'prompt' && recalled && doc.status === 'ok') policy = true
      if (command === 'show' && doc.status === 'ok' && validId(doc.summary?.id)) {
        if (!validId(args[0]) || !doc.summary.id.startsWith(args[0])) throw new Error('invalid-readback')
        shown.add(doc.summary.id)
        shown.add(args[0])
        if (written.has(doc.summary.id)) verified.add(doc.summary.id)
      }
      if (write) {
        if (doc.status === 'pending' || doc.status === 'skip') uncertain = false
        else if (doc.status === 'ok' && validId(doc.summary?.id)) { uncertain = false; written.add(doc.summary.id); verified.delete(doc.summary.id) }
        else throw new Error('write-unconfirmed')
      }
      return doc
    },
    finish(text) {
      if (uncertain || !recalled || !policy) throw new Error('archive-unconfirmed')
      let receipt
      try { receipt = JSON.parse(text) } catch { throw new Error('archive-invalid-receipt') }
      if (!['stored', 'already-stored', 'nothing-to-store', 'read-only'].includes(receipt.result) || !Array.isArray(receipt.ids) || receipt.ids.some(id => !validId(id) || !shown.has(id))) throw new Error('archive-invalid-receipt')
      if ([...written].some(id => !verified.has(id)) || (receipt.result === 'stored' && !written.size) || (receipt.result === 'already-stored' && !receipt.ids.length)) throw new Error('archive-unverified')
      return { result: written.size ? 'stored' : receipt.result, records: [...written], checkedRecords: [...new Set([...receipt.ids, ...verified])], calls: commands.length }
    },
  }
}
