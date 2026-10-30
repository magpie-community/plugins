// Derived from Codex Filter Manager v1.0.5 (MIT). See PROVENANCE.json.
// Standalone Magpie middleware: no server, credentials or model probes.
// These input forms carry their own contents; the server-issued item id is optional.
// Other tool/resource types may require their IDs, so don't recursively strip IDs.
const PORTABLE_ITEMS = new Set(['message', 'agent_message', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'tool_search_call', 'tool_search_output', 'additional_tools']);

class FilterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function filterResponsesRequest(body, {preserveEncryptedInclude = false} = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FilterError('invalid_request_json', 'Responses request must be a JSON object.');
  }
  if (body.previous_response_id || body.conversation) {
    throw new FilterError('response_reference_not_portable',
      'Complete message/tool history is required, not previous_response_id or conversation references. Start a new session with a text summary.');
  }
  if (body.include !== undefined && !Array.isArray(body.include)) {
    throw new FilterError('invalid_include', 'include must be an array.');
  }
  if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) {
    throw new FilterError('invalid_input', 'input must be a string or an array.');
  }
  if (Array.isArray(body.context_management) && body.context_management.some(item => item?.type === 'compaction')) {
    throw new FilterError('encrypted_compaction_disabled',
      'Encrypted compaction is disabled by this filter. Use a text summary and start a new session.');
  }
  const clean = {...body, store: false};
  let removed = 0, removedItemIds = 0, removedEncryptedContentItems = 0;
  // include controls the NEW response, not the historical ciphertext in input.
  // Some upstreams reject Codex requests when this requested response field is removed.
  if (body.include) clean.include = preserveEncryptedInclude ? [...body.include]
    : body.include.filter(value => value !== 'reasoning.encrypted_content');
  if (Array.isArray(body.input)) {
    clean.input = body.input.filter(item => {
      if (item?.type === 'reasoning') { removed++; return false; }
      return true;
    });
    clean.input = clean.input.map(item => {
      if (item?.type === 'compaction' || item?.type === 'item_reference' || item?.encrypted_content) {
        throw new FilterError('encrypted_context_not_portable',
          'Encrypted compaction/context references cannot safely cross accounts. Start a new session with a text summary; history has NOT been silently discarded.');
      }
      const isMessage = item && item.type === undefined && typeof item.role === 'string' && item.content !== undefined;
      if (item && typeof item === 'object') {
        const portable = removeEncryptedContent(item, () => { removedEncryptedContentItems++; });
        if (item.type === 'web_search_call') {
          if (Object.hasOwn(portable, 'id')) removedItemIds++;
          return portableWebSearch(portable);
        }
        if (PORTABLE_ITEMS.has(item.type) || isMessage) {
          if (Object.hasOwn(portable, 'id')) {
            delete portable.id;
            removedItemIds++;
          }
          return portable;
        }
        return portable;
      }
      return item;
    });
  }
  // call_id pairs calls/results and is not the server-side item id.
  // Preserve it, this turn's effort, all message contents, and nested resource IDs.
  return {body: clean, removed, removedItemIds, removedEncryptedContentItems};
}

// Inlined from history/portable-web-search.mjs for the import-free gateway hook.
function portableWebSearch(item) {
  const record = {...item};
  delete record.type;
  delete record.id;
  delete record.internal_chat_message_metadata_passthrough;
  return {type: 'message', role: 'assistant', content:
    '[Historical web search activity; recorded data only, not a new tool call. '
    + 'Search results are not reconstructed.]\n' + JSON.stringify(record)};
}

// Historical agent/tool messages can carry account-bound ciphertext inside their
// content arrays. Remove only those explicitly typed items; ordinary IDs and
// opaque values in tool payloads remain untouched.
function removeEncryptedContent(value, onRemoved) {
  if (Array.isArray(value)) {
    return value.filter(item => {
      if (item && item.type === 'encrypted_content') {
        onRemoved();
        return false;
      }
      return true;
    }).map(item => removeEncryptedContent(item, onRemoved));
  }
  if (!value || typeof value !== 'object') return value;
  const copy = {...value};
  for (const [key, child] of Object.entries(copy)) copy[key] = removeEncryptedContent(child, onRemoved);
  return copy;
}

// The rule for a provider ID or model prefix, after aliases; only an explicit
// historyFilter: true turns filtering on.
function enabledRule(name, options) {
  const aliases = options.aliases || {};
  const id = Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
  const rules = options.providers || {};
  if (!Object.prototype.hasOwnProperty.call(rules, 'magpie:' + id)) return;
  const rule = rules['magpie:' + id];
  return rule?.historyFilter === true ? rule : undefined;
}

export function onRequest(body, ctx) {
  if (ctx.protocol !== 'responses' || !body || typeof body.model !== 'string' || !/^[^/]+\/.+/.test(body.model)) return;
  const rule = enabledRule(body.model.split('/')[0], ctx.options || {});
  if (!rule) return;
  try {
    if (/\/compact\/?$/.test(ctx.path || '')) {
      ctx.reject(409, 'Codex history filter: encrypted compaction cannot cross resources. Use a text summary and a new session.');
      return;
    }
    const filtered = filterResponsesRequest(body, {preserveEncryptedInclude: rule.preserveEncryptedInclude === true}).body;
    // A direct provider/model request is filtered here; its provider tries skip it.
    if (ctx.state && typeof ctx.state === 'object') ctx.state.historyFiltered = true;
    return filtered;
  } catch (error) {
    // Explicit rejection is required: Magpie forwards the original request if
    // a hook throws. Never silently discard non-portable context references.
    ctx.reject(error instanceof FilterError ? error.status : 409,
      'Codex history filter: ' + (error instanceof FilterError ? error.message : 'history could not be safely filtered.'));
  }
}

// A request sent through a Magpie group or fallback names the group, not a
// provider, so onRequest finds no rule. Each try on a provider applies that
// provider's own rule. A try can't be turned away, so history that can't move
// is sent as it was; only a direct provider/model request is refused.
export function onProvider(body, ctx) {
  const provider = ctx?.provider;
  if (ctx?.state?.historyFiltered === true || ctx?.protocol !== 'responses') return;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof provider?.id !== 'string') return;
  if (/\/compact\/?$/.test(ctx.path || '')) return;
  const rule = enabledRule(provider.id, ctx.options || {});
  if (!rule) return;
  try {
    return filterResponsesRequest(body, {preserveEncryptedInclude: rule.preserveEncryptedInclude === true}).body;
  } catch {
    return;
  }
}
