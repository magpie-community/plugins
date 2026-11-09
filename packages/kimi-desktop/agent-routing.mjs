import crypto from 'node:crypto';

const RESPONSE_LIMIT = 32 * 1024 * 1024;
const PROFILE_SECTION = /\[agent-profile-route:v1\][\s\S]*?\[\/agent-profile-route\]/g;
const PROFILE_BINDING = /^\[agent-profile-route:v1\]\r?\n([A-Za-z0-9_-]{43}):([a-f0-9]{64})\r?\n\[\/agent-profile-route\]$/;
const RESERVED_PROFILE = /\[\/?agent-profile-route\b/i;
const ROUTE_MARKER = /\[(?=\/?agent-profile-route)/gi;
const ABSENCE_COUNT_THRESHOLD = 3;
const ABSENCE_WINDOW_MS = 600000;
const PROFILE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CALL_INTENT = /^call_rs1_([a-f0-9]{16})_([dpsn])_([a-f0-9]{24})$/;
const INTENT_ROLES = { p: 'primary', s: 'secondary', n: 'native' };
const ROLE_DESCRIPTION = 'Available models (pass via model):\n'
  + '- primary: Use a new ordinary Work worker profile on the configured primary model; replaces subagent_type.\n'
  + '- secondary [default]: Use a new ordinary Work worker profile on the configured secondary model; replaces subagent_type. '
  + 'The default applies only when both model and subagent_type are omitted.\n'
  + '- native: Preserve the supplied native subagent_type and its specialized behavior. '
  + 'Omitting model preserves an explicit native subagent_type. '
  + 'Resumed and forked agents keep their existing profile and model binding for every selection.';
const MODEL_DESCRIPTION = 'Optional selection for a new subagent. primary or secondary uses a new ordinary Work worker '
  + 'profile and replaces subagent_type. When both model and subagent_type are omitted, secondary is used. '
  + 'Omitting model preserves an explicit native subagent_type. native preserves the supplied native '
  + 'subagent_type. Resuming or forking keeps the existing profile and model binding.';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => Object.assign(Error(code), { code });
const modelID = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/[\x00-\x1f]/.test(value);
const scopedRole = value => value === 'primary' || value === 'secondary';
const bounded = text => {
  if (Buffer.byteLength(text) > RESPONSE_LIMIT) throw failure('agent_routing_response_too_large');
  return text;
};

function neutralizeText(text) {
  return text.replace(ROUTE_MARKER, '');
}

// Removes the leading bracket from route markers in any non-identity string
// without authenticating or binding it. Non-destructive and reference-
// preserving: unchanged data keeps its original reference, and function values
// are never called, so any marker produced only at JSON.stringify time (e.g. a
// toJSON hook) still trips the serialized reserved-marker guard.
export function neutralizeRouteMarkers(value) {
  if (typeof value === 'string') return neutralizeText(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = new Array(value.length);
    for (let index = 0; index < value.length; index++) {
      const item = neutralizeRouteMarkers(value[index]);
      if (item !== value[index]) changed = true;
      next[index] = item;
    }
    return changed ? next : value;
  }
  if (record(value)) {
    let changed = false;
    const entries = [];
    for (const [key, entry] of Object.entries(value)) {
      const nextKey = neutralizeText(key);
      const nextEntry = neutralizeRouteMarkers(entry);
      if (nextKey !== key || nextEntry !== entry) changed = true;
      entries.push([nextKey, nextEntry]);
    }
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

function nativeAgent(tool) {
  const schema = tool?.function?.parameters;
  return tool?.type === 'function' && tool.function.name === 'Agent' && schema?.type === 'object'
    && record(schema.properties) && schema.properties.prompt?.type === 'string'
    && schema.properties.description?.type === 'string' && Array.isArray(schema.required)
    && schema.required.includes('prompt') && schema.required.includes('description');
}

function roleTool(tool) {
  const fn = tool.function, schema = fn.parameters;
  const original = typeof fn.description === 'string' ? fn.description : '';
  const models = /^Available models \(pass via model\):[^\S\r\n]*(?:\r?\n-[^\r\n]*)*/gm;
  const description = models.test(original) ? original.replace(models, ROLE_DESCRIPTION)
    : original + (original ? '\n\n' : '') + ROLE_DESCRIPTION;
  return { ...tool, function: { ...fn, description, parameters: { ...schema,
    properties: { ...schema.properties, model: {
      type: 'string', enum: ['primary', 'secondary', 'native'], description: MODEL_DESCRIPTION,
    } }, required: schema.required.filter(name => name !== 'model'),
  } } };
}

// Only an authenticated section in a profile's system/developer prompt selects
// a model. Native compaction keeps this prompt even after discarding all chat
// history. The caller owns key/profile persistence; this module has no I/O.
export class AgentModelRouter {
  #key;
  #namespace;
  #bindings = new Map();
  #roles = new Map();
  #absence = new Map();

  constructor({ secret, bindings = {}, roles = {}, absence = {} }) {
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret)) {
      throw failure('agent_routing_invalid_secret');
    }
    this.#key = Buffer.from(secret, 'hex');
    this.#namespace = crypto.createHash('sha256').update(secret.toLowerCase()).digest('hex').slice(0, 12);
    if (!record(bindings)) throw failure('agent_profile_unbound');
    for (const [token, model] of Object.entries(bindings)) {
      if (!PROFILE_TOKEN.test(token) || !modelID(model)) throw failure('agent_profile_unbound');
      this.#bindings.set(token, model);
    }
    if (!record(roles)) throw failure('agent_profile_unbound');
    for (const [token, role] of Object.entries(roles)) {
      // A role extends an owned token; it cannot introduce a route of its own.
      if (!this.#bindings.has(token) || !scopedRole(role)) throw failure('agent_profile_unbound');
      this.#roles.set(token, role);
    }
    if (!record(absence)) throw failure('agent_profile_unbound');
    for (const [model, entry] of Object.entries(absence)) {
      if (!modelID(model) || !record(entry)
          || !Number.isSafeInteger(entry.count) || entry.count < 0
          || !Number.isSafeInteger(entry.firstMissingAt) || entry.firstMissingAt < 0) {
        throw failure('agent_profile_unbound');
      }
      this.#absence.set(model, { count: entry.count, firstMissingAt: entry.firstMissingAt });
    }
  }

  get namespace() { return this.#namespace; }
  get bindings() { return Object.fromEntries(this.#bindings); }
  get roles() { return Object.fromEntries(this.#roles); }
  get boundModels() { return [...new Set(this.#bindings.values())]; }
  get boundProfiles() {
    const profiles = new Map();
    for (const [token, model] of this.#bindings) {
      const role = this.#roles.get(token);
      profiles.set(JSON.stringify([model, role ?? null]), { model, ...(role ? { role } : {}) });
    }
    return [...profiles.values()];
  }
  get absence() { return Object.fromEntries([...this.#absence].map(([model, entry]) => [model, { ...entry }])); }

  #token(model, role) {
    for (const [token, bound] of this.#bindings) {
      if (bound === model && this.#roles.get(token) === role) return token;
    }
    let token;
    do { token = crypto.randomBytes(32).toString('base64url'); } while (this.#bindings.has(token));
    this.#bindings.set(token, model);
    if (role !== undefined) this.#roles.set(token, role);
    return token;
  }

  registerModels(models, allowedModels) {
    if (!Array.isArray(models) || !Array.isArray(allowedModels)
        || models.some(model => !modelID(model) || !allowedModels.includes(model))) {
      throw failure('model_not_enabled_for_kimi');
    }
    // Only validate and pre-allocate. Pruning and absence counting happen in
    // observeCatalog after a successful catalog sync.
    for (const model of models) this.#token(model);
    return this.bindings;
  }

  registerRoles(models, allowedModels) {
    if (!record(models) || !Array.isArray(allowedModels)
        || !modelID(models.primaryModel) || !allowedModels.includes(models.primaryModel)
        || (models.secondaryModel !== undefined && models.secondaryModel !== ''
          && (!modelID(models.secondaryModel) || !allowedModels.includes(models.secondaryModel)))) {
      throw failure('model_not_enabled_for_kimi');
    }
    return {
      primary: this.#token(models.primaryModel, 'primary'),
      secondary: this.#token(models.secondaryModel || models.primaryModel, 'secondary'),
    };
  }

  observeCatalog(allowedModels, { now = Date.now(), allowRetirement = true } = {}) {
    if (!Array.isArray(allowedModels) || !Number.isSafeInteger(now) || now < 0) {
      throw failure('model_not_enabled_for_kimi');
    }
    for (const model of this.boundModels) {
      if (allowedModels.includes(model)) {
        // Present again: clear any absence immediately and keep the original token.
        this.#absence.delete(model);
      } else {
        const entry = this.#absence.get(model);
        const count = Math.min((entry?.count ?? 0) + 1, ABSENCE_COUNT_THRESHOLD);
        const firstMissingAt = entry?.firstMissingAt ?? now;
        this.#absence.set(model, { count, firstMissingAt });
        if (allowRetirement && count >= ABSENCE_COUNT_THRESHOLD && now - firstMissingAt >= ABSENCE_WINDOW_MS) {
          for (const [token, bound] of [...this.#bindings]) if (bound === model) {
            this.#bindings.delete(token);
            this.#roles.delete(token);
          }
          this.#absence.delete(model);
        }
      }
    }
    return { bindings: this.bindings, absence: this.absence };
  }

  #mac(token) {
    return crypto.createHmac('sha256', this.#key).update('agent-profile-route:v1:' + token).digest();
  }

  #intentMAC(nonce, code, args) {
    const subtype = Object.hasOwn(args, 'subagent_type') ? args.subagent_type : '';
    return crypto.createHmac('sha256', this.#key).update('agent-call-intent:v1:')
      .update(JSON.stringify([nonce, code, subtype])).digest().subarray(0, 12);
  }

  #intentID(code, args) {
    const nonce = crypto.randomBytes(8).toString('hex');
    return `call_rs1_${nonce}_${code}_${this.#intentMAC(nonce, code, args).toString('hex')}`;
  }

  // Native history stores the translated arguments. Authenticate the original
  // selection in the opaque call ID so an audit can distinguish an omitted
  // default from an explicit role. IDs never establish a request's route.
  #restoreIntent(call) {
    if (call?.type !== 'function' || call.function?.name !== 'Agent'
        || typeof call.id !== 'string' || typeof call.function.arguments !== 'string') return call;
    const match = CALL_INTENT.exec(call.id);
    if (!match) return call;
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { return call; }
    if (!record(args) || Object.hasOwn(args, 'model')
        || !crypto.timingSafeEqual(this.#intentMAC(match[1], match[2], args), Buffer.from(match[3], 'hex'))
        || match[2] === 'd') return call;
    return { ...call, function: { ...call.function,
      arguments: JSON.stringify({ ...args, model: INTENT_ROLES[match[2]] }),
    } };
  }

  profileName(model, role) {
    if (!modelID(model) || (role !== undefined && !scopedRole(role))) throw failure('model_not_enabled_for_kimi');
    const identity = role === undefined ? 'agent-profile-name:v1:' + model
      : 'agent-profile-name:v2:' + JSON.stringify([model, role]);
    return 'local-agent-' + this.#namespace + '-'
      + crypto.createHmac('sha256', this.#key).update(identity).digest('hex').slice(0, 24);
  }

  profileText(model, role) {
    const name = this.profileName(model, role);
    const token = this.#token(model, role);
    return '---\n'
      + `name: ${name}\n`
      + 'description: Ordinary Work worker for an assigned task.\n'
      + 'tools: ["*"]\n'
      + 'disallowedTools: ["Agent", "AgentSwarm"]\n'
      + 'subagents: []\n'
      + '---\n\n'
      + '${base_prompt}\n\n'
      + `[agent-profile-route:v1]\n${token}:${this.#mac(token).toString('hex')}\n[/agent-profile-route]\n\n`
      + 'Complete only the task assigned by the parent agent. Work within the inherited tool permissions, '
      + 'and return the result to the parent for handoff. Do not launch or coordinate additional agents.\n';
  }

  #strip(text) {
    let model = null, role, invalid = false;
    const clean = text.replace(PROFILE_SECTION, (section, offset) => {
      const match = PROFILE_BINDING.exec(section);
      const end = offset + section.length;
      // MUTATION protocol-auth: malformed, foreign, and unknown routes never fall back.
      if (!match || (offset > 0 && text[offset - 1] !== '\n')
          || (end < text.length && !/^\r?\n/.test(text.slice(end)))
          || !this.#bindings.has(match[1])
          || !crypto.timingSafeEqual(this.#mac(match[1]), Buffer.from(match[2], 'hex'))) invalid = true;
      else {
        model = this.#bindings.get(match[1]);
        role = this.#roles.get(match[1]);
      }
      return '';
    });
    if (invalid || RESERVED_PROFILE.test(clean)) throw failure('agent_profile_unbound');
    return { text: clean, model, role };
  }

  prepare(payload, { primaryModel, allowedModels, enableRoles = true, includeRouteRole = false }) {
    let binding = null, routeRole, translateResponse = false;
    const messages = Array.isArray(payload.messages) ? payload.messages.map(message => {
      if (message?.role === 'system' || message?.role === 'developer') {
        const cleanText = text => {
          const clean = this.#strip(text);
          if (clean.model !== null) {
            binding = clean.model;
            routeRole = clean.role;
          }
          return clean.text;
        };
        if (typeof message.content === 'string') return { ...message, content: cleanText(message.content) };
        if (Array.isArray(message.content)) return { ...message, content: message.content.map(part =>
          part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: cleanText(part.text) } : part) };
      }
      if (enableRoles && message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls.map(call => this.#restoreIntent(call));
        if (calls.some((call, index) => call !== message.tool_calls[index])) return { ...message, tool_calls: calls };
      }
      return message;
    }) : payload.messages;
    const tools = enableRoles && Array.isArray(payload.tools) ? payload.tools.map(tool => {
      if (!nativeAgent(tool)) return tool;
      translateResponse = true;
      return roleTool(tool);
    }) : payload.tools;
    const model = binding ?? primaryModel;
    if (binding !== null && (!Array.isArray(allowedModels) || !allowedModels.includes(binding))) {
      throw failure('agent_profile_unbound');
    }
    if (!modelID(model) || !Array.isArray(allowedModels) || !allowedModels.includes(model)) {
      throw failure('model_not_enabled_for_kimi');
    }
    const prepared = { ...payload, model,
      ...(Array.isArray(messages) ? { messages } : {}), ...(Array.isArray(tools) ? { tools } : {}),
    };
    // Identity text is already authenticated and stripped above; every other
    // field is neutralized rather than bound. The serialized boundary guard
    // still rejects any residual reserved marker, including one produced only
    // at JSON.stringify time such as a toJSON hook.
    const neutralized = neutralizeRouteMarkers(prepared);
    if (RESERVED_PROFILE.test(JSON.stringify(neutralized))) throw failure('agent_profile_unbound');
    return { payload: neutralized, model, translateResponse,
      ...(routeRole ? { routeRole } : includeRouteRole && binding !== null ? { routeRole: null } : {}) };
  }

  #translateCall(call, { primaryModel, secondaryModel, roleOptionsEnabled = false }) {
    if (call?.type !== 'function' || call.function?.name !== 'Agent') return call;
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch { return call; }
    if (!record(args) || typeof args.prompt !== 'string' || typeof args.description !== 'string'
        || (Object.hasOwn(args, 'model') && !['primary', 'secondary', 'native'].includes(args.model))) {
      return call;
    }
    // MUTATION protocol-native: an explicitly supplied native profile is not a default worker.
    const role = args.model ?? (Object.hasOwn(args, 'subagent_type') ? 'native' : 'secondary');
    const translated = { ...args };
    delete translated.model;
    if (role !== 'native' && !(typeof args.resume === 'string' && args.resume.length > 0) && args.fork !== true) {
      translated.subagent_type = this.profileName(role === 'primary' ? primaryModel : secondaryModel || primaryModel,
        roleOptionsEnabled === true ? role : undefined);
    }
    const code = Object.hasOwn(args, 'model') ? { primary: 'p', secondary: 's', native: 'n' }[args.model] : 'd';
    return { ...call, id: this.#intentID(code, translated),
      function: { ...call.function, arguments: bounded(JSON.stringify(translated)) } };
  }

  transformJSON(completion, models) {
    bounded(JSON.stringify(completion));
    if (!Array.isArray(completion?.choices)) return completion;
    const choices = completion.choices.map(choice => {
      if (!Array.isArray(choice?.message?.tool_calls)) return choice;
      if (choice.message.tool_calls.some(call => call?.type === 'function' && call.function?.name === 'Agent')
          && ['length', 'content_filter', 'error', 'cancelled'].includes(choice.finish_reason)) {
        return choice;
      }
      return { ...choice, message: { ...choice.message,
        tool_calls: choice.message.tool_calls.map(call => this.#translateCall(call, models)),
      } };
    });
    const result = { ...completion, choices };
    bounded(JSON.stringify(result));
    return result;
  }

  async *transformSSE(body, models) {
    const decoder = new TextDecoder('utf-8');
    const pending = new Map(), native = new Map(), passthrough = new Set(), finished = new Set(), envelopes = new Map();
    let inputBytes = 0, outputBytes = 0, buffer = '', sequence = 0, raw = false;
    const output = text => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > RESPONSE_LIMIT) throw failure('agent_routing_response_too_large');
      return text;
    };
    const validFragment = fragment => record(fragment) && Number.isSafeInteger(fragment.index) && fragment.index >= 0
      && (!Object.hasOwn(fragment, 'id') || typeof fragment.id === 'string')
      && (!Object.hasOwn(fragment, 'function') || (record(fragment.function)
        && ['name', 'arguments'].every(key => !Object.hasOwn(fragment.function, key)
          || typeof fragment.function[key] === 'string')));
    const release = choiceIndex => {
      const calls = pending.get(choiceIndex);
      pending.delete(choiceIndex);
      return calls ? [...calls.values()].flatMap(call => call.fragments)
        .sort((a, b) => a.sequence - b.sequence).map(entry => entry.fragment) : [];
    };
    const synthetic = (choiceIndex, calls, finishReason = null) => 'data: '
      + JSON.stringify({ ...envelopes.get(choiceIndex), choices: [{ index: choiceIndex,
        delta: { tool_calls: calls }, finish_reason: finishReason }] }) + '\n\n';
    const releaseAll = () => [...pending.keys()].map(index => synthetic(index, release(index)));
    const append = (choiceIndex, fragment) => {
      if (native.get(choiceIndex)?.has(fragment.index)) return [fragment];
      if (!pending.has(choiceIndex)) pending.set(choiceIndex, new Map());
      const calls = pending.get(choiceIndex);
      if (!calls.has(fragment.index)) calls.set(fragment.index, { fields: {}, fn: {}, ids: [], names: [], args: [],
        fragments: [], hasID: false, hasName: false, hasArgs: false });
      const call = calls.get(fragment.index);
      call.fragments.push({ sequence: sequence++, fragment });
      for (const [key, value] of Object.entries(fragment)) {
        if (key !== 'id' && key !== 'function') call.fields[key] = value;
      }
      if (Object.hasOwn(fragment, 'id')) { call.hasID = true; call.ids.push(fragment.id); }
      if (Object.hasOwn(fragment, 'function')) {
        for (const [key, value] of Object.entries(fragment.function)) {
          if (key === 'name') { call.hasName = true; call.names.push(value); }
          else if (key === 'arguments') { call.hasArgs = true; call.args.push(value); }
          else call.fn[key] = value;
        }
      }
      // MUTATION protocol-incremental: only Agent and its unresolved name prefix wait.
      if (!'Agent'.startsWith(call.names.join('')) || (call.fields.type && call.fields.type !== 'function')) {
        calls.delete(fragment.index);
        if (!calls.size) pending.delete(choiceIndex);
        if (!native.has(choiceIndex)) native.set(choiceIndex, new Set());
        native.get(choiceIndex).add(fragment.index);
        return call.fragments.map(entry => entry.fragment);
      }
      return [];
    };
    const flush = (choiceIndex, finishReason) => {
      const calls = pending.get(choiceIndex);
      pending.delete(choiceIndex);
      native.delete(choiceIndex);
      finished.add(choiceIndex);
      return calls ? [...calls.values()].map(call => {
        const full = { ...call.fields, ...(call.hasID ? { id: call.ids.join('') } : {}), function: {
          ...call.fn, ...(call.hasName ? { name: call.names.join('') } : {}),
          ...(call.hasArgs ? { arguments: call.args.join('') } : {}),
        } };
        return ['tool_calls', 'stop'].includes(finishReason) ? this.#translateCall(full, models) : full;
      }) : [];
    };
    const event = (frame, delimiter) => {
      if (raw) return { texts: [frame + delimiter] };
      const lines = frame.split(/\r?\n/), data = [], dataLines = [];
      let eventName = '';
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line === 'data' || line.startsWith('data:')) {
          data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, '')); dataLines.push(index);
        } else if (line.startsWith('event:')) eventName = line.slice(6).replace(/^ /, '');
      }
      if (!dataLines.length) return { texts: [frame + delimiter] };
      const text = data.join('\n');
      if (text.trim() === '[DONE]') {
        // MUTATION protocol-done: missing finish_reason still releases every choice before DONE.
        const texts = [...pending.keys()].map(index => synthetic(index, flush(index, 'tool_calls'), 'tool_calls'));
        return { texts: [...texts, frame + delimiter], done: true };
      }
      if (!text.trim()) return { texts: [frame + delimiter] };
      let value;
      try { value = JSON.parse(text); }
      catch { raw = true; return { texts: [...releaseAll(), frame + delimiter] }; }
      if (eventName === 'error' || (record(value) && Object.hasOwn(value, 'error'))) {
        pending.clear(); native.clear(); raw = true;
        return { texts: [frame + delimiter] };
      }
      if (!Array.isArray(value?.choices)) return { texts: [frame + delimiter] };
      if (value.choices.some(choice => !record(choice)
          || ((choice.delta?.tool_calls !== undefined || pending.has(choice.index))
            && (!Number.isSafeInteger(choice.index) || choice.index < 0)))) {
        raw = true;
        return { texts: [...releaseAll(), frame + delimiter] };
      }
      const { choices: ignoredChoices, usage: ignoredUsage, ...envelope } = value;
      let changed = false;
      const prefixes = [];
      const choices = value.choices.map(choice => {
        const fragments = choice.delta?.tool_calls;
        if (passthrough.has(choice.index) || finished.has(choice.index)) return choice;
        envelopes.set(choice.index, envelope);
        // MUTATION protocol-index: untrackable native fragments do not abort a whole turn.
        if (fragments !== undefined && (!Array.isArray(fragments) || !fragments.every(validFragment))) {
          passthrough.add(choice.index);
          const held = release(choice.index);
          if (!held.length) return choice;
          if (!Array.isArray(fragments)) {
            prefixes.push(synthetic(choice.index, held));
            return choice;
          }
          changed = true;
          return { ...choice, delta: { ...choice.delta, tool_calls: [...held, ...fragments] } };
        }
        if (!fragments?.length && !pending.has(choice.index)) {
          if (choice.finish_reason != null) { finished.add(choice.index); native.delete(choice.index); }
          return choice;
        }
        const forwarded = (fragments || []).flatMap(fragment => append(choice.index, fragment));
        if (choice.finish_reason != null) forwarded.push(...flush(choice.index, choice.finish_reason));
        if (forwarded.length === (fragments?.length || 0)
            && forwarded.every((fragment, index) => fragment === fragments[index])) return choice;
        const delta = { ...choice.delta };
        if (forwarded.length) delta.tool_calls = forwarded;
        else delete delta.tool_calls;
        changed = true;
        return { ...choice, delta };
      });
      if (!changed) return { texts: [...prefixes, frame + delimiter] };
      const serialized = bounded(JSON.stringify({ ...value, choices }));
      const first = dataLines[0], indexes = new Set(dataLines), newline = delimiter.startsWith('\r\n') ? '\r\n' : '\n';
      return { texts: [...prefixes, lines.flatMap((line, index) => index === first ? ['data: ' + serialized]
        : indexes.has(index) ? [] : [line]).join(newline) + delimiter] };
    };
    for await (const chunk of body) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      inputBytes += bytes.byteLength;
      if (inputBytes > RESPONSE_LIMIT) throw failure('agent_routing_response_too_large');
      buffer += decoder.decode(bytes, { stream: true });
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const result = event(frame, boundary[0]);
        for (const text of result.texts) yield output(text);
        if (result.done) return;
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const result = event(buffer, '');
      for (const text of result.texts) yield output(text);
      if (result.done) return;
    }
    for (const text of releaseAll()) yield output(text);
  }
}
