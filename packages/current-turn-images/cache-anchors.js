import {visitImages} from './filter.js';

// Explicit opt-in only. Existing client cache policy wins.
export function addCacheAnchors(body, ctx) {
  const models = ctx.options?.cacheAnchors?.[ctx.protocol] || [];
  if (!Array.isArray(models) || !models.includes(ctx.model || body.model)) return {body, added: 0};
  if (ctx.protocol === 'anthropic') return addAnthropicAnchor(body);
  if (ctx.protocol !== 'responses') return {body, added: 0};
  if (!Array.isArray(body.input) || body.prompt_cache_options?.mode === 'explicit') return {body, added: 0};
  const pending = [body];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'prompt_cache_breakpoint' || key === 'cache_control') return {body, added: 0};
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  let preceding;
  let selected;
  outer: for (let messageIndex = 0; messageIndex < body.input.length; messageIndex++) {
    const message = body.input[messageIndex];
    if (!message) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (let partIndex = 0; partIndex < content.length; partIndex++) {
      const part = message.content[partIndex];
      if (['user', 'developer', 'system'].includes(message.role) && part?.type === 'input_text' && part.text) preceding = {messageIndex, partIndex, field: 'content'};
      let hasImage = false;
      visitImages(part, ctx.protocol, () => { hasImage = true; });
      if (hasImage) {
        selected = preceding;
        break outer;
      }
    }
    // Responses tool text is a closer stable boundary than the preceding user
    // message. It stays in place when its neighboring screenshot is removed.
    if (Array.isArray(message.output)) {
      for (let partIndex = 0; partIndex < message.output.length; partIndex++) {
        const part = message.output[partIndex];
        if (['function_call_output', 'custom_tool_call_output'].includes(message.type)
          && part?.type === 'input_text' && part.text) preceding = {messageIndex, partIndex, field: 'output'};
        let hasImage = false;
        visitImages(part, ctx.protocol, () => { hasImage = true; });
        if (hasImage) { selected = preceding; break outer; }
      }
    } else if (message.output) {
      let hasImage = false;
      visitImages(message.output, ctx.protocol, () => { hasImage = true; });
      if (hasImage) { selected = preceding; break; }
    }
  }
  if (!selected) return {body, added: 0};
  const input = body.input.map((message, messageIndex) => {
    if (messageIndex !== selected.messageIndex) return message;
    return {...message, [selected.field]: message[selected.field].map((part, partIndex) => partIndex === selected.partIndex
      ? {...part, prompt_cache_breakpoint: {mode: 'explicit'}} : part)};
  });
  return {body: {...body, input, ...(body.prompt_cache_options ? {} : {prompt_cache_options: {mode: 'implicit', ttl: '30m'}})}, added: 1};
}

function addAnthropicAnchor(body) {
  if (!Array.isArray(body.messages)) return {body, added: 0};
  const markers = [];
  const pending = [body];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'cache_control') markers.push(child);
      else if (child && typeof child === 'object') pending.push(child);
    }
  }
  if (markers.length >= 4 || markers.some(marker => !marker || marker.type !== 'ephemeral'
    || Object.keys(marker).some(key => !['type', 'ttl'].includes(key))
    || (marker.ttl !== undefined && marker.ttl !== '5m'))) return {body, added: 0};
  let preceding;
  let selected;
  outer: for (let messageIndex = 0; messageIndex < body.messages.length; messageIndex++) {
    const message = body.messages[messageIndex];
    if (!Array.isArray(message?.content)) continue;
    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
      const part = message.content[partIndex];
      if (message.role === 'user' && part?.type === 'text' && part.text) preceding = {messageIndex, partIndex};
      let hasImage = false;
      visitImages(part, 'anthropic', () => { hasImage = true; });
      if (hasImage) {
        selected = preceding;
        break outer;
      }
    }
  }
  if (!selected || body.messages[selected.messageIndex].content[selected.partIndex].cache_control) return {body, added: 0};
  // Keep the text boundary fixed, but do not promise image-independent cache hits.
  // Leave 1h/mixed TTL policies alone to avoid changing ordering or cache cost.
  const messages = body.messages.map((message, messageIndex) => messageIndex !== selected.messageIndex ? message
    : {...message, content: message.content.map((part, partIndex) => partIndex !== selected.partIndex ? part
      : {...part, cache_control: {type: 'ephemeral'}})});
  return {body: {...body, messages}, added: 1};
}
