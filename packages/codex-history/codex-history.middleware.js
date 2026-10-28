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

export function onRequest(body, ctx) {
  if (ctx.protocol !== 'responses' || !body || typeof body.model !== 'string' || !/^[^/]+\/.+/.test(body.model)) return;
  const prefix = body.model.split('/')[0];
  const options = ctx.options || {};
  const aliases = options.aliases || {};
  const id = Object.prototype.hasOwnProperty.call(aliases, prefix) ? aliases[prefix] : prefix;
  const rules = options.providers || {};
  const rule = rules['magpie:' + id];
  if (!Object.prototype.hasOwnProperty.call(rules, 'magpie:' + id) || rule?.historyFilter !== true) return;
  try {
    if (/\/compact\/?$/.test(ctx.path || '')) {
      ctx.reject(409, 'Codex history filter: encrypted compaction cannot cross resources. Use a text summary and a new session.');
      return;
    }
    return filterResponsesRequest(body, {preserveEncryptedInclude: rule.preserveEncryptedInclude === true}).body;
  } catch (error) {
    // Explicit rejection is required: Magpie forwards the original request if
    // a hook throws. Never silently discard non-portable context references.
    ctx.reject(error instanceof FilterError ? error.status : 409,
      'Codex history filter: ' + (error instanceof FilterError ? error.message : 'history could not be safely filtered.'));
  }
}

// Some strict OpenAI-compatible upstreams require a tool schema whose root is
// an object. Codex's automation_update uses a root union, so providers can opt
// into folding that declaration. The hook runs per provider try, which is
// important for groups and fallbacks: only one candidate's attempt changes.
function schemaMap(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function hasRootUnion(schema) {
  return Object.hasOwn(schema, 'anyOf') || Object.hasOwn(schema, 'oneOf') || Object.hasOwn(schema, 'allOf');
}
function resolveSchemaRef(root, branch) {
  if (!schemaMap(branch) || typeof branch.$ref !== 'string') return branch;
  for (const section of ['$defs', 'definitions']) {
    const prefix = '#/' + section + '/';
    if (!branch.$ref.startsWith(prefix)) continue;
    const found = root?.[section]?.[branch.$ref.slice(prefix.length)];
    return schemaMap(found) ? found : null;
  }
  return null;
}
function appendDistinct(values, value) {
  const key = JSON.stringify(value);
  if (!values.some(existing => JSON.stringify(existing) === key)) values.push(value);
}
function objectRootIn(root, schema, depth) {
  if (!schemaMap(schema)) return false;
  if (schema.type === 'object' && !hasRootUnion(schema)) return false;
  const props = schemaMap(schema.properties) ? {...schema.properties} : {};
  const required = Array.isArray(schema.required) ? [...schema.required] : [];
  if (Array.isArray(schema.allOf)) {
    for (const raw of schema.allOf) {
      const branch = resolveSchemaRef(root, raw);
      if (!schemaMap(branch)) continue;
      if (schemaMap(branch.properties)) {
        for (const key of Object.keys(branch.properties)) {
          if (!Object.hasOwn(props, key)) props[key] = branch.properties[key];
        }
      }
      if (Array.isArray(branch.required)) required.push(...branch.required);
    }
  }
  delete schema.allOf;
  const branches = [];
  for (const key of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[key])) continue;
    for (const raw of schema[key]) {
      let branch = resolveSchemaRef(root, raw);
      if (!schemaMap(branch)) continue;
      if (hasRootUnion(branch) && depth < 8) {
        branch = JSON.parse(JSON.stringify(branch));
        objectRootIn(root, branch, depth + 1);
      }
      if (branch.type !== 'object' && !Object.hasOwn(branch, 'properties')) continue;
      branches.push(branch);
    }
    delete schema[key];
  }
  const from = new Map();
  let common = null;
  for (const branch of branches) {
    if (schemaMap(branch.properties)) {
      for (const [key, value] of Object.entries(branch.properties)) {
        if (Object.hasOwn(props, key)) continue;
        if (!from.has(key)) from.set(key, []);
        appendDistinct(from.get(key), value);
      }
    }
    const branchRequired = Array.isArray(branch.required) ? branch.required : [];
    common = common === null ? [...branchRequired] : common.filter(name => branchRequired.includes(name));
  }
  for (const [key, variants] of from) props[key] = variants.length === 1 ? variants[0] : {anyOf: variants};
  const merged = [];
  for (const name of [...required, ...(common || [])]) {
    if (!merged.some(existing => JSON.stringify(existing) === JSON.stringify(name))) merged.push(name);
  }
  schema.type = 'object';
  schema.properties = props;
  if (merged.length) schema.required = merged;
  else delete schema.required;
  return true;
}
function collectCompatibility(tools, found) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!schemaMap(tool)) continue;
    const target = schemaMap(tool.function) ? tool.function : tool;
    const name = target.name || tool.name;
    if (typeof name === 'string' && /automation_update$/i.test(name)) {
      for (const key of ['parameters', 'input_schema', 'inputSchema']) {
        if (schemaMap(target[key])) found.push(target[key]);
      }
    }
    collectCompatibility(tool.tools, found);
  }
}

// Magpie chooses this rule by the provider actually being tried. It is kept
// independent of historyFilter so users can disable history cleanup while
// retaining the strict DeepSeek wire compatibility.
export function onProvider(body, ctx) {
  const provider = ctx?.provider;
  if (!body || typeof provider?.id !== 'string') return;
  const model = (typeof provider.model === 'string' ? provider.model : body.model) || '';
  if (!/^deepseek(?:[-/]|$)/i.test(model)) return;
  const options = ctx.options || {};
  const aliases = options.aliases || {};
  const id = Object.prototype.hasOwnProperty.call(aliases, provider.id) ? aliases[provider.id] : provider.id;
  const rule = (options.providers || {})['magpie:' + id];
  // DeepSeek protocol compatibility is opt-in per provider; no ID is special.
  if (rule?.deepSeekObjectRoot !== true) return;
  const compatibility = [];
  collectCompatibility(body.tools, compatibility);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === 'tool_search_output' || item?.type === 'additional_tools') {
        collectCompatibility(item.tools, compatibility);
      }
    }
  }
  let changed = false;
  for (const schema of compatibility) if (objectRootIn(schema, schema, 0)) changed = true;
  return changed ? body : undefined;
}
