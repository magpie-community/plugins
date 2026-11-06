import { applies } from './common.js';

export function onRequest(body, ctx) {
  if (!applies(body, ctx) || !Array.isArray(body.input)) return;
  let changed = false;
  const input = [];
  for (const item of body.input) {
    if (item?.type !== 'agent_message') { input.push(item); continue; }
    if ('encrypted_content' in item || !Array.isArray(item.content) || !item.content.length ||
        item.content.some(part => !part || 'encrypted_content' in Object(part) ||
          !(part.type === 'input_text' && typeof part.text === 'string' || part.type === 'input_image' && typeof part.image_url === 'string')) ||
        !item.content.some(part => part.type === 'input_image' || part.text.trim())) {
      input.push(item); continue;
    }
    const author = typeof item.author === 'string' ? item.author : '';
    const recipient = typeof item.recipient === 'string' ? item.recipient : '';
    const header = author && recipient ? `From ${author} to ${recipient}` : author ? `From ${author}` : recipient ? `To ${recipient}` : '';
    input.push({
      type: 'message', role: 'user',
      content: [...(header ? [{type: 'input_text', text: header + '\n\n'}] : []), ...item.content]
    });
    changed = true;
  }
  if (changed) return {...body, input};
}
