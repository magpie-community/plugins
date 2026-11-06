import { applies } from './common.js';

export function onRequest(body, ctx) {
  if (!applies(body, ctx) || !Array.isArray(body.input)) return;
  let changed = false;
  const input = [];
  for (const item of body.input) {
    if (item?.type !== 'agent_message') { input.push(item); continue; }
    if (!Array.isArray(item.content) || !item.content.length ||
        item.content.some(part => part?.type !== 'input_text' || typeof part.text !== 'string')) {
      ctx.reject(409, 'Agent message compatibility: task contains unverified sealed content. Retry after its source response completes; actual ciphertext is not decoded.');
      return;
    }
    if (!item.content.some(part => part.text.trim())) {
      ctx.reject(400, 'Agent message compatibility: empty task body.');
      return;
    }
    const author = typeof item.author === 'string' ? item.author : 'unknown';
    const recipient = typeof item.recipient === 'string' ? item.recipient : 'unknown';
    input.push({
      type: 'message', role: 'user',
      content: [{type: 'input_text', text: '[Agent message: ' + author + ' -> ' + recipient + ']\n'}, ...item.content]
    });
    changed = true;
  }
  if (changed) return {...body, input};
}
