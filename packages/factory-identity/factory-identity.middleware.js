const ORIGINAL = "You are omp's trusted coding assistant.";
const REPLACEMENT = "You are droid's trusted coding assistant.";

export function onProvider(body, ctx) {
  if (ctx.provider?.id !== "factory") return;

  // 按客户端协议处理指令字段；onProvider 此时已确定实际上游。
  const fields = {};
  switch (ctx.protocol) {
    case "anthropic":
      fields.system = replaceContent(body.system);
      break;
    case "chat":
      fields.messages = replaceMessages(body.messages);
      break;
    case "responses":
      fields.instructions = replaceText(body.instructions);
      fields.input = replaceMessages(body.input);
      break;
    case "gemini":
      for (const key of ["systemInstruction", "system_instruction"]) {
        const instruction = body[key];
        if (!instruction) continue;
        const parts = replaceContent(instruction.parts);
        if (parts !== instruction.parts) fields[key] = { ...instruction, parts };
      }
      break;
    default:
      return;
  }

  let result = body;
  for (const key of Object.keys(fields)) {
    if (fields[key] === body[key]) continue;
    if (result === body) result = { ...body };
    result[key] = fields[key];
  }
  if (result !== body) return result;
}

function replaceText(text) {
  if (typeof text !== "string" || !text.includes(ORIGINAL)) return text;
  return text.split(ORIGINAL).join(REPLACEMENT);
}

function replaceContent(content) {
  if (typeof content === "string") return replaceText(content);
  if (!Array.isArray(content)) return content;

  let changed = false;
  const result = content.map((block) => {
    if (!block || (block.type !== undefined && block.type !== "text" && block.type !== "input_text")) {
      return block;
    }
    const text = replaceText(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? result : content;
}

function replaceMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "system" && message.role !== "developer") return message;
    const content = replaceContent(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? result : messages;
}
