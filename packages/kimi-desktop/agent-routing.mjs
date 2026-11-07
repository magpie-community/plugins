import crypto from 'node:crypto';

const RESPONSE_LIMIT = 32 * 1024 * 1024;
const PROFILE_SECTION = /^\[agent-profile-route:v1\]\r?\n([A-Za-z0-9_-]{1,5464}):([a-f0-9]{64})\r?\n\[\/agent-profile-route\](?=\r?$)/gm;
const CALL_INTENT = /^call_rs1_([a-f0-9]{16})_([dpsn])_([a-f0-9]{24})$/;
const INTENT_ROLES = { p: 'primary', s: 'secondary', n: 'native' };
const ROLE_DESCRIPTION = 'Available models (pass via model):\n'
  + '- primary: Use a new ordinary Work worker profile on the configured primary model; replaces subagent_type.\n'
  + '- secondary [default]: Use a new ordinary Work worker profile on the configured secondary model; replaces subagent_type.\n'
  + '- native: Preserve the supplied native subagent_type and its specialized behavior. '
  + 'Resumed and forked agents keep their existing profile and model binding for every selection.';
const MODEL_DESCRIPTION = 'Optional selection for a new subagent. primary or secondary uses a new ordinary Work worker '
  + 'profile and replaces subagent_type. When omitted, secondary is used. native preserves the supplied native '
  + 'subagent_type. Resuming or forking keeps the existing profile and model binding.';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => Object.assign(Error(code), { code });
const modelID = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/[\x00-\x1f]/.test(value);
const bounded = text => {
  if (Buffer.byteLength(text) > RESPONSE_LIMIT) throw failure('agent_routing_response_too_large');
  return text;
};

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

  constructor({ secret }) {
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret)) {
      throw failure('agent_routing_invalid_secret');
    }
    this.#key = Buffer.from(secret, 'hex');
  }

  #mac(encoded) {
    return crypto.createHmac('sha256', this.#key).update('agent-profile-route:v1:' + encoded).digest();
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

  profileName(model) {
    if (!modelID(model)) throw failure('model_not_enabled_for_kimi');
    return 'local-agent-' + crypto.createHash('sha256').update(model).digest('hex').slice(0, 24);
  }

  profileText(model) {
    const name = this.profileName(model);
    const encoded = Buffer.from(model).toString('base64url');
    return '---\n'
      + `name: ${name}\n`
      + 'description: Ordinary Work worker for an assigned task.\n'
      + 'tools: ["*"]\n'
      + 'disallowedTools: ["Agent", "AgentSwarm"]\n'
      + 'subagents: []\n'
      + '---\n\n'
      + '${base_prompt}\n\n'
      + `[agent-profile-route:v1]\n${encoded}:${this.#mac(encoded).toString('hex')}\n[/agent-profile-route]\n\n`
      + 'Complete only the task assigned by the parent agent. Work within the inherited tool permissions, '
      + 'and return the result to the parent for handoff. Do not launch or coordinate additional agents.\n';
  }

  #strip(text) {
    let model = null;
    const clean = text.replace(PROFILE_SECTION, (section, encoded, signature) => {
      if (!crypto.timingSafeEqual(this.#mac(encoded), Buffer.from(signature, 'hex'))) return section;
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!modelID(decoded) || Buffer.from(decoded).toString('base64url') !== encoded) return section;
      model = decoded;
      return '';
    });
    return { text: clean, model };
  }

  prepare(payload, { primaryModel, allowedModels }) {
    let binding = null, translateResponse = false;
    const messages = Array.isArray(payload.messages) ? payload.messages.map(message => {
      if (message?.role === 'system' || message?.role === 'developer') {
        const cleanText = text => {
          const clean = this.#strip(text);
          if (clean.model !== null) binding = clean.model;
          return clean.text;
        };
        if (typeof message.content === 'string') return { ...message, content: cleanText(message.content) };
        if (Array.isArray(message.content)) return { ...message, content: message.content.map(part =>
          part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: cleanText(part.text) } : part) };
      }
      if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls.map(call => this.#restoreIntent(call));
        if (calls.some((call, index) => call !== message.tool_calls[index])) return { ...message, tool_calls: calls };
      }
      return message;
    }) : payload.messages;
    const tools = Array.isArray(payload.tools) ? payload.tools.map(tool => {
      if (!nativeAgent(tool)) return tool;
      translateResponse = true;
      return roleTool(tool);
    }) : payload.tools;
    const model = binding ?? primaryModel;
    if (!modelID(model) || !Array.isArray(allowedModels) || !allowedModels.includes(model)) {
      throw failure('model_not_enabled_for_kimi');
    }
    return { payload: { ...payload, model,
      ...(Array.isArray(messages) ? { messages } : {}), ...(Array.isArray(tools) ? { tools } : {}),
    }, model, translateResponse };
  }

  #translateCall(call, { primaryModel, secondaryModel }) {
    if (call?.type !== 'function' || call.function?.name !== 'Agent') return call;
    let args;
    try { args = JSON.parse(call.function.arguments); }
    catch { throw failure('agent_routing_invalid_arguments'); }
    if (!record(args) || typeof args.prompt !== 'string' || typeof args.description !== 'string'
        || (Object.hasOwn(args, 'model') && !['primary', 'secondary', 'native'].includes(args.model))) {
      throw failure('agent_routing_invalid_arguments');
    }
    const role = args.model ?? 'secondary';
    const translated = { ...args };
    delete translated.model;
    if (role !== 'native' && !(typeof args.resume === 'string' && args.resume.length > 0) && args.fork !== true) {
      translated.subagent_type = this.profileName(role === 'primary' ? primaryModel : secondaryModel || primaryModel);
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
        throw failure('agent_routing_invalid_stream');
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
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const pending = new Map(), finished = new Set();
    let inputBytes = 0, outputBytes = 0, buffer = '', errored = false;
    const output = text => {
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > RESPONSE_LIMIT) throw failure('agent_routing_response_too_large');
      return text;
    };
    const append = (choiceIndex, fragment) => {
      if (!record(fragment) || !Number.isSafeInteger(fragment.index) || fragment.index < 0
          || finished.has(choiceIndex)) throw failure('agent_routing_invalid_stream');
      if (!pending.has(choiceIndex)) pending.set(choiceIndex, new Map());
      const calls = pending.get(choiceIndex);
      if (!calls.has(fragment.index)) calls.set(fragment.index, { fields: { index: fragment.index },
        fn: {}, ids: [], names: [], args: [], hasID: false, hasName: false, hasArgs: false });
      const call = calls.get(fragment.index);
      for (const [key, value] of Object.entries(fragment)) {
        if (key !== 'id' && key !== 'function') call.fields[key] = value;
      }
      if (Object.hasOwn(fragment, 'id')) {
        if (typeof fragment.id !== 'string') throw failure('agent_routing_invalid_stream');
        call.hasID = true; call.ids.push(fragment.id);
      }
      if (Object.hasOwn(fragment, 'function')) {
        if (!record(fragment.function)) throw failure('agent_routing_invalid_stream');
        for (const [key, value] of Object.entries(fragment.function)) {
          if (key === 'name' || key === 'arguments') {
            if (typeof value !== 'string') throw failure('agent_routing_invalid_stream');
            if (key === 'name') { call.hasName = true; call.names.push(value); }
            else { call.hasArgs = true; call.args.push(value); }
          } else call.fn[key] = value;
        }
      }
    };
    const flush = (choiceIndex, finishReason) => {
      const result = [];
      let size = 0;
      for (const call of pending.get(choiceIndex).values()) {
        const full = { ...call.fields, ...(call.hasID ? { id: call.ids.join('') } : {}), function: {
          ...call.fn, ...(call.hasName ? { name: call.names.join('') } : {}),
          ...(call.hasArgs ? { arguments: call.args.join('') } : {}),
        } };
        if (full.function.name === 'Agent' && !['tool_calls', 'stop'].includes(finishReason)) {
          throw failure('agent_routing_invalid_stream');
        }
        const translated = this.#translateCall(full, models);
        size += Buffer.byteLength(JSON.stringify(translated));
        if (size + outputBytes > RESPONSE_LIMIT) throw failure('agent_routing_response_too_large');
        result.push(translated);
      }
      pending.delete(choiceIndex);
      finished.add(choiceIndex);
      return result;
    };
    const event = (frame, delimiter) => {
      const lines = frame.split(/\r?\n/);
      const data = [], dataLines = [];
      let eventName = '';
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line === 'data' || line.startsWith('data:')) {
          data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, '')); dataLines.push(index);
        } else if (line.startsWith('event:')) eventName = line.slice(6).replace(/^ /, '');
      }
      if (!dataLines.length) return { text: frame + delimiter };
      const text = data.join('\n');
      if (text.trim() === '[DONE]') {
        if (pending.size) throw failure('agent_routing_invalid_stream');
        return { text: frame + delimiter, done: true };
      }
      if (!text.trim()) return { text: frame + delimiter };
      let value;
      try { value = JSON.parse(text); } catch { throw failure('agent_routing_invalid_stream'); }
      if (eventName === 'error' || (record(value) && Object.hasOwn(value, 'error'))) {
        pending.clear(); errored = true;
        return { text: frame + delimiter };
      }
      if (!Array.isArray(value?.choices)) return { text: frame + delimiter };
      let changed = false;
      const choices = value.choices.map(choice => {
        if (!record(choice)) throw failure('agent_routing_invalid_stream');
        const fragments = choice.delta?.tool_calls;
        if (fragments !== undefined && !Array.isArray(fragments)) throw failure('agent_routing_invalid_stream');
        if (!fragments?.length && !pending.has(choice.index)) return choice;
        if (errored || !Number.isSafeInteger(choice.index) || choice.index < 0) {
          throw failure('agent_routing_invalid_stream');
        }
        for (const fragment of fragments || []) append(choice.index, fragment);
        const delta = { ...choice.delta };
        delete delta.tool_calls;
        if (choice.finish_reason !== null && choice.finish_reason !== undefined && pending.has(choice.index)) {
          delta.tool_calls = flush(choice.index, choice.finish_reason);
        }
        changed = true;
        return { ...choice, delta };
      });
      if (!changed) return { text: frame + delimiter };
      const serialized = bounded(JSON.stringify({ ...value, choices }));
      const first = dataLines[0], indexes = new Set(dataLines);
      return { text: lines.flatMap((line, index) => index === first ? ['data: ' + serialized]
        : indexes.has(index) ? [] : [line]).join('\n') + '\n\n' };
    };
    for await (const chunk of body) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      inputBytes += bytes.byteLength;
      if (inputBytes > RESPONSE_LIMIT) throw failure('agent_routing_response_too_large');
      try { buffer += decoder.decode(bytes, { stream: true }); }
      catch { throw failure('agent_routing_invalid_stream'); }
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const result = event(frame, boundary[0]);
        yield output(result.text);
        if (result.done) return;
      }
    }
    try { buffer += decoder.decode(); } catch { throw failure('agent_routing_invalid_stream'); }
    if (buffer.trim() || pending.size) throw failure('agent_routing_invalid_stream');
  }
}
